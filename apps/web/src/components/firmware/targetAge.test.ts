import type { ConnectTarget, Connection } from "@fme/contracts";
import { describe, expect, it } from "vite-plus/test";
import { targetAge } from "./targetAge";

const port: ConnectTarget = { _tag: "serial", path: "/dev/ttyUSB0" };
const simulated: ConnectTarget = { _tag: "simulated" };

const connected = (target: ConnectTarget, details: string): Connection => ({
  _tag: "connected",
  target,
  device: { banner: "OBD-II EMULATOR V1.2", details },
  unsent: [],
});

const made2017 = "00.00.02,00.01.05,201712,GH201712BN00001,1HGCD5654VA061985";
const made2019 = "00.00.02,00.01.05,201910,GH201910BN00001,1HGCD5654VA061985";

describe("targetAge", () => {
  it("warns about a connected unit made before 2018 and says when it was made", () => {
    expect(targetAge(connected(port, made2017), port)).toEqual({
      warning: "too-old",
      made: "December 2017",
    });
    expect(targetAge(connected(simulated, made2017), simulated).warning).toBe("too-old");
  });

  it("has no warning for a connected unit that is new enough", () => {
    expect(targetAge(connected(port, made2019), port)).toEqual({ warning: null, made: null });
  });

  it("can't read the age of a port that isn't the connected device", () => {
    const unread = { warning: "unknown-age", made: null };
    expect(targetAge({ _tag: "disconnected" }, port)).toEqual(unread);
    expect(targetAge(undefined, port)).toEqual(unread);
    expect(targetAge(connected({ _tag: "serial", path: "/dev/ttyUSB1" }, made2017), port)).toEqual(
      unread,
    );
    expect(targetAge(connected(simulated, made2017), port)).toEqual(unread);
    expect(targetAge(connected(port, "00.00.02,00.01.05"), port)).toEqual(unread);
  });

  it("stays quiet about the simulated device when it isn't connected", () => {
    expect(targetAge({ _tag: "disconnected" }, simulated)).toEqual({ warning: null, made: null });
  });
});
