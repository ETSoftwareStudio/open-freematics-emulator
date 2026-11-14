import type { ConnectTarget, FirmwareUpdateState } from "@fme/contracts";
import { describe, expect, it } from "vite-plus/test";
import { updateView, type UpdateRun } from "./updateView";

const target: ConnectTarget = { _tag: "simulated" };
const idle: FirmwareUpdateState = { _tag: "idle" };
const running: FirmwareUpdateState = {
  _tag: "running",
  target,
  stage: "writing",
  written: 1024,
  total: 2500,
};
const succeeded: FirmwareUpdateState = { _tag: "succeeded", target, bytes: 2500, version: "1.3" };
const failed: FirmwareUpdateState = {
  _tag: "failed",
  target,
  stage: "writing",
  reason: "The bootloader rejected a command.",
  applicationErased: true,
};

const pending: UpdateRun = { baseline: idle, outcome: null };
const callFailed: UpdateRun = {
  baseline: idle,
  outcome: { ok: false, message: "The socket closed." },
};
/** A run this window didn't start: found running after a reload or from another window. */
const found: UpdateRun = { baseline: null, outcome: null };

describe("updateView", () => {
  it("shows progress while the server reports a running update, whatever the call did", () => {
    for (const run of [pending, callFailed, found]) {
      expect(updateView(running, run)).toEqual({ _tag: "progress", state: running });
    }
  });

  it("waits for the server's first report after the update is asked for", () => {
    expect(updateView(idle, pending)).toEqual({ _tag: "progress", state: null });
    expect(updateView(null, pending)).toEqual({ _tag: "progress", state: null });
  });

  it("takes the result from the streamed state, not from the call", () => {
    for (const run of [pending, callFailed, found]) {
      expect(updateView(succeeded, run)).toEqual({
        _tag: "succeeded",
        bytes: 2500,
        version: "1.3",
      });
      expect(updateView(failed, run)).toEqual({
        _tag: "failed",
        message: "The bootloader rejected a command.",
        applicationErased: true,
      });
    }
  });

  it("shows the call's error when the server refused to start the run", () => {
    const refused = { ok: false, message: "A firmware update is already running." } as const;
    expect(updateView(idle, { baseline: idle, outcome: refused })).toEqual({
      _tag: "failed",
      message: refused.message,
      applicationErased: false,
    });
    // The result of an earlier run is still the server's state; it isn't this run's.
    expect(updateView(failed, { baseline: failed, outcome: refused })).toEqual({
      _tag: "failed",
      message: refused.message,
      applicationErased: false,
    });
    expect(updateView(succeeded, { baseline: succeeded, outcome: null })).toEqual({
      _tag: "progress",
      state: null,
    });
  });
});
