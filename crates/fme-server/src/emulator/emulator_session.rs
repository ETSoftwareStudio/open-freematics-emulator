//! What the server believes is configured on the emulator, and the connection that keeps the
//! device in step with it. Values are the last ones the device acknowledged; the firmware can't
//! report most of them back.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use fme_core::contracts::base_schemas::{CalibrationId, DtcCode, PidId, Vin};
use fme_core::contracts::emulator::{
    ConnectTarget, Connection, DeviceCapabilities, DeviceInfo, DtcMode, Dtcs, EmulatorCommandError,
    EmulatorCommandReason, EmulatorConnectError, EmulatorConnectReason, EmulatorNotConnectedError,
    EmulatorOperationError, EmulatorState, ObdProtocol, Readiness, ReadinessMonitor,
    ReadinessMonitorId, SerialPortInfo, SerialPortListError, TrafficChannel, UnsentEdit,
};
use fme_core::contracts::presets::{Preset, PresetRef};
use fme_core::shared::at_commands as at;
use fme_core::shared::default_state::make_default_state;
use fme_core::shared::dtcs::PIDS_RESET_BY_CLEAR;
use fme_core::shared::pids::{clamp_pid_value, find_pid};
use fme_core::shared::readiness::{MONITOR_STATUS_PID, encode_monitor_status};
use tokio::sync::watch;

use super::at_client::{AtClient, AtClientOptions};
use crate::device::device_link::{DeviceLink, DeviceLinkError};
use crate::device::serial_ports::SerialPorts;
use crate::device::simulated_device::SimulatedDevice;
use crate::traffic::traffic_log::TrafficLog;

const PROBE_DTC: &str = "P0000";
const HANDSHAKE_ATTEMPTS: usize = 3;
const HANDSHAKE_RETRY: Duration = Duration::from_millis(200);

fn pid_command(pid: &PidId, value: f64) -> String {
    // Raw bytes: the firmware's decimal conversion truncates, rejects negatives, and
    // mis-converts 015E.
    match find_pid(pid) {
        Some(definition) => at::set_pid_raw(pid, &definition.encode(value)),
        None => at::set_pid_decimal(pid, value),
    }
}

fn monitor_status_command(readiness: &Readiness, dtcs: &Dtcs) -> String {
    at::set_pid_raw(
        &MONITOR_STATUS_PID,
        &encode_monitor_status(readiness, dtcs.stored.len()),
    )
}

fn clamp_for(pid: &PidId, value: f64) -> f64 {
    find_pid(pid).map_or(value, |definition| clamp_pid_value(definition, value))
}

fn parse_device_info(lines: &[String]) -> Option<DeviceInfo> {
    let banner = lines
        .iter()
        .find(|line| line.to_ascii_uppercase().contains("EMULATOR"))?;
    Some(DeviceInfo {
        banner: banner.clone(),
        details: lines.iter().find(|line| line.contains(',')).cloned(),
    })
}

fn target_tag(target: &ConnectTarget) -> &'static str {
    match target {
        ConnectTarget::Serial { .. } => "serial",
        ConnectTarget::Simulated => "simulated",
    }
}

// Like a scan tool's Mode 04: codes go, and so do the MIL-on and since-cleared counters.
fn clear(state: &mut EmulatorState) {
    state.dtcs = Dtcs::default();
    for pid in &PIDS_RESET_BY_CLEAR {
        state.pids.insert(pid.clone(), 0.0);
    }
}

fn set_pids(state: &mut EmulatorState, values: &[(PidId, f64)]) {
    for (pid, value) in values {
        state.pids.insert(pid.clone(), *value);
    }
}

struct Pushed {
    state: EmulatorState,
    unsent: Vec<UnsentEdit>,
}

/// Finds which DTC modes the firmware takes by setting a throwaway code in each. Runs right
/// after ATZ, and the codes it leaves are cleared before the real state is pushed.
#[tracing::instrument(name = "EmulatorSession.probeDtcModes", skip_all)]
async fn probe_dtc_modes(client: &AtClient) -> Result<Vec<DtcMode>, EmulatorCommandError> {
    let probe: Vec<DtcCode> = DtcCode::new(PROBE_DTC).into_iter().collect();
    let mut accepted = vec![DtcMode::Stored];
    for &mode in DtcMode::ALL.iter().filter(|&&mode| mode != DtcMode::Stored) {
        match client.command(&at::set_dtcs(mode, &probe)).await {
            Ok(()) => accepted.push(mode),
            Err(error) if error.reason == EmulatorCommandReason::Rejected => {}
            Err(error) => return Err(error),
        }
    }
    if accepted.len() > 1 {
        client.command(at::CLEAR_DTCS).await?;
    }
    Ok(accepted)
}

