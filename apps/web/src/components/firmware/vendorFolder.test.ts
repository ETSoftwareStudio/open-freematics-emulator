import type { ImportVendorFilesInput } from "@fme/contracts";
import { describe, expect, it } from "vite-plus/test";
import { importVendorFolder } from "./vendorFolder";

const IMAGE = "Firmware_MK2_20250311.hex";

describe("importVendorFolder", () => {
  it("reports an unreadable file without importing, then imports the folder once it reads", async () => {
    const calls: Array<ImportVendorFilesInput> = [];
    const importFiles = async (payload: ImportVendorFilesInput) => {
      calls.push(payload);
      return { ok: true as const, value: { keyFound: true, imagesAdded: 1 } };
    };
    const unreadable = Object.assign(new File([], IMAGE), {
      arrayBuffer: () => Promise.reject(new DOMException("gone", "NotReadableError")),
    });

    const failed = await importVendorFolder([unreadable], importFiles);
    expect(failed).toMatchObject({ error: true, imported: false });
    expect(failed.note).toMatch(/couldn't be read/);
    expect(calls).toEqual([]);

    const retried = await importVendorFolder([new File([":00000001FF"], IMAGE)], importFiles);
    expect(retried).toEqual({ note: "Found 1 firmware image.", error: false, imported: true });
    expect(calls.map((call) => call.files.map((file) => file.name))).toEqual([[IMAGE]]);
  });
});
