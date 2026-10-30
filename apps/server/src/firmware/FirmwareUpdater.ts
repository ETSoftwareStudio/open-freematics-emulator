import {
  FirmwareImageError,
  FirmwareUpdateError,
  type ConnectTarget,
  type FirmwareImageSummary,
  type FirmwareUpdateInput,
  type FirmwareUpdateStage,
  type FirmwareUpdateState,
} from "@fme/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { DeviceLink } from "../device/DeviceLink.ts";
import * as SerialPorts from "../device/SerialPorts.ts";
import * as SimulatedDevice from "../device/SimulatedDevice.ts";
import * as EmulatorSession from "../emulator/EmulatorSession.ts";
import * as TrafficLog from "../traffic/TrafficLog.ts";
import {
  BootloaderCommand,
  decodeReplyFrame,
  encodeCommandFrame,
  PROBE_FRAME,
  wireKeyFingerprint,
  type ReplyFrame,
} from "./bootloaderFrame.ts";
import {
  APPLICATION_BASE,
  erasePayload,
  finalizerCrc,
  finalizerPayload,
  planFlash,
  runPayload,
  writePayload,
} from "./flashPlan.ts";
import { parseIntelHex, type FirmwareImage } from "./intelHex.ts";

/** SHA-256 of the vendor bootloader's wire key. The key itself is never in this repository. */
const VENDOR_WIRE_KEY_SHA256 = "2d892f5f5ff0f613b75d1feea642910b064e7f35a5e616264dc039c90a082243";

// The vendor updater's waits, except the erase: it allows 3 s, and waiting longer is harmless.
export const RESTART_DELAY = Duration.seconds(1);
export const HANDSHAKE_TIMEOUT = Duration.seconds(1);
export const HANDSHAKE_ATTEMPTS = 5;
export const REPLY_TIMEOUT = Duration.seconds(2);
const FINISH_TIMEOUT = Duration.seconds(1);
export const ERASE_TIMEOUT = Duration.seconds(10);
const WRITE_TIMEOUT = Duration.seconds(5);
export const RUN_SETTLE = Duration.millis(200);

export class FirmwareUpdater extends Context.Service<
  FirmwareUpdater,
  {
    /** Current state first, then every change. */
    readonly state: Stream.Stream<FirmwareUpdateState>;
    readonly inspect: (image: string) => Effect.Effect<FirmwareImageSummary, FirmwareImageError>;
    /**
     * Disconnects the session and flashes the image through the bootloader. Once started, the
     * update runs to the end even if the caller goes away; `state` reports its progress.
     */
    readonly update: (
      input: FirmwareUpdateInput,
    ) => Effect.Effect<void, FirmwareImageError | FirmwareUpdateError>;
  }
>()("@fme/server/firmware/FirmwareUpdater") {}

interface BootloaderConnection {
  readonly send: (
    data: string | Uint8Array,
    note: string,
  ) => Effect.Effect<void, FirmwareUpdateError>;
  /** False when the text doesn't arrive in time. */
  readonly awaitText: (
    text: string,
    timeout: Duration.Duration,
  ) => Effect.Effect<boolean, FirmwareUpdateError>;
  /** Sends a command and returns the first reply. */
  readonly request: (
    command: number,
    payload: Uint8Array,
    timeout: Duration.Duration,
  ) => Effect.Effect<ReplyFrame, FirmwareUpdateError>;
  /** Sends a command and waits for its acknowledgement, skipping other frames as the vendor does. */
  readonly command: (
    command: number,
    payload: Uint8Array,
    timeout: Duration.Duration,
  ) => Effect.Effect<void, FirmwareUpdateError>;
  /** Sends a command that gets no reply. */
  readonly post: (command: number, payload: Uint8Array) => Effect.Effect<void, FirmwareUpdateError>;
}

const linkError = () => new FirmwareUpdateError({ reason: "link" });

const readImage = (text: string): Effect.Effect<FirmwareImage, FirmwareImageError> => {
  const parsed = parseIntelHex(text);
  if (Result.isFailure(parsed)) {
    return Effect.fail(new FirmwareImageError({ reason: "unreadable", line: parsed.failure.line }));
  }
  return parsed.success.segments[0]?.address === APPLICATION_BASE
    ? Effect.succeed(parsed.success)
    : Effect.fail(new FirmwareImageError({ reason: "outsideApplication", line: null }));
};

