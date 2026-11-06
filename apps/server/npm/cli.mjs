#!/usr/bin/env node
// Entry point of the npm package (`npx open-freematics-emulator`): starts the bundled server on the
// built web app next to it, then opens the browser. Other flags go to the server unchanged.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const args = process.argv.slice(2);
const open = !args.includes("--no-open");
const serverArgs = args.filter((arg) => arg !== "--no-open");
const { values } = NodeUtil.parseArgs({
  args: serverArgs,
  strict: false,
  options: { host: { type: "string" }, port: { type: "string" }, "web-root": { type: "string" } },
});
if (values["web-root"] === undefined) {
  serverArgs.push("--web-root", NodeURL.fileURLToPath(new URL("./web", import.meta.url)));
}
process.argv.splice(2, Infinity, ...serverArgs);
await import("./server/bin.mjs");

const host = typeof values.host === "string" ? values.host : "127.0.0.1";
const port =
  typeof values.port === "string" ? values.port : (process.env.FME_SERVER_PORT ?? "3738");
const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

// A request sent while the server is still starting can stall, so each probe has its own timeout.
const isHealthy = () =>
  fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }).then(
    (response) => response.ok,
    () => false,
  );
let healthy = false;
for (const started = Date.now(); !healthy && Date.now() - started < 15_000;) {
  healthy = await isHealthy();
  if (!healthy) await new Promise((resolve) => setTimeout(resolve, 200));
}
if (healthy) console.log(`Open Freematics Emulator is running at ${url}. Press Ctrl+C to stop.`);

if (healthy && open) {
  const [command, commandArgs] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  NodeChildProcess.spawn(command, commandArgs, { detached: true, stdio: "ignore" })
    .on("error", () => console.log(`Open ${url} in your browser.`))
    .unref();
}
