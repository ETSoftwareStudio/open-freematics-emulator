//! Reads the emulator back through an ELM327-compatible OBD-II adapter plugged into its OBD
//! port, the way a scan tool or telematics device would see it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fme_core::contracts::base_schemas::PidId;
use fme_core::contracts::emulator::TrafficChannel;
use fme_core::contracts::reader::{
    PidReading, PollInterval, PollingSettings, ReaderCommandError, ReaderCommandReason,
    ReaderConnectError, ReaderConnectReason, ReaderConnection, ReaderNotConnectedError,
    ReaderOperationError, ReaderState, ReaderTarget,
};
use fme_core::js;
use fme_core::shared::elm327::{
    is_can_protocol, parse_dtc_reply, parse_pid_reply, parse_vin_reply,
};
use fme_core::shared::pids::find_pid;
use indexmap::IndexMap;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::elm_client::{ElmClient, ElmClientOptions, RequestOptions};
use crate::device::device_link::{DeviceLink, DeviceLinkError};
use crate::device::serial_ports::SerialPorts;
use crate::device::simulated_device::SimulatedDevice;
use crate::device::tcp_sockets::TcpSockets;
use crate::traffic::traffic_log::TrafficLog;

const DEFAULT_WATCH: [&str; 3] = ["010C", "010D", "0105"];
const IDLE_PAUSE: Duration = Duration::from_secs(1);
/// Echo, line feeds and headers off; automatic protocol search.
const SETUP_COMMANDS: [&str; 5] = ["ATE0", "ATL0", "ATS1", "ATH0", "ATSP0"];

