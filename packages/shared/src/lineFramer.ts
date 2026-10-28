/**
 * Splits the emulator's byte stream into lines. The firmware ends lines with `\r`,
 * sometimes followed by `\n`; blank lines carry nothing and are dropped.
 */
export const makeLineFramer = () => {
  let buffer = "";
  return (chunk: string): ReadonlyArray<string> => {
    buffer += chunk;
    const parts = buffer.split(/\r\n|\r|\n/);
    buffer = parts.pop() ?? "";
    return parts.map((line) => line.trim()).filter((line) => line.length > 0);
  };
};
