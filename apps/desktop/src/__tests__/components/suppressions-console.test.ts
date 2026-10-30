/**
 * suppressions-console — pure logic behind the restored suppressions
 * console pieces (desktop audit follow-up):
 *
 *   1. classifySearchQuery — decides exact `email=` vs prefix `q=` vs
 *      client-only filtering. A wrong classification either sends a
 *      partial string to the exact filter (zero rows → "not
 *      suppressed" falsehood) or silently keeps a full email
 *      client-side (missing matches beyond the loaded page).
 *   2. reasonMatchesFilter — the chips must match BOTH the legacy
 *      free-form reasons and the canonical X1 enum the server-side
 *      search returns.
 *   3. buildTrendSeries — per-reason series built from the trend
 *      endpoint's `by_reason` maps; all-zero reasons dropped; unknown
 *      reasons preserved; day totals fall back to an "All" series.
 *   4. splitBlocked / parseBlockedIdentifier / forceSelector — the
 *      bulk-delete force flow must only offer to force rows the server
 *      says are force-releasable, never permanent (DSAR) ones, and the
 *      force pass must re-send ONLY those rows (not the original
 *      selection).
 *   5. summarizeMirrorResult — counts a mirror run reports.
 */

import { describe, expect, it } from "vitest";

import {
  forceSelector,
  parseBlockedIdentifier,
  splitBlocked,
} from "../../components/suppressions/bulk-blocked";
import { summarizeMirrorResult } from "../../components/suppressions/mirror-summary";
import {
  buildTrendSeries,
  trendTotal,
} from "../../components/suppressions/trend-series";
import {
  classifySearchQuery,
  FILTER_REASON_ALIASES,
  reasonMatchesFilter,
} from "../../components/suppressions/suppression-search";
import type { SuppressionTrendPoint } from "../../lib/api-client";
import {
  buildSuppressionTotalLabel,
  filterSuppressionRows,
  parseBulkSuppressionEmails,
} from "../../pages/Suppressions";

describe("suppression page truth helpers", () => {
  it("deduplicates normalized valid paste entries and drops malformed lines", () => {
    expect(
      parseBulkSuppressionEmails(
        " User@Example.com\ninvalid\nuser@example.com,second@example.com ",
      ),
    ).toEqual(["user@example.com", "second@example.com"]);
  });

  it("uses authoritative server-search rows without reapplying substring matching", () => {
    const serverRow = {
      id: "x1",
      email: "authoritative@example.com",
      reason: "spam_complaint",
      created_at: "2026-07-10T00:00:00Z",
    };
    expect(
      filterSuppressionRows({
        rows: [],
        searchRows: [serverRow],
        usingServerSearch: true,
        filter: "complaint",
        query: "does-not-appear-in-address",
        dateFrom: "2026-07-01",
        dateTo: "2026-07-31",
      }),
    ).toEqual([serverRow]);
  });

  it("labels partial client searches as loaded-sample matches", () => {
    const rows = [
      {
        id: "1",
        email: "one@example.com",
        reason: "manual",
        created_at: "2026-07-10T00:00:00Z",
      },
    ];
    expect(
      buildSuppressionTotalLabel({
        rows,
        filtered: rows,
        serverTotal: 500,
        usingServerSearch: false,
        searchRows: null,
        searchTotal: null,
        searchTruncated: false,
        clientFilterActive: true,
        partial: true,
      }),
    ).toBe("1 match · searching first 1 loaded");
  });
});

describe("classifySearchQuery", () => {
  it("empty / whitespace → none", () => {
    expect(classifySearchQuery("")).toEqual({ mode: "none", value: "" });
    expect(classifySearchQuery("   ")).toEqual({ mode: "none", value: "" });
  });

  it("1–2 chars → client-only (too short for the server prefix filter)", () => {
    expect(classifySearchQuery("a").mode).toBe("client");
    expect(classifySearchQuery("ab").mode).toBe("client");
  });

  it("≥3 chars that aren't a full email → prefix", () => {
    expect(classifySearchQuery("bou")).toEqual({
      mode: "prefix",
      value: "bou",
    });
    expect(classifySearchQuery("bounce-test")).toEqual({
      mode: "prefix",
      value: "bounce-test",
    });
  });

  it("a full email → exact, never prefix", () => {
    expect(classifySearchQuery("user@example.com")).toEqual({
      mode: "exact",
      value: "user@example.com",
    });
  });

  it("partial addresses with @ but no full domain stay prefix", () => {
    // "user@exa" is not a complete email — the exact filter would
    // return zero rows and the UI would falsely report "no matches".
    expect(classifySearchQuery("user@exa").mode).toBe("prefix");
    expect(classifySearchQuery("@example.com").mode).toBe("prefix");
  });

  it("trims and lowercases (server matching is citext)", () => {
    expect(classifySearchQuery("  User@Example.COM ")).toEqual({
      mode: "exact",
      value: "user@example.com",
    });
  });

  it("emails with internal whitespace are not exact", () => {
    expect(classifySearchQuery("us er@example.com").mode).toBe("prefix");
  });
});