fn initial_state() -> ReaderState {
    ReaderState {
        connection: ReaderConnection::Disconnected,
        watching: DEFAULT_WATCH
            .iter()
            .filter_map(|pid| PidId::new(*pid).ok())
            .collect(),
        polling: PollingSettings {
            paused: false,
            interval: PollInterval::Ms500,
        },
        poll_rate: 0,
        readings: IndexMap::new(),
        unanswered: Vec::new(),
        vehicle_responding: false,
        voltage: None,
        dtcs: None,
        dtcs_at: None,
        monitor_status: None,
        vin: None,
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

fn target_tag(target: &ReaderTarget) -> &'static str {
    match target {
        ReaderTarget::Serial { .. } => "serial",
        ReaderTarget::Tcp { .. } => "tcp",
        ReaderTarget::Simulated => "simulated",
    }
}

/// The number in `(\d+(?:\.\d+)?)\s*V`, matched case-insensitively.
fn voltage_in(line: &str) -> Option<f64> {
    let bytes = line.as_bytes();
    let digits_from = |start: usize| {
        start
            + bytes[start..]
                .iter()
                .take_while(|byte| byte.is_ascii_digit())
                .count()
    };
    let unit_follows = |end: usize| {
        line[end..]
            .trim_start_matches(js::is_whitespace)
            .starts_with(['V', 'v'])
    };
    (0..bytes.len())
        .filter(|&start| bytes[start].is_ascii_digit())
        .find_map(|start| {
            let whole = digits_from(start);
            let fraction = (bytes.get(whole) == Some(&b'.')
                && bytes.get(whole + 1).is_some_and(u8::is_ascii_digit))
            .then(|| digits_from(whole + 1));
            [fraction, Some(whole)]
                .into_iter()
                .flatten()
                .find(|&end| unit_follows(end))
                .map(|end| js::number(&line[start..end]))
        })
}

/// `ATRV` answers like `12.6V`.
fn parse_voltage(lines: &[String]) -> Option<f64> {
    lines.iter().find_map(|line| voltage_in(line))
}

/// `/^44\b/`: the positive reply to Mode 04.
fn is_clear_reply(line: &str) -> bool {
    line.strip_prefix("44").is_some_and(|rest| {
        !rest
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

fn identify(lines: &[String]) -> Option<String> {
    lines
        .iter()
        .find(|line| {
            let line = line.to_ascii_uppercase();
            line.contains("ELM") || line.contains("OBD")
        })
        .cloned()
}

async fn describe_protocol(client: &ElmClient) -> Option<String> {
    let lines = client.request("ATDPN", RequestOptions::QUIET).await.ok()?;
    lines.into_iter().next()
}

async fn read_voltage(client: &ElmClient) -> Option<f64> {
    let lines = client.request("ATRV", RequestOptions::QUIET).await.ok()?;
    parse_voltage(&lines)
}

// Per-PID and per-cycle work shares the caller's span instead of opening its own.
async fn read_watched(
    state: &watch::Sender<ReaderState>,
    client: &ElmClient,
    quiet: bool,
) -> usize {
    let watching = state.borrow().watching.clone();
    let options = RequestOptions {
        quiet,
        ..RequestOptions::default()
    };
    let mut answered = IndexMap::new();
    let mut unanswered = Vec::new();
    for pid in &watching {
        let reply = client.query(pid, options).await.ok();
        let Some(raw) = reply.and_then(|lines| parse_pid_reply(&lines, pid)) else {
            unanswered.push(pid.clone());
            continue;
        };
        let value = find_pid(pid).map_or_else(
            || raw.first().copied().map_or(0.0, f64::from),
            |definition| definition.decode(&raw),
        );
        let reading = PidReading {
            value,
            raw,
            at: now_millis(),
        };
        answered.insert(pid.clone(), reading);
    }
    // One update per cycle, so clients see a whole poll at once.
    state.send_modify(|state| {
        if !watching.is_empty() {
            state.vehicle_responding = unanswered.len() < watching.len();
        }
        state.readings.extend(answered);
        state.unanswered = unanswered;
    });
    watching.len()
}

async fn poll_cycle(state: &watch::Sender<ReaderState>, client: &ElmClient) {
    if state
        .subscribe()
        .wait_for(|state| !state.polling.paused)
        .await
        .is_err()
    {
        return;
    }
    let started = Instant::now();
    let requests = read_watched(state, client, true).await;
    let voltage = read_voltage(client).await;
    let current = state.borrow().clone();
    if voltage != current.voltage {
        state.send_modify(|state| state.voltage = voltage);
    }
    if let ReaderConnection::Connected { protocol: None, .. } = current.connection
        && let Some(protocol) = describe_protocol(client).await
        && protocol != "A0"
        && protocol != "0"
    {
        state.send_modify(|state| {
            if let ReaderConnection::Connected {
                protocol: current, ..
            } = &mut state.connection
            {
                *current = Some(protocol);
            }
        });
    }
    let elapsed = started.elapsed().as_millis() as f64;
    let interval = f64::from(current.polling.interval.millis());
    // A slow adapter stretches the cycle past the interval.
    let poll_rate = js::math_round(requests as f64 * 1000.0 / interval.max(elapsed)) as u32;
    if poll_rate != current.poll_rate {
        state.send_modify(|state| {
            state.poll_rate = if state.polling.paused { 0 } else { poll_rate };
        });
    }
    let pause = if requests > 0 {
        Duration::from_millis((interval - elapsed).max(0.0) as u64)
    } else {
        IDLE_PAUSE
    };
    tokio::time::sleep(pause).await;
}

async fn poll(state: Arc<watch::Sender<ReaderState>>, client: ElmClient) {
    loop {
        poll_cycle(&state, &client).await;
    }
}

async fn read_codes(
    state: &watch::Sender<ReaderState>,
    client: &ElmClient,
) -> Result<(), ReaderCommandError> {
    let lines = client.query("03", RequestOptions::SEARCH).await?;
    let protocol = match &state.borrow().connection {
        ReaderConnection::Connected { protocol, .. } => protocol.clone(),
        _ => None,
    };
    let is_can = protocol.as_deref().is_none_or(is_can_protocol);
    let dtcs = parse_dtc_reply(&lines, 0x03, is_can);
    let monitor_status = client
        .query("0101", RequestOptions::default())
        .await
        .ok()
        .and_then(|reply| parse_pid_reply(&reply, "0101"));
    let dtcs_at = now_millis();
    state.send_modify(|state| {
        state.dtcs = Some(dtcs);
        state.dtcs_at = Some(dtcs_at);
        state.monitor_status = monitor_status;
    });
    Ok(())
}

#[derive(Debug)]
struct ActiveConnection {
    id: u64,
    client: ElmClient,
    poller: JoinHandle<()>,
}

#[derive(Debug)]
struct Inner {
    serial_ports: SerialPorts,
    tcp_sockets: TcpSockets,
    simulated: SimulatedDevice,
    traffic: TrafficLog,
    state: Arc<watch::Sender<ReaderState>>,
    active: Mutex<Option<ActiveConnection>>,
    connection_ids: AtomicU64,
    // Connect, disconnect, reads and clears run one at a time, so none uses a closing connection.
    lock: tokio::sync::Mutex<()>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        let active = self
            .active
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(active) = active.take() {
            active.poller.abort();
        }
    }
}

impl Inner {
    fn active(&self) -> MutexGuard<'_, Option<ActiveConnection>> {
        self.active.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn update(&self, modify: impl FnOnce(&mut ReaderState)) {
        self.state.send_modify(modify);
    }

    fn client(&self) -> Result<ElmClient, ReaderNotConnectedError> {
        self.active()
            .as_ref()
            .map(|active| active.client.clone())
            .ok_or(ReaderNotConnectedError {})
    }

    async fn close(active: ActiveConnection) {
        active.poller.abort();
        if active.poller.await.is_err_and(|error| error.is_panic()) {
            tracing::warn!("the reader's poll task failed");
        }
        active.client.close().await;
    }

    async fn close_active(&self) {
        let current = self.active().take();
        if let Some(current) = current {
            Self::close(current).await;
        }
    }

    #[tracing::instrument(name = "ObdReader.onLinkLost", skip_all)]
    async fn on_link_lost(&self, id: u64) {
        let current = {
            let mut active = self.active();
            match &*active {
                Some(current) if current.id == id => active.take(),
                _ => None,
            }
        };
        let Some(current) = current else {
            return;
        };
        Self::close(current).await;
        self.update(|state| {
            if let ReaderConnection::Connected { target, .. } = &state.connection {
                state.vehicle_responding = false;
                state.connection = ReaderConnection::Failed {
                    target: target.clone(),
                    reason: "The OBD-II adapter disconnected.".to_owned(),
                };
            }
        });
    }
}

/// Puts the state back to disconnected when a connect stops halfway because its caller left: by
/// then the old connection is closed and the new one was never kept.
struct Abandoned<'a> {
    inner: &'a Inner,
    armed: bool,
}

impl Drop for Abandoned<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.inner
                .update(|state| state.connection = ReaderConnection::Disconnected);
        }
    }
}

