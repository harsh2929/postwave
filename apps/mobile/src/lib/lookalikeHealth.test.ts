/**
 * How alarmed to be about one modeled audience.
 *
 * The rules under test are the ones that decide whether an operator trusts a
 * lookalike, so each of them can be wrong in a way that is invisible on screen:
 *
 *  - An UNFINISHED model must never be judged on its counts. `member_count`
 *    defaults to 0 and is only written at the end, so "Empty" and "Building"
 *    are the same row until the status says otherwise. Getting the precedence
 *    backwards tells an operator their audience matched nobody when it is
 *    simply not done.
 *  - An UNRECOGNISED status must not fall through to a quality judgement. This
 *    build cannot interpret it, and interpreting it anyway is how a half-built
 *    audience gets rendered as finished.
 *  - A MISSING histogram must not read as "not weak". Three-valued on purpose:
 *    unknown is not the same as fine.
 *  - Only an EXACT pool cap is reported. Anything less cannot be distinguished
 *    from a workspace that is simply that size, and a wrong truncation warning
 *    would make people distrust a model that is fine.
 */
import { describe, expect, it } from "vitest";

import {
  bandTotals,
  filledToCeiling,
  isStaleLookalike,
  isWeakMatch,
  lookalikeAgeDays,
  lookalikeFilterCounts,
  lookalikeHealthPresentation,
  lookalikeHealthState,
  LOOKALIKE_STALE_DAYS,
  matchesLookalikeFilter,
  matchesLookalikeQuery,
  orderLookalikes,
  poolTruncation,
  shortfallOf,
  type LookalikeHealthInputs,
} from "./lookalikeHealth";

const NOW = Date.UTC(2026, 6, 25, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function audience(
  overrides: Partial<LookalikeHealthInputs> = {},
): LookalikeHealthInputs {
  return {
    status: "ready",
    memberCount: 5000,
    sizeRequested: 5000,
    seedCount: 800,
    candidateCount: 40_000,
    bands: { high: 3000, medium: 1500, low: 500 },
    createdAt: new Date(NOW - 2 * DAY).toISOString(),
    ...overrides,
  };
}

describe("health state", () => {
  it("calls a clean, full, mostly-similar model ready", () => {
    expect(lookalikeHealthState(audience())).toBe("ready");
  });

  it("leads with failure, whatever the counts say", () => {
    expect(
      lookalikeHealthState(
        audience({ status: "failed", memberCount: 4000, bands: { high: 4000, medium: 0, low: 0 } }),
      ),
    ).toBe("failed");
  });

  it("never judges an UNFINISHED model on its provisional counts", () => {
    // member_count defaults to 0 and is written at the end. "Empty" here would
    // be a claim nobody has made yet.
    for (const status of ["pending", "running"] as const) {
      expect(lookalikeHealthState(audience({ status, memberCount: 0 }))).toBe(
        "building",
      );
    }
  });

  it("treats an unrecognised status as unknown rather than falling through", () => {
    expect(
      lookalikeHealthState(audience({ status: null, memberCount: 0 })),
    ).toBe("unknown");
  });

  it("calls a finished model that matched nobody empty", () => {
    expect(lookalikeHealthState(audience({ memberCount: 0 }))).toBe("empty");
  });

  it("calls a majority-weak model weak even when it filled the ask", () => {
    expect(
      lookalikeHealthState(
        audience({ bands: { high: 100, medium: 200, low: 4700 } }),
      ),
    ).toBe("weak");
  });

  it("calls a full-quality model that fell short short", () => {
    expect(
      lookalikeHealthState(
        audience({ memberCount: 3000, bands: { high: 2500, medium: 400, low: 100 } }),
      ),
    ).toBe("short");
  });

  it("does not call a model weak when the histogram is missing", () => {
    // Unknown quality is not bad quality. It falls through to the size read.
    expect(
      lookalikeHealthState(
        audience({ bands: { high: null, medium: null, low: null } }),
      ),
    ).toBe("ready");
  });

  it("gives every state a word and a spoken sentence, never colour alone", () => {
    for (const state of [
      "failed",
      "empty",
      "unknown",
      "building",
      "weak",
      "short",
      "ready",
    ] as const) {
      const presentation = lookalikeHealthPresentation(state);
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.spoken.length).toBeGreaterThan(20);
    }
  });
});

