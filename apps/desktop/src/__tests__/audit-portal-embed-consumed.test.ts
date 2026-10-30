// SPDX-License-Identifier: AGPL-3.0-only
//
// De-island guard: the desktop app dogfoods @postwave/audit-portal-react.
//
// The 2026-07-18 Apple-level integration audit flagged @postwave/audit-portal-react
// as an "unconsumed substrate package" — a published embed SDK with zero
// first-party consumers, so nobody dogfooded the embed contract. The audit
// modal now renders the real <PostwaveAuditPortal /> from the minted session
// (0 → 1 first-party consumer). This test fails if that consumption is removed
// (turning it back into an island) or if the security-relevant origin pins are
// dropped. Mirrors the design-tokens drift guards.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MODAL = readFileSync(
  path.resolve(__dirname, "../components/audit/AuditPortalSessionModal.tsx"),
  "utf8",
);

describe("audit-portal-react is dogfooded by the desktop audit modal", () => {
  it("imports the published embed SDK", () => {
    expect(MODAL).toMatch(/from ["']@postwave\/audit-portal-react["']/);
    expect(MODAL).toContain("PostwaveAuditPortal");
    expect(MODAL).toContain("portalSessionOrigin");
  });

  it("renders the embed component from the minted session", () => {
    expect(MODAL).toMatch(/<PostwaveAuditPortal\b/);
    expect(MODAL).toContain("sessionUrl={session.portalUrl}");
  });

  it("pins both the portal and parent origins (never a wildcard)", () => {
    expect(MODAL).toContain("portalOrigin={portalSessionOrigin(");
    expect(MODAL).toContain("parentOrigin={");
  });
});
