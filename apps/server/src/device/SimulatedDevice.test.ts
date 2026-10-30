import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { decodeReplyFrame, encodeCommandFrame } from "../firmware/bootloaderFrame.ts";
import { SIMULATED_BANNER, SimulatedBootloader, SimulatedFirmware } from "./SimulatedDevice.ts";

// Replies recorded from a real MK2 (firmware V1.2) over USB.
describe("SimulatedFirmware", () => {
  it.each([
    ["ATE0", "OK\r"],
    ["ATINF0", "OK\r"],
    ["ATGET 0101", "0101=00 07 65 00 \r"],
    ["ATGET 0105", "0105=00 \r"],
    ["ATGET 0142", "0142=00 00 \r"],
    ["ATGET 0120", "0120=FF FF FF FF \r"],
    ["ATGET 01FF", "01FF=\r"],
    ["ATSET 0105=-10", "ERROR\r"],
    ["ATSET CALID=ABC123", "ERROR\r"],
    ["ATGET CALID", "ERROR\r"],
    ["ATSET DTC7=P0300", "ERROR\r"],
    ["ATSET DTCA=U0100", "ERROR\r"],
    ["ATSET DTC=X123", "ERROR\r"],
    ["ATSET DTC=P0105,P0106", "OK\r"],
    ["ATGET DTC", "ERROR\r"],
    ["ATBUS FOO", "ERROR\r"],
    ["ATGET BUS", "ERROR\r"],
    ["ATBOGUS", "ERROR\r"],
    ["ATGET VIN", "1HGCD5654VA061985\r\n"],
    ["atget vin", "1HGCD5654VA061985\r\n"],
  ])("answers %s like the firmware", (command, reply) => {
    expect(new SimulatedFirmware().handle(command)).toBe(reply);
  });

  it("stores raw and decimal PID values", () => {
    const firmware = new SimulatedFirmware();
    expect(firmware.handle("ATSET 010C=0x1F,0x40")).toBe("OK\r");
    expect(firmware.handle("ATGET 010C")).toBe("010C=1F 40 \r");
    expect(firmware.handle("ATSET 0142=13.8")).toBe("OK\r");
    expect(firmware.handle("ATGET 0142")).toBe("0142=35 E8 \r");
  });

  it("echoes commands while echo is on", () => {
    const firmware = new SimulatedFirmware();
    firmware.handle("ATE1");
    expect(firmware.handle("ATGET BUS")).toBe("ATGET BUS\rERROR\r");
  });

  it("zeroes PIDs and prints the banner on reset", () => {
    const firmware = new SimulatedFirmware();
    firmware.handle("ATSET 010C=2000");
    const reply = firmware.handle("ATZ");
    expect(reply.startsWith(`${SIMULATED_BANNER}\r\n${SIMULATED_BANNER}\r\n`)).toBe(true);
    expect(reply.endsWith(",1HGCD5654VA061985\r\n")).toBe(true);
    expect(firmware.handle("ATGET 010C")).toBe("010C=00 00 \r");
  });
});

// Replies a real MK2 V1.2 bootloader gave a read-only probe on 2026-10-30.
describe("SimulatedBootloader", () => {
  const text = (data: string) => Buffer.from(data, "latin1");
  const said = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

  it("answers the handshake only after a reset arms it", () => {
    const bootloader = new SimulatedBootloader();
    expect(bootloader.mode).toBe("off");
    bootloader.mode = "armed";
    expect(said(bootloader.receive(text("***")))).toBe(">>>");
    expect(said(bootloader.receive(text("Download?")))).toBe("OK.");
  });

  it("reports 128 KiB of flash and a 12-byte chip ID", () => {
    const bootloader = new SimulatedBootloader();
    bootloader.mode = "armed";
    bootloader.receive(text("***Download?"));
    const reply = bootloader.receive(
      encodeCommandFrame(0x00, new Uint8Array(), bootloader.wireKey),
    );
    const { command, payload } = Result.getOrThrow(decodeReplyFrame(reply));
    expect(command).toBe(0x00);
    expect([payload[0], payload[1], payload.length]).toEqual([0x00, 0x80, 14]);
  });
});