const imageBytes = (image: FirmwareImage) =>
  image.segments.reduce((sum, segment) => sum + segment.data.length, 0);

const commandName = (command: number) =>
  Object.entries(BootloaderCommand).find(([, value]) => value === command)?.[0] ??
  `0x${command.toString(16)}`;

const describeRequest = (command: number, payload: Uint8Array) => {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (command === BootloaderCommand.write) {
    return `bootloader write 0x${view.getUint32(0).toString(16)} (${payload.length - 6} bytes)`;
  }
  if (command === BootloaderCommand.erase) {
    return `bootloader erase 0x${view.getUint32(0).toString(16)} (${view.getUint16(4)} pages)`;
  }
  return `bootloader ${commandName(command)}`;
};

const describeReply = ({ command, payload }: ReplyFrame) =>
  `bootloader reply ${commandName(command)} (${payload.length} bytes)`;

const expectReply = (reply: ReplyFrame, command: number, minLength = 0) =>
  reply.command === command && reply.payload.length >= minLength
    ? Effect.succeed(reply.payload)
    : Effect.fail(new FirmwareUpdateError({ reason: "unexpectedReply" }));

export interface FirmwareUpdaterOptions {
  /** Whether a real serial port may be flashed. */
  readonly realHardware: boolean;
}

