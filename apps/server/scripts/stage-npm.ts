// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - plain Node release tooling.
/**
 * Stages `open-freematics-emulator` (launcher + web app) and the platform package for `--target`
 * (default: this machine) with the Rust `fme` binary in `.stage/npm`, one directory each. Versions
 * are the desktop app's, so one tag releases them all.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const name = "open-freematics-emulator";
// Rust target → npm platform package suffix and its `os`/`cpu`/`libc` fields.
const platforms = {
  "aarch64-apple-darwin": { os: "darwin", cpu: "arm64" },
  "x86_64-apple-darwin": { os: "darwin", cpu: "x64" },
  "aarch64-unknown-linux-gnu": { os: "linux", cpu: "arm64", libc: "glibc" },
  "x86_64-unknown-linux-gnu": { os: "linux", cpu: "x64", libc: "glibc" },
  "aarch64-pc-windows-msvc": { os: "win32", cpu: "arm64" },
  "x86_64-pc-windows-msvc": { os: "win32", cpu: "x64" },
} as const;
const isTarget = (target: string): target is keyof typeof platforms =>
  Object.hasOwn(platforms, target);
const packageName = (platform: { os: string; cpu: string }) =>
  `${name}-${platform.os}-${platform.cpu}`;

const root = NodePath.resolve(import.meta.dirname, "..");
const repo = NodePath.resolve(root, "../..");
const stage = NodePath.join(root, ".stage/npm");

const { values } = NodeUtil.parseArgs({ options: { target: { type: "string" } } });
const target =
  values.target ??
  Object.entries(platforms).find(
    ([, platform]) => platform.os === process.platform && platform.cpu === process.arch,
  )?.[0];
if (target === undefined || !isTarget(target)) {
  console.error(`No npm platform package for ${target ?? `${process.platform}-${process.arch}`}.`);
  process.exit(1);
}

const readJson = (path: string) => JSON.parse(NodeFS.readFileSync(path, "utf8"));
const desktop = readJson(NodePath.join(repo, "apps/desktop/package.json")) as {
  version: string;
  productName: string;
};
const web = NodePath.join(repo, "apps/web/dist");
if (!NodeFS.existsSync(web)) {
  console.error(`Missing ${web}. Run \`vp run npm:stage\`, which builds it first.`);
  process.exit(1);
}

NodeChildProcess.execFileSync(
  "cargo",
  ["build", "--release", "--locked", "-p", "fme-server", "--bin", "fme", "--target", target],
  { cwd: repo, stdio: "inherit" },
);
const platform = platforms[target];
const exe = platform.os === "win32" ? "fme.exe" : "fme";
const binary = NodePath.join(repo, "target", target, "release", exe);

const url = "https://github.com/ETSoftwareStudio/open-freematics-emulator";
const common = {
  version: desktop.version,
  homepage: `${url}#readme`,
  bugs: `${url}/issues`,
  // npm provenance checks this against the repository that built the package.
  repository: { type: "git", url: `git+${url}.git` },
  license: "MIT",
  author: "ET Software Studio Inc.",
};
const writePackage = (
  directory: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
) => {
  NodeFS.rmSync(directory, { recursive: true, force: true });
  for (const [path, input] of Object.entries(files)) {
    NodeFS.cpSync(input, NodePath.join(directory, path), { recursive: true });
  }
  NodeFS.writeFileSync(
    NodePath.join(directory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
};

writePackage(
  NodePath.join(stage, name),
  {
    name,
    ...common,
    description: `${desktop.productName}: open-source app for the Freematics OBD-II Emulator MK2. Unofficial.`,
    keywords: ["freematics", "freematics-mk2", "obd2", "obd-ii", "obd-emulator", "elm327"],
    type: "module",
    bin: { [name]: "cli.mjs" },
    engines: { node: ">=20" },
    optionalDependencies: Object.fromEntries(
      Object.values(platforms).map((each) => [packageName(each), desktop.version]),
    ),
  },
  {
    "cli.mjs": NodePath.join(root, "npm/cli.mjs"),
    web,
    "README.md": NodePath.join(repo, "README.md"),
    LICENSE: NodePath.join(repo, "LICENSE"),
    "THIRD_PARTY_NOTICES.md": NodePath.join(repo, "THIRD_PARTY_NOTICES.md"),
  },
);

const platformDirectory = NodePath.join(stage, packageName(platform));
writePackage(
  platformDirectory,
  {
    name: packageName(platform),
    ...common,
    description: `The ${desktop.productName} server for ${platform.os}-${platform.cpu}. Install ${name} instead.`,
    os: [platform.os],
    cpu: [platform.cpu],
    ...("libc" in platform ? { libc: [platform.libc] } : {}),
    preferUnplugged: true,
  },
  { [`bin/${exe}`]: binary, LICENSE: NodePath.join(repo, "LICENSE") },
);
NodeFS.writeFileSync(
  NodePath.join(platformDirectory, "README.md"),
  `# ${packageName(platform)}\n\nThe \`fme\` server binary of [${name}](${url}) for ${platform.os}-${platform.cpu}. ` +
    `Run \`npx ${name}\`; npm picks this package for you.\n`,
);
NodeFS.chmodSync(NodePath.join(platformDirectory, "bin", exe), 0o755);

console.log(`Staged ${name}@${desktop.version} and ${packageName(platform)} in ${stage}`);
