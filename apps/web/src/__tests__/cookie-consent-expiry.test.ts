// SPDX-License-Identifier: AGPL-3.0-only
//
// The cookie-consent record expires after 13 months, because two published
// documents say it does:
//
//   /legal/privacy §7   "Cookie consent record — 13 months — Re-consent timer"
//   /legal/cookies      register row moosewave.cookie.consent.v1, "13 months"
//
// The banner had written `ts` into the record since the beginning and nothing
// read it — readPrefs() did not even name the field on its parse type — so a
// visitor who accepted analytics once was captured on that decision forever.
// A stale rejection is merely over-conservative; a stale grant is capture
// without current consent, which is the direction that matters.
//
// The window is pinned to the published figure rather than hardcoded twice:
// change CONSENT_MAX_AGE_MONTHS and the legal pages have to move with it.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CONSENT_MAX_AGE_MONTHS,
  isConsentCurrent,
  parseConsentRecord,
} from "@/lib/cookie-consent-record";

const SRC = resolve(process.cwd(), "src");

const PREFS = { essential: true as const, analytics: true, marketing: false };
const NOW = new Date("2026-08-16T12:00:00.000Z");

function record(ts: string | undefined): string {
  return JSON.stringify(ts === undefined ? { prefs: PREFS } : { prefs: PREFS, ts });
}

/** `months` before NOW, as an ISO stamp. */
function ago(months: number, days = 0): string {
  const d = new Date(NOW);
  d.setMonth(d.getMonth() - months);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

describe("cookie consent expiry", () => {
  it("matches the window both legal pages publish", () => {
    const privacy = readFileSync(
      join(SRC, "app/(marketing)/legal/privacy/page.tsx"),
      "utf8",
    );
    const cookies = readFileSync(
      join(SRC, "app/(marketing)/legal/cookies/page.tsx"),
      "utf8",
    );
    const claim = `${CONSENT_MAX_AGE_MONTHS} months`;
    expect(privacy).toContain(claim);
    // The register row for the consent entry specifically, not just any "13
    // months" on the page — ph_* carries the same figure independently.
    expect(cookies).toMatch(
      new RegExp(
        `moosewave\\.cookie\\.consent\\.v1[\\s\\S]{0,220}?duration:\\s*"${claim}"`,
      ),
    );
  });

  it("honours a decision made inside the window", () => {
    expect(isConsentCurrent(ago(1), NOW)).toBe(true);
    expect(isConsentCurrent(ago(CONSENT_MAX_AGE_MONTHS - 1), NOW)).toBe(true);
    expect(parseConsentRecord(record(ago(6)), NOW).prefs).toEqual(PREFS);
  });

  it("stops honouring it once the window lapses", () => {
    expect(isConsentCurrent(ago(CONSENT_MAX_AGE_MONTHS, 7), NOW)).toBe(false);
    expect(isConsentCurrent(ago(24), NOW)).toBe(false);
    // The whole point: an expired GRANT must stop counting as consent.
    expect(parseConsentRecord(record(ago(24)), NOW).prefs).toBeNull();
  });

  it("treats an undateable record as expired, not as consent", () => {
    // Fail closed, matching the rule telemetry.ts already applies to
    // unreadable storage. Each of these could otherwise be a permanent grant.
    for (const ts of [undefined, "", "not-a-date", "null"]) {
      expect(parseConsentRecord(record(ts), NOW).prefs, String(ts)).toBeNull();
    }
    expect(isConsentCurrent(1_700_000_000, NOW)).toBe(false); // number, not ISO
  });

  it("rejects a future stamp rather than extending the window", () => {
    // Clock skew or a tampered entry would otherwise buy 13 extra months.
    const future = new Date(NOW);
    future.setFullYear(future.getFullYear() + 1);
    expect(isConsentCurrent(future.toISOString(), NOW)).toBe(false);
  });

  it("still evicts an oversize entry", () => {
    // Pre-existing behaviour that must survive the refactor: both readers
    // delete a record past the byte cap.
    const huge = JSON.stringify({ prefs: PREFS, pad: "x".repeat(5 * 1024) });
    const out = parseConsentRecord(huge, NOW);
    expect(out.oversize).toBe(true);
    expect(out.prefs).toBeNull();
  });

  it("is enforced by both readers, not just the banner", () => {
    // A banner that re-prompts while telemetry keeps capturing against the
    // stale entry would be worse than never expiring at all, so neither may
    // parse the record itself.
    for (const rel of [
      "components/marketing/cookie-banner.tsx",
      "lib/telemetry.ts",
    ]) {
      const text = readFileSync(join(SRC, rel), "utf8");
      expect(text, rel).toContain("parseConsentRecord");
      // No local re-parse of the stored blob.
      expect(text, rel).not.toMatch(/JSON\.parse\(raw\)/);
    }
  });
});