describe("shortfall", () => {
  it("reports how far short and what share of the ask went unfilled", () => {
    expect(shortfallOf({ memberCount: 4000, sizeRequested: 5000 })).toEqual({
      missing: 1000,
      share: 0.2,
    });
  });

  it("is null when the model filled the ask", () => {
    expect(shortfallOf({ memberCount: 5000, sizeRequested: 5000 })).toBeNull();
  });

  it("is null — not zero — when either figure is missing", () => {
    expect(shortfallOf({ memberCount: null, sizeRequested: 5000 })).toBeNull();
    expect(shortfallOf({ memberCount: 4000, sizeRequested: null })).toBeNull();
  });

  it("separates 'stopped at the ceiling' from 'fell short'", () => {
    expect(filledToCeiling({ memberCount: 5000, sizeRequested: 5000 })).toBe(true);
    expect(filledToCeiling({ memberCount: 4000, sizeRequested: 5000 })).toBe(false);
    expect(filledToCeiling({ memberCount: 0, sizeRequested: 5000 })).toBe(false);
    expect(filledToCeiling({ memberCount: null, sizeRequested: 5000 })).toBe(false);
  });
});

describe("similarity histogram", () => {
  it("totals the three bands", () => {
    expect(bandTotals({ bands: { high: 3, medium: 2, low: 1 } })).toEqual({
      high: 3,
      medium: 2,
      low: 1,
      total: 6,
    });
  });

  it("refuses to total a partial histogram", () => {
    // Silently treating the missing band as zero would understate exactly the
    // band a reader is about to draw a conclusion from.
    expect(bandTotals({ bands: { high: 3, medium: null, low: 1 } })).toBeNull();
  });

  it("is three-valued: weak, not weak, and unknown", () => {
    expect(isWeakMatch({ bands: { high: 1, medium: 1, low: 5 } })).toBe(true);
    expect(isWeakMatch({ bands: { high: 5, medium: 1, low: 1 } })).toBe(false);
    expect(isWeakMatch({ bands: { high: null, medium: 1, low: 1 } })).toBeNull();
    expect(isWeakMatch({ bands: { high: 0, medium: 0, low: 0 } })).toBeNull();
  });

  it("does not call an exact tie weak", () => {
    // low must OUTNUMBER the rest, not merely equal them.
    expect(isWeakMatch({ bands: { high: 2, medium: 2, low: 4 } })).toBe(false);
  });
});

describe("pool truncation", () => {
  it("reports a seed sample that hit its exact 20,000 ceiling", () => {
    expect(poolTruncation({ seedCount: 20_000, candidateCount: 100 })).toEqual({
      seedCapped: true,
      candidatesCapped: false,
    });
  });

  it("reports a candidate pool that hit its exact 50,000 ceiling", () => {
    expect(poolTruncation({ seedCount: 10, candidateCount: 50_000 })).toEqual({
      seedCapped: false,
      candidatesCapped: true,
    });
  });

  it("stays silent just under the cap, where truncation is unknowable", () => {
    // The candidate LIMIT is applied before seed members are subtracted, so
    // 49,999 could be a truncated pool or a workspace of that size.
    expect(
      poolTruncation({ seedCount: 19_999, candidateCount: 49_999 }),
    ).toEqual({ seedCapped: false, candidatesCapped: false });
  });

  it("stays silent when the counts were never recorded", () => {
    expect(poolTruncation({ seedCount: null, candidateCount: null })).toEqual({
      seedCapped: false,
      candidatesCapped: false,
    });
  });
});

