import { describe, expect, it } from "vitest";

import {
  fatigueVerdict,
  parseFatigueDeciles,
  parseSubscriberTimeseries,
  parseTemplateLeaderboard,
  subscriberChartInput,
  subscriberNetChange,
  type FatigueDecile,
} from "./analyticsSeries";

describe("parseSubscriberTimeseries", () => {
  it("reads the documented envelope and a bare array alike", () => {
    const rows = [
      { date: "2026-06-01", count: 10 },
      { date: "2026-06-02", count: 14 },
    ];
    expect(parseSubscriberTimeseries({ range: "7d", points: rows })).toEqual(
      rows,
    );
    expect(parseSubscriberTimeseries(rows)).toEqual(rows);
  });

  it("survives every drift shape without throwing or inventing rows", () => {
    expect(parseSubscriberTimeseries(null)).toEqual([]);
    expect(parseSubscriberTimeseries(undefined)).toEqual([]);
    expect(parseSubscriberTimeseries({})).toEqual([]);
    expect(parseSubscriberTimeseries({ points: "nope" })).toEqual([]);
    expect(parseSubscriberTimeseries({ points: [null, 3] })).toEqual([]);
  });

  it("drops unreadable days rather than charting them as zero", () => {
    // A zero-valued day would draw a cliff the workspace never experienced.
    expect(
      parseSubscriberTimeseries({
        points: [
          { date: "2026-06-01", count: 10 },
          { date: "2026-06-02" },
          { date: "", count: 3 },
          { date: "2026-06-04", count: -2 },
          { date: "2026-06-05", count: 12 },
        ],
      }),
    ).toEqual([
      { date: "2026-06-01", count: 10 },
      { date: "2026-06-05", count: 12 },
    ]);
  });

  it("keeps a genuine measured zero", () => {
    expect(
      parseSubscriberTimeseries({ points: [{ date: "2026-06-01", count: 0 }] }),
    ).toEqual([{ date: "2026-06-01", count: 0 }]);
  });
});

describe("subscriberChartInput", () => {
  it("labels every point with a year-bearing date", () => {
    const input = subscriberChartInput([
      { date: "2026-06-01T00:00:00Z", count: 5 },
    ]);
    expect(input.values).toEqual([5]);
    expect(input.labels[0]).toMatch(/2026/);
  });

  it("falls back to the raw label rather than rendering 'Invalid Date'", () => {
    const input = subscriberChartInput([{ date: "not-a-date", count: 5 }]);
    expect(input.labels[0]).toBe("not-a-date");
  });
});

describe("subscriberNetChange", () => {
  it("reports the movement across the window, including a decline", () => {
    expect(
      subscriberNetChange([
        { date: "a", count: 100 },
        { date: "b", count: 90 },
      ]),
    ).toBe(-10);
  });

  it("returns null for fewer than two points", () => {
    expect(subscriberNetChange([])).toBeNull();
    expect(subscriberNetChange([{ date: "a", count: 100 }])).toBeNull();
  });
});

describe("parseTemplateLeaderboard", () => {
  it("normalizes rows and keeps API rates as 0..1 fractions", () => {
    expect(
      parseTemplateLeaderboard({
        items: [
          {
            template_id: "tpl_1",
            template_name: "Weekly digest",
            campaigns_used: 4,
            sent: 1000,
            opens: 250,
            clicks: 40,
            open_rate: 0.25,
            click_rate: 0.04,
          },
        ],
      }),
    ).toEqual([
      {
        id: "tpl_1",
        name: "Weekly digest",
        campaignsUsed: 4,
        sent: 1000,
        opens: 250,
        clicks: 40,
        openRate: 0.25,
        clickRate: 0.04,
      },
    ]);
  });

  it("drops rows with no identity and names untitled templates", () => {
    const rows = parseTemplateLeaderboard({
      items: [{ template_name: "orphan" }, { template_id: "tpl_2" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Untitled template");
    expect(rows[0]?.openRate).toBeNull();
  });
});

describe("parseFatigueDeciles", () => {
  it("keeps only buckets with both rates present", () => {
    expect(
      parseFatigueDeciles({
        deciles: [
          { sends_bucket: "1", subscribers: 10, open_rate: 0.4, unsub_rate: 0 },
          { sends_bucket: "2", subscribers: 10, open_rate: 0.3 },
        ],
      }),
    ).toEqual([
      { bucket: "1", subscribers: 10, openRate: 0.4, unsubRate: 0 },
    ]);
  });
});

function curve(openRates: number[]): FatigueDecile[] {
  return openRates.map((openRate, i) => ({
    bucket: String(i + 1),
    subscribers: 100,
    openRate,
    unsubRate: 0.001 * (i + 1),
  }));
}

describe("fatigueVerdict", () => {
  it("declines to judge a curve too short to read", () => {
    expect(fatigueVerdict(curve([0.4, 0.3, 0.2]))).toBeNull();
    expect(fatigueVerdict([])).toBeNull();
  });

  it("calls a flat curve healthy", () => {
    const verdict = fatigueVerdict(curve([0.4, 0.4, 0.4, 0.41, 0.39]));
    expect(verdict?.severity).toBe("ok");
    expect(verdict?.headline).toContain("hold up");
  });

  it("flags a moderate sag as watch and a steep one as fatigued", () => {
    expect(fatigueVerdict(curve([0.4, 0.4, 0.4, 0.36, 0.32]))?.severity).toBe(
      "watch",
    );
    expect(fatigueVerdict(curve([0.4, 0.4, 0.4, 0.3, 0.2]))?.severity).toBe(
      "fatigued",
    );
  });

  it("measures against the LIGHTEST deciles, not the dragged-down mean", () => {
    const verdict = fatigueVerdict(curve([0.5, 0.5, 0.5, 0.4, 0.25]));
    expect(verdict?.decline).toBeCloseTo(0.5, 5);
    expect(verdict?.heaviestBucket).toBe("5");
  });

  it("returns null when the baseline itself is zero", () => {
    // Nothing to compare against; a divide by zero would print Infinity%.
    expect(fatigueVerdict(curve([0, 0, 0, 0, 0]))).toBeNull();
  });

  it("never reports a negative decline when heavy senders open MORE", () => {
    const verdict = fatigueVerdict(curve([0.2, 0.2, 0.2, 0.4, 0.5]));
    expect(verdict?.decline).toBe(0);
    expect(verdict?.severity).toBe("ok");
  });
});
