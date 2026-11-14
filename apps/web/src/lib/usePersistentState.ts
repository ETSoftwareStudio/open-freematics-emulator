import { useState } from "react";

/** The stored value as it is now; another window may have written it since this one mounted. */
export const readPersistent = <A>(key: string, fallback: A): A => {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return fallback;
    const parsed: unknown = JSON.parse(stored);
    return typeof parsed === typeof fallback ? (parsed as A) : fallback;
  } catch {
    return fallback;
  }
};

const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return;
  }
};

type Widen<A> = A extends boolean ? boolean : A extends number ? number : A;

/** `useState` for layout choices (open panes, sizes) that should survive a reload. */
export function usePersistentState<A extends string | number | boolean>(key: string, fallback: A) {
  type Value = Widen<A>;
  const [value, setValue] = useState<Value>(() => readPersistent<Value>(key, fallback as Value));
  const set = (next: Value | ((previous: Value) => Value)) =>
    setValue((previous) => {
      const resolved = typeof next === "function" ? next(previous) : next;
      write(key, resolved);
      return resolved;
    });
  return [value, set] as const;
}
