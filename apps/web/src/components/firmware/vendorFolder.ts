import { MAX_VENDOR_BINARY_LENGTH, type ImportVendorFilesInput } from "@fme/contracts";

type ImportFiles = (
  payload: ImportVendorFilesInput,
) => Promise<
  | { readonly ok: true; readonly value: { readonly imagesAdded: number } }
  | { readonly ok: false; readonly message: string }
>;

export interface FolderOutcome {
  readonly note: string;
  readonly error: boolean;
  readonly imported: boolean;
}

/** FirmwareUpdater.exe (for the key) and the firmware .hex files; the rest of the folder is skipped. */
const collectVendorFiles = async (
  files: ReadonlyArray<File>,
): Promise<ImportVendorFilesInput["files"]> => {
  const wanted = files
    .filter((file) => /^firmwareupdater\.exe$|\.hex$/i.test(file.name))
    .filter((file) => file.size <= MAX_VENDOR_BINARY_LENGTH)
    .slice(0, 32);
  return Promise.all(
    wanted.map(async (file) => ({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );
};

/** Reads the chosen folder and imports it. Never rejects, so the dialog always leaves its busy state. */
export const importVendorFolder = async (
  files: ReadonlyArray<File>,
  importFiles: ImportFiles,
): Promise<FolderOutcome> => {
  const collected = await collectVendorFiles(files).catch(() => null);
  if (collected === null) {
    return {
      note: "A file in that folder couldn't be read. Check it's still there and choose the folder again.",
      error: true,
      imported: false,
    };
  }
  if (collected.length === 0) {
    return {
      note: "That folder has no FirmwareUpdater.exe or firmware .hex files.",
      error: true,
      imported: false,
    };
  }
  const result = await importFiles({ files: collected }).catch(() => ({
    ok: false as const,
    message: "The Freematics files couldn't be imported.",
  }));
  if (!result.ok) return { note: result.message, error: true, imported: false };
  const added = result.value.imagesAdded;
  return {
    note:
      added === 0
        ? "No firmware images were in that folder."
        : `Found ${added} firmware ${added === 1 ? "image" : "images"}.`,
    error: false,
    imported: true,
  };
};
