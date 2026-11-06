// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - plain Node release tooling.
/**
 * Stages the npm package (`npx open-freematics-emulator`) in `.stage/npm`: the bundled server, the
 * built web app and `npm/cli.mjs`, which starts one on the other. Run `vp run build` at the repo
 * root first. The version is the desktop app's, so one tag releases both.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "..");
const repo = NodePath.resolve(root, "../..");
const stage = NodePath.join(root, ".stage/npm");
const readJson = (path: string) => JSON.parse(NodeFS.readFileSync(path, "utf8"));
const server = readJson(NodePath.join(root, "package.json")) as {
  dependencies: Record<string, string>;
};
const desktop = readJson(NodePath.join(repo, "apps/desktop/package.json")) as {
  version: string;
  productName: string;
};
const rootManifest = readJson(NodePath.join(repo, "package.json")) as {
  engines: { node: string };
};

const inputs = {
  "server/bin.mjs": NodePath.join(root, "dist/bin.mjs"),
  web: NodePath.join(repo, "apps/web/dist"),
  "cli.mjs": NodePath.join(root, "npm/cli.mjs"),
  "README.md": NodePath.join(repo, "README.md"),
  LICENSE: NodePath.join(repo, "LICENSE"),
  "THIRD_PARTY_NOTICES.md": NodePath.join(repo, "THIRD_PARTY_NOTICES.md"),
};
for (const input of Object.values(inputs)) {
  if (!NodeFS.existsSync(input)) {
    console.error(`Missing ${input}. Run \`vp run build\` at the repo root first.`);
    process.exit(1);
  }
}

NodeFS.rmSync(stage, { recursive: true, force: true });
for (const [target, input] of Object.entries(inputs)) {
  NodeFS.cpSync(input, NodePath.join(stage, target), { recursive: true });
}

const external = ["serialport", "7z-wasm"];
const url = "https://github.com/ETSoftwareStudio/open-freematics-emulator";
NodeFS.writeFileSync(
  NodePath.join(stage, "package.json"),
  `${JSON.stringify(
    {
      name: "open-freematics-emulator",
      version: desktop.version,
      description: `${desktop.productName}: open-source app for the Freematics OBD-II Emulator MK2. Unofficial.`,
      keywords: ["freematics", "freematics-mk2", "obd2", "obd-ii", "obd-emulator", "elm327"],
      homepage: `${url}#readme`,
      bugs: `${url}/issues`,
      repository: { type: "git", url: `git+${url}.git` },
      license: "MIT",
      author: "ET Software Studio Inc.",
      type: "module",
      bin: { "open-freematics-emulator": "cli.mjs" },
      engines: rootManifest.engines,
      dependencies: Object.fromEntries(external.map((name) => [name, server.dependencies[name]])),
    },
    null,
    2,
  )}\n`,
);
console.log(`Staged open-freematics-emulator@${desktop.version} in ${stage}`);
