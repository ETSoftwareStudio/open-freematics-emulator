import { describe, expect, it } from "vite-plus/test";
import { isLocalRequest } from "./http.ts";

describe("isLocalRequest", () => {
  it.each([
    ["the desktop window", "127.0.0.1:52731", "http://127.0.0.1:52731", true],
    ["the dev server through Vite", "localhost:5738", "http://localhost:5738", true],
    ["an IPv6 loopback page", "[::1]:3738", "http://[::1]:3738", true],
    ["a local script without an Origin", "127.0.0.1:3738", undefined, true],
    ["another website", "127.0.0.1:3738", "https://evil.example", false],
    ["another local port", "127.0.0.1:3738", "http://127.0.0.1:8080", false],
    ["localhost against 127.0.0.1", "127.0.0.1:3738", "http://localhost:3738", false],
    ["a sandboxed or file:// page", "127.0.0.1:3738", "null", false],
    ["DNS rebinding", "evil.example:3738", "http://evil.example:3738", false],
    ["a LAN address", "192.168.1.20:3738", "http://192.168.1.20:3738", false],
    ["a missing Host", undefined, undefined, false],
  ] as const)("%s", (_, host, origin, allowed) => {
    expect(isLocalRequest({ host, origin })).toBe(allowed);
  });

  it.each([
    ["the desktop window", "127.0.0.1:52731", "fme://app", "fme://app", true],
    ["the desktop origin without the flag", "127.0.0.1:52731", "fme://app", null, false],
    ["another custom scheme", "127.0.0.1:52731", "evil://app", "fme://app", false],
    ["a lookalike host", "127.0.0.1:52731", "fme://app.evil", "fme://app", false],
    ["the desktop origin on a rebound host", "evil.example:52731", "fme://app", "fme://app", false],
    ["its own served page", "127.0.0.1:52731", "http://127.0.0.1:52731", "fme://app", true],
  ] as const)("with an app origin: %s", (_, host, origin, appOrigin, allowed) => {
    expect(isLocalRequest({ host, origin }, appOrigin)).toBe(allowed);
  });
});
