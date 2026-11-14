//! An ELM327-compatible OBD-II adapter over one link. Replies end with a `>` prompt instead of
//! OK/ERROR, and may span several lines. One task owns the link and runs each exchange to
//! completion; callers queue requests and wait for the answer.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use fme_core::contracts::emulator::TrafficDirection;
use fme_core::contracts::reader::{ReaderCommandError, ReaderCommandReason};
use fme_core::js;
use fme_core::shared::elm327::is_no_answer;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::device::device_link::{DeviceLink, DeviceLinkError};
use crate::emulator::at_client::{OnLinkLost, OnTraffic};

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
/// A cold Bluetooth link takes seconds to come up before the adapter even sees the reset.
pub const RESET_TIMEOUT: Duration = Duration::from_secs(8);
/// The first request after reset makes the adapter search every protocol.
pub const SEARCH_TIMEOUT: Duration = Duration::from_secs(12);

pub struct ElmClientOptions {
    pub on_traffic: OnTraffic,
    /// Runs once if the link fails or closes underneath the client.
    pub on_link_lost: OnLinkLost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestOptions {
    pub timeout: Duration,
    /// Keeps routine polls out of the traffic log; their results show up in the reader state.
    pub quiet: bool,
}

impl Default for RequestOptions {
    fn default() -> Self {
        Self {
            timeout: REQUEST_TIMEOUT,
            quiet: false,
        }
    }
}

impl RequestOptions {
    pub const QUIET: Self = Self {
        timeout: REQUEST_TIMEOUT,
        quiet: true,
    };

    pub const RESET: Self = Self {
        timeout: RESET_TIMEOUT,
        quiet: false,
    };

