import type { PidId, PresetPids } from "@fme/contracts";
import { describe, expect, it } from "vite-plus/test";
import { describeChange, presetSummary } from "./presetText";

const pids = (values: Record<string, number>) => values as PresetPids;
const scenario = (values: Record<string, number>) =>
  pids({ "010C": 750, "010D": 0, "0111": 14, "0105": 90, "0146": 22, ...values });

describe("presetSummary", () => {
  it.each([
    ["idle RPM when parked", scenario({}), "750 rpm"],
    ["speed and RPM when moving", scenario({ "010C": 2350, "010D": 72 }), "72 km/h · 2,350 rpm"],
    ["a cold engine's coolant", scenario({ "010C": 1250, "0105": 6 }), "6 °C coolant"],
    ["an overheating engine's coolant", scenario({ "010C": 820, "0105": 118 }), "118 °C coolant"],
    [
      "throttle and RPM at wide-open throttle",
      scenario({ "010C": 5500, "010D": 98, "0111": 88 }),
      "88 % · 5,500 rpm",
    ],
    ["the first value without RPM", pids({ "0110": 14.5, "0105": 90 }), "MAF 14.5 g/s"],
    ["an empty preset", pids({}), "No values"],
  ])("shows %s", (_, values, expected) => {
    expect(presetSummary(values)).toBe(expected);
  });
});

describe("describeChange", () => {
  it("names the PID and keeps the step's decimals", () => {
    expect(describeChange({ pid: "0110" as PidId, presetValue: 14.5, currentValue: 16.25 })).toBe(
      "MAF air flow rate 14.5 → 16.25 g/s",
    );
  });
});
