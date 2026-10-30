import { describe, expect, it } from "vitest";

import {
  blocklistSummary,
  breachFixTarget,
  hubBanner,
  hubHeadline,
  hubRates,
  rateTone,
  sortedBreaches,
  trendCaption,
  type HubLike,
} from "./deliverabilityHubView";

function hub(overrides: Partial<HubLike> = {}): HubLike {
  return {
    score: 82,
    grade: "Good",
    status: "ok",
    trend: "flat",
    trendDelta: 0,
    history: [],
    bounceRate: 0.004,
    complaintRate: 0.0002,
    engagementRate: 0.31,
    windowDays: 30,
    sends7d: 1200,
  sampleQualified: true,
  sends30d: 5000,
  minimumSampleSends: 1000,
  sampleReason: "",
    autoThrottled: false,
    autoThrottleReason: "",
    breaches: [],
    blocklistHits: [],
    computedAt: "2026-07-25T10:00:00Z",
    ...overrides,
  };
}

describe("hubHeadline", () => {
  it("speaks the score and grade rather than relying on colour", () => {
    const out = hubHeadline(hub());
    expect(out.score).toBe("82");
    expect(out.grade).toBe("Good");
    expect(out.spoken).toBe("Deliverability score 82 out of 100, graded Good");
    expect(out.tone).toBe("info");
  });

  it("does NOT render a missing score as zero", () => {
    // A shape drift must not print "0 — Critical" and start a fire drill.
    const out = hubHeadline({ score: Number.NaN, grade: "" });
    expect(out.score).toBe("—");
    expect(out.tone).toBe("neutral");
    expect(out.spoken).toBe("Deliverability score unavailable");
  });

  it("keeps a genuine zero as a real, terrible score", () => {
    const out = hubHeadline({ score: 0, grade: "Critical" });
    expect(out.score).toBe("0");
    expect(out.tone).toBe("danger");
  });

  it("lets the server grade win over the numeric band so colour never lies", () => {
    // 82 alone bands to "info"; the server says Excellent, so follow the word.
    expect(hubHeadline({ score: 82, grade: "Excellent" }).tone).toBe("success");
  });
});

describe("trendCaption", () => {
  it("reads flat as no change even when a delta leaks through", () => {
    expect(trendCaption({ trend: "flat", trendDelta: 3 })).toBe(
      "No change vs last week",
    );
  });

  it("words a rise and a fall in points", () => {
    expect(trendCaption({ trend: "up", trendDelta: 4 })).toBe(
      "Up 4 points vs last week",
    );
    expect(trendCaption({ trend: "down", trendDelta: -1 })).toBe(
      "Down 1 point vs last week",
    );
  });
});

