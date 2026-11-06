/**
 * Packages the app for x64 and arm64: dmg/zip (macOS), NSIS installer and zip (Windows),
 * AppImage/deb (Linux). Builds for this OS, or pass `--mac`, `--win`, `--linux`; `--dir` stops at
 * unpacked apps. Staged outside the pnpm workspace so it ships a plain npm `node_modules`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { build } from "electron-builder";

const root = NodePath.resolve(import.meta.dirname, "..");
const stage = NodePath.join(root, ".stage");
const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "package.json"), "utf8")) as {
  productName: string;
  version: string;
  description: string;
  homepage: string;
  dependencies: Record<string, string>;
  devDependencies: { electron: string };
};

if (!NodeFS.existsSync(NodePath.join(root, "dist/main.mjs"))) {
  console.error("Missing dist/main.mjs. Run `vp run desktop:dist` at the repo root.");
  process.exit(1);
}

NodeFS.rmSync(stage, { recursive: true, force: true });
NodeFS.mkdirSync(stage, { recursive: true });
NodeFS.cpSync(NodePath.join(root, "dist"), NodePath.join(stage, "dist"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(stage, "package.json"),
  JSON.stringify(
    {
      name: "open-freematics-emulator",
      productName: manifest.productName,
      version: manifest.version,
      description: manifest.description,
      homepage: manifest.homepage,
      author: "Elton Viana",
      desktopName: "open-freematics-emulator.desktop",
      type: "module",
      main: "dist/main.mjs",
      dependencies: manifest.dependencies,
    },
    null,
    2,
  ),
);
// serialport ships N-API prebuilds for every OS and arch, so one install serves every target.
NodeChildProcess.execFileSync(
  "npm",
  ["install", "--omit=dev", "--no-package-lock", "--no-audit", "--no-fund", "--ignore-scripts"],
  { cwd: stage, stdio: "inherit", shell: process.platform === "win32" },
);

const requested = {
  mac: process.argv.includes("--mac"),
  win: process.argv.includes("--win"),
  linux: process.argv.includes("--linux"),
};
const current = { darwin: "mac", win32: "win", linux: "linux" }[process.platform as string];
const anyRequested = requested.mac || requested.win || requested.linux;
const target = (platform: "mac" | "win" | "linux") =>
  (anyRequested ? requested[platform] : current === platform) ? { [platform]: [] } : {};

const BOTH: Array<"x64" | "arm64"> = ["x64", "arm64"];

await build({
  projectDir: stage,
  publish: "never",
  dir: process.argv.includes("--dir"),
  ...target("mac"),
  ...target("win"),
  ...target("linux"),
  config: {
    appId: "io.github.eltonvs.open-freematics-emulator",
    productName: manifest.productName,
    electronVersion: manifest.devDependencies.electron,
    // The server runs as its own Node process and loads serialport's native prebuild from disk.
    asar: false,
    npmRebuild: false,
    directories: {
      output: NodePath.join(root, "release"),
      buildResources: NodePath.join(root, "build"),
    },
    files: ["dist/**/*", "package.json", "node_modules/**/*"],
    mac: {
      target: [
        { target: "dmg", arch: BOTH },
        { target: "zip", arch: BOTH },
      ],
      category: "public.app-category.developer-tools",
      // Unsigned until there is a Developer ID; see the README.
      identity: null,
      extendInfo: {
        NSBluetoothAlwaysUsageDescription: "Connects to Bluetooth OBD-II adapters.",
      },
    },
    // The zip needs no Wine, so it also builds on machines that can't produce the installer.
    win: {
      target: [
        { target: "nsis", arch: BOTH },
        { target: "zip", arch: BOTH },
      ],
    },
    linux: {
      target: [
        { target: "AppImage", arch: BOTH },
        { target: "deb", arch: BOTH },
      ],
      category: "Development",
      maintainer: "Elton Viana",
      syncDesktopName: true,
    },
  },
});
