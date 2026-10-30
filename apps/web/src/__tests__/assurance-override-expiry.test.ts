// SPDX-License-Identifier: AGPL-3.0-only
//
// An assurance waiver that has expired must not read as "Waived".
//
// campaignassurancegate.authorizeOverrides disqualifies an override whose
// ExpiresAt has passed:
//
//     (override.ExpiresAt != nil && !override.ExpiresAt.After(now))
//
// …so the blocking finding stands and the queue is refused. The panel rendered
// `expires_at` as text and compared it to nothing, so an expired waiver kept a
// "Waived" badge. The operator read the finding as cleared, pressed Send, and
// the gate said no — the UI was asserting a state the server contradicts.
//
// The gate's ORDER is the subtle part and this mirrors it: take the LATEST
// override for a finding, then judge it. There is no fallback to an older
// still-valid override, so a fresh reject supersedes an earlier allow_send and
// an expired latest override blocks even with a live one beneath it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { overrideIsActive } from "@/app/(dashboard)/app/campaigns/[id]/campaign-assurance-panel";

const GATE = readFileSync(
  resolve(
    process.cwd(),
    "../../apps/api/internal/campaignassurancegate/gate.go",
  ),
  "utf8",
);

const NOW = Date.parse("2026-08-16T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe("override activity mirrors the gate", () => {
  it("the gate really does disqualify on expiry", () => {
    // Guard the guard: if the server stopped enforcing expiry, this whole
    // mirror would be wrong rather than merely redundant.
    expect(GATE).toContain(
      "(override.ExpiresAt != nil && !override.ExpiresAt.After(now))",
    );
    // …and it selects the latest first, then validates.
    expect(GATE).toMatch(/latest\[override\.FindingID\] = override/);
    expect(GATE).toMatch(/override, ok := latest\[finding\.ID\]/);
  });

  it("treats a waiver with a future expiry as active", () => {
    expect(
      overrideIsActive(
        { decision: "allow_send", expires_at: iso(60 * 60 * 1000) },
        NOW,
      ),
    ).toBe(true);
  });

  it("treats a lapsed waiver as inactive", () => {
    expect(
      overrideIsActive(
        { decision: "allow_send", expires_at: iso(-1000) },
        NOW,
      ),
    ).toBe(false);
  });

  it("treats an expiry exactly at now as inactive, like After()", () => {
    // Go's `!ExpiresAt.After(now)` is false only when strictly later, so an
    // expiry equal to now does NOT authorise.
    expect(
      overrideIsActive({ decision: "allow_send", expires_at: iso(0) }, NOW),
    ).toBe(false);
  });

  it("treats an open-ended waiver as active", () => {
    expect(overrideIsActive({ decision: "allow_send" }, NOW)).toBe(true);
  });

  it("never treats a rejection as a waiver, expiry notwithstanding", () => {
    expect(
      overrideIsActive(
        { decision: "reject", expires_at: iso(60 * 60 * 1000) },
        NOW,
      ),
    ).toBe(false);
  });

  it("fails closed on an unparseable expiry", () => {
    // The gate would compare against a zero time and reject; an
    // unparseable stamp cannot be shown to be in the future.
    expect(
      overrideIsActive({ decision: "allow_send", expires_at: "soon" }, NOW),
    ).toBe(false);
  });

  it("treats a missing override as no waiver", () => {
    expect(overrideIsActive(undefined, NOW)).toBe(false);
  });
});

describe("the panel surfaces the expired state", () => {
  const PANEL = readFileSync(
    resolve(
      process.cwd(),
      "src/app/(dashboard)/app/campaigns/[id]/campaign-assurance-panel.tsx",
    ),
    "utf8",
  );

  it("labels a lapsed waiver rather than showing 'Waived'", () => {
    expect(PANEL).toContain("Waiver expired");
    // The badge must not decide on `decision` alone any more.
    expect(PANEL).not.toMatch(
      /\{override\.decision === "allow_send" \? "Waived" : "Rejected"\}/,
    );
  });

  it("says the finding is blocking again", () => {
    expect(PANEL).toMatch(/no longer authorises a send/);
  });
});
