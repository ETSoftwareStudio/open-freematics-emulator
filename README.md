<img src="assets/icon.svg" width="64" height="64" alt="">

# Open Freematics Emulator

[![Release](https://img.shields.io/github/v/release/ETSoftwareStudio/open-freematics-emulator)](https://github.com/ETSoftwareStudio/open-freematics-emulator/releases/latest)
[![npm](https://img.shields.io/npm/v/open-freematics-emulator)](https://www.npmjs.com/package/open-freematics-emulator)
[![CI](https://github.com/ETSoftwareStudio/open-freematics-emulator/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ETSoftwareStudio/open-freematics-emulator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/ETSoftwareStudio/open-freematics-emulator)](LICENSE)

A modern control app for the [Freematics OBD-II Emulator MK2](https://freematics.com/products/freematics-obd-emulator-mk2/).
It replaces the Windows-only GUI with a local server that owns the USB serial link and a web UI
that drives it, on macOS, Linux and Windows.

Under the hood: a Rust server that speaks Effect RPC over a WebSocket, and typed Effect Schema
contracts shared with a React client.

> [!NOTE]
> This is an independent, unofficial, open-source project; "Open" in the name means open source.
> It is not affiliated with, endorsed by or supported by Freematics. Freematics and its product
> names are trademarks of their owner, used here only to say which device the app works with.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/emulator-dark.png">
  <img src="docs/media/emulator-light.png" alt="The Emulator screen: RPM and speed gauges, warning lamps, scenario presets, the PID inspector and the AT console">
</picture>

The **Emulator** screen sets what the car reports: drag or type on the gauges, apply a scenario
preset, add trouble codes, and watch every AT command in the console.

![A short tour: dragging the RPM, speed, fuel and coolant needles around their dials, applying presets, then the scan tool reading the same values back](docs/media/demo.gif)

The **Scan tool** screen reads it all back through an ELM327 adapter plugged into the emulator,
the way a real OBD-II reader would, and flags any value that doesn't match.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/scan-tool-dark.png">
  <img src="docs/media/scan-tool-light.png" alt="The Scan tool screen: live PID readback with Match results, trouble codes, readiness and the adapter traffic log">
</picture>

## Install

- **macOS:** `brew install --cask etsoftwarestudio/tap/open-freematics-emulator`
- **Desktop installers** for x64 and arm64 on the
  [Releases page](https://github.com/ETSoftwareStudio/open-freematics-emulator/releases/latest):
  `.dmg` for macOS, the `-setup.exe` or `.msi` for Windows, and `.deb` or `.AppImage` for Linux.
  `SHA256SUMS.txt` lists their checksums.
- **macOS, Windows, Linux (x64 or arm64) with Node.js 20 or later:** `npx open-freematics-emulator`
  starts the app and opens it in your browser. Linux needs glibc and `libudev1`, which desktop
  distros ship.

The macOS app is signed and notarized. The Windows installer isn't code-signed yet, so Windows
warns the first time you run it: click **More info → Run anyway**.

## Quick start

Needs Node.js 24 and a Rust toolchain (on Linux also `libudev-dev`). With rustup, cargo installs
the version `rust-toolchain.toml` pins.

```sh
vp install
vp run dev          # server on :3738 + web on :5738, open http://localhost:5738
```

To run it without the dev tooling, build the UI once and let the server serve it:

```sh
vp run build
vp run start        # open http://localhost:3738
```

## Desktop app

The desktop app (Tauri) runs on macOS, Windows and Linux, x64 and arm64. It runs the server
in-process and shows the UI in the system webview; nothing else needs to be installed.

```sh
vp run desktop:dev                # app window on the Vite dev server, with hot reload
vp run desktop                    # build and open the app
vp run desktop:dist               # installers for this OS into target/release/bundle
vp run @fme/desktop-tauri#smoke   # check the packaged app for this OS
```

| OS      | Output                            |
| ------- | --------------------------------- |
| macOS   | `.app` and `.dmg` (ad-hoc signed) |
| Windows | NSIS installer `.exe` and `.msi`  |
| Linux   | `.deb` and `.AppImage`            |

Each OS builds its own installers; the `Desktop (Tauri)` GitHub workflow does that on a runner
per OS and architecture, smoke-tests each package and uploads them, and each release publishes
them (see [RELEASING.md](RELEASING.md)). Linux builds need the
WebKitGTK development packages the workflow installs.

On Linux, add yourself to the `dialout` group (`sudo usermod -aG dialout $USER`, then log in
again) to open serial ports; port discovery uses libudev, which desktop distros ship.

Verify a connected MK2 end to end (every control set over RPC and read back from the device):

```sh
vp run hardware:check   # with vp run dev running
```

No hardware? Pick **Simulated device** in the connection bar. It behaves like a V1.3 unit, AT
commands and bootloader both, so everything in the UI works end to end, firmware updates included.

With hardware: power the emulator from its 12 V adapter, plug in USB with a data cable, and pick
its port. Current units use a CP2102 bridge (`/dev/cu.usbserial-*` on macOS), older ones a CH340
(`/dev/cu.wchusbserial*`); macOS ships drivers for both.

## Firmware import

Open **Update Firmware…** and choose **Download from Freematics…** to fetch the official GUI
package directly from Freematics. The app checks its pinned SHA-256, unpacks only the updater
and firmware images without executing Windows code, and imports the wire key and images into
its local data directory. Vendor files and keys are not bundled with this app. The temporary
installer is deleted after import. If Freematics replaces the package, verification fails closed;
**Import folder…** remains available for an installed or unpacked copy.

Importing does not flash anything. Updating the selected device still requires the separate
**Erase and Update** confirmation. Simulated updates do not validate real-device behavior.

## Goals

**Primary: full control of the MK2 over USB**, verified against real hardware.

1. **Typed contracts** – `packages/contracts`: emulator state, inputs, errors and the WebSocket RPC
   group as Effect Schemas. ✅
2. **Protocol core** – `packages/shared`: AT command builders, line framing, the PID catalog with
   SAE J1979 encoders, PID 0101 readiness encoding. ✅
3. **Server** – `crates/fme-server` (Rust): a USB serial device link, a simulated MK2 that
   matches the measured firmware behavior, a serialized AT client with timeouts and a traffic log,
   and an `EmulatorSession` service that owns device state. Thin WebSocket RPC on top. ✅
4. **Web UI** – `apps/web`: connection bar, ignition and protocol, PID controls, DTCs, VIN,
   readiness monitors, raw AT console with traffic log. ✅
5. **Verified end to end** – the app running against the real emulator over USB, every control
   checked by reading the value back from the device. ✅ (`vp run hardware:check`: 20/20 on a V1.2
   unit and again after flashing it to V1.3; UI driven in the browser against the same unit.)
6. **Firmware updates** – flash an official image through the MK2's bootloader from the Firmware
   inspector, with no Windows updater. ✅ (A real unit taken from V1.2 to V1.3.) The images and
   the bootloader's 16-byte wire key come from Freematics' own GUI package (see
   [Firmware import](#firmware-import)); the key is checked against a known hash and kept only in
   the app's local data directory, never in this repo or a release. Nothing addresses flash below
   `0x08003800`, where the vendor bootloader lives.

**Additional: wireless.**

7. **Scan tool read-back** – connect an ELM327-compatible OBD-II adapter plugged into the
   emulator (Bluetooth SPP, Wi-Fi or USB) and see what a vehicle reader gets: live PID values next
   to each control, stored codes, VIN, detected protocol. ✅ with the simulated adapter and a
   real Bluetooth ELM327 (`vp run hardware:check --reader /dev/cu.OBDII`, 24/24). On macOS the
   adapter's port only answers once the Bluetooth link is connected. macOS also stops serving a
   Bluetooth serial port after its first close, so the app keeps the adapter's port open while
   it runs: disconnecting and reconnecting works. After restarting the app, if the adapter
   doesn't answer, forget it in System Settings → Bluetooth and pair it again.
8. **Emulator over BLE** – manage the MK2 through its built-in BLE serial link instead of USB.

**Later:** drive-cycle scenarios (scripted PID streams).

## Firmware notes (measured on one unit, on V1.2 and after updating it to V1.3)

- 38400 8N1 over a CP2102 (newer units) or CH340 bridge. Lines end in `\r`; `ATGET VIN` ends in
  `\r\n`. `ATGET <pid>` answers `010C=1F 40 `.
- Decimal `ATSET` truncates instead of rounding, rejects negatives, and mis-converts 015E, so the
  app always sends raw bytes from its own SAE encoders.
- `ATZ`/`ATR` reset every PID to zero and print `OBD-II EMULATOR V1.x` plus an info line
  (`<fw>,<hw>,<YYYYMM>,<serial>,<vin>`). The date is the unit's, not the firmware's: it didn't
  change with the update.
- V1.2: `ATGET BUS`, CALID and Mode 07/0A DTCs answer `ERROR`.
- V1.3: CALID (default `JMB*36761500`) and Mode 07/0A DTCs work, an `SPN:00` line follows the
  info line, and the default VIN `LSGGG54EXE105928` has 16 characters, so the app shows it but
  won't set it back.
- `ATR` restarts into the bootloader, which answers `***` with `>>>` (and ignores it otherwise).
  Updates use AES-128-ECB command frames and clear replies; the simulated device models both.
- On macOS the CP210x driver never wakes kqueue, so the server reads the port with blocking reads
  that time out in the driver (`VMIN 0`, `VTIME 1`) instead of waiting for readiness.
- On macOS (27.2), `bluetoothd` serves a Bluetooth SPP port (`/dev/cu.OBDII`) once per pairing.
  After the first close, opens still succeed but no byte ever comes back until the adapter is
  paired again. The server holds those ports open until it stops, and says so when the first
  open of one hears nothing.

## Layout

```
crates/fme-server   Rust server: serial link, AT client, emulator session, WebSocket RPC, static web
crates/fme-core     Pure protocol helpers and wire types the server builds on
crates/effect-rpc   Effect RPC's WebSocket protocol for Rust
apps/web            React + Vite client
apps/desktop-tauri  Tauri desktop shell that runs the server in-process
packages/contracts  Effect Schema contracts shared by server and web
packages/shared     Pure protocol helpers (subpath exports, no barrel)
tools               Hardware check, the npm launcher and its packaging
oxlint-plugin-fme   Lint rules that enforce the Effect and testing conventions
docs/internals      Conventions for contributors and agents (start from AGENTS.md)
```

## Scripts

| Command                 | What it does                                                 |
| ----------------------- | ------------------------------------------------------------ |
| `vp run dev`            | Rust server and Vite dev server together                     |
| `vp run desktop:dev`    | The desktop app on the Vite dev server                       |
| `vp run build`          | Builds the web app and the release server                    |
| `vp run start`          | Runs the release server, which also serves the web UI        |
| `vp run test`           | Runs every package's tests                                   |
| `vp run typecheck`      | Type-checks every package                                    |
| `vp run check`          | Format check, lint, typecheck and tests, TypeScript and Rust |
| `vp run hardware:check` | Checks a connected MK2 over RPC (with `vp run dev` running)  |
| `vp run npm:stage`      | Stages the npx packages in `.stage/npm`                      |
| `vp run npm:smoke`      | Installs and runs the staged packages as npx would           |

Releases: see [RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE). Portions are derived from other MIT-licensed software; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
