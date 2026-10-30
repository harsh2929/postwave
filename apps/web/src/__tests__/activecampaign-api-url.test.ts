// SPDX-License-Identifier: AGPL-3.0-only
//
// Validates the ActiveCampaign account API URL a user pastes during migration
// setup. It is the guard that keeps credentials from being posted to an
// attacker-chosen host, and it had no direct coverage.
import { describe, expect, it } from "vitest";

import { activeCampaignApiUrlError } from "@/lib/activecampaign-api-url";

const ok = (raw: string) => expect(activeCampaignApiUrlError(raw)).toBeNull();
const rejects = (raw: string) =>
  expect(activeCampaignApiUrlError(raw)).toBeTruthy();

describe("activeCampaignApiUrlError", () => {
  it("accepts the account root with or without a scheme", () => {
    ok("https://acct.api-us1.com");
    ok("acct.api-us1.com");
    ok("  acct.api-us1.com  ");
    ok("https://acct.api-us1.com/");
  });

  it("accepts an explicit /api/3 path", () => {
    ok("https://acct.api-us1.com/api/3");
    ok("https://acct.api-us1.com/api/3/");
    ok("https://acct.api-us1.com/api/3/contacts");
  });

  it("treats the scheme case-insensitively", () => {
    // Schemes are case-insensitive per RFC 3986; a case-sensitive check
    // rejected this valid URL and told the user to "use HTTPS".
    ok("HTTPS://acct.api-us1.com");
    ok("HttPs://acct.api-us1.com/api/3");
  });

  it("requires a value", () => {
    rejects("");
    rejects("   ");
  });

  it("rejects non-HTTPS schemes", () => {
    rejects("http://acct.api-us1.com");
    rejects("HTTP://acct.api-us1.com");
    rejects("ftp://acct.api-us1.com");
    rejects("javascript://acct.api-us1.com");
  });

  it("rejects embedded credentials, queries and fragments", () => {
    rejects("https://user:pw@acct.api-us1.com");
    rejects("https://acct.api-us1.com?token=x");
    rejects("https://acct.api-us1.com#frag");
  });

  it("rejects non-default ports", () => {
    rejects("https://acct.api-us1.com:8443");
    ok("https://acct.api-us1.com:443");
  });

  it("rejects loopback, bare IPs and single-label hosts", () => {
    rejects("https://localhost");
    rejects("https://api.localhost");
    rejects("https://127.0.0.1");
    rejects("https://10.0.0.5/api/3");
    rejects("https://intranet");
    rejects("https://[::1]");
  });

  it("rejects a path outside the API root", () => {
    rejects("https://acct.api-us1.com/admin");
    rejects("https://acct.api-us1.com/api/2");
    rejects("https://acct.api-us1.com/api/30");
  });

  it("rejects hosts with invalid labels", () => {
    rejects("https://-bad.api-us1.com");
    rejects("https://bad-.api-us1.com");
    rejects("https://exa mple.com");
  });
});
