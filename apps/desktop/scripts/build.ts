/**
 * Bundles the Electron main process into `dist/` and copies in the bundled server and the built
 * web app. Run `vp run build` at the root first; it produces both. `--main-only` skips them for
 * `vp run desktop:dev`, where the window loads the dev server instead.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { build } from "vite-plus/pack";

const root = NodePath.resolve(import.meta.dirname, "..");
const serverBundle = NodePath.resolve(root, "../server/dist/bin.mjs");
const webDist = NodePath.resolve(root, "../web/dist");
const mainOnly = process.argv.includes("--main-only");

for (const input of mainOnly ? [] : [serverBundle, webDist]) {
  if (!NodeFS.existsSync(input)) {
    console.error(`Missing ${input}. Run \`vp run build\` at the repo root first.`);
    process.exit(1);
  }
}

process.chdir(root);
await build({
  config: false,
  entry: ["src/main.ts"],
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node24",
  clean: true,
  deps: { neverBundle: ["electron"] },
});
// Sandboxed preloads must be CommonJS.
await build({
  config: false,
  entry: ["src/preload.ts"],
  outDir: "dist",
  format: "cjs",
  platform: "node",
  target: "node24",
  clean: false,
  deps: { neverBundle: ["electron"] },
});

NodeFS.cpSync(NodePath.join(root, "build/icon.png"), NodePath.join(root, "dist/icon.png"));
if (!mainOnly) {
  NodeFS.cpSync(serverBundle, NodePath.join(root, "dist/server/bin.mjs"));
  NodeFS.cpSync(webDist, NodePath.join(root, "dist/web"), { recursive: true });
}
