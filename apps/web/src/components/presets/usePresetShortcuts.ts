import type { Preset } from "@fme/contracts";
import { useEffect, useEffectEvent } from "react";
import { hasModifier, useWindowChrome } from "~/lib/windowChrome";

const SHORTCUT_COUNT = 9;

/** The presets ⌥1–⌥9 apply: the built-ins, then the first user presets. */
export const shortcutPresets = (presets: ReadonlyArray<Preset>) => presets.slice(0, SHORTCUT_COUNT);

export function useShortcutLabels() {
  const { platform } = useWindowChrome();
  const mac = platform === "mac";
  return {
    apply: (index: number) => (mac ? `⌥${index + 1}` : `Alt+${index + 1}`),
    applyAria: (index: number) => `Alt+${index + 1}`,
    saveNew: mac ? "⇧⌘S" : "Ctrl+Shift+S",
    saveNewAria: mac ? "Shift+Meta+S" : "Control+Shift+S",
  };
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.closest("input, textarea, select") !== null);

/** ⌥1–⌥9 apply presets and ⇧⌘S (Ctrl+Shift+S) saves the values as a new one. */
export function usePresetShortcuts({
  presets,
  onApply,
  onSaveNew,
}: {
  presets: ReadonlyArray<Preset>;
  onApply: (preset: Preset) => void;
  onSaveNew: () => void;
}) {
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || typing(event.target)) return;
    // `code`, not `key`: ⌥1 types "¡" on a Mac keyboard.
    const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && digit) {
      const preset = shortcutPresets(presets)[Number(digit) - 1];
      if (preset === undefined) return;
      event.preventDefault();
      onApply(preset);
    } else if (hasModifier(event) && event.shiftKey && !event.altKey && event.code === "KeyS") {
      event.preventDefault();
      onSaveNew();
    }
  });
  // oxlint-disable-next-line fme/no-unreasoned-state-sync -- window-wide preset shortcuts (⌥1–⌥9 apply, ⇧⌘S save as new)
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
