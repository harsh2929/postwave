/**
 * settings-gates — pure derivation logic behind:
 *   - Settings → Sample data badge (GET /onboarding/sample-data)
 *   - Settings → Slack "Connect" gate (GET /integrations/slack/availability)
 *   - Sending Settings → IP pool card (sending-settings `ip_pool` field)
 *   - Send Time → legacy device-local STO migration hint
 *
 * High-stakes invariants:
 *   1. Honesty under failure: a failed status probe yields "unknown" /
 *      conservative gating — never a fabricated "Empty" or "Shared".
 *   2. Slack gate precedence: server-not-configured beats the session
 *      requirement (no point signing in when OAuth can't start at all).
 *   3. Unknown availability (probe failed / older server) falls back to
 *      the conservative pre-probe behaviour: require a cookie session.
 */

import { describe, expect, it } from "vitest";

import {
  deriveSampleBadge,
  deriveSlackGate,
  describeIpPool,
  formatSampleCounts,
  parseLegacyStoHint,
} from "../lib/settings-gates";

describe("deriveSampleBadge", () => {
  it("reports 'checking' while the probe is in flight", () => {
    expect(deriveSampleBadge(true, null, null)).toBe("checking");
    // Loading wins even if a stale status/error is still around.
    expect(deriveSampleBadge(true, "boom", null)).toBe("checking");
    expect(deriveSampleBadge(true, null, { seeded: true })).toBe("checking");
  });

  it("is honest about probe failures — unknown, never 'empty'", () => {
    expect(deriveSampleBadge(false, "network down", null)).toBe("unknown");
    // Error takes precedence over any stale status snapshot.
    expect(deriveSampleBadge(false, "500", { seeded: true })).toBe("unknown");
    // No error but also no data (shouldn't happen, but stay honest).
    expect(deriveSampleBadge(false, null, null)).toBe("unknown");
  });

  it("maps server truth onto seeded/empty", () => {
    expect(
      deriveSampleBadge(false, null, {
        seeded: true,
        seeded_at: "2026-06-01T00:00:00Z",
      }),
    ).toBe("seeded");
    expect(deriveSampleBadge(false, null, { seeded: false })).toBe("empty");
  });
});

describe("formatSampleCounts", () => {
  it("returns null when there is nothing to show", () => {
    expect(formatSampleCounts(undefined)).toBeNull();
    expect(formatSampleCounts({})).toBeNull();
  });

  it("renders known keys in display order", () => {
    expect(
      formatSampleCounts({
        campaigns: 3,
        subscribers: 50,
        sequences: 1,
        lists: 1,
        segments: 1,
      }),
    ).toBe(
      "Subscribers: 50 · Lists: 1 · Segments: 1 · Campaigns: 3 · Sequences: 1",
    );
  });

  it("appends unknown keys alphabetically instead of dropping them", () => {
    expect(
      formatSampleCounts({ templates: 2, subscribers: 50, forms: 1 }),
    ).toBe("Subscribers: 50 · Forms: 1 · Templates: 2");
  });

  it("keeps zero counts visible (0 is information, not absence)", () => {
    expect(formatSampleCounts({ subscribers: 0 })).toBe("Subscribers: 0");
  });
});

describe("deriveSlackGate", () => {
  it("blocks on not_configured regardless of session state", () => {
    const avail = { configured: false, requires_session: true };
    expect(deriveSlackGate(avail, true)).toEqual({ kind: "not_configured" });
    expect(deriveSlackGate(avail, false)).toEqual({ kind: "not_configured" });
    // …and even when the server says no session is needed.
    expect(
      deriveSlackGate({ configured: false, requires_session: false }, true),
    ).toEqual({ kind: "not_configured" });
  });

  it("requires a session only when the server says so", () => {
    const needs = { configured: true, requires_session: true };
    expect(deriveSlackGate(needs, false)).toEqual({ kind: "needs_session" });
    expect(deriveSlackGate(needs, true)).toEqual({ kind: "ok" });
    // Session not required → API-key-only sessions may connect.
    const open = { configured: true, requires_session: false };
    expect(deriveSlackGate(open, false)).toEqual({ kind: "ok" });
    expect(deriveSlackGate(open, true)).toEqual({ kind: "ok" });
  });

  it("falls back to the conservative session gate when availability is unknown", () => {
    // Probe failed / older server: behave exactly like the pre-probe
    // build — the OAuth start route historically required a cookie
    // session, so gate on that.
    expect(deriveSlackGate(null, false)).toEqual({ kind: "needs_session" });
    expect(deriveSlackGate(null, true)).toEqual({ kind: "ok" });
  });
});

describe("describeIpPool", () => {
  it("is honest when the server doesn't report a pool", () => {
    expect(describeIpPool(undefined)).toEqual({ kind: "unknown" });
    // Defensive: a malformed pool without a name is still unknown.
    expect(describeIpPool({ name: "", dedicated: true })).toEqual({
      kind: "unknown",
    });
  });

  it("surfaces name + dedicated/shared from the live field", () => {
    expect(describeIpPool({ name: "pool-eu-1", dedicated: true })).toEqual({
      kind: "known",
      name: "pool-eu-1",
      dedicated: true,
    });
    expect(describeIpPool({ name: "shared-default", dedicated: false })).toEqual(
      { kind: "known", name: "shared-default", dedicated: false },
    );
  });
});

describe("parseLegacyStoHint", () => {
  it("defaults to enabled when the key was never written", () => {
    expect(parseLegacyStoHint(null)).toBe(true);
  });

  it("parses both historical truthy encodings", () => {
    expect(parseLegacyStoHint("1")).toBe(true);
    expect(parseLegacyStoHint("true")).toBe(true);
  });

  it("treats anything else as disabled", () => {
    expect(parseLegacyStoHint("0")).toBe(false);
    expect(parseLegacyStoHint("false")).toBe(false);
    expect(parseLegacyStoHint("garbage")).toBe(false);
  });
});