describe("reasonMatchesFilter", () => {
  it('"all" matches everything including missing reasons', () => {
    expect(reasonMatchesFilter(undefined, "all")).toBe(true);
    expect(reasonMatchesFilter("anything", "all")).toBe(true);
  });

  it("legacy free-form values match their chip", () => {
    expect(reasonMatchesFilter("complaint", "complaint")).toBe(true);
    expect(reasonMatchesFilter("manual", "manual")).toBe(true);
    expect(reasonMatchesFilter("unsubscribe", "unsubscribe")).toBe(true);
    expect(reasonMatchesFilter("hard_bounce", "hard_bounce")).toBe(true);
  });

  it("canonical X1 values (server-side search rows) match the same chips", () => {
    expect(reasonMatchesFilter("spam_complaint", "complaint")).toBe(true);
    expect(reasonMatchesFilter("list_manual", "manual")).toBe(true);
    expect(reasonMatchesFilter("manual_unsubscribe", "unsubscribe")).toBe(true);
    expect(reasonMatchesFilter("global_unsubscribe", "unsubscribe")).toBe(true);
  });

  it("is case-insensitive and rejects cross-chip values", () => {
    expect(reasonMatchesFilter("Spam_Complaint", "complaint")).toBe(true);
    expect(reasonMatchesFilter("hard_bounce", "complaint")).toBe(false);
    expect(reasonMatchesFilter(undefined, "manual")).toBe(false);
  });

  it("every alias list is non-empty and contains the chip's own value family", () => {
    for (const [chip, aliases] of Object.entries(FILTER_REASON_ALIASES)) {
      expect(aliases.length, chip).toBeGreaterThan(0);
    }
  });
});

describe("buildTrendSeries", () => {
  const day = (
    date: string,
    count: number,
    by_reason: Record<string, number>,
  ): SuppressionTrendPoint => ({ date, count, by_reason });

  it("empty input → no series", () => {
    expect(buildTrendSeries([])).toEqual([]);
  });

  it("builds one series per reason, zero-filling missing days", () => {
    const series = buildTrendSeries([
      day("2026-06-01", 3, { hard_bounce: 2, manual: 1 }),
      day("2026-06-02", 1, { manual: 1 }),
    ]);
    expect(series.map((s) => s.label)).toEqual(["Hard bounce", "Manual"]);
    const bounce = series[0];
    expect(bounce?.values).toEqual([
      { date: "2026-06-01", count: 2 },
      { date: "2026-06-02", count: 0 },
    ]);
  });

  it("keeps a stable known-reason order and appends unknown reasons", () => {
    const series = buildTrendSeries([
      day("2026-06-01", 3, {
        zz_future_reason: 1,
        spam_complaint: 1,
        hard_bounce: 1,
      }),
      day("2026-06-02", 0, {}),
    ]);
    expect(series.map((s) => s.label)).toEqual([
      "Hard bounce",
      "Spam complaint",
      "zz_future_reason",
    ]);
  });

  it("drops reasons that are all-zero across the window", () => {
    const series = buildTrendSeries([
      day("2026-06-01", 1, { hard_bounce: 1, manual: 0 }),
      day("2026-06-02", 0, { manual: 0 }),
    ]);
    expect(series.map((s) => s.label)).toEqual(["Hard bounce"]);
  });

  it("falls back to an 'All' series when day totals exist without a per-reason breakdown", () => {
    const series = buildTrendSeries([
      day("2026-06-01", 4, {}),
      day("2026-06-02", 2, {}),
    ]);
    expect(series).toHaveLength(1);
    expect(series[0]?.label).toBe("All");
    expect(series[0]?.values).toEqual([
      { date: "2026-06-01", count: 4 },
      { date: "2026-06-02", count: 2 },
    ]);
  });

  it("does NOT fabricate an 'All' series for an all-zero window (empty state instead)", () => {
    expect(
      buildTrendSeries([day("2026-06-01", 0, {}), day("2026-06-02", 0, {})]),
    ).toEqual([]);
  });
});

describe("trendTotal", () => {
  it("sums day counts", () => {
    expect(
      trendTotal([
        { date: "2026-06-01", count: 4, by_reason: {} },
        { date: "2026-06-02", count: 2, by_reason: {} },
      ]),
    ).toBe(6);
    expect(trendTotal([])).toBe(0);
  });
});

