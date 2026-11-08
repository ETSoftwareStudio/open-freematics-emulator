//! The emulator's AT command interface over one link. One task owns the link and runs each
//! command/reply exchange to completion; callers queue requests and wait for the answer.

use std::collections::VecDeque;
use std::time::Duration;

use fme_core::contracts::emulator::{
    EmulatorCommandError, EmulatorCommandReason, TrafficDirection,
};
use fme_core::shared::at_commands::{is_error_line, is_ok_line};
use fme_core::shared::line_framer::LineFramer;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::device::device_link::{DeviceLink, DeviceLinkError};

pub const COMMAND_TIMEOUT: Duration = Duration::from_millis(1500);
pub const RESET_TIMEOUT: Duration = Duration::from_secs(3);

pub type OnTraffic = Box<dyn Fn(TrafficDirection, &str) + Send>;
pub type OnLinkLost = Box<dyn FnOnce(Option<DeviceLinkError>) + Send>;

pub struct AtClientOptions {
    pub on_traffic: OnTraffic,
    /// Runs once if the link fails or closes underneath the client.
    pub on_link_lost: OnLinkLost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// Answers `OK` or `ERROR`.
    Command,
    /// An `ATGET` that answers one value line.
    Query,
    /// `ATZ`, which prints the banner and ends with the info line.
    Reset,
    /// Anything; stops on the reply shape the firmware uses for it.
    Raw,
}

type Reply = Result<Vec<String>, EmulatorCommandError>;

struct Request {
    command: String,
    kind: Kind,
    reply: oneshot::Sender<Reply>,
}

enum Message {
    Exchange(Request),
    Close,
}

/// A handle to the task that owns the link. Clones share it; the task stops and releases the
/// link on `close`, or once every handle is dropped.
#[derive(Debug, Clone)]
pub struct AtClient {
    requests: mpsc::UnboundedSender<Message>,
}

fn error(command: &str, reason: EmulatorCommandReason) -> EmulatorCommandError {
    EmulatorCommandError {
        command: command.to_owned(),
        reason,
    }
}

fn normalize(line: &str) -> String {
    line.replace(' ', "").to_uppercase()
}

fn is_echo(command: &str, line: &str) -> bool {
    normalize(line) == normalize(command)
}

impl AtClient {
    /// Wraps a link for one connection. Lines left over from an earlier command (late replies,
    /// debug output) are discarded before each send.
    pub fn spawn(link: Box<dyn DeviceLink>, options: AtClientOptions) -> Self {
        let (requests, inbox) = mpsc::unbounded_channel();
        let actor = Actor {
            link,
            framer: LineFramer::new(),
            lines: VecDeque::new(),
            on_traffic: options.on_traffic,
            on_link_lost: Some(options.on_link_lost),
        };
        tokio::spawn(actor.run(inbox));
        Self { requests }
    }

    /// Sends a command that answers `OK` or `ERROR`.
    #[tracing::instrument(name = "AtClient.command", skip_all, fields(command = command))]
    pub async fn command(&self, command: &str) -> Result<(), EmulatorCommandError> {
        self.exchange(command, Kind::Command).await.map(|_| ())
    }

    /// Sends an `ATGET` query and returns its value line.
    #[tracing::instrument(name = "AtClient.query", skip_all, fields(command = command))]
    pub async fn query(&self, command: &str) -> Result<String, EmulatorCommandError> {
        let lines = self.exchange(command, Kind::Query).await?;
        lines
            .into_iter()
            .next()
            .ok_or_else(|| error(command, EmulatorCommandReason::Rejected))
    }

    /// Sends `ATZ` and returns the banner and info lines it prints.
    #[tracing::instrument(name = "AtClient.reset", skip_all)]
    pub async fn reset(&self) -> Result<Vec<String>, EmulatorCommandError> {
        self.exchange("ATZ", Kind::Reset).await
    }

    /// Sends anything and returns whatever lines come back.
    #[tracing::instrument(name = "AtClient.raw", skip_all, fields(command = command))]
    pub async fn raw(&self, command: &str) -> Result<Vec<String>, EmulatorCommandError> {
        self.exchange(command, Kind::Raw).await
    }

    /// Lets the exchange in progress finish, then releases the link before returning.
    pub async fn close(&self) {
        if self.requests.send(Message::Close).is_ok() {
            self.requests.closed().await;
        }
    }

    async fn exchange(&self, command: &str, kind: Kind) -> Reply {
        let (reply, answer) = oneshot::channel();
        let request = Request {
            command: command.to_owned(),
            kind,
            reply,
        };
        let link_error = || error(command, EmulatorCommandReason::Link);
        self.requests
            .send(Message::Exchange(request))
            .map_err(|_| link_error())?;
        answer.await.map_err(|_| link_error())?
    }
}

