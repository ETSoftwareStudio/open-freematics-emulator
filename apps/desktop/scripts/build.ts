/**
 * Bundles the Electron main process into `dist/` and copies in the bundled server and the built
 * web app. Run `pnpm build` at the root first; it produces both.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { build } from "vite-plus/pack";

const root = NodePath.resolve(import.meta.dirname, "..");
const serverBundle = NodePath.resolve(root, "../server/dist/bin.mjs");
const webDist = NodePath.resolve(root, "../web/dist");

for (const input of [serverBundle, webDist]) {
  if (!NodeFS.existsSync(input)) {
    console.error(`Missing ${input}. Run \`pnpm build\` at the repo root first.`);
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

NodeFS.cpSync(serverBundle, NodePath.join(root, "dist/server/bin.mjs"));
NodeFS.cpSync(webDist, NodePath.join(root, "dist/web"), { recursive: true });
