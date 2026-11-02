import { describe, expect, it } from "vite-plus/test";
import { toInfo } from "./SerialPorts.ts";

const listed = (path: string, ids: { vendorId?: string; productId?: string; pnpId?: string }) => ({
  path,
  manufacturer: undefined,
  serialNumber: undefined,
  locationId: undefined,
  pnpId: ids.pnpId,
  vendorId: ids.vendorId,
  productId: ids.productId,
});

describe("toInfo", () => {
  it.each([
    ["darwin", listed("/dev/tty.usbserial-0001", { vendorId: "10C4", productId: "EA60" }), "usb"],
    ["darwin", listed("/dev/tty.OBDII", {}), "bluetooth"],
    ["linux", listed("/dev/ttyUSB0", { vendorId: "1a86", productId: "7523" }), "usb"],
    ["linux", listed("/dev/rfcomm0", {}), "bluetooth"],
    ["linux", listed("/dev/ttyS0", {}), "other"],
    [
      "win32",
      listed("COM5", { pnpId: "BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}" }),
      "bluetooth",
    ],
    ["win32", listed("COM3", { vendorId: "10C4", productId: "EA60" }), "usb"],
  ] as const)("on %s classifies %o as %s", (platform, port, transport) => {
    expect(toInfo(port, platform).transport).toBe(transport);
  });

  it("opens macOS ports through their call-up device", () => {
    const info = toInfo(
      listed("/dev/tty.usbserial-0001", { vendorId: "10C4", productId: "EA60" }),
      "darwin",
    );
    expect(info).toMatchObject({ path: "/dev/cu.usbserial-0001", likelyEmulator: true });
  });
});