/// Cheap to clone; clones share one reader.
#[derive(Debug, Clone)]
pub struct ObdReader {
    inner: Arc<Inner>,
}

impl ObdReader {
    pub fn new(
        serial_ports: SerialPorts,
        tcp_sockets: TcpSockets,
        simulated: SimulatedDevice,
        traffic: TrafficLog,
    ) -> Self {
        let (state, _) = watch::channel(initial_state());
        Self {
            inner: Arc::new(Inner {
                serial_ports,
                tcp_sockets,
                simulated,
                traffic,
                state: Arc::new(state),
                active: Mutex::new(None),
                connection_ids: AtomicU64::new(0),
                lock: tokio::sync::Mutex::new(()),
            }),
        }
    }

    /// The current state, then every change.
    pub fn state(&self) -> watch::Receiver<ReaderState> {
        self.inner.state.subscribe()
    }

    #[tracing::instrument(name = "ObdReader.connect", skip_all, fields(target = target_tag(&target)))]
    pub async fn connect(&self, target: ReaderTarget) -> Result<(), ReaderConnectError> {
        let _permit = self.inner.lock.lock().await;
        let mut abandoned = Abandoned {
            inner: &self.inner,
            armed: true,
        };
        self.inner.close_active().await;
        self.inner.update(|state| {
            *state = ReaderState {
                watching: std::mem::take(&mut state.watching),
                polling: state.polling,
                connection: ReaderConnection::Connecting {
                    target: target.clone(),
                },
                ..initial_state()
            };
        });
        let id = self.inner.connection_ids.fetch_add(1, Ordering::Relaxed) + 1;
        let result = self.attempt(&target, id).await;
        abandoned.armed = false;
        if let Err(error) = &result {
            let reason = error.to_string();
            self.inner.update(|state| {
                state.connection = ReaderConnection::Failed {
                    target: target.clone(),
                    reason,
                };
            });
        }
        result
    }

