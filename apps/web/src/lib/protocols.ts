import type { ObdProtocol } from "@fme/contracts";

export const PROTOCOLS: ReadonlyArray<{ value: ObdProtocol; label: string }> = [
  { value: "CAN_11B_500K", label: "CAN 11-bit 500 kbps" },
  { value: "CAN_11B_250K", label: "CAN 11-bit 250 kbps" },
  { value: "CAN_29B_500K", label: "CAN 29-bit 500 kbps" },
  { value: "CAN_29B_250K", label: "CAN 29-bit 250 kbps" },
  { value: "ISO9141_2", label: "ISO 9141-2" },
  { value: "KWP2000_FAST", label: "KWP2000 fast" },
  { value: "KWP2000_5BPS", label: "KWP2000 5 baud" },
  { value: "J1850_PWM", label: "J1850 PWM" },
  { value: "J1850_VPW", label: "J1850 VPW" },
  { value: "J1939", label: "J1939" },
];

export const protocolLabel = (protocol: ObdProtocol) =>
  PROTOCOLS.find((candidate) => candidate.value === protocol)?.label ?? protocol;
