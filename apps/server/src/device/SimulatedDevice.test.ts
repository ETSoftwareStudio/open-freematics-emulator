import { describe, expect, it } from "@effect/vitest";
import { SIMULATED_BANNER, SimulatedFirmware } from "./SimulatedDevice.ts";

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