struct Actor {
    link: Box<dyn DeviceLink>,
    framer: LineFramer,
    lines: VecDeque<String>,
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
                for line in self.framer.push(&text) {
                    (self.on_traffic)(TrafficDirection::Rx, &line);
                    self.lines.push_back(line);
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

    // Once a command is written its reply is coming, so the exchange runs to the end even if the
    // caller has gone; stopping early would hand that reply to the next command. A caller that
    // gives up while still queued is skipped.
    async fn exchange(&mut self, request: Request) {
        if request.reply.is_closed() {
            return;
        }
        let Request {
            command,
            kind,
            reply,
        } = request;
        self.lines.clear();
        (self.on_traffic)(TrafficDirection::Tx, &command);
        let result = match self.link.write(format!("{command}\r").as_bytes()).await {
            Ok(()) => self.collect(&command, kind).await,
            Err(_) => Err(error(&command, EmulatorCommandReason::Link)),
        };
        if reply.send(result).is_err() {
            tracing::debug!("caller left before its exchange finished");
        }
    }

    async fn collect(&mut self, command: &str, kind: Kind) -> Reply {
        let timeout = match kind {
            Kind::Command | Kind::Query => COMMAND_TIMEOUT,
            Kind::Reset | Kind::Raw => RESET_TIMEOUT,
        };
        let deadline = Instant::now() + timeout;
        let mut collector = Collector {
            command,
            kind,
            received: Vec::new(),
        };
        loop {
            while let Some(line) = self.lines.pop_front() {
                if let Some(done) = collector.feed(line) {
                    return done;
                }
            }
            let lost = self.on_link_lost.is_none();
            tokio::select! {
                chunk = self.link.next_chunk(), if !lost => self.receive(chunk),
                () = tokio::time::sleep_until(deadline) => return collector.timed_out(),
            }
        }
    }
}

struct Collector<'a> {
    command: &'a str,
    kind: Kind,
    received: Vec<String>,
}

