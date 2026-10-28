/** Launches the built app with the workspace's Electron. */
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

// Under Node, the `electron` package exports the path to its binary.
const electron = NodeModule.createRequire(import.meta.url)("electron") as string;
// Terminals inside Electron apps can export this, which would start Electron as plain Node.
const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;

const child = NodeChildProcess.spawn(electron, ["."], {
  cwd: NodePath.resolve(import.meta.dirname, ".."),
  env,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
