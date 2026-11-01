<img src="assets/icon.svg" width="64" height="64" alt="">

# freematics-emulator

A modern control app for the [Freematics OBD-II Emulator MK2](https://freematics.com/products/freematics-obd-emulator-mk2/).
It replaces the Windows-only GUI with a local server that owns the USB serial link and a web UI
that drives it, on macOS, Linux and Windows.

Under the hood: a Node WebSocket server built from Effect services, and typed RPC contracts
shared with a React client.

> [!NOTE]
> This is an independent, unofficial project. It is not affiliated with, endorsed by or
> supported by Freematics. Freematics and product names are trademarks of their owner, used here
> only to say which device the app works with.

## Quick start

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

The desktop app (Electron) runs on macOS, Windows and Linux, x64 and arm64. It bundles the server
and the UI; nothing else needs to be installed.

```sh
vp run desktop:dev            # dev server + app window, with hot reload
vp run desktop                # build and open the app
vp run desktop:dist           # installers for this OS into apps/desktop/release
vp run desktop:dist --win     # or --mac, --linux; --dir for unpacked apps only
vp run @fme/desktop#smoke     # check the packaged app for this OS
```

| OS      | Output                                                          |
| ------- | --------------------------------------------------------------- |
| macOS   | `.dmg` and `.zip` (unsigned: right-click → Open the first time) |
| Windows | NSIS installer `.exe` and a portable `.zip`                     |
| Linux   | `.AppImage` and `.deb`                                          |

Each OS builds its own installers best; the `Desktop` GitHub workflow does that on macOS, Windows
and Linux runners, smoke-tests each package and uploads them. From an Apple Silicon Mac, Linux
packages also build in Docker with `electronuserland/builder:wine`. The Windows installer step
needs Wine and fails there without Rosetta; `--win` still produces the zip.

On Linux, add yourself to the `dialout` group (`sudo usermod -aG dialout $USER`, then log in
again) to open serial ports; port discovery uses `udevadm`, which desktop distros ship.

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
3. **Server** – `apps/server`: a USB serial device link, a simulated MK2 that matches the measured
   firmware behavior, a serialized AT client with timeouts and a traffic log, and an
   `EmulatorSession` service that owns device state. Thin WebSocket RPC on top. ✅
4. **Web UI** – `apps/web`: connection bar, ignition and protocol, PID controls, DTCs, VIN,
   readiness monitors, raw AT console with traffic log. ✅
5. **Verified end to end** – the app running against the real emulator over USB, every control
   checked by reading the value back from the device. ✅ (`vp run hardware:check`: 20/20 on a V1.2
   unit and again after flashing it to V1.3; UI driven in the browser against the same unit.)
6. **Firmware updates** – flash an official image through the MK2's bootloader from the Firmware
   inspector, with no Windows updater. ✅ (A real unit taken from V1.2 to V1.3.) You supply the
   `.hex` from Freematics' GUI package and the bootloader's 16-byte wire key; the key is checked
   against a known hash, used for that update only, and never stored. Nothing addresses flash
   below `0x08003800`, where the vendor bootloader lives.

**Additional: wireless.**

7. **Scan tool read-back** – connect an ELM327-compatible OBD-II adapter plugged into the
   emulator (Bluetooth SPP, Wi-Fi or USB) and see what a vehicle reader gets: live PID values next
   to each control, stored codes, VIN, detected protocol. ✅ with the simulated adapter and a
   real Bluetooth ELM327 (`vp run hardware:check --reader /dev/cu.OBDII`, 24/24). On macOS the
   adapter's port only answers once the Bluetooth link is connected.
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
- On macOS, `serialport`'s kqueue poller never fires for the CP210x driver; the server reads the
  port through Node's TTY stream instead.

## Layout

```
apps/server         Node server: serial link, AT client, emulator session, WebSocket RPC, static web
apps/web            React + Vite client
packages/contracts  Effect Schema contracts shared by server and web
packages/shared     Pure protocol helpers (subpath exports, no barrel)
oxlint-plugin-fme   Lint rules that enforce the Effect and testing conventions
docs/internals      Conventions for contributors and agents (start from AGENTS.md)
```

## Scripts

| Command              | What it does                                        |
| -------------------- | --------------------------------------------------- |
| `vp run dev`         | Server (watch) and Vite dev server together         |
| `vp run desktop:dev` | The same, plus the desktop window on the dev server |
| `vp run build`       | Builds the web app and the server bundle            |
| `vp run start`       | Runs the built server, which also serves the web UI |
| `vp run test`        | Runs every package's tests                          |
| `vp run typecheck`   | Type-checks every package                           |
| `vp run check`       | Format check, lint, typecheck and tests             |
