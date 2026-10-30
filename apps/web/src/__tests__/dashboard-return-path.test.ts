// SPDX-License-Identifier: AGPL-3.0-only
//
// Signing back in must return you to the page you were on.
//
// The dashboard layout's three auth redirects hardcoded `?next=%2Fapp`. The
// middleware already preserved the real destination for a visitor with no
// session cookie, but the layout handles the *other* case — cookie present,
// API says 401 — which is what a session expiring mid-use looks like. Those
// users were silently returned to the dashboard root. An emailed link to one
// campaign's analytics became "here is your dashboard, find it yourself".
//
// Server components cannot read the request path, so the middleware forwards it
// as a request header. That makes the header the new thing to get wrong: it is
// attacker-controllable on the way IN, so the middleware must overwrite it
// rather than pass it through, and the consumer must still run it through the
// `safeNextPath` allow-list. Both halves are asserted here.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PATHNAME_HEADER, safeNextPath } from "@/lib/safe-navigation";

const src = (rel: string) =>
  readFileSync(resolve(process.cwd(), "src", rel), "utf8");

describe("dashboard auth redirects preserve the destination", () => {
  const layout = src("app/(dashboard)/layout.tsx");

  it("no longer hardcodes the dashboard root as the return path", () => {
    // Match the CODE, not the prose. The first draft of this test asserted the
    // string `next=%2Fapp` was absent from the file and failed on the comment
    // above the fix, which quotes the old literal to explain it — the same
    // trap as scanning source without stripping comments.
    const hardcoded = /redirect\(\s*["'`]\/(?:login|totp-challenge)\?next=%2Fapp["'`]\s*\)/;
    expect(layout).not.toMatch(hardcoded);
  });

  it("routes the requested path through the shared allow-list", () => {
    expect(layout).toContain("safeNextPath");
    expect(layout).toContain(PATHNAME_HEADER === "x-postwave-pathname" ? "PATHNAME_HEADER" : "");
    // All three redirects (login + two totp) must use the computed value.
    const redirects = layout.match(/redirect\(`\/(?:login|totp-challenge)\?next=/g) ?? [];
    expect(redirects).toHaveLength(3);
  });
});

describe("the forwarded pathname header cannot become an open redirect", () => {
  const middleware = src("middleware.ts");

  it("is set from the request URL, never copied from the inbound header", () => {
    // `new Headers(req.headers)` carries an attacker's value in; the set() is
    // what overwrites it. If this line moves above the clone, or is removed,
    // a client could choose its own post-login destination.
    const clone = middleware.indexOf("new Headers(req.headers)");
    const set = middleware.indexOf("PATHNAME_HEADER,");
    expect(clone).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(clone);
    expect(middleware).toContain("req.nextUrl.pathname + req.nextUrl.search");
  });

  it("rejects every off-origin or out-of-scope destination", () => {
    for (const forged of [
      "https://evil.example.com",
      "//evil.example.com",
      "http://evil.example.com/app",
      "/etc/passwd",
      "/appearance-not-app",
      "javascript:alert(1)",
      "",
    ]) {
      expect(safeNextPath(forged)).toBe("/app");
    }
  });

  it("keeps genuine dashboard destinations intact", () => {
    for (const real of [
      "/app",
      "/app/campaigns",
      "/app/campaigns/abc123/analytics",
      "/app/settings/team",
      "/app?tab=drafts",
    ]) {
      expect(safeNextPath(real)).toBe(real);
    }
  });
});
