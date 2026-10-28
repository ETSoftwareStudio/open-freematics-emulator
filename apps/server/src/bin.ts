#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - the CLI entry resolves its own install path.
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
  },
});

const webRoot = NodePath.resolve(import.meta.dirname, "../../web/dist");

Server.makeLayer({
  host: values.host,
  port: Number(values.port),
  webRoot: values.dev ? null : webRoot,
}).pipe(Layer.launch, NodeRuntime.runMain);
