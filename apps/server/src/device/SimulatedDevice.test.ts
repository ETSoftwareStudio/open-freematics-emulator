import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { decodeReplyFrame, encodeCommandFrame } from "../firmware/bootloaderFrame.ts";
import {
  SimulatedBootloader,
  SimulatedElm327,
  SimulatedFirmware,
  simulatedBanner,
} from "./SimulatedDevice.ts";

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
    expect(new SimulatedFirmware("1.2").handle(command)).toBe(reply);
  });

  // Replies the same unit gave after it was flashed to V1.3 on 2026-10-30.
  it.each([
    ["ATGET VIN", "LSGGG54EXE105928\r\n"],
    ["ATGET CALID", "JMB*36761500\r\n"],
    ["ATSET DTC7=P0300", "OK\r"],
    ["ATSET DTCA=U0100", "OK\r"],
  ])("answers %s like V1.3", (command, reply) => {
    expect(new SimulatedFirmware("1.3").handle(command)).toBe(reply);
  });

  it("prints V1.3's extra line after the info line on restart", () => {
    const reply = new SimulatedFirmware("1.3").handle("ATR");
    expect(reply).toContain(`${simulatedBanner("1.3")}\r\n00.00.02,00.01.08,`);
    expect(reply.endsWith(",LSGGG54EXE105928\r\nSPN:00\r\n")).toBe(true);
  });

  it("reports pending and permanent codes to a scan tool on V1.3", () => {
    const firmware = new SimulatedFirmware("1.3");
    const adapter = new SimulatedElm327(firmware);
    firmware.handle("ATSET DTC7=P0300,P0420");
    firmware.handle("ATSET DTCA=U0100");
    expect(adapter.handle("07")).toBe("47 02 03 00 04 20\r\r>");
    expect(adapter.handle("0A")).toBe("4A 01 C1 00\r\r>");
    expect(adapter.handle("04")).toBe("44\r\r>");
    expect([firmware.pendingDtcs, firmware.permanentDtcs]).toEqual([[], ["U0100"]]);
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
    const firmware = new SimulatedFirmware("1.2");
    firmware.handle("ATSET 010C=2000");
    const reply = firmware.handle("ATZ");
    const banner = simulatedBanner("1.2");
    expect(reply.startsWith(`${banner}\r\n${banner}\r\n`)).toBe(true);
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
