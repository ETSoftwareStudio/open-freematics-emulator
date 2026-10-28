import { describe, expect, it } from "vite-plus/test";
import {
  START_ANGLE,
  SWEEP,
  angleToValue,
  arcPath,
  majorTicks,
  valueToAngle,
  zoneAt,
} from "./gaugeGeometry.ts";

const rpm = { min: 0, max: 8000 };

describe("gauge geometry", () => {
  it("maps the range onto the sweep and pegs values outside it", () => {
    expect(valueToAngle(0, rpm)).toBe(START_ANGLE);
    expect(valueToAngle(4000, rpm)).toBe(START_ANGLE + SWEEP / 2);
    expect(valueToAngle(8000, rpm)).toBe(START_ANGLE + SWEEP);
    expect(valueToAngle(9999, rpm)).toBe(START_ANGLE + SWEEP);
    expect(valueToAngle(-40, { min: 40, max: 130 })).toBe(START_ANGLE);
  });

  it("turns a pointer angle back into a value", () => {
    expect(angleToValue(270, rpm)).toBe(4000);
    // atan2 reports the right half of the dial as negative angles.
    expect(angleToValue(-45, rpm)).toBeCloseTo(5333.33, 1);
    expect(angleToValue(45, rpm)).toBe(8000);
  });

  it("snaps the dead zone under the dial to the nearest end", () => {
    expect(angleToValue(100, rpm)).toBe(0);
    expect(angleToValue(80, rpm)).toBe(8000);
  });

  it("draws nothing for an empty arc", () => {
    expect(arcPath(100, 80, 135, 135)).toBe("");
    expect(arcPath(100, 80, 135, 405)).toContain(" 0 1 1 ");
  });

  it("picks round tick steps", () => {
    expect(majorTicks(rpm, 8).ticks).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000]);
    expect(majorTicks({ min: 0, max: 260 }, 8).step).toBe(50);
    expect(majorTicks({ min: 8, max: 16 }, 4).ticks).toEqual([8, 10, 12, 14, 16]);
  });

  it("finds the zone a value sits in", () => {
    const zones = [{ min: 6500, max: 8000, tone: "critical" as const }];
    expect(zoneAt(zones, 7000)).toBe("critical");
    expect(zoneAt(zones, 3000)).toBeUndefined();
  });
});