    async fn open_link(
        &self,
        target: &ReaderTarget,
    ) -> Result<Box<dyn DeviceLink>, DeviceLinkError> {
        Ok(match target {
            ReaderTarget::Simulated => Box::new(self.inner.simulated.open_adapter()),
            ReaderTarget::Serial { path } => Box::new(self.inner.serial_ports.open(path).await?),
            ReaderTarget::Tcp { host, port } => {
                Box::new(self.inner.tcp_sockets.open(host, *port).await?)
            }
        })
    }

    fn client_options(&self, id: u64) -> ElmClientOptions {
        let traffic = self.inner.traffic.clone();
        let reader = Arc::downgrade(&self.inner);
        ElmClientOptions {
            on_traffic: Box::new(move |direction, text| {
                traffic.record(TrafficChannel::Reader, direction, text);
            }),
            on_link_lost: Box::new(move |_| {
                drop(tokio::spawn(async move {
                    if let Some(inner) = reader.upgrade() {
                        inner.on_link_lost(id).await;
                    }
                }));
            }),
        }
    }

    async fn attempt(&self, target: &ReaderTarget, id: u64) -> Result<(), ReaderConnectError> {
        let fail = |reason| ReaderConnectError {
            target: target.clone(),
            reason,
        };
        let link = self
            .open_link(target)
            .await
            .map_err(|_| fail(ReaderConnectReason::OpenFailed))?;
        let client = ElmClient::spawn(link, self.client_options(id));

        let reset = client.request("ATZ", RequestOptions::default()).await;
        let Some(identity) = reset.ok().and_then(|lines| identify(&lines)) else {
            client.close().await;
            return Err(fail(ReaderConnectReason::NoAdapter));
        };
        for command in SETUP_COMMANDS {
            if client
                .request(command, RequestOptions::default())
                .await
                .is_err()
            {
                tracing::debug!(command, "the adapter did not take a setup command");
            }
        }
        let searched = client.query("0100", RequestOptions::SEARCH).await.is_ok();
        let protocol = if searched {
            describe_protocol(&client).await
        } else {
            None
        };
        let voltage = read_voltage(&client).await;

        let poller = tokio::spawn(poll(Arc::clone(&self.inner.state), client.clone()));
        *self.inner.active() = Some(ActiveConnection { id, client, poller });
        self.inner.update(|state| {
            state.vehicle_responding = searched;
            state.voltage = voltage;
            state.connection = ReaderConnection::Connected {
                target: target.clone(),
                adapter: identity,
                protocol,
            };
        });
        Ok(())
    }

    #[tracing::instrument(name = "ObdReader.disconnect", skip_all)]
    pub async fn disconnect(&self) {
        let _permit = self.inner.lock.lock().await;
        self.inner.close_active().await;
        self.inner.update(|state| {
            state.vehicle_responding = false;
            state.poll_rate = 0;
            state.connection = ReaderConnection::Disconnected;
        });
    }

    /// Replaces the PIDs polled while connected.
    #[tracing::instrument(name = "ObdReader.watch", skip_all)]
    pub fn watch(&self, pids: Vec<PidId>) {
        self.inner.update(|state| state.watching = pids);
    }

