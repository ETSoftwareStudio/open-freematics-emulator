# Changelog

## [1.1.0](https://github.com/ETSoftwareStudio/open-freematics-emulator/compare/v1.0.2...v1.1.0) (2026-11-09)


### Features

* port the server to Rust and add a Tauri desktop shell ([#5](https://github.com/ETSoftwareStudio/open-freematics-emulator/issues/5)) ([0c4dd3c](https://github.com/ETSoftwareStudio/open-freematics-emulator/commit/0c4dd3cfd0b40afbe8f39c27a448a1581492be1f))

## [1.0.2](https://github.com/ETSoftwareStudio/open-freematics-emulator/compare/v1.0.1...v1.0.2) (2026-11-08)


### Bug Fixes

* **desktop:** keep saved UI state across launches ([#2](https://github.com/ETSoftwareStudio/open-freematics-emulator/issues/2)) ([6646b60](https://github.com/ETSoftwareStudio/open-freematics-emulator/commit/6646b6049118f6e25bca43f2b15d7ae18f321e66))

## [1.0.1](https://github.com/ETSoftwareStudio/open-freematics-emulator/compare/v1.0.0...v1.0.1) (2026-11-06)

No app changes. The npm package is now published with npm trusted publishing, so it carries
provenance.

## 1.0.0 (2026-11-06)

First public release.

### Features

* Control a Freematics OBD-II Emulator MK2 over USB: protocol, PIDs, trouble codes, VIN and
  supply voltage, from a desktop app or a browser.
* Instrument cluster: drag a gauge or type a value to set it, with warning lamps and the scan
  tool's read-back on the same dial.
* Scan tool screen: read every setting back through an ELM327 adapter (Bluetooth, USB or Wi-Fi)
  plugged into the emulator, as a real scan tool would.
* Driving-scenario presets, named trouble codes, and firmware-aware locks for what the MK2's
  firmware can't do.
* Update the MK2's firmware from the app with the official Freematics images, on any OS.
* Simulated MK2 and adapter, so the app runs without hardware.
* Installers for macOS (signed and notarized), Windows and Linux, `npx open-freematics-emulator`,
  and a Homebrew cask.

### Bug Fixes

* **server:** only accept requests from the app's own page.
* **desktop:** give the Mac app a valid signature.