#[tracing::instrument(name = "EmulatorSession.pushState", skip_all)]
async fn push_state(
    client: &AtClient,
    desired: EmulatorState,
    dtc_modes: Vec<DtcMode>,
) -> Result<Pushed, EmulatorCommandError> {
    client.command(&at::set_protocol(desired.protocol)).await?;
    client.command(at::ignition(desired.ignition)).await?;
    client
        .command(at::vin_response(desired.vin_enabled))
        .await?;
    if let Some(vin) = &desired.vin {
        client.command(&at::set_vin(vin)).await?;
    }
    if let Some(calibration_id) = &desired.calibration_id
        && client
            .command(&at::set_calibration_id(calibration_id))
            .await
            .is_err()
    {
        tracing::debug!("the firmware did not take the calibration ID");
    }
    // Edits staged offline that this firmware can't take are dropped and reported.
    let mut unsent = Vec::new();
    let mut accepted_dtcs = desired.dtcs.clone();
    for &mode in DtcMode::ALL {
        let codes = desired.dtcs.get(mode);
        if codes.is_empty() {
            continue;
        }
        if !dtc_modes.contains(&mode) {
            accepted_dtcs.get_mut(mode).clear();
            unsent.push(UnsentEdit::Dtcs {
                mode,
                codes: codes.clone(),
            });
            continue;
        }
        client.command(&at::set_dtcs(mode, codes)).await?;
    }
    for (pid, value) in &desired.pids {
        client.command(&pid_command(pid, *value)).await?;
    }
    let mut pushed = desired;
    pushed.dtcs = accepted_dtcs;
    client
        .command(&monitor_status_command(&pushed.readiness, &pushed.dtcs))
        .await?;
    let vin = client.query(at::GET_VIN).await.ok();
    let calibration_id = client.query(at::GET_CALIBRATION_ID).await.ok();
    // As the official GUI does: CALID is supported when the firmware answers ATGET CALID.
    let capabilities = DeviceCapabilities {
        dtc_modes,
        calibration_id: calibration_id.is_some(),
    };
    if let Some(calibration_id) = &pushed.calibration_id
        && !capabilities.calibration_id
    {
        unsent.push(UnsentEdit::CalibrationId {
            calibration_id: calibration_id.clone(),
        });
    }
    // Without a readback, the VIN is the one the device acknowledged above, if any.
    if vin.is_some() {
        pushed.vin = vin;
    }
    pushed.calibration_id = calibration_id;
    pushed.capabilities = Some(capabilities);
    Ok(Pushed {
        state: pushed,
        unsent,
    })
}

#[derive(Debug)]
struct ActiveConnection {
    id: u64,
    client: AtClient,
}

#[derive(Debug)]
struct Inner {
    serial_ports: SerialPorts,
    simulated: SimulatedDevice,
    traffic: TrafficLog,
    state: watch::Sender<EmulatorState>,
    active: Mutex<Option<ActiveConnection>>,
    connection_ids: AtomicU64,
    // Connect, disconnect and setters run one at a time so a connect never races a setter.
    lock: tokio::sync::Mutex<()>,
}

impl Inner {
    fn active(&self) -> MutexGuard<'_, Option<ActiveConnection>> {
        self.active.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn client(&self) -> Option<AtClient> {
        self.active().as_ref().map(|active| active.client.clone())
    }

    fn update(&self, modify: impl FnOnce(&mut EmulatorState)) {
        self.state.send_modify(modify);
    }

    async fn close_active(&self) {
        let current = self.active().take();
        if let Some(current) = current {
            current.client.close().await;
        }
    }

    /// Makes the connection the active one, unless its link is lost already. One lock covers the
    /// check and the store, so `on_link_lost` finds every connection that loses its link later.
    fn keep(&self, connection: ActiveConnection) -> Result<(), ActiveConnection> {
        let mut active = self.active();
        if connection.client.link_lost() {
            return Err(connection);
        }
        *active = Some(connection);
        Ok(())
    }