    #[tracing::instrument(name = "ObdReader.setPolling", skip_all)]
    pub fn set_polling(&self, polling: PollingSettings) {
        self.inner.update(|state| {
            state.polling = polling;
            if polling.paused {
                state.poll_rate = 0;
            }
        });
    }

    /// Reads every watched PID once, logging each exchange, even while polling is paused.
    #[tracing::instrument(name = "ObdReader.readOnce", skip_all)]
    pub async fn read_once(&self) -> Result<(), ReaderOperationError> {
        let _permit = self.inner.lock.lock().await;
        let client = self.inner.client()?;
        read_watched(&self.inner.state, &client, false).await;
        Ok(())
    }

    /// Reads the stored codes (Mode 03) and the MIL and readiness bits (PID 0101).
    #[tracing::instrument(name = "ObdReader.readDtcs", skip_all)]
    pub async fn read_dtcs(&self) -> Result<(), ReaderOperationError> {
        let _permit = self.inner.lock.lock().await;
        let client = self.inner.client()?;
        Ok(read_codes(&self.inner.state, &client).await?)
    }

    /// Clears the codes from the vehicle side (Mode 04), then reads them back.
    #[tracing::instrument(name = "ObdReader.clearDtcs", skip_all)]
    pub async fn clear_dtcs(&self) -> Result<(), ReaderOperationError> {
        let _permit = self.inner.lock.lock().await;
        let client = self.inner.client()?;
        let reply = client.query("04", RequestOptions::SEARCH).await?;
        if !reply.iter().any(|line| is_clear_reply(line)) {
            return Err(ReaderCommandError {
                command: "04".to_owned(),
                reason: ReaderCommandReason::Rejected,
            }
            .into());
        }
        Ok(read_codes(&self.inner.state, &client).await?)
    }

