import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

export interface FileSystemCall {
  readonly method: "writeFile" | "rename" | "remove";
  readonly path: string;
}

const notFound = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
  });

const parent = (path: string) => path.slice(0, path.lastIndexOf("/"));

/**
 * Test support: an in-memory file system whose calls complete synchronously, so concurrent fibers
 * interleave deterministically. `hook` runs before each writeFile and remove and after each rename
 * (the moment a new file is in place), so a test can block or fail exactly there.
 */
export const memoryFileSystem = (
  hook: (call: FileSystemCall) => Effect.Effect<void, PlatformError.PlatformError> = () =>
    Effect.void,
) => {
  const files = new Map<string, Uint8Array>();
  const readFile = (path: string) =>
    Effect.suspend(() => {
      const data = files.get(path);
      return data === undefined ? Effect.fail(notFound("readFile", path)) : Effect.succeed(data);
    });
  const writeFile = (path: string, data: Uint8Array) =>
    hook({ method: "writeFile", path }).pipe(
      Effect.andThen(Effect.sync(() => void files.set(path, Uint8Array.from(data)))),
    );
  const fileSystem = FileSystem.makeNoop({
    exists: (path) => Effect.sync(() => files.has(path)),
    makeDirectory: () => Effect.void,
    readDirectory: (directory) =>
      Effect.sync(() =>
        [...files.keys()]
          .filter((path) => parent(path) === directory)
          .map((path) => path.slice(directory.length + 1)),
      ),
    readFile,
    readFileString: (path) => Effect.map(readFile(path), (data) => new TextDecoder().decode(data)),
    writeFile,
    writeFileString: (path, text) => writeFile(path, new TextEncoder().encode(text)),
    rename: (from, to) =>
      readFile(from).pipe(
        Effect.map((data) => {
          files.delete(from);
          files.set(to, data);
        }),
        Effect.andThen(hook({ method: "rename", path: to })),
      ),
    remove: (path, options) =>
      hook({ method: "remove", path }).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            files.delete(path) || options?.force === true
              ? Effect.void
              : Effect.fail(notFound("remove", path)),
          ),
        ),
      ),
  });
  return { files, layer: Layer.succeed(FileSystem.FileSystem, fileSystem) };
};

/** A one-shot gate: the first caller of `pass` signals `entered` and waits for `open`. */
export const makeGate = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const opened = yield* Deferred.make<void>();
  let used = false;
  return {
    entered: Deferred.await(entered),
    open: Deferred.succeed(opened, undefined),
    pass: Effect.suspend(() => {
      if (used) return Effect.void;
      used = true;
      return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(opened)));
    }),
  };
});
