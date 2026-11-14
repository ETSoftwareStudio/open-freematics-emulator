import { WS_METHODS, type TrafficEntry } from "@fme/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { EmulatorClient } from "./client.ts";
import { resubscribing } from "./resubscribing.ts";

const TRAFFIC_LIMIT = 400;

/**
 * A subscription that outlives the socket. When the socket drops, the atom goes back to its
 * initial result until the next subscription delivers, so no stale value stays up.
 */
const subscribe = <A, E>(stream: (client: EmulatorClient["Service"]) => Stream.Stream<A, E>) => {
  const source = EmulatorClient.runtime.atom(
    Stream.unwrap(
      Effect.gen(function* () {
        return stream(yield* EmulatorClient);
      }),
    ).pipe(resubscribing),
  );
  return Atom.make((get) =>
    AsyncResult.flatMap(get(source), (value) =>
      Option.isSome(value) ? AsyncResult.success(value.value) : AsyncResult.initial(true),
    ),
  );
};

export const emulatorStateAtom = subscribe((client) =>
  client(WS_METHODS.subscribeState, undefined),
).pipe(Atom.keepAlive, Atom.withLabel("emulator:state"));

// The log restarts with each subscription: the server replays its recent history, and a
// restarted server numbers entries from 1 again.
export const trafficAtom = subscribe((client) =>
  client(WS_METHODS.subscribeTraffic, undefined).pipe(
    Stream.scan(
      (): ReadonlyArray<TrafficEntry> => [],
      (log, entry) => [...log.slice(-(TRAFFIC_LIMIT - 1)), entry],
    ),
  ),
).pipe(Atom.keepAlive, Atom.withLabel("emulator:traffic"));

export const readerStateAtom = subscribe((client) =>
  client(WS_METHODS.readerSubscribeState, undefined),
).pipe(Atom.keepAlive, Atom.withLabel("reader:state"));

/** Built-ins first, then user presets; every window sees the same list. */
export const presetsAtom = subscribe((client) =>
  client(WS_METHODS.subscribePresets, undefined),
).pipe(Atom.keepAlive, Atom.withLabel("presets"));

export const firmwareUpdateAtom = subscribe((client) =>
  client(WS_METHODS.subscribeFirmwareUpdate, undefined),
).pipe(Atom.keepAlive, Atom.withLabel("firmware:update"));

export const wireKeyStatusAtom = subscribe((client) =>
  client(WS_METHODS.subscribeWireKey, undefined),
).pipe(Atom.keepAlive, Atom.withLabel("firmware:wireKey"));

/** Firmware images imported from the user's Freematics folder, newest first. */
export const firmwareLibraryAtom = subscribe((client) =>
  client(WS_METHODS.subscribeFirmwareLibrary, undefined),
).pipe(Atom.keepAlive, Atom.withLabel("firmware:library"));

export const portsAtom = EmulatorClient.query(WS_METHODS.listPorts, undefined, {
  reactivityKeys: ["ports"],
});

export const connectAtom = EmulatorClient.mutation(WS_METHODS.connect);
export const disconnectAtom = EmulatorClient.mutation(WS_METHODS.disconnect);
export const setIgnitionAtom = EmulatorClient.mutation(WS_METHODS.setIgnition);
export const setProtocolAtom = EmulatorClient.mutation(WS_METHODS.setProtocol);
export const setVinEnabledAtom = EmulatorClient.mutation(WS_METHODS.setVinEnabled);
export const setVinAtom = EmulatorClient.mutation(WS_METHODS.setVin);
export const setCalibrationIdAtom = EmulatorClient.mutation(WS_METHODS.setCalibrationId);
// One mutation per PID: a new value cancels that PID's in-flight update, not other PIDs'.
export const setPidAtom = Atom.family((_pid: string) => EmulatorClient.mutation(WS_METHODS.setPid));
export const setDtcsAtom = EmulatorClient.mutation(WS_METHODS.setDtcs);
export const clearDtcsAtom = EmulatorClient.mutation(WS_METHODS.clearDtcs);
export const setReadinessAtom = EmulatorClient.mutation(WS_METHODS.setReadiness);
export const sendRawAtom = EmulatorClient.mutation(WS_METHODS.sendRaw);
export const readerConnectAtom = EmulatorClient.mutation(WS_METHODS.readerConnect);
export const readerDisconnectAtom = EmulatorClient.mutation(WS_METHODS.readerDisconnect);
export const readerWatchAtom = EmulatorClient.mutation(WS_METHODS.readerWatch);
export const readerReadDtcsAtom = EmulatorClient.mutation(WS_METHODS.readerReadDtcs);
export const readerReadVinAtom = EmulatorClient.mutation(WS_METHODS.readerReadVin);
export const readerClearDtcsAtom = EmulatorClient.mutation(WS_METHODS.readerClearDtcs);
export const readerSetPollingAtom = EmulatorClient.mutation(WS_METHODS.readerSetPolling);
export const readerReadOnceAtom = EmulatorClient.mutation(WS_METHODS.readerReadOnce);
export const applyPresetAtom = EmulatorClient.mutation(WS_METHODS.applyPreset);
export const savePresetAtom = EmulatorClient.mutation(WS_METHODS.savePreset);
export const deletePresetAtom = EmulatorClient.mutation(WS_METHODS.deletePreset);
export const inspectFirmwareAtom = EmulatorClient.mutation(WS_METHODS.inspectFirmware);
export const updateFirmwareAtom = EmulatorClient.mutation(WS_METHODS.updateFirmware);
export const importVendorFilesAtom = EmulatorClient.mutation(WS_METHODS.importVendorFiles);
export const downloadVendorFirmwareAtom = EmulatorClient.mutation(
  WS_METHODS.downloadVendorFirmware,
);
export const forgetWireKeyAtom = EmulatorClient.mutation(WS_METHODS.forgetWireKey);