    #[tracing::instrument(name = "EmulatorSession.onLinkLost", skip_all)]
    async fn on_link_lost(&self, id: u64) {
        // Under the lock no connect runs, so the state changed below is this connection's.
        let _permit = self.lock.lock().await;
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
        current.client.close().await;
        self.update(|state| {
            if let Connection::Connected { target, .. } = &state.connection {
                state.connection = Connection::Failed {
                    target: target.clone(),
                    reason: "The device disconnected.".to_owned(),
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
                .update(|state| state.connection = Connection::Disconnected);
        }
    }
}

/// Cheap to clone; clones share one session.
#[derive(Debug, Clone)]
pub struct EmulatorSession {
    inner: Arc<Inner>,
}

impl EmulatorSession {
    pub fn new(serial_ports: SerialPorts, simulated: SimulatedDevice, traffic: TrafficLog) -> Self {
        let (state, _) = watch::channel(make_default_state());
        Self {
            inner: Arc::new(Inner {
                serial_ports,
                simulated,
                traffic,
                state,
                active: Mutex::new(None),
                connection_ids: AtomicU64::new(0),
                lock: tokio::sync::Mutex::new(()),
            }),
        }
    }

    /// The current state, then every change.
    pub fn state(&self) -> watch::Receiver<EmulatorState> {
        self.inner.state.subscribe()
    }

    pub async fn list_ports(&self) -> Result<Vec<SerialPortInfo>, SerialPortListError> {
        self.inner.serial_ports.list().await
    }

    #[tracing::instrument(
        name = "EmulatorSession.connect",
        skip_all,
        fields(target = target_tag(&target))
    )]
    pub async fn connect(&self, target: ConnectTarget) -> Result<(), EmulatorConnectError> {
        let _permit = self.inner.lock.lock().await;
        let mut abandoned = Abandoned {
            inner: &self.inner,
            armed: true,
        };
        self.inner.close_active().await;
        self.inner.update(|state| {
            state.connection = Connection::Connecting {
                target: target.clone(),
            };
        });
        let id = self.inner.connection_ids.fetch_add(1, Ordering::Relaxed) + 1;
        let result = self.attempt(&target, id).await;
        abandoned.armed = false;
        if let Err(error) = &result {
            let reason = error.to_string();
            self.inner.update(|state| {
                state.connection = Connection::Failed {
                    target: target.clone(),
                    reason,
                };
            });
        }
        result
    }

    async fn open_link(
        &self,
        target: &ConnectTarget,
    ) -> Result<Box<dyn DeviceLink>, DeviceLinkError> {
        Ok(match target {
            ConnectTarget::Simulated => Box::new(self.inner.simulated.open()),
            ConnectTarget::Serial { path } => Box::new(self.inner.serial_ports.open(path).await?),
        })
    }

    fn client_options(&self, id: u64) -> AtClientOptions {
        let traffic = self.inner.traffic.clone();
        let session = Arc::downgrade(&self.inner);
        AtClientOptions {
            on_traffic: Box::new(move |direction, text| {
                traffic.record(TrafficChannel::Emulator, direction, text);
            }),
            on_link_lost: Box::new(move |_| {
                drop(tokio::spawn(async move {
                    if let Some(inner) = session.upgrade() {
                        inner.on_link_lost(id).await;
                    }
                }));
            }),
        }
    }

    async fn attempt(&self, target: &ConnectTarget, id: u64) -> Result<(), EmulatorConnectError> {
        let fail = |reason| EmulatorConnectError {
            target: target.clone(),
            reason,
        };
        let link = self
            .open_link(target)
            .await
            .map_err(|_| fail(EmulatorConnectReason::OpenFailed))?;
        let client = AtClient::spawn(link, self.client_options(id));
        let (reset_lines, pushed) = match self.set_up(&client).await {
            Ok(set_up) => set_up,
            Err(reason) => {
                let reason = if client.link_lost() {
                    EmulatorConnectReason::LinkLost
                } else {
                    reason
                };
                client.close().await;
                return Err(fail(reason));
            }
        };
        if let Err(lost) = self.inner.keep(ActiveConnection { id, client }) {
            lost.client.close().await;
            return Err(fail(EmulatorConnectReason::LinkLost));
        }
        let device = parse_device_info(&reset_lines);
        self.inner.update(|state| {
            let mut pids = std::mem::take(&mut state.pids);
            for (pid, value) in pushed.state.pids.iter() {
                pids.insert(pid.clone(), *value);
            }
            *state = EmulatorState {
                pids,
                connection: Connection::Connected {
                    target: target.clone(),
                    device,
                    unsent: pushed.unsent,
                },
                ..pushed.state
            };
        });
        Ok(())
    }

    async fn set_up(
        &self,
        client: &AtClient,
    ) -> Result<(Vec<String>, Pushed), EmulatorConnectReason> {
        // ATZ gives us the firmware banner and a clean slate; older firmware may stay silent.
        let reset_lines = client.reset().await.unwrap_or_default();
        if client.command(at::echo(false)).await.is_err() {
            tracing::debug!("the device did not take ATE0");
        }
        let mut attempt = 1;
        while client.command(at::debug_output(false)).await.is_err() {
            if attempt == HANDSHAKE_ATTEMPTS {
                return Err(EmulatorConnectReason::NoHandshake);
            }
            attempt += 1;
            tokio::time::sleep(HANDSHAKE_RETRY).await;
        }
        let desired = self.inner.state.borrow().clone();
        let setup_failed = |_| EmulatorConnectReason::SetupFailed;
        let dtc_modes = probe_dtc_modes(client).await.map_err(setup_failed)?;
        let pushed = push_state(client, desired, dtc_modes)
            .await
            .map_err(setup_failed)?;
        Ok((reset_lines, pushed))
    }

    #[tracing::instrument(name = "EmulatorSession.disconnect", skip_all)]
    pub async fn disconnect(&self) {
        let _permit = self.inner.lock.lock().await;
        self.inner.close_active().await;
        self.inner
            .update(|state| state.connection = Connection::Disconnected);
    }

    /// Sends commands when connected, then applies `next` to the state. While disconnected it
    /// only changes the state, which is pushed to the device on the next connect.
    #[tracing::instrument(name = "EmulatorSession.apply", skip_all)]
    async fn apply(
        &self,
        commands: impl FnOnce(&EmulatorState) -> Vec<String>,
        next: impl FnOnce(&mut EmulatorState),
    ) -> Result<(), EmulatorOperationError> {
        if let Some(client) = self.inner.client() {
            let current = self.inner.state.borrow().clone();
            for command in commands(&current) {
                client.command(&command).await?;
            }
        }
        self.inner.update(next);
        Ok(())
    }

    #[tracing::instrument(name = "EmulatorSession.setIgnition", skip_all)]
    pub async fn set_ignition(&self, on: bool) -> Result<(), EmulatorOperationError> {
        let _permit = self.inner.lock.lock().await;
        self.apply(
            |_| vec![at::ignition(on).to_owned()],
            |state| state.ignition = on,
        )
        .await
    }

    #[tracing::instrument(name = "EmulatorSession.setProtocol", skip_all)]
    pub async fn set_protocol(&self, protocol: ObdProtocol) -> Result<(), EmulatorOperationError> {
        let _permit = self.inner.lock.lock().await;
        self.apply(
            |_| vec![at::set_protocol(protocol)],
            |state| state.protocol = protocol,
        )
        .await
    }

    #[tracing::instrument(name = "EmulatorSession.setVinEnabled", skip_all)]
    pub async fn set_vin_enabled(&self, enabled: bool) -> Result<(), EmulatorOperationError> {
        let _permit = self.inner.lock.lock().await;
        self.apply(
            |_| vec![at::vin_response(enabled).to_owned()],
            |state| state.vin_enabled = enabled,
        )
        .await
    }

    #[tracing::instrument(name = "EmulatorSession.setVin", skip_all)]
    pub async fn set_vin(&self, vin: &Vin) -> Result<(), EmulatorOperationError> {
        let _permit = self.inner.lock.lock().await;
        self.apply(
            |_| vec![at::set_vin(vin)],
            |state| state.vin = Some(vin.to_string()),
        )
        .await
    }

    #[tracing::instrument(name = "EmulatorSession.setCalibrationId", skip_all)]
    pub async fn set_calibration_id(
        &self,
        calibration_id: &CalibrationId,
    ) -> Result<(), EmulatorOperationError> {
        let _permit = self.inner.lock.lock().await;
        self.apply(
            |_| vec![at::set_calibration_id(calibration_id)],
            |state| state.calibration_id = Some(calibration_id.to_string()),
        )
        .await
    }

    // Other PID edits keep `last_preset`: the UI shows them as edits to it.
    #[tracing::instrument(name = "EmulatorSession.setPid", skip_all, fields(pid = %pid))]
    pub async fn set_pid(&self, pid: &PidId, value: f64) -> Result<(), EmulatorOperationError> {
        let _permit = self.inner.lock.lock().await;
        let clamped = clamp_for(pid, value);
        self.apply(
            |_| vec![pid_command(pid, clamped)],
            |state| {
                state.pids.insert(pid.clone(), clamped);
            },
        )
        .await
    }

    /// Sets the preset's PIDs in its order and records it as the last preset. If a command
    /// fails, the PIDs the device acknowledged stay set and the last preset is unchanged.
    #[tracing::instrument(name = "EmulatorSession.applyPreset", skip_all, fields(preset = %preset.id))]
    pub async fn apply_preset(&self, preset: &Preset) -> Result<(), EmulatorOperationError> {
        let _permit = self.inner.lock.lock().await;
        let values: Vec<(PidId, f64)> = preset
            .pids
            .iter()
            .map(|(pid, value)| (pid.clone(), clamp_for(pid, *value)))
            .collect();
        if let Some(client) = self.inner.client() {
            for (sent, (pid, value)) in values.iter().enumerate() {
                if let Err(error) = client.command(&pid_command(pid, *value)).await {
                    self.inner.update(|state| set_pids(state, &values[..sent]));
                    return Err(error.into());
                }
            }
        }
        self.inner.update(|state| {
            set_pids(state, &values);
            state.last_preset = Some(PresetRef {
                id: preset.id.clone(),
                name: preset.name.clone(),
            });
        });
        Ok(())
    }

    #[tracing::instrument(name = "EmulatorSession.setDtcs", skip_all)]
    pub async fn set_dtcs(
        &self,
        mode: DtcMode,
        codes: Vec<DtcCode>,
    ) -> Result<(), EmulatorOperationError> {
        let _permit = self.inner.lock.lock().await;
        let commands = |current: &EmulatorState| {
            let mut next = current.dtcs.clone();
            *next.get_mut(mode) = codes.clone();
            if !codes.is_empty() {
                return vec![
                    at::set_dtcs(mode, &codes),
                    monitor_status_command(&current.readiness, &next),
                ];
            }
            // The firmware can only clear every mode at once, so restore the others after.
            let mut commands = vec![at::CLEAR_DTCS.to_owned()];
            for &other in DtcMode::ALL {
                let kept = current.dtcs.get(other);
                if other != mode && !kept.is_empty() {
                    commands.push(at::set_dtcs(other, kept));
                }
            }
            commands.push(monitor_status_command(&current.readiness, &next));
            commands
        };
        let next = |state: &mut EmulatorState| *state.dtcs.get_mut(mode) = codes.clone();
        self.apply(commands, next).await
    }

    #[tracing::instrument(name = "EmulatorSession.clearDtcs", skip_all)]
    pub async fn clear_dtcs(&self) -> Result<(), EmulatorOperationError> {
        let _permit = self.inner.lock.lock().await;
        self.apply(
            |current| {
                let mut next = current.clone();
                clear(&mut next);
                let mut commands = vec![at::CLEAR_DTCS.to_owned()];
                commands.extend(PIDS_RESET_BY_CLEAR.iter().map(|pid| pid_command(pid, 0.0)));
                commands.push(monitor_status_command(&next.readiness, &next.dtcs));
                commands
            },
            clear,
        )
        .await
    }

    #[tracing::instrument(name = "EmulatorSession.setReadiness", skip_all)]
    pub async fn set_readiness(
        &self,
        monitor: ReadinessMonitorId,
        monitor_state: ReadinessMonitor,
    ) -> Result<(), EmulatorOperationError> {
        let _permit = self.inner.lock.lock().await;
        self.apply(
            |current| {
                let mut readiness = current.readiness;
                *readiness.get_mut(monitor) = monitor_state;
                vec![monitor_status_command(&readiness, &current.dtcs)]
            },
            |state| *state.readiness.get_mut(monitor) = monitor_state,
        )
        .await
    }

    #[tracing::instrument(name = "EmulatorSession.sendRaw", skip_all)]
    pub async fn send_raw(&self, command: &str) -> Result<Vec<String>, EmulatorOperationError> {
        let _permit = self.inner.lock.lock().await;
        let client = self.inner.client().ok_or(EmulatorNotConnectedError {})?;
        Ok(client.raw(command).await?)
    }
}

#[cfg(test)]
mod tests {
    use fme_core::contracts::emulator::{TrafficDirection, TrafficEntry};
    use fme_core::contracts::presets::PresetId;

