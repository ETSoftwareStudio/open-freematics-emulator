import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import {
  ConnectTarget,
  EmulatorConnectError,
  EmulatorOperationError,
  EmulatorState,
  ObdProtocol,
  SendRawInput,
  SendRawResult,
  SerialPortInfo,
  SerialPortListError,
  SetCalibrationIdInput,
  SetDtcsInput,
  SetPidInput,
  SetReadinessInput,
  SetVinInput,
  TrafficEntry,
} from "./emulator.ts";
import { PidId } from "./baseSchemas.ts";
import {
  Preset,
  PresetChangeError,
  PresetId,
  PresetNotFoundError,
  SavePresetInput,
} from "./presets.ts";
import { ReaderConnectError, ReaderOperationError, ReaderState, ReaderTarget } from "./reader.ts";

export const WS_METHODS = {
  listPorts: "emulator.listPorts",
  connect: "emulator.connect",
  disconnect: "emulator.disconnect",
  setIgnition: "emulator.setIgnition",
  setProtocol: "emulator.setProtocol",
  setVinEnabled: "emulator.setVinEnabled",
  setVin: "emulator.setVin",
  setCalibrationId: "emulator.setCalibrationId",
  setPid: "emulator.setPid",
  setDtcs: "emulator.setDtcs",
  clearDtcs: "emulator.clearDtcs",
  setReadiness: "emulator.setReadiness",
  sendRaw: "emulator.sendRaw",
  subscribeState: "emulator.subscribeState",
  subscribeTraffic: "emulator.subscribeTraffic",
  readerConnect: "reader.connect",
  readerDisconnect: "reader.disconnect",
  readerWatch: "reader.watch",
  readerReadDtcs: "reader.readDtcs",
  readerReadVin: "reader.readVin",
  readerSubscribeState: "reader.subscribeState",
  subscribePresets: "presets.subscribe",
  applyPreset: "presets.apply",
  savePreset: "presets.save",
  deletePreset: "presets.delete",
} as const;

const operation = <const Tag extends string, P extends Schema.Top>(tag: Tag, payload: P) =>
  Rpc.make(tag, { payload, success: Schema.Void, error: EmulatorOperationError });

export const WsRpcGroup = RpcGroup.make(
  Rpc.make(WS_METHODS.listPorts, {
    success: Schema.Array(SerialPortInfo),
    error: SerialPortListError,
  }),
  Rpc.make(WS_METHODS.connect, {
    payload: Schema.Struct({ target: ConnectTarget }),
    error: EmulatorConnectError,
  }),
  Rpc.make(WS_METHODS.disconnect),
  operation(WS_METHODS.setIgnition, Schema.Struct({ on: Schema.Boolean })),
  operation(WS_METHODS.setProtocol, Schema.Struct({ protocol: ObdProtocol })),
  operation(WS_METHODS.setVinEnabled, Schema.Struct({ enabled: Schema.Boolean })),
  operation(WS_METHODS.setVin, SetVinInput),
  operation(WS_METHODS.setCalibrationId, SetCalibrationIdInput),
  operation(WS_METHODS.setPid, SetPidInput),
  operation(WS_METHODS.setDtcs, SetDtcsInput),
  operation(WS_METHODS.clearDtcs, Schema.Struct({})),
  operation(WS_METHODS.setReadiness, SetReadinessInput),
  Rpc.make(WS_METHODS.sendRaw, {
    payload: SendRawInput,
    success: SendRawResult,
    error: EmulatorOperationError,
  }),
  Rpc.make(WS_METHODS.subscribeState, { success: EmulatorState, stream: true }),
  Rpc.make(WS_METHODS.subscribeTraffic, { success: TrafficEntry, stream: true }),
  Rpc.make(WS_METHODS.readerConnect, {
    payload: Schema.Struct({ target: ReaderTarget }),
    error: ReaderConnectError,
  }),
  Rpc.make(WS_METHODS.readerDisconnect),
  Rpc.make(WS_METHODS.readerWatch, { payload: Schema.Struct({ pids: Schema.Array(PidId) }) }),
  Rpc.make(WS_METHODS.readerReadDtcs, { error: ReaderOperationError }),
  Rpc.make(WS_METHODS.readerReadVin, { error: ReaderOperationError }),
  Rpc.make(WS_METHODS.readerSubscribeState, { success: ReaderState, stream: true }),
  Rpc.make(WS_METHODS.subscribePresets, { success: Schema.Array(Preset), stream: true }),
  Rpc.make(WS_METHODS.applyPreset, {
    payload: Schema.Struct({ id: PresetId }),
    error: Schema.Union([PresetNotFoundError, EmulatorOperationError]),
  }),
  Rpc.make(WS_METHODS.savePreset, {
    payload: SavePresetInput,
    success: Preset,
    error: PresetChangeError,
  }),
  Rpc.make(WS_METHODS.deletePreset, {
    payload: Schema.Struct({ id: PresetId }),
    error: PresetChangeError,
  }),
);
