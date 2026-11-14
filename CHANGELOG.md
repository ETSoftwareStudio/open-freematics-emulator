# Changelog

## [1.1.1](https://github.com/ETSoftwareStudio/open-freematics-emulator/compare/v1.1.0...v1.1.1) (2026-11-14)


### Bug Fixes

* **firmware:** protect a running firmware update ([#8](https://github.com/ETSoftwareStudio/open-freematics-emulator/issues/8)) ([3eeed26](https://github.com/ETSoftwareStudio/open-freematics-emulator/commit/3eeed26e7ee6404bb7d5b5c5090f0fa7cefd0aec))
* harden the local server guard and the release workflows ([#11](https://github.com/ETSoftwareStudio/open-freematics-emulator/issues/11)) ([77f0f48](https://github.com/ETSoftwareStudio/open-freematics-emulator/commit/77f0f48d3b3a640a993139f0a65066b39764ba0a))
* **server:** keep the session state in step with the device ([#9](https://github.com/ETSoftwareStudio/open-freematics-emulator/issues/9)) ([b04733c](https://github.com/ETSoftwareStudio/open-freematics-emulator/commit/b04733ced0221a3cbff85e95a4b2a16931cd3372))
* **web:** show server offline, stop watch list fights, fix gauge and port limits ([#12](https://github.com/ETSoftwareStudio/open-freematics-emulator/issues/12)) ([8c67aaa](https://github.com/ETSoftwareStudio/open-freematics-emulator/commit/8c67aaa1ff3508e5c23d2b521c039d8e0c3e8c93))

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
