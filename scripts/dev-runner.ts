// @effect-diagnostics nodeBuiltinImport:off - a plain process supervisor for local development.
import * as NodeChildProcess from "node:child_process";

const serverPort = process.env.FME_SERVER_PORT ?? "3738";
const webPort = process.env.PORT ?? "5738";

interface Task {
  readonly name: string;
  readonly cwd: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

// The server is built once and not restarted on changes; Vite hot-reloads the web app.
const build = NodeChildProcess.spawnSync("cargo", ["build", "-p", "fme-server", "--bin", "fme"], {
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

const tasks: ReadonlyArray<Task> = [
  { name: "server", cwd: ".", command: "target/debug/fme", args: ["--dev"] },
  { name: "web", cwd: "apps/web", command: "vp", args: ["run", "dev"] },
];

// Each task runs in its own process group so a stop reaches what it starts too (`vp` runs Vite).
const isWindows = process.platform === "win32";
const FORCE_AFTER_MS = 5000;

const signalTree = (child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals) => {
  if (child.pid === undefined) return;
  if (isWindows) {
    NodeChildProcess.spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The whole group has already exited.
  }
};

const spawnTask = (task: Task) => {
  const child = NodeChildProcess.spawn(task.command, task.args, {
    cwd: task.cwd,
    env: { ...process.env, FME_SERVER_PORT: serverPort, PORT: webPort },
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWindows,
  });
  const prefix = `[${task.name}] `;
  const forward = (stream: NodeJS.WritableStream) => (chunk: Buffer) =>
    stream.write(
      chunk
        .toString()
        .split("\n")
        .map((line) => (line.length > 0 ? prefix + line : line))
        .join("\n"),
    );
  child.stdout.on("data", forward(process.stdout));
  child.stderr.on("data", forward(process.stderr));
  child.on("exit", (code) => {
    process.stdout.write(`${prefix}exited with ${code}\n`);
    shutdown(code ?? 0);
  });
  // "close" waits for the pipes too, which the task's own children hold until they exit.
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  return { child, closed };
};

const running = tasks.map(spawnTask);

let stopping = false;
function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const { child } of running) signalTree(child, "SIGTERM");
  const force = setTimeout(() => {
    for (const { child } of running) signalTree(child, "SIGKILL");
    setTimeout(() => process.exit(), 1000).unref();
  }, FORCE_AFTER_MS);
  void Promise.all(running.map(({ closed }) => closed)).then(() => {
    clearTimeout(force);
    process.exit();
  });
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

process.stdout.write(`[dev-runner] web http://localhost:${webPort} · server :${serverPort}\n`);
