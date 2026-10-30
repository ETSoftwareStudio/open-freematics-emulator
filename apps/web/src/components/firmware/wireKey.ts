const KEY_BYTES = 16;
/** Larger files are neither form of key, so they aren't read. */
export const MAX_KEY_FILE_BYTES = 256;

/**
 * The bootloader wire key from a key file as 32 lower-case hex digits: either the 16 raw bytes or
 * text holding exactly 32 hex digits. Null when the file is neither.
 */
export function parseWireKeyFile(bytes: Uint8Array): string | null {
  if (bytes.length === KEY_BYTES) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  if (bytes.length > MAX_KEY_FILE_BYTES) return null;
  const text = new TextDecoder().decode(bytes).trim();
  return /^[0-9a-f]{32}$/i.test(text) ? text.toLowerCase() : null;
}
