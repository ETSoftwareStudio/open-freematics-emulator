import { WS_METHODS, WsRpcGroup } from "@fme/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as EmulatorSession from "./emulator/EmulatorSession.ts";
import * as ObdReader from "./obd/ObdReader.ts";
import * as PresetStore from "./presets/PresetStore.ts";
import * as TrafficLog from "./traffic/TrafficLog.ts";

const handlers = WsRpcGroup.toLayer(
  Effect.gen(function* () {
    const session = yield* EmulatorSession.EmulatorSession;
    const traffic = yield* TrafficLog.TrafficLog;
    const reader = yield* ObdReader.ObdReader;
    const presets = yield* PresetStore.PresetStore;
    return WsRpcGroup.of({
      [WS_METHODS.listPorts]: () => session.listPorts,
      [WS_METHODS.connect]: ({ target }) => session.connect(target),
      [WS_METHODS.disconnect]: () => session.disconnect,
      [WS_METHODS.setIgnition]: ({ on }) => session.setIgnition(on),
      [WS_METHODS.setProtocol]: ({ protocol }) => session.setProtocol(protocol),
      [WS_METHODS.setVinEnabled]: ({ enabled }) => session.setVinEnabled(enabled),
      [WS_METHODS.setVin]: ({ vin }) => session.setVin(vin),
      [WS_METHODS.setCalibrationId]: ({ calibrationId }) => session.setCalibrationId(calibrationId),
      [WS_METHODS.setPid]: ({ pid, value }) => session.setPid(pid, value),
      [WS_METHODS.setDtcs]: ({ mode, codes }) => session.setDtcs(mode, codes),
      [WS_METHODS.clearDtcs]: () => session.clearDtcs,
      [WS_METHODS.setReadiness]: ({ monitor, supported, complete }) =>
        session.setReadiness(monitor, { supported, complete }),
      [WS_METHODS.sendRaw]: ({ command }) =>
        session.sendRaw(command).pipe(Effect.map((lines) => ({ lines }))),
      [WS_METHODS.subscribeState]: () => session.state,
      [WS_METHODS.subscribeTraffic]: () => traffic.stream,
      [WS_METHODS.readerConnect]: ({ target }) => reader.connect(target),
      [WS_METHODS.readerDisconnect]: () => reader.disconnect,
      [WS_METHODS.readerWatch]: ({ pids }) => reader.watch(pids),
      [WS_METHODS.readerReadDtcs]: () => reader.readDtcs,
      [WS_METHODS.readerReadVin]: () => reader.readVin,
      [WS_METHODS.readerSubscribeState]: () => reader.state,
      [WS_METHODS.subscribePresets]: () => presets.presets,
      [WS_METHODS.applyPreset]: ({ id }) => presets.apply(id),
      [WS_METHODS.savePreset]: (input) => presets.save(input),
      [WS_METHODS.deletePreset]: ({ id }) => presets.delete(id),
    });
  }),
);

export const layer = RpcServer.layerHttp({
  group: WsRpcGroup,
  path: "/ws",
  protocol: "websocket",
}).pipe(Layer.provide(handlers), Layer.provide(RpcSerialization.layerJson));