describe("hubBanner", () => {
  it("leads with auto-throttle, because the cap is already in force", () => {
    const banner = hubBanner(
      hub({
        autoThrottled: true,
        autoThrottleReason: "Complaint rate above 0.3% for 3 days",
        breaches: [
          {
            code: "b",
            severity: "critical",
            title: "Complaint rate breach",
            detail: "d",
            fixLabel: "",
          },
        ],
      }),
    );
    expect(banner?.title).toBe("Sending is auto-throttled");
    expect(banner?.message).toBe("Complaint rate above 0.3% for 3 days");
    expect(banner?.tone).toBe("danger");
  });

  it("falls back to the worst critical breach when nothing is throttled", () => {
    const banner = hubBanner(
      hub({
        breaches: [
          {
            code: "a",
            severity: "warn",
            title: "Warn",
            detail: "",
            fixLabel: "",
          },
          {
            code: "b",
            severity: "critical",
            title: "Hard bounces spiking",
            detail: "12% of sends bounced",
            fixLabel: "",
          },
        ],
      }),
    );
    expect(banner?.title).toBe("Hard bounces spiking");
    expect(banner?.message).toBe("12% of sends bounced");
  });

  it("stays silent for a healthy workspace and for warn-only breaches", () => {
    expect(hubBanner(hub())).toBeNull();
    expect(
      hubBanner(
        hub({
          breaches: [
            {
              code: "a",
              severity: "warn",
              title: "W",
              detail: "",
              fixLabel: "",
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("supplies its own copy when the server omits a throttle reason", () => {
    const banner = hubBanner(
      hub({ autoThrottled: true, autoThrottleReason: "  " }),
    );
    expect(banner?.message).toContain("reduced this workspace's send rate");
  });
});

describe("sortedBreaches", () => {
  it("orders critical, then warn, then info, then alphabetically", () => {
    const rows = sortedBreaches([
      { severity: "info", title: "Zebra" },
      { severity: "warn", title: "Beta" },
      { severity: "critical", title: "Delta" },
      { severity: "warn", title: "Alpha" },
    ]);
    expect(rows.map((r) => r.title)).toEqual([
      "Delta",
      "Alpha",
      "Beta",
      "Zebra",
    ]);
  });

  it("does not mutate its input", () => {
    const input = [
      { severity: "info", title: "B" },
      { severity: "critical", title: "A" },
    ];
    sortedBreaches(input);
    expect(input[0]?.title).toBe("B");
  });
});

describe("blocklistSummary", () => {
  it("names the tier-1 count instead of flattening it into a total", () => {
    const out = blocklistSummary([
      { tier1: true },
      { tier1: false },
      { tier1: false },
    ]);
    expect(out.caption).toBe("1 tier-1 listing of 3");
    expect(out.tone).toBe("danger");
    expect(out.tier1).toBe(1);
  });

  it("tones a tier-2-only listing as a warning, not an emergency", () => {
    const out = blocklistSummary([{ tier1: false }]);
    expect(out.caption).toBe("1 tier-2 listing");
    expect(out.tone).toBe("warning");
  });

  it("says nothing when the workspace is clean", () => {
    expect(blocklistSummary([]).caption).toBe("");
    expect(blocklistSummary(undefined).total).toBe(0);
  });
});

describe("rateTone", () => {
  it("treats a high bounce rate as danger and a low one as success", () => {
    expect(rateTone("bounce", 0.06)).toBe("danger");
    expect(rateTone("bounce", 0.03)).toBe("warning");
    expect(rateTone("bounce", 0.001)).toBe("success");
  });

  it("uses the ESP-standard complaint line, not the bounce line", () => {
    // 0.2% would be "fine" on the bounce scale and is a warning here.
    expect(rateTone("complaint", 0.002)).toBe("warning");
    expect(rateTone("complaint", 0.004)).toBe("danger");
  });

  it("inverts for engagement", () => {
    expect(rateTone("engagement", 0.35)).toBe("success");
    expect(rateTone("engagement", 0.02)).toBe("danger");
  });

  it("returns neutral rather than success for a missing value", () => {
    expect(rateTone("bounce", undefined)).toBe("neutral");
  });
});

describe("hubRates", () => {
  it("marks bounce and complaint as lower-is-better", () => {
    const rates = hubRates(hub());
    expect(rates.map((r) => r.higherIsBetter)).toEqual([false, false, true]);
    expect(rates[0]?.value).toBeCloseTo(0.004);
  });
});

describe("an unqualified sample is not a score", () => {
  /**
   * With no sending at all the arithmetic lands on a perfect 100/A: zero
   * bounces over zero sends. The server says so itself -- `sample_qualified:
   * false` beside `minimum_sample_sends: 1000` and `totals.sends_30d: 0` --
   * and this view dropped all three, so the app printed "100 / 100  A" on the
   * screen an operator opens to decide whether their sending is safe. Seen
   * in-app on 2026-08-19 against a workspace with 0 sends.
   *
   * Desktop's ScoreCard already refuses it (score only when sample_qualified,
   * grade "N/A" otherwise). This is the same rule.
   */
  it("refuses to print a score the server says is unqualified", () => {
    const out = hubHeadline({
      score: 100,
      grade: "A",
      sampleQualified: false,
      sends30d: 0,
      minimumSampleSends: 1000,
    });
    expect(out.score).toBe("—");
    expect(out.grade).not.toBe("A");
    expect(out.tone).toBe("neutral");
  });

  it("says how far short the sample is, in the spoken label", () => {
    const out = hubHeadline({
      score: 92,
      grade: "A",
      sampleQualified: false,
      sends30d: 40,
      minimumSampleSends: 1000,
    });
    expect(out.spoken).toContain("40");
    expect(out.spoken).toContain("1000");
  });

  it("still prints a real score once the sample qualifies", () => {
    const out = hubHeadline({
      score: 92,
      grade: "B",
      sampleQualified: true,
      sends30d: 5000,
      minimumSampleSends: 1000,
    });
    expect(out.score).toBe("92");
    expect(out.grade).toBe("B");
  });

  it("leaves a caller that knows nothing about sampling unchanged", () => {
    // Backwards compatible: only an EXPLICIT false suppresses the score.
    const out = hubHeadline({ score: 77, grade: "C" });
    expect(out.score).toBe("77");
  });
});

describe("the shortfall is explained in the server's own words", () => {
  /**
   * The hub ships a sentence with the reason: "fewer than 1,000 successful
   * campaign sends in the 30-day model window". It names WHICH sends count
   * (successful campaign sends) and WHICH window they are counted in (the
   * 30-day model window) — detail a client-side reconstruction from the raw
   * counts gets subtly wrong.
   */
  it("prefers the server sentence over a rebuilt one", () => {
    const out = hubHeadline({
      score: 100,
      grade: "A",
      sampleQualified: false,
      sends30d: 0,
      minimumSampleSends: 1000,
      sampleReason:
        "fewer than 1,000 successful campaign sends in the 30-day model window",
    });
    expect(out.spoken).toContain("successful campaign sends");
    expect(out.spoken).toContain("30-day model window");
  });

  it("falls back to the counts when the server sent no reason", () => {
    const out = hubHeadline({
      score: 100,
      grade: "A",
      sampleQualified: false,
      sends30d: 40,
      minimumSampleSends: 1000,
      sampleReason: "   ",
    });
    expect(out.spoken).toContain("40");
    expect(out.spoken).toContain("1000");
  });
});

describe("breachFixTarget", () => {
  it("returns nothing when the server sent no label", () => {
    expect(breachFixTarget({ fixLabel: "  " })).toBeNull();
    expect(
      breachFixTarget({ fixLabel: "", fixSection: "suppressions" }),
    ).toBeNull();
  });

  it("lets a server http(s) href win over any section slug", () => {
    expect(
      breachFixTarget({
        fixLabel: "Request delisting",
        fixHref: "https://delist.example.com/form",
        fixSection: "suppressions",
      }),
    ).toEqual({
      kind: "href",
      label: "Request delisting",
      url: "https://delist.example.com/form",
    });
  });

  it("never opens a non-http scheme", () => {
    expect(
      breachFixTarget({ fixLabel: "Fix", fixHref: "javascript:alert(1)" }),
    ).toBeNull();
  });

  it("maps known section slugs to the owning tab", () => {
    expect(
      breachFixTarget({ fixLabel: "Clean list", fixSection: "suppressions" }),
    ).toEqual({
      kind: "route",
      label: "Clean list",
      route: "/(tabs)/suppressions",
    });
  });

  it("gives an unknown slug no button rather than a guessed destination", () => {
    expect(
      breachFixTarget({ fixLabel: "Fix", fixSection: "made-up-surface" }),
    ).toBeNull();
  });
});
