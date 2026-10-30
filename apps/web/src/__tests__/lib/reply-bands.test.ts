// SPDX-License-Identifier: AGPL-3.0-only
//
// The live tenant reports zeros for every reply figure, so these pin the
// behaviour that only becomes visible once replies exist: the three-band
// split must not be collapsed into two, and the sender window must not be
// mistaken for the summary window.

import { describe, expect, it } from "vitest";

import {
  bandResidual,
  windowsDisagree,
  type ReplySummary,
} from "@/lib/replies-api";

function summary(over: Partial<ReplySummary> = {}): ReplySummary {
  return {
    total: 0,
    human_replies: 0,
    excluded_non_human: 0,
    unclassified_replies: 0,
    matched: 0,
    unmatched: 0,
    window_days: 30,
    top_campaigns: [],
    ...over,
  };
}

describe("reply classification bands", () => {
  it("treats unclassified as its own band, not as human or excluded", () => {
    // 100 replies: 40 human, 35 bots, 25 undecided. Reporting engagement as
    // "65 human" (folding the undecided in) or "40 of 75" (folding them into
    // excluded) are both wrong, and in opposite directions.
    const s = summary({
      total: 100,
      human_replies: 40,
      excluded_non_human: 35,
      unclassified_replies: 25,
    });
    expect(bandResidual(s)).toBe(0);
    expect(s.human_replies).toBe(40);
    expect(s.human_replies + s.unclassified_replies).not.toBe(s.human_replies);
  });

  it("surfaces a residual when the bands do not account for every reply", () => {
    const s = summary({
      total: 100,
      human_replies: 40,
      excluded_non_human: 35,
      unclassified_replies: 20,
    });
    expect(bandResidual(s)).toBe(5);
  });

  it("reports a negative residual rather than clamping it away", () => {
    // Double-counting upstream would make the bands exceed the total. That is
    // a data problem worth showing, not one to hide behind Math.max(0, …).
    const s = summary({
      total: 10,
      human_replies: 8,
      excluded_non_human: 5,
      unclassified_replies: 0,
    });
    expect(bandResidual(s)).toBe(-3);
  });

  it("flags the sender window when it differs from the summary window", () => {
    expect(windowsDisagree(30, 90)).toBe(true);
    expect(windowsDisagree(30, 30)).toBe(false);
  });

  it("does not claim a mismatch when either window is unknown", () => {
    // A zero window means "not reported", which is not evidence of a
    // different period.
    expect(windowsDisagree(0, 90)).toBe(false);
    expect(windowsDisagree(30, 0)).toBe(false);
  });
});
