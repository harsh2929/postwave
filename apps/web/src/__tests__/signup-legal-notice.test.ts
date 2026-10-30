// SPDX-License-Identifier: AGPL-3.0-only
//
// Both sign-up surfaces must give the notice at the moment data is collected.
//
// GDPR Art. 13(1) requires the privacy information "at the time when personal
// data are obtained". A sign-up form takes an email address, so that moment is
// the form, not a footer link on another page. The Terms set an 18+ floor
// (legal/terms §3), and a floor stated only inside a document the user is never
// pointed at is not a floor anyone is asked to meet — which is also the COPPA
// and GDPR Art. 8 question a regulator would ask.
//
// The 2026-09 compliance audit found the mobile sign-up had carried this notice
// since it was written and the web sign-up had never had it. One surface being
// right is what makes the other surface's omission a drift problem rather than
// an oversight, so this asserts both and will fail if either regresses.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");

const SURFACES = [
  {
    name: "web sign-up",
    file: path.join(REPO_ROOT, "apps", "web", "src", "app", "signup", "page.tsx"),
  },
  {
    name: "mobile sign-up",
    file: path.join(REPO_ROOT, "apps", "mobile", "app", "(auth)", "sign-up.tsx"),
  },
];

describe("sign-up surfaces carry the collection-time legal notice", () => {
  it.each(SURFACES)("$name exists", ({ file }) => {
    // If the file moves, this test must fail loudly rather than skip the
    // surface it was written to protect.
    expect(existsSync(file), `${path.relative(REPO_ROOT, file)} not found`).toBe(true);
  });

  it.each(SURFACES)("$name links the Terms", ({ file }) => {
    expect(readFileSync(file, "utf8")).toMatch(/legal\/terms|["']terms["']/i);
  });

  it.each(SURFACES)("$name links the Privacy Policy", ({ file }) => {
    expect(readFileSync(file, "utf8")).toMatch(/legal\/privacy|["']privacy["']/i);
  });

  it("web sign-up states the minimum age", () => {
    // Mobile defers to the Terms by reference; web states it inline because the
    // web form is the surface a regulator reaches first and the one that had no
    // notice at all. Asserted only where it is claimed, so this cannot pass
    // vacuously on a surface that never made the claim.
    const source = readFileSync(SURFACES[0].file, "utf8");
    expect(source).toMatch(/at least 18 years old/i);
  });

  it.each(SURFACES)("$name notice mentions agreement, not just links", ({ file }) => {
    // A bare pair of footer links is navigation. The notice has to say that
    // proceeding IS the agreement, which is what makes it an Art. 13 notice and
    // the point of contract formation rather than decoration.
    // Matches the idea, not one surface's phrasing: mobile says "By signing
    // up you agree to…", web says "…and agree to…".
    expect(readFileSync(file, "utf8")).toMatch(/\bagree to\b/i);
  });
});
