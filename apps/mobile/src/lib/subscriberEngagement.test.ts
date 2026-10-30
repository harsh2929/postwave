/**
 * subscriberEngagement — distribution/browse parsing, the defaults
 * fallback (a tenant with no rules RUNS the defaults and the view must say
 * so), the whole-set PUT with its version echo, and the tone thirds.
 */
import { describe, expect, it } from "vitest";

import {
  bucketTone,
  buildScoringRulesPut,
  parseScoreDistribution,
  parseScoredPage,
  parseScoringRules,
  scoringRulesProblem,
} from "./subscriberEngagement";

describe("parseScoreDistribution", () => {
  it("parses the decile buckets and labels an unlabeled one", () => {
    expect(
      parseScoreDistribution({
        buckets: [
          { range: "0..9", min: 0, max: 9, count: 40 },
          { min: 10, max: 19, count: 8 },
        ],
      }),
    ).toEqual([
      { range: "0..9", min: 0, max: 9, count: 40 },
      { range: "10..19", min: 10, max: 19, count: 8 },
    ]);
    expect(parseScoreDistribution(null)).toEqual([]);
  });
});

describe("bucketTone — desktop's thirds", () => {
  it("ramps low → mid → high across the strip", () => {
    expect(bucketTone(0, 10)).toBe("low");
    expect(bucketTone(4, 10)).toBe("mid");
    expect(bucketTone(9, 10)).toBe("high");
  });
});

describe("parseScoredPage", () => {
  it("keeps id+email+score rows and the paging counters", () => {
    expect(
      parseScoredPage({
        items: [
          { id: "s1", email: "a@x.com", score: 82 },
          { id: "", email: "junk@x.com", score: 1 },
        ],
        page: 2,
        per_page: 50,
        total: 120,
      }),
    ).toEqual({
      items: [{ id: "s1", email: "a@x.com", score: 82 }],
      page: 2,
      total: 120,
    });
  });
});

describe("parseScoringRules", () => {
  const payload = {
    rules: [],
    defaults: [
      { event_type: "email_open", weight: 1 },
      { event_type: "order_placed", weight: 10, note: "commerce" },
    ],
    event_catalog: [
      { event_type: "email_open", label: "Opened an email", category: "email" },
      { event_type: "order_placed", label: "Placed an order", category: "commerce" },
    ],
    version: "v-abc",
    window_days: 180,
  };

  it("falls back to the DEFAULTS when the tenant has no rows, and says so", () => {
    const view = parseScoringRules(payload);
    expect(view.usingDefaults).toBe(true);
    expect(view.rules.map((r) => r.label)).toEqual([
      "Opened an email",
      "Placed an order",
    ]);
    expect(view.version).toBe("v-abc");
    expect(view.windowDays).toBe(180);
  });

  it("prefers tenant rules when they exist", () => {
    const view = parseScoringRules({
      ...payload,
      rules: [{ event_type: "email_open", weight: 3 }],
    });
    expect(view.usingDefaults).toBe(false);
    expect(view.rules).toEqual([
      { eventType: "email_open", label: "Opened an email", weight: 3, note: "" },
    ]);
  });
});

describe("saving the rule set", () => {
  it("refuses an empty set and non-integer weights", () => {
    expect(scoringRulesProblem([])).toMatch(/at least one rule/);
    expect(
      scoringRulesProblem([{ eventType: "email_open", weight: 1.5 }]),
    ).toMatch(/whole number/);
    expect(
      scoringRulesProblem([{ eventType: "email_open", weight: 5 }]),
    ).toBeNull();
  });

  it("the PUT carries the WHOLE set and echoes the loaded version", () => {
    expect(
      buildScoringRulesPut(
        [
          { eventType: "email_open", label: "x", weight: 3, note: "" },
          { eventType: "order_placed", label: "y", weight: 10, note: "commerce" },
        ],
        "v-abc",
      ),
    ).toEqual({
      rules: [
        { event_type: "email_open", weight: 3 },
        { event_type: "order_placed", weight: 10, note: "commerce" },
      ],
      expected_version: "v-abc",
    });
  });
});
