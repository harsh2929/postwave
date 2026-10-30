/**
 * The `http://` host policy — and specifically the ONE place it was relaxed.
 *
 * Plain http is allowed to loopback because those packets never leave the
 * machine. It is now ALSO allowed to a private-network IP, but only in a
 * non-production build, and only because a physical phone talking to a dev API
 * on the developer's Mac cannot satisfy the loopback rule at all: `localhost`
 * on the device means the device.
 *
 * The cost is that credentials cross the LAN in cleartext, so the blast radius
 * has to stay exactly this size. These tests are what keep it there.
 */
import { describe, expect, it } from "vitest";

import { HTTP_PRIVATE_NETWORK_ALLOWED, validateApiBaseUrl } from "./config";

const ok = (url: string) => validateApiBaseUrl(url).ok;
/** The same check as a PRODUCTION build would run it. */
const okInProd = (url: string) =>
  validateApiBaseUrl(url, "production").ok;

describe("http is always allowed to loopback", () => {
  it("accepts localhost and the loopback literals", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(ok(`http://${host}:8080`), host).toBe(true);
    }
  });
});

describe("http to a private network — dev only", () => {
  it("is enabled in this (non-production) build", () => {
    // Guards the guard: if the constant flipped, every case below would pass
    // vacuously for the wrong reason.
    expect(HTTP_PRIVATE_NETWORK_ALLOWED).toBe(true);
  });

  it("accepts every RFC1918 range and link-local", () => {
    for (const host of [
      "192.168.1.16",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.254",
      "169.254.10.1",
    ]) {
      expect(ok(`http://${host}:8080`), host).toBe(true);
    }
  });

  it("rejects the 172.x addresses that are NOT private", () => {
    // 172.16-31 is private; 172.15 and 172.32 are public routable space, and an
    // off-by-one here would put credentials on the open internet in cleartext.
    for (const host of ["172.15.0.1", "172.32.0.1"]) {
      expect(ok(`http://${host}:8080`), host).toBe(false);
    }
  });

  it("still rejects public hosts over http", () => {
    for (const host of ["api.moosewave.com", "8.8.8.8", "example.test"]) {
      expect(ok(`http://${host}`), host).toBe(false);
    }
  });

  it("rejects a NAME that merely looks private", () => {
    // Names are excluded on purpose: DNS can point anywhere, so accepting one
    // would reopen the hole the policy exists to close.
    expect(ok("http://192.168.1.16.evil.test")).toBe(false);
    expect(ok("http://localhost.evil.test")).toBe(false);
  });

  it("keeps https working for everything", () => {
    expect(ok("https://api.moosewave.com")).toBe(true);
    expect(ok("https://192.168.1.16:8080")).toBe(true);
  });
});

describe("PRODUCTION is https-only — the relaxation must not leak", () => {
  it("refuses http to a private network in a production build", () => {
    // The whole safety argument rests on this. validateApiBaseUrl takes the
    // build profile as a parameter, so this is the real production code path,
    // not a proxy for it.
    for (const host of ["192.168.1.16", "10.0.0.5", "172.16.0.1"]) {
      expect(okInProd(`http://${host}:8080`), host).toBe(false);
    }
  });

  it("refuses http to loopback in production too", () => {
    // Pre-existing rule, retained: a production build must never point at a
    // local API. Asserted here so the relaxation cannot quietly widen it.
    expect(okInProd("http://localhost:8080")).toBe(false);
  });

  it("still accepts https in production", () => {
    expect(okInProd("https://api.moosewave.com")).toBe(true);
  });
});
