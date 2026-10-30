// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { portalSessionOrigin, withPortalTheme } from "./session-url.js";

const token = `${"a".repeat(32)}.${"b".repeat(32)}.${"c".repeat(32)}`;
const valid = `https://audit.moosewave.com/portal/audit#bootstrap=${token}`;
const origin = "https://audit.moosewave.com";

describe("portal session URL boundary", () => {
  it("accepts the exact HTTPS portal path and adds only a known theme", () => {
    expect(portalSessionOrigin(valid, origin)).toBe(origin);
    expect(withPortalTheme(valid, "dark", origin)).toBe(
      `https://audit.moosewave.com/portal/audit?theme=dark#bootstrap=${token}`,
    );
    expect(
      withPortalTheme(valid, "dark", origin, "https://customer.example"),
    ).toBe(
      `https://audit.moosewave.com/portal/audit?theme=dark&parent_origin=https%3A%2F%2Fcustomer.example#bootstrap=${token}`,
    );
  });

  it.each([
    "http://customer.example",
    "https://user@customer.example",
    "https://customer.example/path",
    "not an origin",
  ])("rejects an invalid parent origin: %s", (parentOrigin) => {
    expect(withPortalTheme(valid, undefined, origin, parentOrigin)).toBe(
      "about:blank",
    );
  });

  it.each([
    `http://audit.moosewave.com/portal/audit#bootstrap=${token}`,
    `https://user:pass@audit.moosewave.com/portal/audit#bootstrap=${token}`,
    `https://audit.moosewave.com/portal/audit/extra#bootstrap=${token}`,
    `https://audit.moosewave.com/portal/audit?next=https://evil.test#bootstrap=${token}`,
    "https://audit.moosewave.com/portal/audit#bootstrap=",
    "https://audit.moosewave.com/portal/audit#bootstrap=not-a-jwt",
    `https://audit.moosewave.com/portal/audit#bootstrap=${token}&next=evil`,
    `https://attacker.example/portal/audit#bootstrap=${token}`,
    `https://audit.moosewave.com/portal/audit#bootstrap=${"a".repeat(1_900)}.${"b".repeat(32)}.${"c".repeat(32)}`,
  ])("rejects hostile or malformed input: %s", (value) => {
    expect(portalSessionOrigin(value, origin)).toBe("");
    expect(withPortalTheme(value, "light", origin)).toBe("about:blank");
  });

  it.each([
    "",
    "http://audit.moosewave.com",
    "https://user@audit.moosewave.com",
    "https://audit.moosewave.com/portal",
    "https://audit.moosewave.com?next=evil",
    "not a URL",
  ])("rejects an invalid configured portal origin: %s", (configuredOrigin) => {
    expect(portalSessionOrigin(valid, configuredOrigin)).toBe("");
    expect(withPortalTheme(valid, undefined, configuredOrigin)).toBe(
      "about:blank",
    );
  });
});

describe("an empty parentOrigin is a caller error, not an omission", () => {
  const token = `${"a".repeat(30)}.${"b".repeat(30)}.${"c".repeat(30)}`;
  const PORTAL = "https://audit.postwave.example";
  const sessionUrl = `${PORTAL}/portal/audit#bootstrap=${token}`;

  it("omitting it entirely still renders without the param", () => {
    // The parameter is genuinely optional for a direct caller of
    // withPortalTheme; only PostwaveAuditPortal types it as required.
    const out = withPortalTheme(sessionUrl, undefined, PORTAL, undefined);
    expect(out).not.toBe("about:blank");
    expect(out).not.toContain("parent_origin=");
  });

  it("a valid origin is normalised into the query", () => {
    const out = withPortalTheme(
      sessionUrl,
      undefined,
      PORTAL,
      "https://app.customer.example",
    );
    expect(out).toContain("parent_origin=https%3A%2F%2Fapp.customer.example");
  });

  it.each([
    ["an empty string", ""],
    ["whitespace", "   "],
    ["a malformed origin", "not a url"],
    ["http rather than https", "http://app.customer.example"],
    ["an origin with a path", "https://app.customer.example/embed"],
    ["credentials in the origin", "https://u:p@app.customer.example"],
  ])("fails closed for %s", (_label, parent) => {
    // "" used to be the one unusable value that did NOT fail closed: the param
    // was silently omitted, the iframe rendered, and onLoaded/onError never
    // fired because the SPA refuses to postMessage without a targetOrigin.
    // A portal that looks fine and never calls back is worse than a blank one.
    expect(withPortalTheme(sessionUrl, undefined, PORTAL, parent)).toBe(
      "about:blank",
    );
  });

  it("still rejects a session URL that fails its own checks", () => {
    // Guard the guard: a function returning about:blank for everything would
    // satisfy every assertion above.
    expect(
      withPortalTheme("https://evil.example/portal/audit#bootstrap=" + token, undefined, PORTAL, "https://app.customer.example"),
    ).toBe("about:blank");
    expect(
      withPortalTheme(sessionUrl, "dark", PORTAL, "https://app.customer.example"),
    ).toContain("theme=dark");
  });
});