    #[tracing::instrument(name = "ObdReader.readVin", skip_all)]
    pub async fn read_vin(&self) -> Result<(), ReaderOperationError> {
        let _permit = self.inner.lock.lock().await;
        let client = self.inner.client()?;
        let lines = client.query("0902", RequestOptions::SEARCH).await?;
        self.inner
            .update(|state| state.vin = parse_vin_reply(&lines));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use fme_core::contracts::base_schemas::DtcCode;
    use fme_core::contracts::emulator::{ConnectTarget, DtcMode};

    use super::*;
    use crate::device::simulated_device::SimulatedVersion;
    use crate::emulator::emulator_session::EmulatorSession;

    struct Fixture {
        session: EmulatorSession,
        reader: ObdReader,
        simulated: SimulatedDevice,
    }

    // V1.2: V1.3's default VIN has 16 characters, which a scan tool doesn't take as a VIN.
    async fn connected() -> Fixture {
        let simulated = SimulatedDevice::new(SimulatedVersion::V1_2);
        let traffic = TrafficLog::new();
        let session = EmulatorSession::new(SerialPorts, simulated.clone(), traffic.clone());
        let reader = ObdReader::new(SerialPorts, TcpSockets, simulated.clone(), traffic);
        session.connect(ConnectTarget::Simulated).await.unwrap();
        reader.connect(ReaderTarget::Simulated).await.unwrap();
        Fixture {
            session,
            reader,
            simulated,
        }
    }

    impl Fixture {
        /// Waits for the reader state to satisfy `predicate`, advancing the poll clock meanwhile.
        async fn state_where(&self, predicate: impl FnMut(&ReaderState) -> bool) -> ReaderState {
            let mut state = self.reader.state();
            tokio::time::advance(Duration::from_secs(1)).await;
            let found = tokio::time::timeout(Duration::from_secs(1), state.wait_for(predicate));
            found.await.unwrap().unwrap().clone()
        }
    }

    fn pid(id: &str) -> PidId {
        PidId::new(id).unwrap()
    }

    fn codes(codes: &[&str]) -> Vec<DtcCode> {
        codes
            .iter()
            .map(|code| DtcCode::new(*code).unwrap())
            .collect()
    }

    fn reading(state: &ReaderState, id: &str) -> Option<f64> {
        state.readings.get(id).map(|reading| reading.value)
    }

    #[tokio::test(start_paused = true)]
    async fn identifies_the_adapter_and_the_protocol_the_emulator_speaks() {
        let fixture = connected().await;
        let state = fixture
            .state_where(|state| matches!(state.connection, ReaderConnection::Connected { .. }))
            .await;
        let ReaderConnection::Connected {
            adapter, protocol, ..
        } = &state.connection
        else {
            unreachable!();
        };
        assert_eq!(adapter, "ELM327 v1.5");
        assert_eq!(protocol.as_deref(), Some("A6"));
        assert!(state.vehicle_responding);
        assert_eq!(state.voltage, Some(12.6));
    }

    #[tokio::test(start_paused = true)]
    async fn reads_back_the_values_the_emulator_serves() {
        let fixture = connected().await;
        fixture.session.set_pid(&pid("010C"), 3000.0).await.unwrap();
        fixture.session.set_pid(&pid("0105"), -10.0).await.unwrap();
        let state = fixture
            .state_where(|state| {
                reading(state, "010C") == Some(3000.0) && reading(state, "0105") == Some(-10.0)
            })
            .await;
        assert_eq!(state.readings["010C"].raw, [0x2e, 0xe0]);
    }

    #[tokio::test(start_paused = true)]
    async fn polls_whatever_the_ui_is_watching() {
        let fixture = connected().await;
        fixture.session.set_pid(&pid("0142"), 13.8).await.unwrap();
        fixture.reader.watch(vec![pid("0142")]);
        let state = fixture
            .state_where(|state| state.readings.contains_key("0142"))
            .await;
        let value = reading(&state, "0142").unwrap();
        assert!((value - 13.8).abs() < 0.005, "{value}");
    }

    #[tokio::test(start_paused = true)]
    async fn reads_stored_codes_and_the_vin() {
        let fixture = connected().await;
        fixture
            .session
            .set_dtcs(DtcMode::Stored, codes(&["P0300", "U0100"]))
            .await
            .unwrap();
        fixture.reader.read_dtcs().await.unwrap();
        fixture.reader.read_vin().await.unwrap();
        let state = fixture.state_where(|state| state.vin.is_some()).await;
        assert_eq!(
            state.dtcs,
            Some(vec!["P0300".to_owned(), "U0100".to_owned()])
        );
        assert_eq!(
            state
                .monitor_status
                .and_then(|bytes| bytes.first().copied()),
            Some(0x82)
        );
        assert!(state.dtcs_at.is_some());
        assert_eq!(state.vin.as_deref(), Some("1HGCD5654VA061985"));
    }

    #[tokio::test(start_paused = true)]
    async fn clears_codes_from_the_vehicle_side_with_mode_04() {
        let fixture = connected().await;
        fixture
            .session
            .set_dtcs(DtcMode::Stored, codes(&["P0301"]))
            .await
            .unwrap();
        fixture.reader.read_dtcs().await.unwrap();
        fixture.reader.clear_dtcs().await.unwrap();
        let state = fixture
            .state_where(|state| state.dtcs.as_ref().is_some_and(Vec::is_empty))
            .await;
        assert!(fixture.simulated.lock().firmware.stored_dtcs.is_empty());
        assert_eq!(state.dtcs, Some(Vec::new()));
    }

    #[tokio::test(start_paused = true)]
    async fn pauses_polling_reads_once_on_demand_then_resumes() {
        let fixture = connected().await;
        let (session, reader) = (&fixture.session, &fixture.reader);
        reader.set_polling(PollingSettings {
            paused: true,
            interval: PollInterval::Ms500,
        });
        reader.watch(vec![pid("010D")]);
        // Lets a cycle that started before the pause finish.
        fixture.state_where(|state| state.poll_rate == 0).await;
        session.set_pid(&pid("010D"), 77.0).await.unwrap();
        let paused = fixture.state_where(|state| state.polling.paused).await;
        assert_ne!(reading(&paused, "010D"), Some(77.0));

        reader.read_once().await.unwrap();
        fixture
            .state_where(|state| reading(state, "010D") == Some(77.0))
            .await;

        session.set_pid(&pid("010D"), 88.0).await.unwrap();
        reader.set_polling(PollingSettings {
            paused: false,
            interval: PollInterval::Ms500,
        });
        fixture
            .state_where(|state| reading(state, "010D") == Some(88.0))
            .await;
    }

    #[tokio::test(start_paused = true)]
    async fn reads_each_watched_pid_once_per_interval() {
        let fixture = connected().await;
        fixture.reader.watch(vec![pid("010C"), pid("010D")]);
        fixture.reader.set_polling(PollingSettings {
            paused: false,
            interval: PollInterval::Ms250,
        });
        let state = fixture.state_where(|state| state.poll_rate == 8).await;
        assert_eq!(state.polling.interval, PollInterval::Ms250);
    }

    #[tokio::test(start_paused = true)]
    async fn marks_pids_the_vehicle_does_not_answer() {
        let fixture = connected().await;
        fixture.reader.watch(vec![pid("010C"), pid("0151")]);
        let state = fixture
            .state_where(|state| state.unanswered.contains(&pid("0151")))
            .await;
        assert_eq!(state.unanswered, [pid("0151")]);
        assert!(state.vehicle_responding);
    }

    #[tokio::test(start_paused = true)]
    async fn notices_when_the_vehicle_stops_answering() {
        let fixture = connected().await;
        fixture.session.set_ignition(false).await.unwrap();
        fixture.state_where(|state| !state.vehicle_responding).await;
        let error = fixture.reader.read_vin().await.unwrap_err();
        let ReaderOperationError::Command(error) = error else {
            panic!("unexpected {error:?}");
        };
        assert_eq!(error.reason, ReaderCommandReason::NoAnswer);
        fixture.session.set_ignition(true).await.unwrap();
        fixture.state_where(|state| state.vehicle_responding).await;
    }

    #[tokio::test(start_paused = true)]
    async fn forgets_the_previous_connections_results_a_read_waits_for_the_reconnect() {
        let fixture = connected().await;
        let reader = &fixture.reader;
        reader.read_dtcs().await.unwrap();
        reader.disconnect().await;
        // The first poll leaves the connect waiting on the adapter, then starts the read.
        let (reconnected, read) =
            tokio::join!(reader.connect(ReaderTarget::Simulated), reader.read_vin());
        reconnected.unwrap();
        read.unwrap();
        let state = reader.state().borrow().clone();
        assert_eq!(state.dtcs, None);
        assert_eq!(state.vin.as_deref(), Some("1HGCD5654VA061985"));
    }

    #[tokio::test(start_paused = true)]
    async fn goes_back_to_disconnected_when_a_connect_is_abandoned_halfway() {
        let fixture = connected().await;
        let reader = &fixture.reader;
        // The connect's first poll leaves it waiting on the adapter; then the caller gives up.
        tokio::select! {
            biased;
            _ = reader.connect(ReaderTarget::Simulated) => panic!("connected at once"),
            () = std::future::ready(()) => {}
        }
        let state = reader.state().borrow().clone();
        assert_eq!(state.connection, ReaderConnection::Disconnected);
        reader.connect(ReaderTarget::Simulated).await.unwrap();
    }

    #[test]
    fn reads_the_supply_voltage() {
        for (line, voltage) in [
            ("12.6V", Some(12.6)),
            ("11 v", Some(11.0)),
            ("1.2.6V", Some(2.6)),
            ("12.V", None),
            ("?", None),
        ] {
            assert_eq!(voltage_in(line), voltage, "{line}");
        }
    }
}