impl Collector<'_> {
    /// Takes one line; returns the reply once the exchange is complete.
    fn feed(&mut self, line: String) -> Option<Reply> {
        let rejected = || Some(Err(error(self.command, EmulatorCommandReason::Rejected)));
        match self.kind {
            Kind::Command if is_ok_line(&line) => Some(Ok(Vec::new())),
            Kind::Command if is_error_line(&line) => rejected(),
            Kind::Command => None,
            Kind::Query if is_echo(self.command, &line) || is_ok_line(&line) => None,
            Kind::Query if is_error_line(&line) => rejected(),
            Kind::Query => Some(Ok(vec![line])),
            Kind::Reset if is_echo(self.command, &line) => None,
            // The info line (comma-separated) is the last thing the firmware prints after a reset.
            Kind::Reset => {
                let info = line.contains(',');
                self.received.push(line);
                info.then(|| Ok(std::mem::take(&mut self.received)))
            }
            Kind::Raw => {
                self.received.push(line);
                self.raw_complete()
                    .then(|| Ok(std::mem::take(&mut self.received)))
            }
        }
    }

    fn raw_complete(&self) -> bool {
        let Some(last) = self.received.last() else {
            return false;
        };
        if is_error_line(last) {
            return true;
        }
        let command = normalize(self.command);
        if command.starts_with("ATGET") {
            return !is_echo(self.command, last);
        }
        if command == "ATZ" || command == "ATR" {
            return last.contains(',');
        }
        is_ok_line(last)
    }

    /// A raw exchange keeps what arrived before the timeout.
    fn timed_out(self) -> Reply {
        if self.kind == Kind::Raw && !self.received.is_empty() {
            return Ok(self.received);
        }
        Err(error(self.command, EmulatorCommandReason::Timeout))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::device_link::{LinkFuture, latin1};

    /// A link whose replies the test scripts: each written command pops the next canned reply.
    struct ScriptedLink {
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

    struct Script {
        written: mpsc::UnboundedReceiver<String>,
        incoming: mpsc::UnboundedSender<String>,
    }

    fn scripted(replies: &[Option<&'static str>]) -> (Box<dyn DeviceLink>, Script) {
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

    fn quiet() -> AtClientOptions {
        AtClientOptions {
            on_traffic: Box::new(|_, _| {}),
            on_link_lost: Box::new(|_| {}),
        }
    }

    fn spawn_command(
        client: &AtClient,
        command: &'static str,
    ) -> tokio::task::JoinHandle<Result<(), EmulatorCommandError>> {
        let client = client.clone();
        tokio::spawn(async move { client.command(command).await })
    }

    #[tokio::test(start_paused = true)]
    async fn resolves_commands_on_ok_and_rejects_on_error() {
        let (link, mut script) = scripted(&[Some("O"), Some("ERROR\r")]);
        let client = AtClient::spawn(link, quiet());
        // "O" alone never completes a line, so the first command waits for the rest.
        let first = spawn_command(&client, "ATE0");
        assert_eq!(script.written.recv().await.unwrap(), "ATE0\r");
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(!first.is_finished());
        tokio::time::advance(Duration::from_secs(1)).await;
        let timed_out = first.await.unwrap().unwrap_err();
        assert_eq!(timed_out.reason, EmulatorCommandReason::Timeout);

        let rejected = client.command("ATBOGUS").await.unwrap_err();
        assert_eq!(rejected.reason, EmulatorCommandReason::Rejected);
    }

    #[tokio::test(start_paused = true)]
    async fn drops_stale_lines_before_a_new_command() {
        let (link, script) = scripted(&[Some("0105=82 \r")]);
        let client = AtClient::spawn(link, quiet());
        script.incoming.send("OK\r".to_owned()).unwrap();
        assert_eq!(client.query("ATGET 0105").await.unwrap(), "0105=82");
    }

    #[tokio::test(start_paused = true)]
    async fn skips_the_echo_when_answering_a_query() {
        let (link, _script) = scripted(&[Some("ATGET VIN\r1HGCD5654VA061985\r\n")]);
        let client = AtClient::spawn(link, quiet());
        assert_eq!(
            client.query("ATGET VIN").await.unwrap(),
            "1HGCD5654VA061985"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn collects_the_reset_banner_through_the_info_line() {
        let (link, _script) = scripted(&[Some(
            "OBD-II EMULATOR V1.2\r\nOBD-II EMULATOR V1.2\r\n00.00.02,00.01.05,201910,X,VIN\r\n",
        )]);
        let client = AtClient::spawn(link, quiet());
        assert_eq!(
            client.reset().await.unwrap(),
            [
                "OBD-II EMULATOR V1.2",
                "OBD-II EMULATOR V1.2",
                "00.00.02,00.01.05,201910,X,VIN",
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_replies_paired_with_commands_when_a_caller_gives_up_mid_exchange() {
        let (link, mut script) = scripted(&[]);
        let client = AtClient::spawn(link, quiet());
        let first = spawn_command(&client, "ATACC1");
        assert_eq!(script.written.recv().await.unwrap(), "ATACC1\r");
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        let second = spawn_command(&client, "ATBOGUS");
        tokio::task::yield_now().await;
        // The first command's late OK must not be taken as the answer to the second.
        script.incoming.send("OK\r".to_owned()).unwrap();
        assert_eq!(script.written.recv().await.unwrap(), "ATBOGUS\r");
        script.incoming.send("ERROR\r".to_owned()).unwrap();
        let rejected = second.await.unwrap().unwrap_err();
        assert_eq!(rejected.reason, EmulatorCommandReason::Rejected);
    }

    #[tokio::test(start_paused = true)]
    async fn skips_a_command_whose_caller_gave_up_while_queued() {
        let (link, mut script) = scripted(&[None, Some("OK\r")]);
        let client = AtClient::spawn(link, quiet());
        let first = spawn_command(&client, "ATACC1");
        assert_eq!(script.written.recv().await.unwrap(), "ATACC1\r");
        let queued = spawn_command(&client, "ATACC0");
        tokio::task::yield_now().await;
        queued.abort();
        assert!(queued.await.unwrap_err().is_cancelled());
        script.incoming.send("OK\r".to_owned()).unwrap();
        first.await.unwrap().unwrap();
        let third = spawn_command(&client, "ATVIN1");
        assert_eq!(script.written.recv().await.unwrap(), "ATVIN1\r");
        third.await.unwrap().unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn reports_a_lost_link() {
        let (link, script) = scripted(&[]);
        let (lost, on_lost) = oneshot::channel();
        let options = AtClientOptions {
            on_link_lost: Box::new(move |cause| lost.send(cause.is_none()).unwrap()),
            ..quiet()
        };
        let _client = AtClient::spawn(link, options);
        drop(script.incoming);
        assert!(on_lost.await.unwrap());
    }

    #[tokio::test(start_paused = true)]
    async fn releases_the_link_on_close_after_the_exchange_in_progress() {
        let (link, mut script) = scripted(&[]);
        let client = AtClient::spawn(link, quiet());
        let pending = spawn_command(&client, "ATACC1");
        assert_eq!(script.written.recv().await.unwrap(), "ATACC1\r");
        let closing = tokio::spawn({
            let client = client.clone();
            async move { client.close().await }
        });
        script.incoming.send("OK\r".to_owned()).unwrap();
        pending.await.unwrap().unwrap();
        closing.await.unwrap();
        assert!(script.written.recv().await.is_none());
        let after = client.command("ATACC0").await.unwrap_err();
        assert_eq!(after.reason, EmulatorCommandReason::Link);
    }
}
