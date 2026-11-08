//! An ELM327-compatible OBD-II adapter over one link. Replies end with a `>` prompt instead of
//! OK/ERROR, and may span several lines. One task owns the link and runs each exchange to
//! completion; callers queue requests and wait for the answer.

use std::collections::VecDeque;
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
        let actor = Actor {
            link,
            buffer: String::new(),
            replies: VecDeque::new(),
            on_traffic: options.on_traffic,
            on_link_lost: Some(options.on_link_lost),
        };
        tokio::spawn(actor.run(inbox));
        Self { requests }
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
    buffer: String,
    replies: VecDeque<Vec<String>>,
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
                self.buffer.push_str(&text);
                while let Some(prompt) = self.buffer.find('>') {
                    let lines = self.buffer[..prompt]
                        .split(['\r', '\n'])
                        .map(js::trim)
                        .filter(|line| !line.is_empty())
                        .map(str::to_owned)
                        .collect();
                    self.buffer.drain(..=prompt);
                    self.replies.push_back(lines);
                }
            }
            Some(Err(cause)) => self.lose(Some(cause)),
            None => self.lose(None),
        }
    }

    fn lose(&mut self, cause: Option<DeviceLinkError>) {
        if let Some(on_link_lost) = self.on_link_lost.take() {
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
        if !options.quiet {
            (self.on_traffic)(TrafficDirection::Tx, &command);
        }
        let result = match self.link.write(format!("{command}\r").as_bytes()).await {
            Ok(()) => self.next_reply(&command, options.timeout).await,
            Err(_) => Err(error(&command, ReaderCommandReason::Link)),
        };
        let result = result.map(|lines| {
            if !options.quiet {
                for line in &lines {
                    (self.on_traffic)(TrafficDirection::Rx, line);
                }
            }
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
            let lost = self.on_link_lost.is_none();
            tokio::select! {
                chunk = self.link.next_chunk(), if !lost => self.receive(chunk),
                () = tokio::time::sleep_until(deadline) => {
                    return Err(error(command, ReaderCommandReason::Timeout));
                }
            }
        }
    }
}