describe("splitBlocked", () => {
  it("separates force-releasable rows (with identifiers) from permanent ones", () => {
    const { forceable, permanent } = splitBlocked([
      "11111111-aaaa: hard_bounce requires force=true",
      "22222222-bbbb: dsar_deletion is permanent",
      "33333333-cccc: spam_complaint requires force=true",
    ]);
    expect(forceable).toEqual([
      {
        line: "11111111-aaaa: hard_bounce requires force=true",
        identifier: "11111111-aaaa",
      },
      {
        line: "33333333-cccc: spam_complaint requires force=true",
        identifier: "33333333-cccc",
      },
    ]);
    expect(permanent).toEqual(["22222222-bbbb: dsar_deletion is permanent"]);
  });

  it("unknown formats are treated as NOT forceable (safe default)", () => {
    const { forceable, permanent } = splitBlocked(["weird line"]);
    expect(forceable).toEqual([]);
    expect(permanent).toEqual(["weird line"]);
  });

  it("a force=true line without a parseable identifier is NOT forceable", () => {
    // We can't target a row we can't identify — offering a force button
    // for it would silently no-op (or worse, mis-target).
    const { forceable, permanent } = splitBlocked([
      "requires force=true",
      ": hard_bounce requires force=true",
    ]);
    expect(forceable).toEqual([]);
    expect(permanent).toEqual([
      "requires force=true",
      ": hard_bounce requires force=true",
    ]);
  });

  it("empty input → both empty (no force button rendered)", () => {
    expect(splitBlocked([])).toEqual({ forceable: [], permanent: [] });
  });
});

describe("parseBlockedIdentifier", () => {
  it("extracts the identifier before the first ': '", () => {
    expect(
      parseBlockedIdentifier("11111111-aaaa: hard_bounce requires force=true"),
    ).toBe("11111111-aaaa");
    expect(
      parseBlockedIdentifier(
        "user@example.com: spam_complaint requires force=true",
      ),
    ).toBe("user@example.com");
  });

  it("returns null for lines without an identifier", () => {
    expect(parseBlockedIdentifier("weird line")).toBeNull();
    expect(parseBlockedIdentifier(": reason requires force=true")).toBeNull();
    expect(parseBlockedIdentifier("")).toBeNull();
  });
});

describe("forceSelector (two-phase force pass payload)", () => {
  it("targets ONLY the server-reported forceable rows, by id", () => {
    // Phase 1: the operator selected 4 emails; the server deleted one,
    // blocked two as forceable and one as permanent.
    const { forceable } = splitBlocked([
      "11111111-aaaa: hard_bounce requires force=true",
      "22222222-bbbb: dsar_deletion is permanent",
      "33333333-cccc: spam_complaint requires force=true",
    ]);
    // Phase 2 payload: exactly the two forceable row ids — never the
    // original 4-email selection ("Force remove 2 blocked" must mean 2).
    expect(forceSelector(forceable)).toEqual({
      ids: ["11111111-aaaa", "33333333-cccc"],
    });
  });

  it("routes email-shaped identifiers through `emails`", () => {
    const { forceable } = splitBlocked([
      "user@example.com: hard_bounce requires force=true",
      "44444444-dddd: spam_complaint requires force=true",
    ]);
    expect(forceSelector(forceable)).toEqual({
      ids: ["44444444-dddd"],
      emails: ["user@example.com"],
    });
  });

  it("empty forceable set → empty selector (no force pass possible)", () => {
    expect(forceSelector([])).toEqual({});
  });
});

describe("summarizeMirrorResult", () => {
  it("renders the counts, pluralizing errors", () => {
    // Counts stay below 1,000 so the assertion doesn't depend on the
    // host locale's digit-grouping separator.
    expect(
      summarizeMirrorResult({
        provider: "ses",
        fetched: 120,
        imported: 110,
        skipped: 10,
        errors: 0,
      }),
    ).toBe("Fetched 120 · imported 110 · skipped 10");
    expect(
      summarizeMirrorResult({
        provider: "mailgun",
        fetched: 10,
        imported: 8,
        skipped: 1,
        errors: 1,
      }),
    ).toBe("Fetched 10 · imported 8 · skipped 1 · 1 error");
  });

  it("includes the provider window when reported", () => {
    expect(
      summarizeMirrorResult({
        provider: "sendgrid",
        fetched: 5,
        imported: 5,
        skipped: 0,
        errors: 0,
        window_from: "2026-06-03T00:00:00Z",
        window_to: "2026-06-10T00:00:00Z",
      }),
    ).toBe(
      "Fetched 5 · imported 5 · skipped 0 (window 2026-06-03 → 2026-06-10)",
    );
  });
});
