import * as Schema from "effect/Schema";
import { PidId } from "./baseSchemas.ts";

/** Built-ins are `builtin:<slug>`; user presets get `user:<uuid>`. */
export const PresetId = Schema.String.check(Schema.isPattern(/^(builtin|user):[a-z0-9-]+$/)).pipe(
  Schema.brand("PresetId"),
);
export type PresetId = typeof PresetId.Type;

export const MAX_PRESET_NAME_LENGTH = 40;

export const PresetName = Schema.Trim.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_PRESET_NAME_LENGTH),
);

/** A preset only sets the PIDs it lists, in its listed order. */
export const PresetPids = Schema.Record(PidId, Schema.Finite);
export type PresetPids = typeof PresetPids.Type;

export const Preset = Schema.Struct({
  id: PresetId,
  name: PresetName,
  builtIn: Schema.Boolean,
  pids: PresetPids,
});
export type Preset = typeof Preset.Type;

/** The last preset applied, as named when it was applied. */
export const PresetRef = Schema.Struct({ id: PresetId, name: Schema.String });
export type PresetRef = typeof PresetRef.Type;

/** Without `id` it creates a user preset; with one it renames and overwrites that preset. */
export const SavePresetInput = Schema.Struct({
  id: Schema.optional(PresetId),
  name: PresetName,
  pids: PresetPids,
});
export type SavePresetInput = typeof SavePresetInput.Type;

export class PresetNotFoundError extends Schema.TaggedError<PresetNotFoundError>()(
  "PresetNotFoundError",
  { id: PresetId },
) {
  override get message(): string {
    return "That preset no longer exists.";
  }
}

export class PresetReadOnlyError extends Schema.TaggedError<PresetReadOnlyError>()(
  "PresetReadOnlyError",
  { id: PresetId, operation: Schema.Literals(["save", "delete"]) },
) {
  override get message(): string {
    return this.operation === "save"
      ? "Built-in presets can't be changed. Save a copy instead."
      : "Built-in presets can't be deleted.";
  }
}

export class PresetPersistError extends Schema.TaggedError<PresetPersistError>()(
  "PresetPersistError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not save presets to disk.";
  }
}

export const PresetChangeError = Schema.Union([
  PresetNotFoundError,
  PresetReadOnlyError,
  PresetPersistError,
]);
export type PresetChangeError = typeof PresetChangeError.Type;
