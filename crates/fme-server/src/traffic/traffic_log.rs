//! Every line sent to or received from the emulator and the adapter, numbered in order.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use fme_core::contracts::emulator::{TrafficChannel, TrafficDirection, TrafficEntry};
use tokio::sync::mpsc;

const HISTORY: usize = 500;

#[derive(Debug, Default)]
struct State {
    sequence: u64,
    history: VecDeque<TrafficEntry>,
    subscribers: Vec<mpsc::UnboundedSender<TrafficEntry>>,
}

/// Cheap to clone; clones share one log.
#[derive(Debug, Clone, Default)]
pub struct TrafficLog {
    state: Arc<Mutex<State>>,
}

impl TrafficLog {
    pub fn new() -> Self {
        Self::default()
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    // Called once per serial line; tracing each would drown the spans around it.
    pub fn record(&self, channel: TrafficChannel, direction: TrafficDirection, text: &str) {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_millis() as u64);
        let mut state = self.state();
        state.sequence += 1;
        let entry = TrafficEntry {
            sequence: state.sequence,
            channel,
            at,
            direction,
            text: text.to_owned(),
        };
        state
            .subscribers
            .retain(|subscriber| subscriber.send(entry.clone()).is_ok());
        if state.history.len() == HISTORY {
            state.history.pop_front();
        }
        state.history.push_back(entry);
    }

    /// Recent history first, then live entries, with no gap or repeat between them.
    pub fn subscribe(&self) -> TrafficStream {
        let (sender, live) = mpsc::unbounded_channel();
        let mut state = self.state();
        state.subscribers.push(sender);
        TrafficStream {
            history: state.history.clone(),
            live,
        }
    }
}

#[derive(Debug)]
pub struct TrafficStream {
    history: VecDeque<TrafficEntry>,
    live: mpsc::UnboundedReceiver<TrafficEntry>,
}

impl TrafficStream {
    /// Waits for the next entry; `None` once every handle to the log is gone.
    pub async fn next(&mut self) -> Option<TrafficEntry> {
        match self.history.pop_front() {
            Some(entry) => Some(entry),
            None => self.live.recv().await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(entries: &[TrafficEntry]) -> Vec<(u64, &str)> {
        entries
            .iter()
            .map(|entry| (entry.sequence, entry.text.as_str()))
            .collect()
    }

    #[tokio::test]
    async fn replays_recent_history_then_streams_live_entries() {
        let log = TrafficLog::new();
        for n in 0..HISTORY + 2 {
            log.record(
                TrafficChannel::Emulator,
                TrafficDirection::Tx,
                &n.to_string(),
            );
        }
        let mut stream = log.subscribe();
        log.record(TrafficChannel::Reader, TrafficDirection::Rx, "live");

        let mut received = Vec::new();
        for _ in 0..=HISTORY {
            received.push(stream.next().await.unwrap());
        }
        assert_eq!(texts(&received[..2]), [(3, "2"), (4, "3")]);
        assert_eq!(
            texts(&received[HISTORY - 1..]),
            [(502, "501"), (503, "live")]
        );
        assert_eq!(received[HISTORY].channel, TrafficChannel::Reader);
    }
}
