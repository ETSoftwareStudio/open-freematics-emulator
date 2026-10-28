import * as Schema from "effect/Schema";

/** A Mode 01 PID as the emulator addresses it: mode byte + PID byte, e.g. `010C`. */
export const PidId = Schema.String.check(Schema.isPattern(/^01[0-9A-F]{2}$/)).pipe(
  Schema.brand("PidId"),
);
export type PidId = typeof PidId.Type;

/** SAE J2012 trouble code, e.g. `P0105`. */
export const DtcCode = Schema.String.check(Schema.isPattern(/^[PCBU][0-3][0-9A-F]{3}$/)).pipe(
  Schema.brand("DtcCode"),
);
export type DtcCode = typeof DtcCode.Type;

/** ISO 3779 VIN: 17 characters, no I, O or Q. */
export const Vin = Schema.String.check(Schema.isPattern(/^[A-HJ-NPR-Z0-9]{17}$/)).pipe(
  Schema.brand("Vin"),
);
export type Vin = typeof Vin.Type;

/** Calibration ID (Mode 09 PID 04); the firmware stores it as ASCII, 16 characters max. */
export const CalibrationId = Schema.String.check(Schema.isPattern(/^[\x20-\x7E]{1,16}$/)).pipe(
  Schema.brand("CalibrationId"),
);
export type CalibrationId = typeof CalibrationId.Type;
