/** Angles are SVG degrees: clockwise from 3 o'clock. Gauges sweep from 7:30 to 4:30. */
export const START_ANGLE = 135;
export const SWEEP = 270;

export interface GaugeRange {
  readonly min: number;
  readonly max: number;
}

export type GaugeTone = "warning" | "critical";

export interface GaugeZone extends GaugeRange {
  readonly tone: GaugeTone;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export const valueFraction = (value: number, { min, max }: GaugeRange) =>
  clamp01((value - min) / (max - min));

export const valueToAngle = (value: number, range: GaugeRange) =>
  START_ANGLE + valueFraction(value, range) * SWEEP;

/** A pointer in the gap below the dial snaps to whichever end is closer. */
export const angleToValue = (angle: number, { min, max }: GaugeRange) => {
  const fromStart = (((angle - START_ANGLE) % 360) + 360) % 360;
  const swept = fromStart <= SWEEP ? fromStart : fromStart - SWEEP < 360 - fromStart ? SWEEP : 0;
  return min + (swept / SWEEP) * (max - min);
};

export const polar = (center: number, radius: number, angle: number) => {
  const radians = (angle * Math.PI) / 180;
  return { x: center + radius * Math.cos(radians), y: center + radius * Math.sin(radians) };
};

export const arcPath = (center: number, radius: number, from: number, to: number) => {
  if (to <= from) return "";
  const start = polar(center, radius, from);
  const end = polar(center, radius, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${large} 1 ${end.x} ${end.y}`;
};

/** Major ticks on a 1-2-2.5-5 step, about `target` of them across the range. */
export const majorTicks = ({ min, max }: GaugeRange, target: number) => {
  const rough = (max - min) / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough) ??
    10 * magnitude;
  const first = Math.ceil(min / step) * step;
  const ticks: Array<number> = [];
  for (let tick = first; tick <= max + step / 1e6; tick += step) {
    ticks.push(Number(tick.toFixed(6)));
  }
  return { step, ticks };
};

export const zoneAt = (zones: ReadonlyArray<GaugeZone>, value: number) =>
  zones.find((zone) => value >= zone.min && value <= zone.max)?.tone;
