import {
  FirmwareImageError,
  FirmwareUpdateError,
  type ConnectTarget,
  type FirmwareImageSummary,
  type FirmwareUpdateInput,
  type FirmwareUpdateStage,
  type FirmwareUpdateState,
} from "@fme/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
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

// The vendor updater waits 1 s for `>>>`, 3 s for an erase and 5 s for each write.
export const RESTART_DELAY = Duration.seconds(1);
export const HANDSHAKE_TIMEOUT = Duration.seconds(1);
export const HANDSHAKE_ATTEMPTS = 5;
const REPLY_TIMEOUT = Duration.seconds(2);
export const ERASE_TIMEOUT = Duration.seconds(3);
const WRITE_TIMEOUT = Duration.seconds(5);

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
  readonly exchange: (
    command: number,
    payload: Uint8Array,
    timeout: Duration.Duration,
  ) => Effect.Effect<ReplyFrame, FirmwareUpdateError>;
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

const describe = (command: number, payload: Uint8Array) => {
  const name = Object.entries(BootloaderCommand).find(([, value]) => value === command)?.[0];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (command === BootloaderCommand.write) {
    return `bootloader write 0x${view.getUint32(0).toString(16)} (${payload.length - 6} bytes)`;
  }
  if (command === BootloaderCommand.erase) {
    return `bootloader erase 0x${view.getUint32(0).toString(16)} (${view.getUint16(4)} pages)`;
  }
  return `bootloader ${name ?? command.toString(16)}`;
};

const expectAck = (reply: ReplyFrame) =>
  reply.command === BootloaderCommand.ack && reply.payload[0] === 0
    ? Effect.void
    : Effect.fail(new FirmwareUpdateError({ reason: "unexpectedReply" }));

const expectReply = (reply: ReplyFrame, command: number, minLength = 0) =>
  reply.command === command && reply.payload.length >= minLength
    ? Effect.succeed(reply.payload)
    : Effect.fail(new FirmwareUpdateError({ reason: "unexpectedReply" }));

const make = Effect.gen(function* () {
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

    const readFrame: Effect.Effect<ReplyFrame, FirmwareUpdateError> = Effect.gen(function* () {
      while (true) {
        const start = pending.indexOf(0xbb);
        pending = start < 0 ? [] : pending.slice(start);
        const end = pending.indexOf(0xee);
        if (end > 0) {
          const frame = Uint8Array.from(pending.slice(0, end + 1));
          pending = pending.slice(end + 1);
          const decoded = decodeReplyFrame(frame);
          if (Result.isFailure(decoded)) {
            return yield* new FirmwareUpdateError({ reason: "unexpectedReply" });
          }
          return decoded.success;
        }
        yield* pull;
      }
    });

    const exchange = Effect.fn("FirmwareUpdater.exchange")(function* (
      command: number,
      payload: Uint8Array,
      timeout: Duration.Duration,
    ) {
      pending = [];
      yield* write(link, encodeCommandFrame(command, payload, wireKey), describe(command, payload));
      const reply = yield* readFrame.pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new FirmwareUpdateError({ reason: "noReply" })),
        }),
      );
      yield* record("rx", describe(reply.command, reply.payload));
      if (reply.command === BootloaderCommand.error) {
        return yield* new FirmwareUpdateError({ reason: "rejected" });
      }
      return reply;
    });

    return {
      send: (data, note) => write(link, data, note),
      awaitText,
      exchange,
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
        .exchange(BootloaderCommand.readChipId, new Uint8Array(), REPLY_TIMEOUT)
        .pipe(Effect.flatMap((reply) => expectReply(reply, BootloaderCommand.readChipId, 14)));
      const flashKib = (info[0]! << 8) | info[1]!;
      const chipId = info.slice(2, 14);
      for (const command of [
        BootloaderCommand.readSerial,
        BootloaderCommand.readVersion,
        BootloaderCommand.readBootInfo,
      ]) {
        yield* bootloader
          .exchange(command, new Uint8Array(), REPLY_TIMEOUT)
          .pipe(Effect.flatMap((reply) => expectReply(reply, command)));
      }
      const plan = planFlash(image, flashKib);
      if (Result.isFailure(plan)) return yield* new FirmwareUpdateError({ reason: "doesNotFit" });

      // Stopping between the erase and the last write leaves no application to boot.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* progress("erasing");
          applicationErased = true;
          yield* bootloader
            .exchange(BootloaderCommand.erase, erasePayload(plan.success.erase), ERASE_TIMEOUT)
            .pipe(Effect.flatMap(expectAck));
          yield* progress("writing");
          for (const block of plan.success.writes) {
            yield* bootloader
              .exchange(BootloaderCommand.write, writePayload(block), WRITE_TIMEOUT)
              .pipe(Effect.flatMap(expectAck));
            written += block.data.length;
            yield* progress("writing");
          }
          yield* progress("finishing");
          yield* bootloader
            .exchange(BootloaderCommand.writeDone, new Uint8Array(), REPLY_TIMEOUT)
            .pipe(Effect.flatMap(expectAck));
          yield* bootloader
            .exchange(BootloaderCommand.readCheck, new Uint8Array(8), REPLY_TIMEOUT)
            .pipe(Effect.flatMap((reply) => expectReply(reply, BootloaderCommand.readCheck)));
          yield* bootloader
            .exchange(
              BootloaderCommand.writeCrc,
              finalizerPayload(finalizerCrc(chipId)),
              REPLY_TIMEOUT,
            )
            .pipe(Effect.flatMap(expectAck));
          const appInfo = yield* bootloader
            .exchange(BootloaderCommand.readAppInfo, new Uint8Array(), REPLY_TIMEOUT)
            .pipe(Effect.flatMap((reply) => expectReply(reply, BootloaderCommand.readAppInfo)));
          yield* bootloader
            .exchange(BootloaderCommand.run, runPayload(plan.success.runAddress), REPLY_TIMEOUT)
            .pipe(Effect.flatMap(expectAck));
          return /<VER>([^<]*)<\/VER>/.exec(Buffer.from(appInfo).toString("latin1"))?.[1] ?? null;
        }),
      );
    });

    yield* Effect.scoped(steps).pipe(
      Effect.matchEffect({
        onSuccess: (version) =>
          SubscriptionRef.set(state, { _tag: "succeeded", target, bytes: total, version }),
        onFailure: (error) =>
          Effect.andThen(
            SubscriptionRef.set(state, {
              _tag: "failed",
              target,
              stage,
              reason: error.message,
              applicationErased,
            }),
            Effect.fail(error),
          ),
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
      // Stays locked until the bootloader protocol has been checked, read-only, on a real unit.
      return yield* new FirmwareUpdateError({ reason: "hardwareLocked" });
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

export const layer = Layer.effect(FirmwareUpdater, make);
