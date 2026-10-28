import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

export class DeviceLinkError extends Schema.TaggedError<DeviceLinkError>()("DeviceLinkError", {
  operation: Schema.Literals(["open", "read", "write"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Device link ${this.operation} failed.`;
  }
}

/** A byte pipe to an emulator: the USB serial port or the in-memory simulator. */
export interface DeviceLink {
  readonly write: (data: string) => Effect.Effect<void, DeviceLinkError>;
  /** Raw text as it arrives. Single consumer; ends or fails when the link drops. */
  readonly chunks: Stream.Stream<string, DeviceLinkError>;
}
