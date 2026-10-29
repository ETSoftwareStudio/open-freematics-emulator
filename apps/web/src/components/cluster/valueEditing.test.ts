import { describe, expect, it } from "vite-plus/test";
import { START_ANGLE, SWEEP, valueToAngle } from "./gaugeGeometry.ts";
import { exitTarget, ghostValue, parseTyped, stepValue } from "./valueEditing.ts";

const rpm = { min: 0, max: 8000 };
const voltage = { min: 8, max: 16 };

describe("value editing", () => {
  it("parses what the gauge shows and rejects the rest", () => {
    expect(parseTyped("1,000")).toBe(1000);
    expect(parseTyped(" 4.75 ")).toBe(4.75);
    expect(parseTyped("-40")).toBe(-40);
    expect(parseTyped("")).toBeNull();
    expect(parseTyped("12a")).toBeNull();
  });

  it("steps by the gauge step, ten at a time, inside the range", () => {
    expect(stepValue(2350, 1, rpm, 50)).toBe(2400);
    expect(stepValue(2350, -10, rpm, 50)).toBe(1850);
    expect(stepValue(2337, 1, rpm, 50)).toBe(2400);
    expect(stepValue(7980, 1, rpm, 50)).toBe(8000);
    expect(stepValue(20, -1, rpm, 50)).toBe(0);
    expect(stepValue(14, 1, voltage, 0.1)).toBeCloseTo(14.1, 6);
  });

  it("shows the ghost only for a typed value that differs, pegged to the dial", () => {
    expect(ghostValue(3000, 2350, rpm)).toBe(3000);
    expect(ghostValue(2350, 2350, rpm)).toBeNull();
    expect(ghostValue(null, 2350, rpm)).toBeNull();
    expect(ghostValue(12000, 2350, rpm)).toBe(8000);
    expect(valueToAngle(ghostValue(4000, 0, rpm) ?? 0, rpm)).toBe(START_ANGLE + SWEEP / 2);
    expect(valueToAngle(ghostValue(-5, 100, rpm) ?? 100, rpm)).toBe(START_ANGLE);
  });

  it("commits the typed value on Enter, and nothing when it is already shown", () => {
    const base = { original: 2000, shown: 2000, live: false };
    expect(exitTarget("enter", { ...base, typed: 3000 })).toBe(3000);
    expect(exitTarget("enter", { ...base, typed: 2000 })).toBeNull();
    // Arrows already moved it to 2400 and the text says 2400: nothing more to send.
    expect(
      exitTarget("enter", { typed: 2400, original: 2000, shown: 2400, live: true }),
    ).toBeNull();
  });

  it("restores the value from before editing on Escape, sending it only if something was sent", () => {
    expect(
      exitTarget("escape", { typed: 3000, original: 2000, shown: 2000, live: false }),
    ).toBeNull();
    expect(exitTarget("escape", { typed: 2400, original: 2000, shown: 2400, live: true })).toBe(
      2000,
    );
    expect(
      exitTarget("escape", { typed: 2000, original: 2000, shown: 2000, live: true }),
    ).toBeNull();
  });

  it("keeps a valid changed value on blur and otherwise restores", () => {
    expect(exitTarget("blur", { typed: 3000, original: 2000, shown: 2000, live: false })).toBe(
      3000,
    );
    expect(exitTarget("blur", { typed: 2400, original: 2000, shown: 2400, live: true })).toBeNull();
    expect(exitTarget("blur", { typed: null, original: 2000, shown: 2400, live: true })).toBe(2000);
    expect(exitTarget("blur", { typed: 2000, original: 2000, shown: 2400, live: true })).toBe(2000);
    expect(
      exitTarget("blur", { typed: null, original: 2000, shown: 2000, live: false }),
    ).toBeNull();
  });
});
