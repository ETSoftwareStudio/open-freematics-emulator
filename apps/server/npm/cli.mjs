#!/usr/bin/env node
// Entry point of the npm package (`npx open-freematics-emulator`): runs the `fme` server binary from
// the platform package npm installed for this OS and CPU on the web app next to this file, then
// opens the browser. Other flags go to the server unchanged.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const readJson = (path) => JSON.parse(NodeFS.readFileSync(path, "utf8"));
const manifest = readJson(new URL("./package.json", import.meta.url));
const platformPackage = `${manifest.name}-${process.platform}-${process.arch}`;

const findBinary = () => {
  let packageJson;
  try {
    packageJson = NodeModule.createRequire(import.meta.url).resolve(
      `${platformPackage}/package.json`,
    );
  } catch {
    const supported = Object.keys(manifest.optionalDependencies ?? {});
    const musl =
      process.platform === "linux" && !process.report?.getReport().header.glibcVersionRuntime;
    return {
      error: !supported.includes(platformPackage)
        ? `${manifest.name} has no build for ${process.platform}-${process.arch}. Supported: ${supported.map((name) => name.slice(manifest.name.length + 1)).join(", ")}.`
        : musl
          ? `${manifest.name} needs a glibc-based Linux; this system uses musl.`
          : `${platformPackage} isn't installed. npm skips it when optional dependencies are omitted (--no-optional, --omit=optional); reinstall without that flag.`,
    };
  }
  const { version } = readJson(packageJson);
  if (version !== manifest.version) {
    return {
      error: `${platformPackage} is ${version}, but ${manifest.name} is ${manifest.version}. Reinstall ${manifest.name}.`,
    };
  }
  const name = process.platform === "win32" ? "fme.exe" : "fme";
  return { binary: NodePath.join(NodePath.dirname(packageJson), "bin", name) };
};

const { binary, error } = findBinary();
if (error !== undefined) {
  console.error(error);
  process.exit(1);
}

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

const child = NodeChildProcess.spawn(binary, serverArgs, { stdio: "inherit" });
const isRunning = () => child.exitCode === null && child.signalCode === null;
child.on("error", (cause) => {
  console.error(`Couldn't start ${binary}: ${cause.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal === null) process.exit(code ?? 1);
  // Die of the same signal, as a shell expects from the process it started.
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    // Windows sends Ctrl+C to every process on the console, and kill() there can't be caught.
    if (isRunning() && !(process.platform === "win32" && signal === "SIGINT")) child.kill(signal);
  });
}

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
for (const started = Date.now(); isRunning() && !healthy && Date.now() - started < 15_000;) {
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
