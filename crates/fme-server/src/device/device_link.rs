//! A byte pipe to an emulator or an OBD-II adapter: the USB serial port, a TCP socket or the
//! in-memory simulator.

use std::future::Future;
use std::pin::Pin;

use tokio::sync::mpsc;

pub type LinkFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkOperation {
    Open,
    Read,
    Write,
}

impl LinkOperation {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Read => "read",
            Self::Write => "write",
        }
    }
}

impl std::fmt::Display for LinkOperation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, thiserror::Error)]
#[error("Device link {operation} failed.")]
pub struct DeviceLinkError {
    pub operation: LinkOperation,
    #[source]
    pub source: std::io::Error,
}

impl DeviceLinkError {
    pub fn new(operation: LinkOperation, source: std::io::Error) -> Self {
        Self { operation, source }
    }
}

/// A link owned by one consumer, which both writes to it and reads what comes back.
pub trait DeviceLink: Send + 'static {
    /// Text for the AT interface, bytes for the bootloader.
    fn write<'a>(&'a mut self, data: &'a [u8]) -> LinkFuture<'a, Result<(), DeviceLinkError>>;

    /// The next run of raw text as it arrives, one character per byte. `None` once the link has
    /// closed, after an `Err` if it failed. Cancel-safe, so it can sit in a `select!`.
    fn next_chunk(&mut self) -> LinkFuture<'_, Option<Result<String, DeviceLinkError>>>;

    /// Releases the link completely before resolving. Dropping it releases it too, eventually.
    fn close(self: Box<Self>) -> LinkFuture<'static, ()> {
        Box::pin(async move { drop(self) })
    }
}

/// Bytes as text, one character per byte, the way the TypeScript server reads them (`latin1`).
pub fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&byte| char::from(byte)).collect()
}

/// Text back to bytes, one byte per character; characters above U+00FF keep their low byte.
pub fn latin1_bytes(text: &str) -> Vec<u8> {
    text.chars().map(|c| (u32::from(c) & 0xff) as u8).collect()
}

/// Incoming chunks fed by a reader thread or task.
#[derive(Debug)]
pub struct Chunks(mpsc::UnboundedReceiver<Result<String, DeviceLinkError>>);

pub type ChunkSender = mpsc::UnboundedSender<Result<String, DeviceLinkError>>;

impl Chunks {
    pub fn channel() -> (ChunkSender, Self) {
        let (sender, receiver) = mpsc::unbounded_channel();
        (sender, Self(receiver))
    }

    pub async fn next(&mut self) -> Option<Result<String, DeviceLinkError>> {
        self.0.recv().await
    }
}

#[cfg(test)]
pub(crate) mod scripted {
    use std::collections::VecDeque;

    use tokio::sync::mpsc;

    use super::{DeviceLink, DeviceLinkError, LinkFuture, latin1};

    /// A link whose replies the test scripts: each written command pops the next canned reply.
    pub(crate) struct ScriptedLink {
        replies: VecDeque<Option<&'static str>>,
        written: mpsc::UnboundedSender<String>,
        buffered: VecDeque<String>,
        incoming: mpsc::UnboundedReceiver<String>,
    }

    impl DeviceLink for ScriptedLink {
        fn write<'a>(&'a mut self, data: &'a [u8]) -> LinkFuture<'a, Result<(), DeviceLinkError>> {
            self.written.send(latin1(data)).unwrap();
            if let Some(Some(reply)) = self.replies.pop_front() {
                self.buffered.push_back(reply.to_owned());
            }
            Box::pin(std::future::ready(Ok(())))
        }

        fn next_chunk(&mut self) -> LinkFuture<'_, Option<Result<String, DeviceLinkError>>> {
            Box::pin(async move {
                match self.buffered.pop_front() {
                    Some(chunk) => Some(Ok(chunk)),
                    None => self.incoming.recv().await.map(Ok),
                }
            })
        }
    }

    pub(crate) struct Script {
        pub(crate) written: mpsc::UnboundedReceiver<String>,
        pub(crate) incoming: mpsc::UnboundedSender<String>,
    }

    pub(crate) fn scripted(replies: &[Option<&'static str>]) -> (Box<dyn DeviceLink>, Script) {
        let (written_tx, written) = mpsc::unbounded_channel();
        let (incoming, incoming_rx) = mpsc::unbounded_channel();
        let link = ScriptedLink {
            replies: replies.iter().copied().collect(),
            written: written_tx,
            buffered: VecDeque::new(),
            incoming: incoming_rx,
        };
        (Box::new(link), Script { written, incoming })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_bytes_and_text_one_to_one() {
        let bytes = [0x41, 0x0d, 0xbb, 0xee, 0xff];
        let text = latin1(&bytes);
        assert_eq!(text.chars().count(), bytes.len());
        assert_eq!(latin1_bytes(&text), bytes);
    }
}
