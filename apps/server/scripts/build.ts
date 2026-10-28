/**
 * Bundles the server into `dist/bin.mjs` so it runs without the workspace (the desktop app ships
 * it). `serialport` stays external: it loads native prebuilds from its own package directory.
 */
import { build } from "vite-plus/pack";

await build({
  config: false,
  entry: ["src/bin.ts"],
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node24",
  deps: { neverBundle: ["serialport"], alwaysBundle: [/^(?!serialport)/], onlyBundle: false },
});
