/**
 * The sign-in form's validator and the request-URL builder must agree.
 *
 * They did not. `lib/config.validateApiBaseUrl` accepted a LAN address for a
 * development build, while `api/url.normalizeApiBaseUrl` kept an older
 * loopback-only copy of the same rule and threw on it — synchronously, from
 * inside `createAuthClient`, on a code path whose rejection was swallowed. The
 * user got a spinner that never stopped, on a URL the form had just accepted.
 *
 * Any address one of them accepts, the other must accept.
 */
import { describe, expect, it } from "vitest";

import { normalizeApiBaseUrl } from "./url";
import { validateApiBaseUrl } from "@/lib/config";

/** Does the request builder accept this address? */
function builderAccepts(url: string): boolean {
  try {
    normalizeApiBaseUrl(url);
    return true;
  } catch {
    return false;
  }
}

const ADDRESSES = [
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  // The LAN cases — the whole point. 172.20.10.2 is an iOS hotspot address.
  "http://172.20.10.2:8080",
  "http://192.168.1.16:8080",
  "http://10.0.0.5:8080",
  "http://169.254.1.1:8080",
  // Public space over http: refused by both, in every build.
  "http://example.com",
  "http://172.15.0.1:8080",
  "http://172.32.0.1:8080",
  "http://8.8.8.8",
  // https is always fine.
  "https://api.moosewave.com",
  "https://172.20.10.2:8080",
];

describe("form validator and request builder agree", () => {
  it.each(ADDRESSES)("agree on %s in a development build", (address) => {
    const formOk = validateApiBaseUrl(address, "development").ok;
    expect(
      builderAccepts(address),
      `form ${formOk ? "ACCEPTS" : "rejects"} ${address}; the request builder must match`,
    ).toBe(formOk);
  });

  it("accepts the LAN address an on-device dev build actually uses", () => {
    // Guards the exact regression: this must not throw.
    expect(() => normalizeApiBaseUrl("http://172.20.10.2:8080")).not.toThrow();
    expect(validateApiBaseUrl("http://172.20.10.2:8080", "development").ok).toBe(
      true,
    );
  });

  it("still refuses public hosts over plain http", () => {
    expect(builderAccepts("http://example.com")).toBe(false);
    // 172.15 and 172.32 sit OUTSIDE 172.16/12 — public address space.
    expect(builderAccepts("http://172.15.0.1:8080")).toBe(false);
    expect(builderAccepts("http://172.32.0.1:8080")).toBe(false);
  });
});
