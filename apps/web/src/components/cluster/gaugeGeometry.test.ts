import { describe, expect, it } from "vite-plus/test";
import {
  START_ANGLE,
  SUB_END_ANGLE,
  SUB_START_ANGLE,
  SWEEP,
  angleToValue,
  arcPath,
  keyedValue,
  majorTicks,
  minorTicks,
  snapToStep,
  subAngleToValue,
  subValueToAngle,
  valueToAngle,
  zoneAt,
} from "./gaugeGeometry.ts";

const rpm = { min: 0, max: 8000 };
const coolant = { min: 40, max: 130 };

describe("gauge geometry", () => {
  it("maps the range onto the sweep and pegs values outside it", () => {
    expect(valueToAngle(0, rpm)).toBe(START_ANGLE);
    expect(valueToAngle(4000, rpm)).toBe(START_ANGLE + SWEEP / 2);
    expect(valueToAngle(8000, rpm)).toBe(START_ANGLE + SWEEP);
    expect(valueToAngle(9999, rpm)).toBe(START_ANGLE + SWEEP);
    expect(valueToAngle(-40, coolant)).toBe(START_ANGLE);
  });

  it("puts the middle of the range at 12 o'clock", () => {
    expect(START_ANGLE + SWEEP / 2).toBe(270);
  });

  it("turns a pointer angle back into a value", () => {
    expect(angleToValue(270, rpm)).toBe(4000);
    // atan2 reports the right half of the dial as negative angles.
    expect(angleToValue(-90, rpm)).toBe(4000);
    expect(angleToValue(0, rpm)).toBeCloseTo(6950.82, 1);
  });

  it("snaps the gap under the dial to the nearest end", () => {
    expect(angleToValue(100, rpm)).toBe(0);
    expect(angleToValue(80, rpm)).toBe(8000);
  });

  it("runs sub-gauges left to right along the bottom", () => {
    expect(subValueToAngle(40, coolant)).toBe(SUB_START_ANGLE);
    expect(subValueToAngle(85, coolant)).toBe(90);
    expect(subValueToAngle(130, coolant)).toBe(SUB_END_ANGLE);
    expect(subValueToAngle(200, coolant)).toBe(SUB_END_ANGLE);
  });

  it("turns a pointer angle into a sub-gauge value and pegs it past the ends", () => {
    expect(subAngleToValue(90, coolant)).toBe(85);
    expect(subAngleToValue(SUB_START_ANGLE, coolant)).toBe(40);
    expect(subAngleToValue(SUB_END_ANGLE, coolant)).toBe(130);
    // Left of the dial (atan2 gives ±180) is the low end, right of it the high end.
    expect(subAngleToValue(180, coolant)).toBe(40);
    expect(subAngleToValue(-170, coolant)).toBe(40);
    expect(subAngleToValue(-10, coolant)).toBe(130);
    expect(subAngleToValue(20, coolant)).toBe(130);
  });

  it("draws nothing for an empty arc", () => {
    expect(arcPath(210, 184, 148, 148)).toBe("");
    expect(arcPath(210, 184, START_ANGLE, START_ANGLE + SWEEP)).toContain(" 0 1 1 ");
  });

  it("picks round tick steps", () => {
    expect(majorTicks(rpm, 8).ticks).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000]);
    expect(majorTicks({ min: 0, max: 260 }, 13).step).toBe(20);
    expect(majorTicks({ min: 8, max: 16 }, 4).ticks).toEqual([8, 10, 12, 14, 16]);
  });

  it("splits each major interval into minor ticks", () => {
    expect(minorTicks([0, 1000, 2000], 1000, 4)).toEqual([250, 500, 750, 1250, 1500, 1750]);
    expect(minorTicks([0, 20, 40], 20, 2)).toEqual([10, 30]);
    expect(minorTicks([0, 0.1], 0.1, 2)).toEqual([0.05]);
    expect(minorTicks([0, 20], 20, 1)).toEqual([]);
  });

  it("finds the zone a value sits in", () => {
    const zones = [{ min: 6500, max: 8000, tone: "critical" as const }];
    expect(zoneAt(zones, 7000, rpm)).toBe("critical");
    expect(zoneAt(zones, 3000, rpm)).toBeUndefined();
  });

  it("gives a value past the display range the zone at that end", () => {
    const hot = [
      { min: 105, max: 115, tone: "warning" as const },
      { min: 115, max: 130, tone: "critical" as const },
    ];
    expect(zoneAt(hot, 140, coolant)).toBe("critical");
    expect(zoneAt(hot, 6, coolant)).toBeUndefined();
    const low = [
      { min: 8, max: 11.5, tone: "critical" as const },
      { min: 14.8, max: 16, tone: "warning" as const },
    ];
    expect(zoneAt(low, 5, { min: 8, max: 16 })).toBe("critical");
    expect(zoneAt(low, 20, { min: 8, max: 16 })).toBe("warning");
    expect(zoneAt(low, 13, { min: 8, max: 16 })).toBeUndefined();
  });

  it("snaps to the step inside the range", () => {
    expect(snapToStep(3124, rpm, 50)).toBe(3100);
    expect(snapToStep(9000, rpm, 50)).toBe(8000);
    expect(snapToStep(-10, rpm, 50)).toBe(0);
  });

  it("moves a step per arrow key, ten with Shift", () => {
    expect(keyedValue("ArrowUp", false, 3100, rpm, 50)).toBe(3150);
    expect(keyedValue("ArrowLeft", false, 3100, rpm, 50)).toBe(3050);
    expect(keyedValue("ArrowDown", true, 3100, rpm, 50)).toBe(2600);
    expect(keyedValue("PageUp", false, 3100, rpm, 50)).toBe(3900);
    expect(keyedValue("End", false, 3100, rpm, 50)).toBe(8000);
    expect(keyedValue("a", false, 3100, rpm, 50)).toBeUndefined();
  });
});
