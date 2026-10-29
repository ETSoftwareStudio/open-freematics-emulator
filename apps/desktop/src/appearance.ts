export const APPEARANCES = ["system", "light", "dark"] as const;
export type Appearance = (typeof APPEARANCES)[number];

export const isAppearance = (value: unknown): value is Appearance =>
  APPEARANCES.some((appearance) => appearance === value);

export const APPEARANCE_CHANNELS = {
  get: "fme:appearance:get",
  set: "fme:appearance:set",
  changed: "fme:appearance:changed",
} as const;
