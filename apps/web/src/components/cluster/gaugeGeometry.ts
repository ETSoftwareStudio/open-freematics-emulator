/**
 * Angles are SVG degrees: clockwise from 3 o'clock. Dials sweep 244° from lower left to lower
 * right, leaving the gap at the bottom for a sub-gauge.
 */
export const START_ANGLE = 148;
export const SWEEP = 244;
/** Sub-gauges run left to right along the bottom gap, so their angle falls as the value rises. */
export const SUB_START_ANGLE = 122;
export const SUB_END_ANGLE = 58;

/** Dial artwork in SVG user units: a 420 square, the scale at `radius`, sub-gauges at `subRadius`. */
export const DIAL = { size: 420, center: 210, radius: 184, subRadius: 172 } as const;

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

const SUB_SWEEP = SUB_START_ANGLE - SUB_END_ANGLE;

export const subValueToAngle = (value: number, range: GaugeRange) =>
  SUB_START_ANGLE - valueFraction(value, range) * SUB_SWEEP;

/** A pointer beyond either end of the sub-gauge pegs it at that end. */
export const subAngleToValue = (angle: number, { min, max }: GaugeRange) => {
  // Normalised to [-90, 270) so the bottom of the dial is one unbroken interval.
  const normalised = ((((angle + 90) % 360) + 360) % 360) - 90;
  const clamped = Math.min(SUB_START_ANGLE, Math.max(SUB_END_ANGLE, normalised));
  return min + ((SUB_START_ANGLE - clamped) / SUB_SWEEP) * (max - min);
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

/** The ticks that split each major interval into `divisions` parts. */
export const minorTicks = (ticks: ReadonlyArray<number>, step: number, divisions: number) =>
  ticks
    .slice(0, -1)
    .flatMap((tick) =>
      Array.from({ length: divisions - 1 }, (_, i) =>
        Number((tick + (step * (i + 1)) / divisions).toFixed(6)),
      ),
    );

export const zoneAt = (zones: ReadonlyArray<GaugeZone>, value: number) =>
  zones.find((zone) => value >= zone.min && value <= zone.max)?.tone;

export const snapToStep = (value: number, { min, max }: GaugeRange, step: number) =>
  Math.min(max, Math.max(min, Math.round(value / step) * step));

/** Where a key moves a gauge: arrows step (Shift steps ten), pages a tenth, Home and End the ends. */
export const keyedValue = (
  key: string,
  shiftKey: boolean,
  value: number,
  range: GaugeRange,
  step: number,
) => {
  const nudge = shiftKey ? step * 10 : step;
  const page = Math.max(step, (range.max - range.min) / 10);
  const targets: Partial<Record<string, number>> = {
    ArrowUp: value + nudge,
    ArrowRight: value + nudge,
    ArrowDown: value - nudge,
    ArrowLeft: value - nudge,
    PageUp: value + page,
    PageDown: value - page,
    Home: range.min,
    End: range.max,
  };
  return targets[key];
};