describe("age and staleness", () => {
  it("counts whole days since the model was materialised", () => {
    expect(
      lookalikeAgeDays({ createdAt: new Date(NOW - 3 * DAY).toISOString() }, NOW),
    ).toBe(3);
  });

  it("never reports a negative age from a clock skew", () => {
    expect(
      lookalikeAgeDays({ createdAt: new Date(NOW + DAY).toISOString() }, NOW),
    ).toBe(0);
  });

  it("says nothing about a model with no build date", () => {
    expect(lookalikeAgeDays({ createdAt: null }, NOW)).toBeNull();
    expect(lookalikeAgeDays({ createdAt: "not a date" }, NOW)).toBeNull();
    // An unknown build date is NOT a stale verdict.
    expect(isStaleLookalike({ createdAt: null }, NOW)).toBe(false);
  });

  it("calls a model stale strictly past the stated threshold", () => {
    const at = (days: number) => ({
      createdAt: new Date(NOW - days * DAY).toISOString(),
    });
    expect(isStaleLookalike(at(LOOKALIKE_STALE_DAYS), NOW)).toBe(false);
    expect(isStaleLookalike(at(LOOKALIKE_STALE_DAYS + 1), NOW)).toBe(true);
  });
});

describe("filters", () => {
  const rows = [
    audience({ status: "failed" }),
    audience(),
    audience({ createdAt: new Date(NOW - 90 * DAY).toISOString() }),
  ];

  it("counts the rows worth opening a phone for", () => {
    expect(lookalikeFilterCounts(rows, NOW)).toEqual({
      all: 3,
      attention: 1,
      stale: 1,
    });
  });

  it("matches everything under 'all'", () => {
    for (const row of rows) {
      expect(matchesLookalikeFilter(row, "all", NOW)).toBe(true);
    }
  });

  it("puts every non-ready state under 'needs a look'", () => {
    expect(matchesLookalikeFilter(rows[0]!, "attention", NOW)).toBe(true);
    expect(matchesLookalikeFilter(rows[1]!, "attention", NOW)).toBe(false);
  });

  it("scopes 'stale' to age alone, not to health", () => {
    expect(matchesLookalikeFilter(rows[2]!, "stale", NOW)).toBe(true);
    expect(matchesLookalikeFilter(rows[0]!, "stale", NOW)).toBe(false);
  });
});

describe("search", () => {
  const row = { id: "abc123-def", name: "High value buyers" };

  it("matches the model name case-insensitively", () => {
    expect(matchesLookalikeQuery(row, "BUYERS", null)).toBe(true);
  });

  it("matches the seed segment's name when it resolved", () => {
    expect(matchesLookalikeQuery(row, "vip", "VIP customers")).toBe(true);
  });

  it("matches an id prefix pasted from a desktop url", () => {
    expect(matchesLookalikeQuery(row, "abc123", null)).toBe(true);
    // A mid-string id fragment is not a prefix and must not match.
    expect(matchesLookalikeQuery(row, "def", null)).toBe(false);
  });

  it("matches everything on an empty query", () => {
    expect(matchesLookalikeQuery(row, "   ", null)).toBe(true);
  });
});

describe("ordering", () => {
  it("leads with the worst state, then the newest inside a band", () => {
    const failed = audience({ status: "failed", createdAt: new Date(NOW - 40 * DAY).toISOString() });
    const empty = audience({ memberCount: 0 });
    const older = audience({ createdAt: new Date(NOW - 10 * DAY).toISOString() });
    const newer = audience({ createdAt: new Date(NOW - 1 * DAY).toISOString() });

    expect(orderLookalikes([newer, older, empty, failed])).toEqual([
      failed,
      empty,
      newer,
      older,
    ]);
  });

  it("sinks a row with no build date to the end of its band", () => {
    const dated = audience({ createdAt: new Date(NOW - 5 * DAY).toISOString() });
    const undated = audience({ createdAt: null });

    expect(orderLookalikes([undated, dated])).toEqual([dated, undated]);
  });

  it("does not mutate the array it was given", () => {
    const input = [audience(), audience({ status: "failed" })];
    const copy = [...input];
    orderLookalikes(input);
    expect(input).toEqual(copy);
  });
});
