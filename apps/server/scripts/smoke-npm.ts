// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off globalFetch:off - plain Node release tooling.
/**
 * Smoke-tests the staged npm package the way `npx` runs it: packs `.stage/npm`, installs the
 * tarball into an empty directory, starts it, and checks that the server answers and serves the UI.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const stage = NodePath.resolve(import.meta.dirname, "../.stage/npm");
const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fme-npm-smoke-"));
const npm = (args: Array<string>, cwd: string) =>
  NodeChildProcess.execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

const tarball = NodePath.join(scratch, npm(["pack", stage, "--silent"], scratch).trim());
const install = NodePath.join(scratch, "install");
NodeFS.mkdirSync(install);
npm(["init", "-y"], install);
npm(["install", tarball, "--no-audit", "--no-fund"], install);

const port = await new Promise<number>((resolve) => {
  const server = NodeNet.createServer().listen(0, "127.0.0.1", () => {
    const address = server.address() as NodeNet.AddressInfo;
    server.close(() => resolve(address.port));
  });
});
const cli = NodePath.join(install, "node_modules/open-freematics-emulator/cli.mjs");
const child = NodeChildProcess.spawn(
  process.execPath,
  [cli, "--no-open", "--port", String(port), "--data-dir", NodePath.join(scratch, "data")],
  { stdio: ["ignore", "pipe", "inherit"] },
);

try {
  const output = await new Promise<string>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`No start message:\n${text}`)), 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("is running at")) {
        clearTimeout(timer);
        resolve(text);
      }
    });
    child.on("exit", (code) => reject(new Error(`Exited with ${code}:\n${text}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/health`);
  const page = await fetch(base).then((response) => response.text());
  if (!health.ok || !page.includes("<title>Open Freematics Emulator</title>")) {
    throw new Error(`Unexpected response: health ${health.status}, page ${page.slice(0, 200)}`);
  }
  console.log(output.trim());
  console.log("npm package OK");
} finally {
  child.kill();
  NodeFS.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}
