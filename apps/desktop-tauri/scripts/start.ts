/** Opens the app `tauri build --no-bundle` built. */
import * as NodeChildProcess from "node:child_process";
import { appBinary } from "./app.ts";

const child = NodeChildProcess.spawn(appBinary(), [], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
