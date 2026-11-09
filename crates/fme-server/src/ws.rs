//! The RPC table: each method decodes its payload and calls one service method, as `ws.ts` does.

use std::sync::Arc;

use effect_rpc::{Cause, Handlers, RpcError, changes};
use fme_core::contracts::emulator::{
    EmulatorOperationError, ReadinessMonitor, SendRawInput, SendRawResult, SetCalibrationIdInput,
    SetDtcsInput, SetPidInput, SetReadinessInput, SetVinInput,
};
use fme_core::contracts::firmware::{
    FirmwareUpdateInput, ImportVendorFilesInput, InspectFirmwareInput,
};
use fme_core::contracts::presets::SavePresetInput;
use fme_core::contracts::reader::PollingSettings;
use fme_core::contracts::rpc::{
    ClearDtcsPayload, ConnectPayload, PresetIdPayload, ReaderConnectPayload, ReaderWatchPayload,
    SetIgnitionPayload, SetProtocolPayload, SetVinEnabledPayload, ws_methods as m,
};
use futures_util::stream;
use serde_json::Value;

use crate::device::serial_ports::SerialPorts;
use crate::emulator::emulator_session::EmulatorSession;
use crate::firmware::FirmwareServices;
use crate::firmware::firmware_updater::UpdateError;
use crate::obd::obd_reader::ObdReader;
use crate::presets::preset_store::PresetStore;
use crate::traffic::traffic_log::TrafficLog;

impl RpcError for UpdateError {
    fn into_cause(self) -> Cause {
        match self {
            Self::Failed(error) => error.into_cause(),
            Self::Defect => Cause::Die(Value::String(self.to_string())),
        }
    }
}

/// The services behind the RPC methods. Cheap to clone.
#[derive(Debug, Clone)]
pub struct Services {
    pub serial_ports: SerialPorts,
    pub session: EmulatorSession,
    pub traffic: TrafficLog,
    pub reader: ObdReader,
    pub presets: Arc<PresetStore>,
    pub firmware: FirmwareServices,
}

