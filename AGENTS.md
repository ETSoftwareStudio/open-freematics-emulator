# Open Freematics Emulator

A local control app for the Freematics OBD-II Emulator MK2. A Rust server owns the USB serial link
and speaks the emulator's AT command set; a React web client drives it over typed RPC. The
conventions below are enforced by lint rules, clippy and the Effect language service. When in
doubt, follow the existing code and the internals docs.

## How it works

The client calls RPCs defined in `packages/contracts/src/rpc.ts` with Effect's RPC client.
`crates/fme-server/src/ws.rs` maps each one to a single `EmulatorSession` method. The session owns
the device state (a `watch` channel streamed to every client) and talks to the device through
`AtClient`, which serializes commands over a `DeviceLink`. A link is either the real serial port or
`SimulatedDevice`, an in-memory model of the MK2 firmware used in dev and tests.

`FirmwareUpdater` flashes the MK2 through its bootloader: after `ATR` it speaks encrypted command
frames (`crates/fme-server/src/firmware/`). The user picks their own Freematics folder once:
`WireKeyStore` takes the wire key from FirmwareUpdater.exe (the window matching the committed
SHA-256) and `FirmwareLibrary` keeps its firmware images, both in the local data dir. Neither is
ever in the repo or a shipped artifact, and nothing may address flash below `0x08003800`.

`ObdReader` is the other side of the emulator: it talks to an ELM327-compatible OBD-II adapter
plugged into the emulator's OBD port (Bluetooth SPP or USB as a serial port, Wi-Fi over TCP) and
polls what a scan tool would see, so every setting can be checked from the vehicle side.
`SimulatedDevice` also provides a simulated adapter that answers from the simulated firmware.
Both sides write to one `TrafficLog`.

## Where code lives

- `crates/` – the server. `fme-server` holds the services, the RPC table, HTTP and the `fme`
  binary; `fme-core` the pure helpers and wire types; `effect-rpc` Effect RPC's WebSocket protocol.
  Read [Rust services](docs/internals/rust-services.md) before adding server code.
- `apps/web` – React/Vite UI. Read [Web UI](docs/internals/web-ui.md) before adding UI, and
  `.repos/effect-smol/LLMS.md` for the Effect library itself.
- `apps/desktop-tauri` – Tauri 2 shell. Its crate runs `fme-server` in-process on a free loopback
  port and loads the web app from Tauri's own origin. Plain cargo commands skip it (it needs the
  webview libraries); lint it with `cargo clippy -p fme-desktop`. Keep it thin: features belong in
  the server or the UI.
- `packages/contracts` – Effect Schema contracts only. Anything crossing the wire is typed here.
  `vp run rs:fixtures` encodes fixtures from them that the Rust wire types must match.
- `packages/shared` – pure helpers with subpath exports and no barrel.
- `tools` – a script that drives a running server over RPC (`vp run hardware:check`), and the
  npm launcher with its stage and smoke scripts.
- `oxlint-plugin-fme` – custom lint rules that enforce the conventions below.
- `.repos/` – read-only reference sources (Effect v4 at the installed version). Never edit or
  import from them. Run `vp run sync:repos` if missing or after bumping `effect`.

## Protocol facts

- 38400 baud, 8N1. Commands and responses end with `\r` (sometimes `\r\n`).
- Commands answer `OK` or `ERROR`; `ATGET` answers one value line.
- `ATE0` and `ATINF0` on connect, as the official GUI does, so no echo or debug noise.
- The firmware cannot report most settings back, so server state is the last acknowledged value.
- PID 0101 byte A (MIL + stored DTC count) is derived from the Mode 03 codes.

## Taste

- Complexity belongs at the device-link boundary. The session stays readable, the UI stays dumb.
- Server features are services; transports stay thin. A `ws.rs` handler decodes input, calls one
  service method, and maps errors. [Rust services](docs/internals/rust-services.md) has the rest.
- Import Effect modules as namespaces from subpaths: `import * as Effect from "effect/Effect"`.
- Reusable Effect functions use `Effect.fn("Module.operation")`, not a function wrapping
  `Effect.gen`. Keep `Effect.gen` for inline programs.
- Errors are `Schema.TaggedError` with structured fields; messages never embed `cause`. Catch
  known tags with `Effect.catchTags`.
- Inferred types over annotations. `any` is the enemy.
- Default to no comment. Write one only for a constraint, an external quirk, or an invariant the
  code can't show, in one line where you can and four at most.
- React effects are for synchronizing with something outside React. Derive in render and act in
  handlers. An effect that stays states its reason with
  `// oxlint-disable-next-line fme/no-unreasoned-state-sync -- <why>`.
- If a rule here fights the task in front of you, say so and get a human sign-off before breaking
  it.

## Verifying

- `vp run check` runs format check, lint, typecheck and tests across the workspace, then
  `vp run rs:check` (rustfmt, clippy with warnings denied, cargo tests). Use `vp` for every
  JavaScript command (`vp run <script>`, `vp install`), not `pnpm`.
- While iterating: `vp test run <files>` from the owning package, `cargo test -p <crate> <filter>`,
  `vp lint`, `vp fmt`.
- Test rules live in [Testing](docs/internals/testing.md): no sleeps, polling, or wall-clock
  deltas.
- Server behavior changes ship with focused tests against the simulated device.
- `crates/fme-server/tests` assert the exact wire frames of every RPC, the raw protocol cases
  and the HTTP routes; a change to what goes over the wire updates them.
- To run the app and verify a change in the browser or on hardware, use the
  [test-emulator-app](.agents/skills/test-emulator-app/SKILL.md) skill.

## Commits and pull requests

- Conventional commit titles, plain language: `fix(server): reconnect after the port drops`.
- Never make a PR unless asked.
- Do not commit plans, research notes, or scratch files.
