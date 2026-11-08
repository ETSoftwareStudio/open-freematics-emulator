export type Platform = "mac" | "windows" | "linux";

export interface WindowChrome {
  /** Running in a desktop app's window rather than a browser tab. */
  readonly desktop: boolean;
  readonly platform: Platform;
  /** macOS draws its traffic lights over the toolbar's leading edge. */
  readonly trafficLights: boolean;
  /** Windows and Linux draw the window buttons over the toolbar's trailing edge. */
  readonly windowControlsOverlay: boolean;
  /** The shortcut modifier as the platform writes it: `⌘` or `Ctrl+`. */
  readonly modifierLabel: string;
}

// The Tauri shell overlays the toolbar on macOS only and keeps the native title bar elsewhere.
const detect = (): WindowChrome => {
  const agent = navigator.userAgent;
  const hint = (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData
    ?.platform;
  const source = hint ?? agent;
  const platform: Platform = /mac/i.test(source)
    ? "mac"
    : /win/i.test(source)
      ? "windows"
      : "linux";
  const electron = /\bElectron\//.test(agent);
  const desktop = electron || "__TAURI_INTERNALS__" in window;
  return {
    desktop,
    platform,
    trafficLights: desktop && platform === "mac",
    windowControlsOverlay: electron && platform !== "mac",
    modifierLabel: platform === "mac" ? "⌘" : "Ctrl+",
  };
};

const chrome = detect();

export function useWindowChrome() {
  return chrome;
}

/** Whether a key event holds the platform's shortcut modifier (⌘ on macOS, Ctrl elsewhere). */
export const hasModifier = (event: KeyboardEvent) =>
  chrome.platform === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
