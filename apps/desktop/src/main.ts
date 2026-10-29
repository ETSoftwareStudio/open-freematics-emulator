import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { APPEARANCE_CHANNELS, isAppearance, type Appearance } from "./appearance.ts";
import { readSettings, writeSettings } from "./settings.ts";

const SERVER_ENTRY = NodePath.join(import.meta.dirname, "server", "bin.mjs");
const WEB_ROOT = NodePath.join(import.meta.dirname, "web");
const ICON = NodePath.join(import.meta.dirname, "icon.png");
const PRELOAD = NodePath.join(import.meta.dirname, "preload.cjs");
const STARTUP_TIMEOUT_MS = 15_000;

let server: NodeChildProcess.ChildProcess | null = null;
let quitting = false;
let settings = readSettings();

const IS_MAC = process.platform === "darwin";
const TOOLBAR_HEIGHT = 52;
// These mirror the web app's --toolbar and --window tokens and its foreground, per theme.
const CHROME = {
  light: { window: "#f5f5f3", toolbar: "#e9e9e6", symbols: "#3d3d3a" },
  dark: { window: "#131312", toolbar: "#1d1d1b", symbols: "#ecebe6" },
};
const chromeColors = () => (nativeTheme.shouldUseDarkColors ? CHROME.dark : CHROME.light);
const titleBarOverlay = () => ({
  color: chromeColors().toolbar,
  symbolColor: chromeColors().symbols,
  height: TOOLBAR_HEIGHT,
});

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

const setAppearance = (appearance: Appearance) => {
  nativeTheme.themeSource = appearance;
  if (appearance === settings.appearance) return;
  settings = { ...settings, appearance };
  writeSettings(settings);
  buildMenu();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(APPEARANCE_CHANNELS.changed, appearance);
  }
};

const buildMenu = () => {
  const appearanceItem = (appearance: Appearance, label: string): MenuItemConstructorOptions => ({
    label,
    type: "radio",
    checked: settings.appearance === appearance,
    click: () => setAppearance(appearance),
  });
  const template: Array<MenuItemConstructorOptions> = [
    ...(IS_MAC
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : [{ label: "File", submenu: [{ role: "quit" }] } satisfies MenuItemConstructorOptions]),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Appearance",
          submenu: [
            appearanceItem("system", "System"),
            appearanceItem("light", "Light"),
            appearanceItem("dark", "Dark"),
          ],
        },
        { type: "separator" },
        ...(app.isPackaged
          ? []
          : ([
              { role: "reload" },
              { role: "forceReload" },
              { role: "toggleDevTools" },
              { type: "separator" },
            ] satisfies Array<MenuItemConstructorOptions>)),
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: IS_MAC
        ? []
        : [{ label: "About Freematics Emulator", click: () => app.showAboutPanel() }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

const createWindow = (url: string) => {
  const window = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Freematics Emulator",
    backgroundColor: chromeColors().window,
    icon: ICON,
    show: false,
    // The web toolbar is the title bar; it leaves room for the window buttons.
    ...(IS_MAC
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 20, y: 19 } }
      : { titleBarStyle: "hidden", titleBarOverlay: titleBarOverlay() }),
    webPreferences: { sandbox: true, contextIsolation: true, preload: PRELOAD },
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

  ipcMain.handle(APPEARANCE_CHANNELS.get, () => settings.appearance);
  ipcMain.handle(APPEARANCE_CHANNELS.set, (_event, appearance: unknown) => {
    if (isAppearance(appearance)) setAppearance(appearance);
  });
  nativeTheme.on("updated", () => {
    if (IS_MAC) return;
    for (const window of BrowserWindow.getAllWindows())
      window.setTitleBarOverlay(titleBarOverlay());
  });
  app.on("before-quit", () => {
    quitting = true;
    server?.kill();
  });

  app.setAboutPanelOptions({
    applicationName: "Freematics Emulator",
    credits:
      "An independent, unofficial app for the Freematics OBD-II Emulator MK2. " +
      "Not affiliated with, endorsed by or supported by Freematics.",
    copyright: "Developed by ET Software Studio Inc. · etsoftware.studio",
    website: "https://etsoftware.studio",
    iconPath: ICON,
  });

  nativeTheme.themeSource = settings.appearance;

  void app.whenReady().then(async () => {
    buildMenu();
    // Unpackaged runs live in the stock Electron bundle, whose Dock icon is Electron's.
    if (!app.isPackaged) app.dock?.setIcon(ICON);
    try {
      // FME_DESKTOP_URL points the window at the dev server instead of the bundled server.
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
