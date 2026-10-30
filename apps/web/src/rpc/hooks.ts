import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { emulatorStateAtom, firmwareUpdateAtom, readerStateAtom } from "./atoms.ts";

/** The last failed command, shown in the banner until dismissed or replaced. */
export const lastErrorAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive);

export function useEmulatorState() {
  const result = useAtomValue(emulatorStateAtom);
  return {
    state: AsyncResult.isSuccess(result) ? result.value : null,
    serverReachable: AsyncResult.isSuccess(result),
  };
}

export function useReaderState() {
  const result = useAtomValue(readerStateAtom);
  return AsyncResult.isSuccess(result) ? result.value : null;
}

export function useFirmwareUpdateState() {
  const result = useAtomValue(firmwareUpdateAtom);
  return AsyncResult.isSuccess(result) ? result.value : null;
}

const describe = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/**
 * Runs an RPC mutation and reports its failure in the error banner. Resolves to whether it
 * succeeded, so callers can reset local drafts either way.
 */
export function useCommand<P, A, E>(atom: Atom.AtomResultFn<{ readonly payload: P }, A, E>) {
  const run = useAtomSet(atom, { mode: "promiseExit" });
  const setError = useAtomSet(lastErrorAtom);
  return async (payload: P) => {
    const exit = await run({ payload });
    if (Exit.isSuccess(exit)) return true;
    if (!Cause.hasInterruptsOnly(exit.cause)) setError(describe(exit.cause));
    return false;
  };
}

/** Runs an RPC mutation for a flow that shows its own errors instead of the banner. */
export function useCall<P, A, E>(atom: Atom.AtomResultFn<{ readonly payload: P }, A, E>) {
  const run = useAtomSet(atom, { mode: "promiseExit" });
  return async (payload: P) => {
    const exit = await run({ payload });
    return Exit.isSuccess(exit)
      ? { ok: true as const, value: exit.value }
      : { ok: false as const, message: describe(exit.cause) };
  };
}