pub fn handlers(services: &Services) -> Handlers {
    let Services {
        serial_ports: _,
        session,
        traffic,
        reader,
        presets,
        firmware,
    } = services;
    let mut h = Handlers::new();
    h.unary(m::LIST_PORTS, session, |s, (): ()| async move {
        s.list_ports().await
    })
    .unary(m::CONNECT, session, |s, p: ConnectPayload| async move {
        s.connect(p.target).await
    })
    .infallible(m::DISCONNECT, session, |s, (): ()| async move {
        s.disconnect().await;
    })
    .unary(
        m::SET_IGNITION,
        session,
        |s, p: SetIgnitionPayload| async move { s.set_ignition(p.on).await },
    )
    .unary(
        m::SET_PROTOCOL,
        session,
        |s, p: SetProtocolPayload| async move { s.set_protocol(p.protocol).await },
    )
    .unary(
        m::SET_VIN_ENABLED,
        session,
        |s, p: SetVinEnabledPayload| async move { s.set_vin_enabled(p.enabled).await },
    )
    .unary(m::SET_VIN, session, |s, p: SetVinInput| async move {
        s.set_vin(&p.vin).await
    })
    .unary(
        m::SET_CALIBRATION_ID,
        session,
        |s, p: SetCalibrationIdInput| async move { s.set_calibration_id(&p.calibration_id).await },
    )
    .unary(m::SET_PID, session, |s, p: SetPidInput| async move {
        s.set_pid(&p.pid, p.value).await
    })
    .unary(m::SET_DTCS, session, |s, p: SetDtcsInput| async move {
        s.set_dtcs(p.mode, p.codes).await
    })
    .unary(
        m::CLEAR_DTCS,
        session,
        |s, _: ClearDtcsPayload| async move { s.clear_dtcs().await },
    )
    .unary(
        m::SET_READINESS,
        session,
        |s, p: SetReadinessInput| async move {
            let monitor = ReadinessMonitor {
                supported: p.supported,
                complete: p.complete,
            };
            s.set_readiness(p.monitor, monitor).await
        },
    )
    .unary(m::SEND_RAW, session, |s, p: SendRawInput| async move {
        let lines = s.send_raw(&p.command).await?;
        Ok::<_, EmulatorOperationError>(SendRawResult { lines })
    })
    .stream(m::SUBSCRIBE_STATE, session, |s, (): ()| changes(s.state()))
    .stream(m::SUBSCRIBE_TRAFFIC, traffic, |t, (): ()| {
        stream::unfold(t.subscribe(), |mut entries| async move {
            let mut batch = vec![entries.next().await?];
            batch.extend(std::iter::from_fn(|| entries.try_next()));
            Some((batch, entries))
        })
    })
    .unary(
        m::READER_CONNECT,
        reader,
        |r, p: ReaderConnectPayload| async move { r.connect(p.target).await },
    )
    .infallible(m::READER_DISCONNECT, reader, |r, (): ()| async move {
        r.disconnect().await;
    })
    .infallible(
        m::READER_WATCH,
        reader,
        |r, p: ReaderWatchPayload| async move {
            r.watch(p.pids);
        },
    )
    .unary(m::READER_READ_DTCS, reader, |r, (): ()| async move {
        r.read_dtcs().await
    })
    .unary(m::READER_READ_VIN, reader, |r, (): ()| async move {
        r.read_vin().await
    })
    .unary(m::READER_CLEAR_DTCS, reader, |r, (): ()| async move {
        r.clear_dtcs().await
    })
    .infallible(
        m::READER_SET_POLLING,
        reader,
        |r, p: PollingSettings| async move {
            r.set_polling(p);
        },
    )
    .unary(m::READER_READ_ONCE, reader, |r, (): ()| async move {
        r.read_once().await
    })
    .stream(m::READER_SUBSCRIBE_STATE, reader, |r, (): ()| {
        changes(r.state())
    })
    .stream(m::SUBSCRIBE_PRESETS, presets, |p, (): ()| {
        changes(p.presets())
    })
    .unary(
        m::APPLY_PRESET,
        presets,
        |p, input: PresetIdPayload| async move { p.apply(&input.id).await },
    )
    .unary(
        m::SAVE_PRESET,
        presets,
        |p, input: SavePresetInput| async move { p.save(input).await },
    )
    .unary(
        m::DELETE_PRESET,
        presets,
        |p, input: PresetIdPayload| async move { p.delete(&input.id).await },
    )
    .unary(
        m::INSPECT_FIRMWARE,
        firmware,
        |f, p: InspectFirmwareInput| async move { f.updater.inspect(&p.image) },
    )
    .unary(
        m::UPDATE_FIRMWARE,
        firmware,
        |f, p: FirmwareUpdateInput| async move { f.updater.update(p).await },
    )
    .stream(m::SUBSCRIBE_FIRMWARE_UPDATE, firmware, |f, (): ()| {
        changes(f.updater.state())
    })
    .stream(m::SUBSCRIBE_WIRE_KEY, firmware, |f, (): ()| {
        changes(f.wire_keys.changes())
    })
    .unary(
        m::IMPORT_VENDOR_FILES,
        firmware,
        |f, p: ImportVendorFilesInput| async move { f.library.import_vendor_files(p).await },
    )
    .unary(
        m::DOWNLOAD_VENDOR_FIRMWARE,
        firmware,
        |f, (): ()| async move { f.vendor_package.download().await },
    )
    .stream(m::SUBSCRIBE_FIRMWARE_LIBRARY, firmware, |f, (): ()| {
        changes(f.library.images())
    })
    .unary(m::FORGET_WIRE_KEY, firmware, |f, (): ()| async move {
        f.wire_keys.forget().await
    });
    h
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firmware::vendor_package::ReqwestClient;

    #[tokio::test]
    async fn every_rpc_has_a_handler() {
        let dir = tempfile::tempdir().unwrap();
        let services = Services::new(dir.path(), Arc::new(ReqwestClient::new().unwrap())).await;
        let handlers = handlers(&services);
        let tags = [
            m::LIST_PORTS,
            m::CONNECT,
            m::DISCONNECT,
            m::SET_IGNITION,
            m::SET_PROTOCOL,
            m::SET_VIN_ENABLED,
            m::SET_VIN,
            m::SET_CALIBRATION_ID,
            m::SET_PID,
            m::SET_DTCS,
            m::CLEAR_DTCS,
            m::SET_READINESS,
            m::SEND_RAW,
            m::SUBSCRIBE_STATE,
            m::SUBSCRIBE_TRAFFIC,
            m::READER_CONNECT,
            m::READER_DISCONNECT,
            m::READER_WATCH,
            m::READER_READ_DTCS,
            m::READER_READ_VIN,
            m::READER_CLEAR_DTCS,
            m::READER_SET_POLLING,
            m::READER_READ_ONCE,
            m::READER_SUBSCRIBE_STATE,
            m::SUBSCRIBE_PRESETS,
            m::APPLY_PRESET,
            m::SAVE_PRESET,
            m::DELETE_PRESET,
            m::INSPECT_FIRMWARE,
            m::UPDATE_FIRMWARE,
            m::SUBSCRIBE_FIRMWARE_UPDATE,
            m::SUBSCRIBE_WIRE_KEY,
            m::IMPORT_VENDOR_FILES,
            m::DOWNLOAD_VENDOR_FIRMWARE,
            m::SUBSCRIBE_FIRMWARE_LIBRARY,
            m::FORGET_WIRE_KEY,
        ];
        assert_eq!(handlers.len(), 36);
        for tag in tags {
            assert!(handlers.contains(tag), "{tag}");
        }
    }
}
