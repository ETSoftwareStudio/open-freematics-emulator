import { useSyncExternalStore } from "react";

export const APPEARANCES = ["system", "light", "dark"] as const;
export type Appearance = (typeof APPEARANCES)[number];

/** What the desktop app's preload exposes; absent in a plain browser. */
interface AppearanceBridge {
  get(): Promise<Appearance>;
  set(appearance: Appearance): Promise<void>;
  onChange(listener: (appearance: Appearance) => void): () => void;
}

declare global {
  interface Window {
    fme?: { appearance: AppearanceBridge };
  }
}

// Read by the inline script in index.html too, before React renders.
const STORAGE_KEY = "fme:appearance";
const bridge = window.fme?.appearance;
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

const isAppearance = (value: unknown): value is Appearance =>
  APPEARANCES.some((appearance) => appearance === value);

const stored = () => {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isAppearance(value) ? value : "system";
  } catch {
    return "system";
  }
};

let current: Appearance = bridge === undefined ? stored() : "system";
const listeners = new Set<() => void>();

const apply = () => {
  // The desktop app sets nativeTheme.themeSource, which the color-scheme media query follows.
  const effective = bridge === undefined ? current : "system";
  const dark = effective === "dark" || (effective === "system" && darkQuery.matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
};

const update = (appearance: Appearance) => {
  current = appearance;
  apply();
  for (const listener of listeners) listener();
};

darkQuery.addEventListener("change", apply);
if (bridge !== undefined) {
  bridge.onChange(update);
  void bridge.get().then(update);
}

export const setAppearance = (appearance: Appearance) => {
  if (bridge !== undefined) {
    update(appearance);
    void bridge.set(appearance);
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, appearance);
  } catch {
    // Without storage the choice lasts until reload.
  }
  update(appearance);
};

/** The chosen appearance: `system` follows the OS, `light` and `dark` override it. */
export function useAppearance() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