const make = Effect.fnUntraced(function* (options: FirmwareUpdaterOptions) {
  const serialPorts = yield* SerialPorts.SerialPorts;
  const simulated = yield* SimulatedDevice.SimulatedDevice;
  const session = yield* EmulatorSession.EmulatorSession;
  const traffic = yield* TrafficLog.TrafficLog;
  const serviceScope = yield* Effect.scope;
  const state = yield* SubscriptionRef.make<FirmwareUpdateState>({ _tag: "idle" });
  const lock = yield* Semaphore.make(1);

  const record = (direction: "tx" | "rx", text: string) =>
    traffic.record("emulator", direction, text);

  const openLink = (target: ConnectTarget) =>
    (target._tag === "simulated" ? simulated.open : serialPorts.open(target.path)).pipe(
      Effect.mapError(linkError),
    );

  const write = (link: DeviceLink, data: string | Uint8Array, note: string) =>
    Effect.andThen(record("tx", note), link.write(data).pipe(Effect.mapError(linkError)));

  /** Opens the port and reads its bytes for the life of the scope. */
  const connect = Effect.fn("FirmwareUpdater.connect")(function* (
    target: ConnectTarget,
    wireKey: Uint8Array,
  ) {
    const link = yield* openLink(target);
    const incoming = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    yield* link.chunks.pipe(
      Stream.runForEach((chunk) => Queue.offer(incoming, Buffer.from(chunk, "latin1"))),
      Effect.ignore,
      Effect.ensuring(Queue.end(incoming)),
      Effect.forkScoped,
    );
    let pending: Array<number> = [];
    const pull = Queue.take(incoming).pipe(
      Effect.map((chunk) => {
        pending.push(...chunk);
      }),
      Effect.mapError(linkError),
    );

    const awaitText = Effect.fn("FirmwareUpdater.awaitText")(
      function* (text: string, _timeout: Duration.Duration) {
        while (true) {
          const at = Buffer.from(pending).toString("latin1").indexOf(text);
          if (at >= 0) {
            pending = pending.slice(at + text.length);
            return true;
          }
          yield* pull;
        }
      },
      (effect, text, timeout) =>
        effect.pipe(
          Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.succeed(false) }),
          Effect.tap((arrived) => (arrived ? record("rx", text) : Effect.void)),
        ),
    );

    // Garbled frames are dropped, as the vendor's reader does; the caller's timeout still applies.
    const nextReply: Effect.Effect<ReplyFrame, FirmwareUpdateError> = Effect.gen(function* () {
      while (true) {
        const start = pending.indexOf(0xbb);
        pending = start < 0 ? [] : pending.slice(start);
        const end = pending.indexOf(0xee);
        if (end < 0) {
          yield* pull;
          continue;
        }
        const frame = Uint8Array.from(pending.slice(0, end + 1));
        pending = pending.slice(end + 1);
        const decoded = decodeReplyFrame(frame);
        if (Result.isFailure(decoded)) {
          const shown = Buffer.from(frame.subarray(0, 32)).toString("hex");
          yield* record("rx", `bootloader unreadable frame ${shown}`);
          continue;
        }
        const reply = decoded.success;
        yield* record("rx", describeReply(reply));
        if (reply.command === BootloaderCommand.error) {
          return yield* new FirmwareUpdateError({ reason: "rejected" });
        }
        return reply;
      }
    });

    const within = <A>(effect: Effect.Effect<A, FirmwareUpdateError>, timeout: Duration.Duration) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new FirmwareUpdateError({ reason: "noReply" })),
        }),
      );

    const post = Effect.fn("FirmwareUpdater.post")(function* (
      command: number,
      payload: Uint8Array,
    ) {
      pending = [];
      yield* write(
        link,
        encodeCommandFrame(command, payload, wireKey),
        describeRequest(command, payload),
      );
    });

    const request = Effect.fn("FirmwareUpdater.request")(function* (
      command: number,
      payload: Uint8Array,
      timeout: Duration.Duration,
    ) {
      yield* post(command, payload);
      return yield* within(nextReply, timeout);
    });

    const command = Effect.fn("FirmwareUpdater.command")(function* (
      command: number,
      payload: Uint8Array,
      timeout: Duration.Duration,
    ) {
      yield* post(command, payload);
      yield* within(
        Effect.gen(function* () {
          while (true) {
            const reply = yield* nextReply;
            if (reply.command === BootloaderCommand.ack && reply.payload[0] === 0) return;
          }
        }),
        timeout,
      );
    });

    return {
      send: (data, note) => write(link, data, note),
      awaitText,
      request,
      command,
      post,
    } satisfies BootloaderConnection;
  });

  /** The vendor updater probes, closes and reopens the port, then sends `***` for `>>>`. */
  const handshake = Effect.fn("FirmwareUpdater.handshake")(function* (
    target: ConnectTarget,
    wireKey: Uint8Array,
  ) {
    const jobScope = yield* Effect.scope;
    for (let attempt = 1; attempt <= HANDSHAKE_ATTEMPTS; attempt++) {
      yield* Effect.scoped(
        Effect.flatMap(openLink(target), (link) => write(link, PROBE_FRAME, "bootloader probe")),
      );
      const attemptScope = yield* Scope.fork(jobScope);
      const connection = yield* connect(target, wireKey).pipe(Scope.provide(attemptScope));
      yield* connection.send("***", "***");
      if (yield* connection.awaitText(">>>", HANDSHAKE_TIMEOUT)) {
        yield* connection.send("Download?", "Download?");
        if (yield* connection.awaitText("OK.", HANDSHAKE_TIMEOUT)) return connection;
      }
      yield* Scope.close(attemptScope, Exit.void);
    }
    return yield* new FirmwareUpdateError({ reason: "noBootloader" });
  });

  const flash = Effect.fn("FirmwareUpdater.flash")(function* (
    target: ConnectTarget,
    image: FirmwareImage,
    wireKey: Uint8Array,
  ) {
    const total = imageBytes(image);
    let stage: FirmwareUpdateStage = "entering";
    let written = 0;
    let applicationErased = false;
    const progress = (next: FirmwareUpdateStage) => {
      stage = next;
      return SubscriptionRef.set(state, { _tag: "running", target, stage, written, total });
    };

    const steps = Effect.gen(function* () {
      yield* progress("entering");
      // As the vendor GUI does before it hands the port to its updater.
      yield* Effect.scoped(Effect.flatMap(openLink(target), (link) => write(link, "ATR\r", "ATR")));
      yield* Effect.sleep(RESTART_DELAY);
      yield* progress("handshake");
      const bootloader = yield* handshake(target, wireKey);

      yield* progress("reading");
      const info = yield* bootloader
        .request(BootloaderCommand.readChipId, new Uint8Array(), REPLY_TIMEOUT)
        .pipe(Effect.flatMap((reply) => expectReply(reply, BootloaderCommand.readChipId, 14)));
      const flashKib = (info[0]! << 8) | info[1]!;
      const chipId = info.slice(2, 14);
      for (const command of [
        BootloaderCommand.readSerial,
        BootloaderCommand.readVersion,
        BootloaderCommand.readBootInfo,
      ]) {
        yield* bootloader
          .request(command, new Uint8Array(), REPLY_TIMEOUT)
          .pipe(Effect.flatMap((reply) => expectReply(reply, command)));
      }
      const plan = planFlash(image, flashKib);
      if (Result.isFailure(plan)) return yield* new FirmwareUpdateError({ reason: "doesNotFit" });

      // Stopping between the erase and the last write leaves no application to boot.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* progress("erasing");
          applicationErased = true;
          yield* bootloader.command(
            BootloaderCommand.erase,
            erasePayload(plan.success.erase),
            ERASE_TIMEOUT,
          );
          yield* progress("writing");
          for (const block of plan.success.writes) {
            yield* bootloader.command(BootloaderCommand.write, writePayload(block), WRITE_TIMEOUT);
            written += block.data.length;
            yield* progress("writing");
          }
          yield* progress("finishing");
          // The vendor updater needs some reply to these two, whatever it says.
          yield* bootloader.request(BootloaderCommand.writeDone, new Uint8Array(), FINISH_TIMEOUT);
          // Its serial-number check: zeros when it has no DevSerialNum.txt, and it ships none.
          yield* bootloader.request(BootloaderCommand.readCheck, new Uint8Array(8), FINISH_TIMEOUT);
          yield* bootloader.command(
            BootloaderCommand.writeCrc,
            finalizerPayload(finalizerCrc(chipId)),
            FINISH_TIMEOUT,
          );
          // A real V1.2 bootloader answers this with a bare `BB 00 EE`, so it's informational.
          const appInfo = yield* bootloader
            .request(BootloaderCommand.readAppInfo, new Uint8Array(), REPLY_TIMEOUT)
            .pipe(Effect.option);
          // The bootloader jumps to the application without answering.
          yield* bootloader.post(BootloaderCommand.run, runPayload(plan.success.runAddress));
          yield* Effect.sleep(RUN_SETTLE);
          if (Option.isNone(appInfo) || appInfo.value.command !== BootloaderCommand.readAppInfo) {
            return null;
          }
          const text = Buffer.from(appInfo.value.payload).toString("latin1");
          return /<VER>([^<]*)<\/VER>/.exec(text)?.[1] ?? null;
        }),
      );
    });

    // Defects too: the state must never be left at "running".
    yield* Effect.scoped(steps).pipe(
      Effect.tap((version) =>
        SubscriptionRef.set(state, { _tag: "succeeded", target, bytes: total, version }),
      ),
      Effect.tapCause((cause) => {
        const error = Cause.findErrorOption(cause);
        return SubscriptionRef.set(state, {
          _tag: "failed",
          target,
          stage,
          reason: Option.isSome(error) ? error.value.message : "The update stopped unexpectedly.",
          applicationErased,
        });
      }),
    );
  });

  const update = Effect.fn("FirmwareUpdater.update")(function* (input: FirmwareUpdateInput) {
    yield* Effect.annotateCurrentSpan("target", input.target._tag);
    const image = yield* readImage(input.image);
    const wireKey = Uint8Array.from(Buffer.from(input.wireKey, "hex"));
    if (input.target._tag === "serial") {
      if (wireKeyFingerprint(wireKey) !== VENDOR_WIRE_KEY_SHA256) {
        return yield* new FirmwareUpdateError({ reason: "wrongKey" });
      }
      if (!options.realHardware) {
        return yield* new FirmwareUpdateError({ reason: "hardwareLocked" });
      }
    }
    const fiber = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        if (!(yield* lock.takeIfAvailable(1))) {
          return yield* new FirmwareUpdateError({ reason: "busy" });
        }
        return yield* Effect.gen(function* () {
          yield* session.disconnect;
          // The simulated unit has no real key; it takes the one this update uses.
          if (input.target._tag === "simulated") simulated.bootloader.wireKey = wireKey;
          yield* flash(input.target, image, wireKey);
        }).pipe(Effect.ensuring(lock.release(1)), Effect.forkIn(serviceScope));
      }),
    );
    yield* Fiber.join(fiber);
  });

  const inspect = Effect.fn("FirmwareUpdater.inspect")(function* (text: string) {
    const image = yield* readImage(text);
    const last = image.segments[image.segments.length - 1]!;
    return {
      start: APPLICATION_BASE,
      end: last.address + last.data.length,
      bytes: imageBytes(image),
    };
  });

  return FirmwareUpdater.of({ state: SubscriptionRef.changes(state), inspect, update });
});

/** Real hardware stays locked until a supervised flash has shown the whole sequence works. */
export const layer = Layer.effect(FirmwareUpdater, make({ realHardware: false }));

export const layerWith = (options: FirmwareUpdaterOptions) =>
  Layer.effect(FirmwareUpdater, make(options));
