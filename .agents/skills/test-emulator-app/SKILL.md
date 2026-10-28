---
name: test-emulator-app
description: Run the Freematics emulator app and verify a change end to end, against the simulated device or a real MK2 over USB. Use for browser verification of the web UI and for hardware checks.
---

# Test the emulator app

## Start it

Run `pnpm dev` from the repository root in the background and keep its terminal. Read the ports
from the `[dev-runner]` line (web 5738, server 3738 by default). Vite proxies `/ws` and `/api` to
the server, so open the web port only.

`node --watch` restarts the server when `apps/server/src` or `packages/` change. A restart drops
the device connection; reconnect from the UI before checking anything.

Stop what you started by the task or PID you recorded. Never kill by name or pattern.

## Pick a device

- **Simulated device** (connection bar) needs no hardware and replays the firmware behavior
  recorded from a V1.2 unit. Use it for UI work.
- **Real MK2**: `ls /dev/cu.*` should show `cu.usbserial-*` (CP2102) or `cu.wchusbserial*`
  (CH340). If nothing appears, the cable is charge-only or the 12 V supply is off; ask the user.
  Only one process can hold the port, so stop other servers before connecting from another one.

## Verify in the browser

Use the Browser panel tools. Open the web port, connect, change the control under test, then read
the value back from the device with the console's `ATGET` quick commands or by typing one. The
console shows every line sent and received, which is the ground truth: a UI change is verified
only when the matching `ATSET` got `OK` and `ATGET` returns the expected bytes.

Base UI sliders don't respond to automated drags. Focus the slider's range input and press
arrow, PageUp or End keys instead; that runs the same change and commit handlers.

## Verify against hardware without a browser

With the dev server connected to nothing, run `pnpm hardware:check` (or
`node apps/server/scripts/hardware-check.ts --port /dev/cu.X`). It drives every control over the
WebSocket RPC, reads each value back from the device, restores the state, and exits non-zero on
any mismatch.

Add `--reader /dev/cu.OBDII` (Bluetooth SPP) or `--reader 192.168.0.10:35000` (Wi-Fi) to also
check what an ELM327 adapter plugged into the emulator reads: live PIDs, stored codes and VIN.
A Bluetooth adapter only gets a `/dev/cu.*` port once it is paired in System Settings →
Bluetooth; a device that is merely listed there has no port.

## When the simulator is wrong

If real hardware answers differently from `SimulatedDevice`, the hardware wins: record the reply,
add it to the table in `SimulatedDevice.test.ts`, then fix the simulator.
