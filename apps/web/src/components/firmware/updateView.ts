import type { FirmwareUpdateState } from "@fme/contracts";

/** One update as this window knows it. */
export interface UpdateRun {
  /**
   * The server's update state when this window asked for the update; any other state came from
   * the run. Null for a run found already running, where every state did.
   */
  readonly baseline: FirmwareUpdateState | null;
  /** How this window's update call ended; null while it is pending, or when it made none. */
  readonly outcome: null | { readonly ok: true } | { readonly ok: false; readonly message: string };
}

export type UpdateView =
  | {
      readonly _tag: "progress";
      /** Null until the server reports the run. */
      readonly state: Extract<FirmwareUpdateState, { _tag: "running" }> | null;
    }
  | {
      readonly _tag: "succeeded";
      readonly bytes: number | null;
      readonly version: string | null;
    }
  | { readonly _tag: "failed"; readonly message: string; readonly applicationErased: boolean };

/**
 * What the dialog shows for a run. The streamed state decides: a running update always shows
 * progress, and its end shows the result, whatever became of the call that started it (the
 * socket may have dropped under it). The call's own outcome only counts when the server never
 * started the run, so the state never moved.
 */
export const updateView = (state: FirmwareUpdateState | null, run: UpdateRun): UpdateView => {
  if (state?._tag === "running") return { _tag: "progress", state };
  const live = state !== run.baseline ? state : null;
  if (live?._tag === "succeeded") {
    return { _tag: "succeeded", bytes: live.bytes, version: live.version };
  }
  if (live?._tag === "failed") {
    return { _tag: "failed", message: live.reason, applicationErased: live.applicationErased };
  }
  if (run.outcome === null) return { _tag: "progress", state: null };
  return run.outcome.ok
    ? { _tag: "succeeded", bytes: null, version: null }
    : { _tag: "failed", message: run.outcome.message, applicationErased: false };
};
