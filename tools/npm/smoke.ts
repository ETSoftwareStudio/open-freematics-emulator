// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off globalFetch:off - plain Node release tooling.
/**
 * Smoke-tests the staged npm packages the way `npx` runs them: packs the main package and this
 * machine's platform package from `.stage/npm`, installs both into an empty directory, starts the
 * launcher, checks that the server answers and serves the UI, and stops it. Also checks the error
 * when npm left the platform package out. Run `vp run npm:stage` first.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const name = "open-freematics-emulator";
const platformPackage = `${name}-${process.platform}-${process.arch}`;
const stage = NodePath.resolve(import.meta.dirname, "../../.stage/npm");
const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fme-npm-smoke-"));
const npm = (args: Array<string>, cwd: string) =>
  NodeChildProcess.execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
const pack = (directory: string) =>
  NodePath.join(
    scratch,
    npm(["pack", NodePath.join(stage, directory), "--silent"], scratch).trim(),
  );
const installDir = (directory: string, tarballs: Array<string>, flags: Array<string> = []) => {
  const install = NodePath.join(scratch, directory);
  NodeFS.mkdirSync(install);
  npm(["init", "-y"], install);
  npm(["install", ...tarballs, "--no-audit", "--no-fund", ...flags], install);
  return install;
};
const sizeOf = (path: string): number =>
  NodeFS.statSync(path).isDirectory()
    ? NodeFS.readdirSync(path).reduce(
        (total, entry) => total + sizeOf(NodePath.join(path, entry)),
        0,
      )
    : NodeFS.statSync(path).size;
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = NodeNet.createServer().listen(0, "127.0.0.1", () => {
      const address = server.address() as NodeNet.AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
const isListening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    socket.on("connect", () => resolve(true)).on("error", () => resolve(false));
    socket.on("connect", () => socket.destroy());
  });
// The launcher must stop the server with it. Windows can't signal it, so end the whole tree there.
const stop = (launcher: NodeChildProcess.ChildProcess) => {
  if (process.platform === "win32") {
    NodeChildProcess.spawnSync("taskkill", ["/pid", String(launcher.pid), "/t", "/f"]);
  } else {
    launcher.kill("SIGTERM");
  }
};

for (const directory of [name, platformPackage]) {
  if (!NodeFS.existsSync(NodePath.join(stage, directory))) {
    console.error(`Missing ${NodePath.join(stage, directory)}. Run \`vp run npm:stage\` first.`);
    process.exit(1);
  }
}

let child: NodeChildProcess.ChildProcess | undefined;
try {
  const main = pack(name);
  const platform = pack(platformPackage);
  const install = installDir("install", [main, platform]);
  const port = await freePort();
  child = NodeChildProcess.spawn(
    process.execPath,
    [
      NodePath.join(install, "node_modules", name, "cli.mjs"),
      "--no-open",
      "--port",
      String(port),
      "--data-dir",
      NodePath.join(scratch, "data"),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const started = child;
  const exited = new Promise<number | string | null>((resolve) =>
    started.on("exit", (code, signal) => resolve(signal ?? code)),
  );
  const output = await new Promise<string>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`No start message:\n${text}`)), 30_000);
    started.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("is running at")) {
        clearTimeout(timer);
        resolve(text);
      }
    });
    void exited.then((status) => reject(new Error(`Exited with ${status}:\n${text}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/health`);
  const page = await fetch(base).then((response) => response.text());
  if (!health.ok || !page.includes("<title>Open Freematics Emulator</title>")) {
    throw new Error(`Unexpected response: health ${health.status}, page ${page.slice(0, 200)}`);
  }
  console.log(output.trim());

  stop(started);
  const status = await exited;
  // `fme` shuts down cleanly on SIGTERM, and the launcher passes its exit code on.
  if (process.platform !== "win32" && status !== 0) {
    throw new Error(`The launcher exited with ${status} after SIGTERM`);
  }
  if (await isListening(port)) throw new Error(`The server still listens on ${port}`);
  child = undefined;

  const withoutBinary = installDir("no-optional", [main], ["--omit=optional"]);
  const missing = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(withoutBinary, "node_modules", name, "cli.mjs"), "--no-open"],
    { encoding: "utf8" },
  );
  if (missing.status !== 1 || !missing.stderr.includes(`${platformPackage} isn't installed`)) {
    throw new Error(`Unexpected result without ${platformPackage}: ${JSON.stringify(missing)}`);
  }

  console.log(`${NodePath.basename(main)}: ${megabytes(NodeFS.statSync(main).size)}`);
  console.log(`${NodePath.basename(platform)}: ${megabytes(NodeFS.statSync(platform).size)}`);
  console.log(`Installed: ${megabytes(sizeOf(NodePath.join(install, "node_modules")))}`);
  console.log("npm packages OK");
} finally {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) stop(child);
  NodeFS.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}
