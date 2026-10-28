/**
 * Parsing for ELM327-compatible OBD-II adapters (the common Bluetooth and Wi-Fi dongles).
 * Assumes the adapter is set up with echo, line feeds and headers off (ATE0 ATL0 ATH0).
 */

/** Lines that mean the vehicle side did not answer. */
const NO_ANSWER = /NO DATA|UNABLE TO CONNECT|CAN ERROR|BUS ERROR|BUS INIT:.*ERROR|STOPPED|\?|ERROR/;

export const isNoAnswer = (lines: ReadonlyArray<string>) =>
  lines.every((line) => NO_ANSWER.test(line) || /SEARCHING/.test(line));

const hexTokens = (line: string) =>
  line
    .replace(/^\d+:\s*/, "")
    .split(/\s+/)
    .filter((token) => /^[0-9A-F]{2}$/i.test(token))
    .map((token) => Number.parseInt(token, 16));

/** Data bytes of a Mode 01 reply (`41 0C 1F 40` → `[0x1F, 0x40]`), from the first ECU that answered. */
export const parsePidReply = (
  lines: ReadonlyArray<string>,
  pid: string,
): ReadonlyArray<number> | undefined => {
  const pidByte = Number.parseInt(pid.slice(2), 16);
  for (const line of lines) {
    const bytes = hexTokens(line);
    if (bytes[0] === 0x41 && bytes[1] === pidByte) return bytes.slice(2);
  }
  return undefined;
};

const DTC_LETTERS = ["P", "C", "B", "U"] as const;

export const decodeDtc = (high: number, low: number) =>
  `${DTC_LETTERS[high >> 6]}${(high >> 4) & 0x3}${(high & 0xf).toString(16)}${low
    .toString(16)
    .padStart(2, "0")}`.toUpperCase();

/**
 * Codes from a Mode 03/07/0A reply. CAN replies carry a count byte after the service byte
 * (`43 02 01 05 03 00`); older buses send three code slots per line, zero-padded.
 */
export const parseDtcReply = (
  lines: ReadonlyArray<string>,
  service: number,
  isCan: boolean,
): ReadonlyArray<string> => {
  const codes: Array<string> = [];
  const replyByte = service + 0x40;
  for (const line of lines) {
    const bytes = hexTokens(line);
    if (bytes[0] !== replyByte) continue;
    const data = bytes.slice(isCan ? 2 : 1);
    for (let i = 0; i + 1 < data.length; i += 2) {
      const high = data[i]!;
      const low = data[i + 1]!;
      if (high !== 0 || low !== 0) codes.push(decodeDtc(high, low));
    }
  }
  return codes;
};

/**
 * The VIN from a Mode 09 PID 02 reply. CAN replies arrive as an ISO-TP sequence
 * (`014`, `0: 49 02 01 31 48 47`, `1: ...`); older buses as `49 02 0N` + 4 bytes per line.
 */
export const parseVinReply = (lines: ReadonlyArray<string>): string | undefined => {
  const bytes: Array<number> = [];
  for (const line of lines) {
    if (/^[0-9A-F]{3}$/i.test(line.trim())) continue;
    const tokens = hexTokens(line);
    bytes.push(...(tokens[0] === 0x49 && tokens[1] === 0x02 ? tokens.slice(3) : tokens));
  }
  const vin = String.fromCharCode(...bytes.filter((byte) => byte >= 0x30 && byte <= 0x5a));
  return vin.length >= 17 ? vin.slice(-17) : undefined;
};

/** Protocol numbers 6–9 (ATDPN) are CAN. `A6` means chosen automatically. */
export const isCanProtocol = (describeProtocolNumber: string) =>
  /^A?[6-9]$/i.test(describeProtocolNumber.trim());
