import { WS_METHODS, type TrafficEntry } from "@fme/contracts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Atom from "effect/reactivity/Atom";
import { EmulatorClient } from "./client.ts";

const TRAFFIC_LIMIT = 400;
const resubscribe = Stream.retry(Schedule.spaced("1 second"));

const subscribe = <A, E>(stream: (client: EmulatorClient["Service"]) => Stream.Stream<A, E>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      return stream(yield* EmulatorClient);
    }),
  ).pipe(resubscribe);

export const emulatorStateAtom = EmulatorClient.runtime
  .atom(subscribe((client) => client(WS_METHODS.subscribeState, undefined)))
  .pipe(Atom.keepAlive, Atom.withLabel("emulator:state"));

export const trafficAtom = EmulatorClient.runtime
  .atom(
    // The log restarts with each subscription: the server replays its recent history, and a
    // restarted server numbers entries from 1 again.
    subscribe((client) =>
      client(WS_METHODS.subscribeTraffic, undefined).pipe(
        Stream.scan(
          (): ReadonlyArray<TrafficEntry> => [],
          (log, entry) => [...log.slice(-(TRAFFIC_LIMIT - 1)), entry],
        ),
      ),
    ),
  )
  .pipe(Atom.keepAlive, Atom.withLabel("emulator:traffic"));

export const readerStateAtom = EmulatorClient.runtime
  .atom(subscribe((client) => client(WS_METHODS.readerSubscribeState, undefined)))
  .pipe(Atom.keepAlive, Atom.withLabel("reader:state"));

/** Built-ins first, then user presets; every window sees the same list. */
export const presetsAtom = EmulatorClient.runtime
  .atom(subscribe((client) => client(WS_METHODS.subscribePresets, undefined)))
  .pipe(Atom.keepAlive, Atom.withLabel("presets"));

export const portsAtom = EmulatorClient.query(WS_METHODS.listPorts, undefined, {
  reactivityKeys: ["ports"],
});

export const connectAtom = EmulatorClient.mutation(WS_METHODS.connect);
export const disconnectAtom = EmulatorClient.mutation(WS_METHODS.disconnect);
export const setIgnitionAtom = EmulatorClient.mutation(WS_METHODS.setIgnition);
export const setProtocolAtom = EmulatorClient.mutation(WS_METHODS.setProtocol);
export const setVinEnabledAtom = EmulatorClient.mutation(WS_METHODS.setVinEnabled);
export const setVinAtom = EmulatorClient.mutation(WS_METHODS.setVin);
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
export const applyPresetAtom = EmulatorClient.mutation(WS_METHODS.applyPreset);
export const savePresetAtom = EmulatorClient.mutation(WS_METHODS.savePreset);
export const deletePresetAtom = EmulatorClient.mutation(WS_METHODS.deletePreset);