    pub const SEARCH: Self = Self {
        timeout: SEARCH_TIMEOUT,
        quiet: false,
    };
}

type Reply = Result<Vec<String>, ReaderCommandError>;

struct Request {
    command: String,
    options: RequestOptions,
    reply: oneshot::Sender<Reply>,
}

enum Message {
    Exchange(Request),
    Close,
}

/// A handle to the task that owns the link. Clones share it; the task stops and releases the
/// link on `close`, or once every handle is dropped.
#[derive(Debug, Clone)]
pub struct ElmClient {
    requests: mpsc::UnboundedSender<Message>,
    received: Arc<AtomicBool>,
    link_lost: Arc<AtomicBool>,
}

fn lines_of(text: &str) -> Vec<String> {
    text.split(['\r', '\n'])
        .map(js::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

fn error(command: &str, reason: ReaderCommandReason) -> ReaderCommandError {
    ReaderCommandError {
        command: command.to_owned(),
        reason,
    }
}

impl ElmClient {
    pub fn spawn(link: Box<dyn DeviceLink>, options: ElmClientOptions) -> Self {
        let (requests, inbox) = mpsc::unbounded_channel();
        let received = Arc::new(AtomicBool::new(false));
        let link_lost = Arc::new(AtomicBool::new(false));
        let actor = Actor {
            link,
            received: Arc::clone(&received),
            link_lost: Arc::clone(&link_lost),
            buffer: String::new(),
            replies: VecDeque::new(),
            log_replies: true,
            on_traffic: options.on_traffic,
            on_link_lost: Some(options.on_link_lost),
        };
        tokio::spawn(actor.run(inbox));
        Self {
            requests,
            received,
            link_lost,
        }
    }

    /// Whether the link failed or closed underneath the client. Set before `on_link_lost` runs.
    pub fn link_lost(&self) -> bool {
        self.link_lost.load(Ordering::Relaxed)
    }

    /// Whether any byte at all has arrived since the client started.
    pub fn received(&self) -> bool {
        self.received.load(Ordering::Relaxed)
    }

    /// Sends one command and returns the reply lines before the `>` prompt.
    #[tracing::instrument(name = "ElmClient.request", skip_all, fields(command = command))]
    pub async fn request(&self, command: &str, options: RequestOptions) -> Reply {
        let (reply, answer) = oneshot::channel();
        let request = Request {
            command: command.to_owned(),
            options,
            reply,
        };
        let link_error = || error(command, ReaderCommandReason::Link);
        self.requests
            .send(Message::Exchange(request))
            .map_err(|_| link_error())?;
        answer.await.map_err(|_| link_error())?
    }

    /// Like `request`, but fails with `no-answer` when the vehicle side stays silent.
    pub async fn query(&self, command: &str, options: RequestOptions) -> Reply {
        let lines = self.request(command, options).await?;
        if is_no_answer(&lines) {
            return Err(error(command, ReaderCommandReason::NoAnswer));
        }
        Ok(lines)
    }

    /// Lets the exchange in progress finish, then releases the link before returning.
    pub async fn close(&self) {
        if self.requests.send(Message::Close).is_ok() {
            self.requests.closed().await;
        }
    }
}

struct Actor {
    link: Box<dyn DeviceLink>,
    received: Arc<AtomicBool>,
    link_lost: Arc<AtomicBool>,
    buffer: String,
    replies: VecDeque<Vec<String>>,
    // Replies are logged as they arrive, so one that comes after its request timed out still shows.
    log_replies: bool,
    on_traffic: OnTraffic,
    on_link_lost: Option<OnLinkLost>,
}

impl Actor {
    async fn run(mut self, mut inbox: mpsc::UnboundedReceiver<Message>) {
        loop {
            let lost = self.on_link_lost.is_none();
            let message = tokio::select! {
                biased;
                chunk = self.link.next_chunk(), if !lost => {
                    self.receive(chunk);
                    continue;
                }
                message = inbox.recv() => message,
            };
            match message {
                Some(Message::Exchange(request)) => self.exchange(request).await,
                Some(Message::Close) | None => break,
            }
        }
        self.link.close().await;
        drop(inbox);
    }

    fn receive(&mut self, chunk: Option<Result<String, DeviceLinkError>>) {
        match chunk {
            Some(Ok(text)) => {
                if !text.is_empty() {
                    self.received.store(true, Ordering::Relaxed);
                }
                self.buffer.push_str(&text);
                while let Some(prompt) = self.buffer.find('>') {
                    let lines = lines_of(&self.buffer[..prompt]);
                    self.buffer.drain(..=prompt);
                    self.log_reply(&lines);
                    self.replies.push_back(lines);
                }
            }
            Some(Err(cause)) => self.lose(Some(cause)),
            None => self.lose(None),
        }
    }

    fn log_reply(&self, lines: &[String]) {
        if self.log_replies {
            for line in lines {
                (self.on_traffic)(TrafficDirection::Rx, line);
            }
        }
    }

    fn lose(&mut self, cause: Option<DeviceLinkError>) {
        if let Some(on_link_lost) = self.on_link_lost.take() {
            self.link_lost.store(true, Ordering::Relaxed);
            on_link_lost(cause);
        }
    }

    // A written command's reply is coming, so the exchange runs to the end even if the caller
    // has gone; stopping early would hand that reply to the next command.
    async fn exchange(&mut self, request: Request) {
        if request.reply.is_closed() {
            return;
        }
        let Request {
            command,
            options,
            reply,
        } = request;
        self.replies.clear();
        self.buffer.clear();
        self.log_replies = !options.quiet;
        if !options.quiet {
            (self.on_traffic)(TrafficDirection::Tx, &command);
        }
        let result = match self.link.write(format!("{command}\r").as_bytes()).await {
            Ok(()) => self.next_reply(&command, options.timeout).await,
            Err(_) => Err(error(&command, ReaderCommandReason::Link)),
        };
        let result = result.map(|lines| {
            let echo = command.replace(' ', "");
            lines
                .into_iter()
                .filter(|line| line.replace(' ', "") != echo)
                .collect()
        });
        if reply.send(result).is_err() {
            tracing::debug!("caller left before its exchange finished");
        }
    }

    async fn next_reply(&mut self, command: &str, timeout: Duration) -> Reply {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(lines) = self.replies.pop_front() {
                return Ok(lines);
            }
            let reason = if self.on_link_lost.is_none() {
                ReaderCommandReason::Link
            } else {
                tokio::select! {
                    chunk = self.link.next_chunk() => {
                        self.receive(chunk);
                        continue;
                    }
                    () = tokio::time::sleep_until(deadline) => ReaderCommandReason::Timeout,
                }
            };
            let partial = lines_of(&self.buffer);
            self.buffer.clear();
            self.log_reply(&partial);
            return Err(error(command, reason));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::device::device_link::scripted::scripted;

    fn quiet() -> ElmClientOptions {
        ElmClientOptions {
            on_traffic: Box::new(|_, _| {}),
            on_link_lost: Box::new(|_| {}),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn drops_what_a_timed_out_reply_left_behind_before_the_next_request() {
        let (link, _script) = scripted(&[Some("SEARCHING...\r41 00"), Some("12.6V\r\r>")]);
        let client = ElmClient::spawn(link, quiet());
        let first = client.request("0100", RequestOptions::default()).await;
        assert_eq!(first.unwrap_err().reason, ReaderCommandReason::Timeout);
        let second = client.request("ATRV", RequestOptions::default()).await;
        assert_eq!(second.unwrap(), ["12.6V"]);
    }
    #[tokio::test(start_paused = true)]
    async fn fails_a_request_at_once_when_the_link_is_lost() {
        let (link, mut script) = scripted(&[]);
        let client = ElmClient::spawn(link, quiet());
        let started = Instant::now();
        let pending = tokio::spawn({
            let client = client.clone();
            async move { client.request("0100", RequestOptions::SEARCH).await }
        });
        assert_eq!(script.written.recv().await.unwrap(), "0100\r");
        drop(script.incoming);
        let cut_off = pending.await.unwrap().unwrap_err();
        assert_eq!(cut_off.reason, ReaderCommandReason::Link);
        let after = client.request("ATRV", RequestOptions::default()).await;
        assert_eq!(after.unwrap_err().reason, ReaderCommandReason::Link);
        assert_eq!(started.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn logs_a_reply_that_timed_out_as_it_arrives_but_never_a_quiet_one() {
        let (link, script) = scripted(&[Some("SEARCHING..."), Some("12.6V\r\r>")]);
        let traffic = Arc::new(Mutex::new(Vec::new()));
        let options = ElmClientOptions {
            on_traffic: Box::new({
                let traffic = Arc::clone(&traffic);
                move |direction, text| {
                    let direction = match direction {
                        TrafficDirection::Tx => "tx",
                        TrafficDirection::Rx => "rx",
                    };
                    traffic.lock().unwrap().push(format!("{direction} {text}"));
                }
            }),
            ..quiet()
        };
        let client = ElmClient::spawn(link, options);
        let first = client.request("0100", RequestOptions::default()).await;
        assert_eq!(first.unwrap_err().reason, ReaderCommandReason::Timeout);
        script
            .incoming
            .send("\rUNABLE TO CONNECT\r\r>".to_owned())
            .unwrap();
        let second = client.request("ATRV", RequestOptions::QUIET).await;
        assert_eq!(second.unwrap(), ["12.6V"]);
        assert_eq!(
            *traffic.lock().unwrap(),
            ["tx 0100", "rx SEARCHING...", "rx UNABLE TO CONNECT"]
        );
    }
}
