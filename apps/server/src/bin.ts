#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - the CLI entry resolves its install and data paths.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Layer from "effect/Layer";
import * as Server from "./server.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: process.env.FME_SERVER_PORT ?? "3738" },
    dev: { type: "boolean", default: false },
    // The desktop app ships the built web app next to the bundled server.
    "web-root": { type: "string" },
    // The desktop app passes Electron's userData directory.
    "data-dir": { type: "string" },
    // The desktop app loads the web app from its own origin and connects to `/ws` from there.
    "app-origin": { type: "string" },
  },
});

const defaultDataDir = () => {
  const home = NodeOS.homedir();
  switch (process.platform) {
    case "darwin":
      return NodePath.join(home, "Library", "Application Support", "Open Freematics Emulator");
    case "win32":
      return NodePath.join(
        process.env.APPDATA || NodePath.join(home, "AppData", "Roaming"),
        "Open Freematics Emulator",
      );
    default:
      return NodePath.join(
        process.env.XDG_CONFIG_HOME || NodePath.join(home, ".config"),
        "open-freematics-emulator",
      );
  }
};

const webRoot = values["web-root"] ?? NodePath.resolve(import.meta.dirname, "../../web/dist");

Server.makeLayer({
  host: values.host,
  port: Number(values.port),
  webRoot: values.dev ? null : webRoot,
  dataDir: NodePath.resolve(values["data-dir"] ?? defaultDataDir()),
  appOrigin: values["app-origin"] ?? null,
}).pipe(Layer.launch, NodeRuntime.runMain);
