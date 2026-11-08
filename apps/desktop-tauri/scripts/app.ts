/**
 * Finds the app `tauri build` produced for this OS: the .app bundle on macOS, the release binary
 * elsewhere. `--target <triple>` looks in that target's directory instead.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const flag = process.argv.indexOf("--target");
const triple = flag === -1 ? undefined : process.argv[flag + 1];
const release = NodePath.resolve(
  import.meta.dirname,
  "../../../target",
  ...(triple === undefined ? [] : [triple]),
  "release",
);
const binary =
  process.platform === "win32" ? "open-freematics-emulator.exe" : "open-freematics-emulator";

export const appBinary = () => {
  const bundled = NodePath.join(
    release,
    "bundle/macos/Open Freematics Emulator.app/Contents/MacOS",
    binary,
  );
  const exe =
    process.platform === "darwin" && NodeFS.existsSync(bundled)
      ? bundled
      : NodePath.join(release, binary);
  if (!NodeFS.existsSync(exe)) throw new Error(`No built app at ${exe}`);
  return exe;
};
