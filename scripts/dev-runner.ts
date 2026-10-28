// @effect-diagnostics nodeBuiltinImport:off - a plain process supervisor for local development.
import * as NodeChildProcess from "node:child_process";

const serverPort = process.env.FME_SERVER_PORT ?? "3738";
const webPort = process.env.PORT ?? "5738";
const webUrl = `http://localhost:${webPort}`;
// `--desktop` also opens the Electron window on the dev server, so the UI hot-reloads there too.
const desktop = process.argv.includes("--desktop");

interface Task {
  readonly name: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
}

const tasks: ReadonlyArray<Task> = [
  { name: "server", cwd: "apps/server", args: ["run", "dev"] },
  { name: "web", cwd: "apps/web", args: ["run", "dev"] },
];

const spawnTask = (task: Task) => {
  const child = NodeChildProcess.spawn("vp", task.args, {
    cwd: task.cwd,
    env: { ...process.env, FME_SERVER_PORT: serverPort, PORT: webPort, ...task.env },
    stdio: ["ignore", "pipe", "pipe"],
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
  return child;
};

const children = tasks.map(spawnTask);

let stopping = false;
function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

process.stdout.write(`[dev-runner] web ${webUrl} · server :${serverPort}\n`);

async function waitForWeb(): Promise<boolean> {
  if (stopping) return false;
  const up = await fetch(webUrl).then(
    (response) => response.ok,
    () => false,
  );
  if (up) return true;
  await new Promise((resolve) => setTimeout(resolve, 250));
  return waitForWeb();
}

if (desktop) {
  const build = NodeChildProcess.spawnSync("vp", ["run", "build", "--main-only"], {
    cwd: "apps/desktop",
    stdio: "inherit",
  });
  if (build.status !== 0) shutdown(build.status ?? 1);
  // Electron shows a blank window if it loads before Vite is listening.
  if (await waitForWeb()) {
    children.push(
      spawnTask({
        name: "desktop",
        cwd: "apps/desktop",
        args: ["run", "start"],
        env: { FME_DESKTOP_URL: webUrl },
      }),
    );
  }
}
