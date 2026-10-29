import type { TrafficEntry } from "@fme/contracts";

export interface Ack {
  readonly command: string;
  readonly latencyMs: number;
}

/** The newest emulator command answered `OK`, with the time it took to answer. */
export const lastAck = (traffic: ReadonlyArray<TrafficEntry>): Ack | null => {
  for (let index = traffic.length - 1; index > 0; index--) {
    const reply = traffic[index]!;
    if (reply.channel !== "emulator" || reply.direction !== "rx" || reply.text.trim() !== "OK") {
      continue;
    }
    for (let before = index - 1; before >= 0; before--) {
      const sent = traffic[before]!;
      if (sent.channel !== "emulator") continue;
      if (sent.direction === "rx") break;
      return { command: sent.text, latencyMs: Math.max(0, reply.at - sent.at) };
    }
  }
  return null;
};
