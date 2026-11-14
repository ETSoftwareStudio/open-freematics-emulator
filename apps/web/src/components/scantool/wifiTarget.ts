import { ReaderTarget } from "@fme/contracts";
import * as Schema from "effect/Schema";

const isReaderTarget = Schema.is(ReaderTarget);

/** The Wi-Fi adapter the fields describe, or null while the contract would refuse it. */
export const wifiTarget = (host: string, port: string) => {
  const digits = port.trim();
  if (!/^\d+$/.test(digits)) return null;
  const target = { _tag: "tcp" as const, host: host.trim(), port: Number(digits) };
  return isReaderTarget(target) ? target : null;
};
