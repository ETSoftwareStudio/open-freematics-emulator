/**
 * Smoke-tests the app `vp run desktop:tauri:dist` built for this OS and arch: it runs the server
 * in-process, loads the window, lets only its own origin talk to the server, and quits cleanly
 * on SIGTERM. It connects to no device and keeps its data in a temp dir.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { appBinary } from "./app.ts";

const TIMEOUT_MS = 30_000;
const exe = appBinary();
const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fme-smoke-"));
const app = NodeChildProcess.spawn(exe, [], {
  env: { ...process.env, FME_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
const exited = new Promise<number | null>((resolve) => app.once("exit", resolve));
let output = "";
const waiters = new Set<() => void>();
const collect = (chunk: Buffer) => {
  process.stdout.write(chunk);
  output += chunk.toString();
  for (const waiter of waiters) waiter();
};
app.stdout.on("data", collect);
app.stderr.on("data", collect);

const waitFor = (pattern: RegExp) =>
  new Promise<RegExpMatchArray>((resolve, reject) => {
    const check = () => {
      const match = output.match(pattern);
      if (match === null) return;
      waiters.delete(check);
      clearTimeout(timer);
      resolve(match);
    };
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`No ${pattern} from the app in ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    waiters.add(check);
    check();
    void exited.then((code) => reject(new Error(`The app exited with ${code}`)));
  });

try {
  const [, address] = await waitFor(/Listening on http:\/\/(\S+)/);
  await waitFor(/Loaded the window/);
  const appOrigin = process.platform === "win32" ? "http://tauri.localhost" : "tauri://localhost";
  const health = await fetch(`http://${address}/api/health`, { headers: { origin: appOrigin } });
  const foreign = await fetch(`http://${address}/api/health`, {
    headers: { origin: "http://example.com" },
  });
  if (!health.ok || foreign.status !== 403) {
    throw new Error(`Origin guard: app ${health.status}, foreign ${foreign.status}`);
  }
  console.log("in-process server started, the window loaded, and only the app origin got in");
  // Windows has no SIGTERM; killing the process there skips the clean stop.
  if (process.platform !== "win32") {
    app.kill("SIGTERM");
    const code = await exited;
    if (code !== 0 || !output.includes("Server stopped")) {
      throw new Error(`The app did not stop cleanly (exit code ${code})`);
    }
    console.log("quit cleanly and stopped the server");
  }
} finally {
  if (app.exitCode === null) app.kill();
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
}
