/**
 * Smoke-tests the unpacked app `pnpm desktop:dist` built for this OS and arch: the packaged
 * Electron loads the native serial module, then runs the bundled server, which serves the UI.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

const release = NodePath.resolve(import.meta.dirname, "../release");
const arm = process.arch === "arm64" ? "-arm64" : "";
const layouts = {
  darwin: {
    exe: `mac${arm}/Freematics Emulator.app/Contents/MacOS/Freematics Emulator`,
    app: `mac${arm}/Freematics Emulator.app/Contents/Resources/app`,
  },
  win32: {
    exe: `win${arm}-unpacked/Freematics Emulator.exe`,
    app: `win${arm}-unpacked/resources/app`,
  },
  linux: {
    exe: `linux${arm}-unpacked/freematics-emulator`,
    app: `linux${arm}-unpacked/resources/app`,
  },
};
const layout = layouts[process.platform as keyof typeof layouts];
if (layout === undefined) throw new Error(`Unsupported platform ${process.platform}`);
const exe = NodePath.join(release, layout.exe);
const app = NodePath.join(release, layout.app);
if (!NodeFS.existsSync(exe)) throw new Error(`No packaged app at ${exe}`);

const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };

const listed = NodeChildProcess.execFileSync(
  exe,
  [
    "-e",
    'import("serialport").then((m) => m.SerialPort.list()).then((p) => console.log(p.length))',
  ],
  { cwd: app, env, encoding: "utf8", timeout: 20_000 },
);
console.log(`serialport loaded under the packaged Electron, ${listed.trim()} port(s) listed`);

const port = await new Promise<number>((resolve) => {
  const probe = NodeNet.createServer().listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
  });
});
const server = NodeChildProcess.spawn(
  exe,
  [
    NodePath.join(app, "dist/server/bin.mjs"),
    "--port",
    String(port),
    "--web-root",
    NodePath.join(app, "dist/web"),
  ],
  { env, stdio: ["ignore", "pipe", "inherit"] },
);
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not start in 20s")), 20_000);
    server.once("exit", (code) => reject(new Error(`Server exited with ${code}`)));
    server.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  if (!health.ok || !page.includes("<title>Freematics Emulator</title>")) {
    throw new Error(`Unexpected responses: health ${health.status}, page ${page.slice(0, 120)}`);
  }
  console.log("bundled server started and served the UI");
} finally {
  server.kill();
}
