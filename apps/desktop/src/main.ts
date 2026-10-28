import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import { BrowserWindow, app, dialog, shell } from "electron";

const SERVER_ENTRY = NodePath.join(import.meta.dirname, "server", "bin.mjs");
const WEB_ROOT = NodePath.join(import.meta.dirname, "web");
const STARTUP_TIMEOUT_MS = 15_000;

let server: NodeChildProcess.ChildProcess | null = null;
let quitting = false;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("No port")),
      );
    });
  });

/** Runs the bundled server on Electron's own Node, so the app needs no separate runtime. */
const startServer = (port: number) =>
  new Promise<string>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [SERVER_ENTRY, "--port", String(port), "--web-root", WEB_ROOT],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    server = child;
    let started = false;
    const output: Array<string> = [];
    const collect = (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      output.push(text);
      if (output.length > 50) output.shift();
      // The server logs this once the HTTP listener is bound.
      if (!started && text.includes("Listening on")) {
        started = true;
        resolve(`http://127.0.0.1:${port}`);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("exit", (code) => {
      server = null;
      const reason = `The emulator server stopped (exit code ${code}).\n\n${output.join("").slice(-2000)}`;
      if (!started) reject(new Error(reason));
      else if (!quitting) {
        dialog.showErrorBox("Freematics Emulator", reason);
        app.quit();
      }
    });
    setTimeout(
      () => reject(new Error("The emulator server did not start in time.")),
      STARTUP_TIMEOUT_MS,
    );
  });

const createWindow = (url: string) => {
  const window = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 420,
    minHeight: 600,
    title: "Freematics Emulator",
    backgroundColor: "#111214",
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  window.once("ready-to-show", () => window.show());
  // Only the local server's pages load in the window; links leave for the system browser.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== new URL(url).origin) event.preventDefault();
  });
  void window.loadURL(url);
};

// A second instance would fight the first over the serial port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window === undefined) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    quitting = true;
    server?.kill();
  });

  void app.whenReady().then(async () => {
    try {
      // FME_DESKTOP_URL points the window at `pnpm dev` instead of the bundled server.
      const url = process.env.FME_DESKTOP_URL ?? (await startServer(await freePort()));
      createWindow(url);
    } catch (error) {
      quitting = true;
      server?.kill();
      dialog.showErrorBox(
        "Freematics Emulator",
        String(error instanceof Error ? error.message : error),
      );
      app.quit();
    }
  });
}