    use super::*;
    use crate::device::serial_ports::Platform;
    use crate::device::serial_ports::fake::FakeSystem;
    use crate::device::simulated_device::{SimulatedFirmware, SimulatedVersion, simulated_banner};

    struct Fixture {
        session: EmulatorSession,
        simulated: SimulatedDevice,
        traffic: TrafficLog,
    }

    // Most cases pin V1.2, which refuses CALID and Mode 07/0A codes; V1.3 has its own case.
    fn on(version: SimulatedVersion) -> Fixture {
        let simulated = SimulatedDevice::new(version);
        let traffic = TrafficLog::new();
        let session =
            EmulatorSession::new(SerialPorts::default(), simulated.clone(), traffic.clone());
        Fixture {
            session,
            simulated,
            traffic,
        }
    }

    async fn connected() -> Fixture {
        let fixture = on(SimulatedVersion::V1_2);
        fixture
            .session
            .connect(ConnectTarget::Simulated)
            .await
            .unwrap();
        fixture
    }

    impl Fixture {
        fn state(&self) -> EmulatorState {
            self.session.state().borrow().clone()
        }

        fn firmware(&self, command: &str) -> String {
            self.simulated.lock().firmware.handle(command)
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

    fn test_preset(pids: &[(&str, f64)]) -> Preset {
        Preset {
            id: PresetId::new("user:test-drive").unwrap(),
            name: "Test drive".to_owned(),
            built_in: false,
            pids: pids.iter().map(|(id, value)| (pid(id), *value)).collect(),
        }
    }

    fn test_drive() -> Option<PresetRef> {
        Some(PresetRef {
            id: PresetId::new("user:test-drive").unwrap(),
            name: "Test drive".to_owned(),
        })
    }

    #[tokio::test(start_paused = true)]
    async fn pushes_the_stored_state_on_connect_and_reports_the_device() {
        let fixture = on(SimulatedVersion::V1_2);
        let session = &fixture.session;
        session.set_pid(&pid("010C"), 3000.0).await.unwrap();
        session.set_ignition(false).await.unwrap();
        session.connect(ConnectTarget::Simulated).await.unwrap();

        let state = fixture.state();
        let Connection::Connected { device, unsent, .. } = &state.connection else {
            panic!("not connected: {:?}", state.connection);
        };
        assert_eq!(
            device.as_ref().map(|device| device.banner.clone()),
            Some(simulated_banner(SimulatedVersion::V1_2))
        );
        assert!(unsent.is_empty());
        // V1.2 rejects pending/permanent codes and CALID; the probe must leave no codes behind.
        assert_eq!(
            state.capabilities,
            Some(DeviceCapabilities {
                dtc_modes: vec![DtcMode::Stored],
                calibration_id: false,
            })
        );
        assert!(fixture.simulated.lock().firmware.stored_dtcs.is_empty());
        assert_eq!(state.vin.as_deref(), Some("1HGCD5654VA061985"));
        assert_eq!(state.calibration_id, None);
        assert!(!fixture.simulated.lock().firmware.ignition);
        assert_eq!(fixture.firmware("ATGET 010C"), "010C=2E E0 \r");
        assert_eq!(fixture.firmware("ATGET 0101"), "0101=00 07 FF 00 \r");
    }

    #[tokio::test(start_paused = true)]
    async fn sends_pid_changes_as_raw_sae_bytes_clamped_to_range() {
        let fixture = connected().await;
        let session = &fixture.session;
        session.set_pid(&pid("0111"), 100.0).await.unwrap();
        session.set_pid(&pid("010E"), -20.0).await.unwrap();
        session.set_pid(&pid("010D"), 999.0).await.unwrap();
        assert_eq!(fixture.firmware("ATGET 0111"), "0111=FF \r");
        assert_eq!(fixture.firmware("ATGET 010E"), "010E=58 \r");
        assert_eq!(fixture.state().pids.get("010D"), Some(&255.0));
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_the_mil_and_stored_code_count_in_step_with_mode_03() {
        let fixture = connected().await;
        let session = &fixture.session;
        session
            .set_dtcs(DtcMode::Stored, codes(&["P0105", "P0300"]))
            .await
            .unwrap();
        assert_eq!(
            fixture.simulated.lock().firmware.stored_dtcs,
            ["P0105", "P0300"]
        );
        assert_eq!(fixture.firmware("ATGET 0101"), "0101=82 07 FF 00 \r");
        session.set_dtcs(DtcMode::Stored, Vec::new()).await.unwrap();
        assert!(fixture.simulated.lock().firmware.stored_dtcs.is_empty());
        assert_eq!(fixture.firmware("ATGET 0101"), "0101=00 07 FF 00 \r");
    }

    #[tokio::test(start_paused = true)]
    async fn surfaces_commands_the_firmware_rejects_without_changing_state() {
        let fixture = connected().await;
        let error = fixture
            .session
            .set_dtcs(DtcMode::Pending, codes(&["P0300"]))
            .await
            .unwrap_err();
        let EmulatorOperationError::Command(error) = error else {
            panic!("unexpected {error:?}");
        };
        assert_eq!(error.reason, EmulatorCommandReason::Rejected);
        assert!(fixture.state().dtcs.pending.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn clears_codes_and_the_counters_a_scan_tools_mode_04_resets() {
        let fixture = connected().await;
        let session = &fixture.session;
        session
            .set_dtcs(DtcMode::Stored, codes(&["P0420"]))
            .await
            .unwrap();
        session.set_pid(&pid("0121"), 120.0).await.unwrap();
        session.set_pid(&pid("0131"), 500.0).await.unwrap();
        session.clear_dtcs().await.unwrap();
        let state = fixture.state();
        assert!(state.dtcs.stored.is_empty());
        assert_eq!(state.pids.get("0121"), Some(&0.0));
        assert_eq!(state.pids.get("0131"), Some(&0.0));
        assert_eq!(fixture.firmware("ATGET 0131"), "0131=00 00 \r");
    }

    #[tokio::test(start_paused = true)]
    async fn passes_raw_console_commands_through() {
        let fixture = connected().await;
        let session = &fixture.session;
        assert_eq!(session.send_raw("ATACC1").await.unwrap(), ["OK"]);
        assert_eq!(
            session.send_raw("ATGET 0120").await.unwrap(),
            ["0120=FF FF FF FF"]
        );
        let reset = session.send_raw("ATR").await.unwrap();
        assert_eq!(reset[0], "System Restarting...");
    }

    #[tokio::test(start_paused = true)]
    async fn stops_talking_to_the_device_after_disconnect() {
        let fixture = connected().await;
        fixture.session.disconnect().await;
        assert_eq!(fixture.state().connection, Connection::Disconnected);
        let error = fixture.session.send_raw("ATZ").await.unwrap_err();
        assert!(matches!(error, EmulatorOperationError::NotConnected(_)));
    }

    #[tokio::test(start_paused = true)]
    async fn goes_back_to_disconnected_when_a_connect_is_abandoned_halfway() {
        let fixture = connected().await;
        let mut state = fixture.session.state();
        // The connect's first poll leaves it waiting on the device; then the caller gives up.
        tokio::select! {
            biased;
            _ = fixture.session.connect(ConnectTarget::Simulated) => panic!("connected at once"),
            () = std::future::ready(()) => {}
        }
        assert!(matches!(
            state.borrow_and_update().connection,
            Connection::Disconnected
        ));
        fixture
            .session
            .connect(ConnectTarget::Simulated)
            .await
            .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn reports_staged_edits_the_firmware_cant_take_and_keeps_its_capabilities() {
        let fixture = on(SimulatedVersion::V1_2);
        let session = &fixture.session;
        assert_eq!(fixture.state().capabilities, None);
        session
            .set_dtcs(DtcMode::Stored, codes(&["P0300"]))
            .await
            .unwrap();
        session
            .set_dtcs(DtcMode::Pending, codes(&["P0420"]))
            .await
            .unwrap();
        session
            .set_dtcs(DtcMode::Permanent, codes(&["P0171", "P0174"]))
            .await
            .unwrap();
        session
            .set_calibration_id(&CalibrationId::new("CAL-1234").unwrap())
            .await
            .unwrap();
        session.connect(ConnectTarget::Simulated).await.unwrap();

        let state = fixture.state();
        let Connection::Connected { unsent, .. } = &state.connection else {
            panic!("not connected: {:?}", state.connection);
        };
        assert_eq!(
            unsent,
            &[
                UnsentEdit::Dtcs {
                    mode: DtcMode::Pending,
                    codes: codes(&["P0420"]),
                },
                UnsentEdit::Dtcs {
                    mode: DtcMode::Permanent,
                    codes: codes(&["P0171", "P0174"]),
                },
                UnsentEdit::CalibrationId {
                    calibration_id: "CAL-1234".to_owned(),
                },
            ]
        );
        assert_eq!(
            state.dtcs,
            Dtcs {
                stored: codes(&["P0300"]),
                ..Dtcs::default()
            }
        );
        assert_eq!(state.calibration_id, None);
        assert_eq!(fixture.simulated.lock().firmware.stored_dtcs, ["P0300"]);

        session.disconnect().await;
        assert_eq!(
            fixture.state().capabilities,
            Some(DeviceCapabilities {
                dtc_modes: vec![DtcMode::Stored],
                calibration_id: false,
            })
        );
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_the_vin_the_device_took_when_it_cant_read_the_vin_back() {
        let fixture = on(SimulatedVersion::V1_2);
        fixture.simulated.lock().firmware.reject_command = Some("ATGET VIN".to_owned());
        let vin = Vin::new("WVWZZZ1JZXW000001").unwrap();
        fixture.session.set_vin(&vin).await.unwrap();
        fixture
            .session
            .connect(ConnectTarget::Simulated)
            .await
            .unwrap();
        assert_eq!(fixture.simulated.lock().firmware.vin, "WVWZZZ1JZXW000001");
        assert_eq!(fixture.state().vin.as_deref(), Some("WVWZZZ1JZXW000001"));
    }

    #[tokio::test(start_paused = true)]
    async fn sends_staged_pending_permanent_and_calibration_edits_v1_3_takes() {
        let fixture = on(SimulatedVersion::V1_3);
        let session = &fixture.session;
        session
            .set_dtcs(DtcMode::Pending, codes(&["P0420"]))
            .await
            .unwrap();
        session
            .set_dtcs(DtcMode::Permanent, codes(&["P0171"]))
            .await
            .unwrap();
        session
            .set_calibration_id(&CalibrationId::new("CAL-1234").unwrap())
            .await
            .unwrap();
        session.connect(ConnectTarget::Simulated).await.unwrap();

        let state = fixture.state();
        let Connection::Connected { unsent, .. } = &state.connection else {
            panic!("not connected: {:?}", state.connection);
        };
        assert!(unsent.is_empty());
        assert_eq!(
            state.capabilities,
            Some(DeviceCapabilities {
                dtc_modes: DtcMode::ALL.to_vec(),
                calibration_id: true,
            })
        );
        let firmware = &fixture.simulated.lock().firmware;
        assert_eq!(firmware.pending_dtcs, ["P0420"]);
        assert_eq!(firmware.permanent_dtcs, ["P0171"]);
        assert_eq!(state.calibration_id.as_deref(), Some("CAL-1234"));
    }

    async fn sent_until(traffic: &TrafficLog, last: &str) -> Vec<TrafficEntry> {
        let mut stream = traffic.subscribe();
        let mut sent = Vec::new();
        while let Some(entry) = stream.next().await {
            let done = entry.text == last;
            if entry.direction == TrafficDirection::Tx && entry.text.starts_with("ATSET") {
                sent.push(entry);
            }
            if done {
                break;
            }
        }
        sent
    }

    #[tokio::test(start_paused = true)]
    async fn sends_the_presets_pids_in_order_and_keeps_it_as_the_last_preset_after_edits() {
        let fixture = connected().await;
        let session = &fixture.session;
        session
            .apply_preset(&test_preset(&[("010C", 3100.0), ("010D", 88.0)]))
            .await
            .unwrap();

        let sent = sent_until(&fixture.traffic, "ATSET 010D=0x58").await;
        let texts: Vec<&str> = sent.iter().map(|entry| entry.text.as_str()).collect();
        assert_eq!(
            texts[texts.len() - 2..],
            ["ATSET 010C=0x30,0x70", "ATSET 010D=0x58"]
        );
        assert_eq!(fixture.state().last_preset, test_drive());

        session.set_pid(&pid("010C"), 2000.0).await.unwrap();
        let edited = fixture.state();
        assert_eq!(edited.pids.get("010C"), Some(&2000.0));
        assert_eq!(edited.last_preset, test_drive());
    }

    #[tokio::test(start_paused = true)]
    async fn stages_the_preset_while_disconnected_and_pushes_it_on_connect() {
        let fixture = on(SimulatedVersion::V1_2);
        let session = &fixture.session;
        session
            .apply_preset(&test_preset(&[("010C", 3100.0), ("0110", 99.8)]))
            .await
            .unwrap();
        let staged = fixture.state();
        assert_eq!(staged.connection, Connection::Disconnected);
        assert_eq!(staged.pids.get("010C"), Some(&3100.0));
        assert_eq!(staged.last_preset, test_drive());
        assert!(!fixture.simulated.lock().firmware.pids.contains_key("010C"));

        session.connect(ConnectTarget::Simulated).await.unwrap();
        assert_eq!(fixture.firmware("ATGET 010C"), "010C=30 70 \r");
        assert_eq!(fixture.firmware("ATGET 0110"), "0110=26 FC \r");
        assert_eq!(fixture.state().last_preset, test_drive());
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_the_pids_the_device_took_when_a_later_one_is_rejected() {
        let fixture = connected().await;
        // The firmware rejects negative decimal values, which uncatalogued PIDs are sent as.
        let error = fixture
            .session
            .apply_preset(&test_preset(&[
                ("010C", 3100.0),
                ("01FF", -5.0),
                ("010D", 88.0),
            ]))
            .await
            .unwrap_err();
        let EmulatorOperationError::Command(error) = error else {
            panic!("unexpected {error:?}");
        };
        assert_eq!(error.reason, EmulatorCommandReason::Rejected);
        let state = fixture.state();
        assert_eq!(state.pids.get("010C"), Some(&3100.0));
        assert_eq!(state.pids.get("010D"), Some(&50.0));
        assert_eq!(state.last_preset, None);
    }

    const PORT: &str = "/dev/cu.usbserial-1";

    /// A session on a fake serial port that the simulated firmware answers.
    fn on_a_fake_port() -> (EmulatorSession, FakeSystem) {
        let firmware = Mutex::new(SimulatedFirmware::new(SimulatedVersion::V1_2));
        let system = FakeSystem::new(false, move |written| {
            let mut firmware = firmware.lock().unwrap();
            Some(firmware.handle(written.trim_end_matches('\r')))
        });
        let session = EmulatorSession::new(
            SerialPorts::with_system(Platform::MacOs, system.clone()),
            SimulatedDevice::default(),
            TrafficLog::new(),
        );
        (session, system)
    }

    fn port() -> ConnectTarget {
        ConnectTarget::Serial {
            path: PORT.to_owned(),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn fails_the_connect_when_the_link_is_lost_at_any_step() {
        for step in ["ATZ\r", "ATSET DTC7=P0000\r", "ATGET CALID\r"] {
            let (session, system) = on_a_fake_port();
            system.fail_read_on(step);
            let started = tokio::time::Instant::now();
            let error = session.connect(port()).await.unwrap_err();
            assert_eq!(error.reason, EmulatorConnectReason::LinkLost, "{step}");
            assert!(started.elapsed() < Duration::from_secs(1), "{step}");
            let state = session.state().borrow().clone();
            assert!(
                matches!(state.connection, Connection::Failed { .. }),
                "{step}: {:?}",
                state.connection
            );
            assert_eq!(system.events(), ["open", "close"], "{step}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn leaves_a_newer_connection_alone_when_an_older_link_is_lost() {
        let (session, system) = on_a_fake_port();
        session.connect(port()).await.unwrap();
        let held = system.hold_close();
        system.fail_read();
        held.entered.await.unwrap();
        // The lost connection is still closing when the user connects to another device.
        let old_one_closes = async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            held.release.send(()).unwrap();
        };
        let (connected, ()) =
            tokio::join!(session.connect(ConnectTarget::Simulated), old_one_closes);
        connected.unwrap();
        session.send_raw("ATGET VIN").await.unwrap();
        let state = session.state().borrow().clone();
        assert!(
            matches!(
                state.connection,
                Connection::Connected {
                    target: ConnectTarget::Simulated,
                    ..
                }
            ),
            "{:?}",
            state.connection
        );
    }
}
