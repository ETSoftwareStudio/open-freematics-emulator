// @effect-diagnostics nodeBuiltinImport:off - a plain process supervisor for local development.
import * as NodeChildProcess from "node:child_process";

const serverPort = process.env.FME_SERVER_PORT ?? "3738";
const webPort = process.env.PORT ?? "5738";

const tasks = [
  { name: "server", cwd: "apps/server", args: ["run", "dev"] },
  { name: "web", cwd: "apps/web", args: ["run", "dev"] },
];

const children = tasks.map((task) => {
  const child = NodeChildProcess.spawn("pnpm", task.args, {
    cwd: task.cwd,
    env: { ...process.env, FME_SERVER_PORT: serverPort, PORT: webPort },
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
});

process.stdout.write(`[dev-runner] web http://localhost:${webPort} · server :${serverPort}\n`);

let stopping = false;
function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
