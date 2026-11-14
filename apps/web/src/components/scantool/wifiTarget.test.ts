import { describe, expect, it } from "vite-plus/test";
import { wifiTarget } from "./wifiTarget.ts";

describe("Wi-Fi adapter target", () => {
  it("accepts a host and a port the contract allows", () => {
    expect(wifiTarget(" 192.168.0.10 ", "35000")).toEqual({
      _tag: "tcp",
      host: "192.168.0.10",
      port: 35000,
    });
    expect(wifiTarget("obd.local", "1")?.port).toBe(1);
    expect(wifiTarget("obd.local", " 65535 ")?.port).toBe(65535);
  });

  it("refuses ports outside 1 to 65535 and anything but digits", () => {
    for (const port of ["0", "65536", "70000", "1e9", "1e3", "0x50", "80.0", "-1", "+80", ""]) {
      expect(wifiTarget("192.168.0.10", port), port).toBeNull();
    }
  });

  it("refuses an empty host", () => {
    expect(wifiTarget("  ", "35000")).toBeNull();
  });
});
