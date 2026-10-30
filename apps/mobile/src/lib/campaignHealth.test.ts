import { describe, expect, it } from "vitest";

import {
  campaignAnomalyRows,
  campaignAnomalySummary,
  readCampaignHealth,
} from "./campaignHealth";

describe("readCampaignHealth", () => {
  it("does not present an under-sampled campaign as healthy or scored", () => {
    expect(
      readCampaignHealth({
        status: "insufficient_data",
        sample_qualified: false,
        sample_size: 125,
        minimum_sample_size: 1000,
        score: 0,
        grade: "N/A",
      }),
    ).toMatchObject({
      tone: "unknown",
      badge: "Sample building",
      headline:
        "125 of 1,000 successful campaign sends are available for rate scoring.",
      scoreLine: null,
    });
  });

  it("reads a healthy send as healthy, with a worded badge", () => {
    const reading = readCampaignHealth({
      status: "healthy",
      score: 94,
      grade: "A",
    });
    expect(reading.tone).toBe("good");
    // Never colour-alone: the badge carries the word too.
    expect(reading.badge).toContain("Healthy");
    expect(reading.scoreLine).toBe("94 / 100 · A");
  });

  it("passes the gateway's own reasons through verbatim", () => {
    const reading = readCampaignHealth({
      status: "needs_attention",
      grade: "C",
      reasons: ["Bounce rate 6.2% over the 30-day baseline of 0.8%"],
    });
    expect(reading.reasons).toEqual([
      "Bounce rate 6.2% over the 30-day baseline of 0.8%",
    ]);
    expect(reading.tone).toBe("warning");
  });

  it("escalates a failing grade past a caution", () => {
    for (const grade of ["D", "E", "F"]) {
      expect(
        readCampaignHealth({ status: "needs_attention", grade }).tone,
      ).toBe("danger");
    }
  });

  it("treats an unrecognised status as a warning rather than swallowing it", () => {
    const reading = readCampaignHealth({ status: "quarantined" });
    expect(reading.tone).toBe("warning");
  });

  it("says 'not measured' rather than 'healthy' when there is no reading", () => {
    const reading = readCampaignHealth(null);
    expect(reading.tone).toBe("unknown");
    expect(reading.badge).toBe("Not measured");
    expect(reading.headline).not.toMatch(/healthy|problem/i);
  });

  it("drops empty reason strings instead of rendering blank bullets", () => {
    expect(
      readCampaignHealth({ status: "needs_attention", reasons: ["", "  "] })
        .reasons,
    ).toEqual([]);
  });
});

describe("campaignAnomalyRows", () => {
  const ANOMALIES = {
    anomalies: [
      {
        hour: "2026-07-26T14:00Z",
        metric: "clicks",
        value: 90,
        mean: 30,
        z_score: 3.1,
        direction: "spike",
      },
      {
        hour: "2026-07-26T15:00Z",
        metric: "unsubs",
        value: 42,
        mean: 5,
        z_score: 6.4,
        direction: "spike",
      },
    ],
  };

  it("turns a z-score into a sentence an operator can act on", () => {
    const rows = campaignAnomalyRows(ANOMALIES);
    expect(rows[0]?.message).toBe(
      "Unsubscribes spiked to 42 in one hour against a baseline of 5 at 2026-07-26T15:00Z.",
    );
    expect(rows[0]?.multiple).toBe("8.4x");
  });

  it("ranks the most extreme z-score first, not the first one returned", () => {
    expect(campaignAnomalyRows(ANOMALIES).map((r) => r.id)).toEqual([
      "unsubs-spike-2026-07-26T15:00Z",
      "clicks-spike-2026-07-26T14:00Z",
    ]);
  });

  it("does not paint good news and bad news the same", () => {
    const rows = campaignAnomalyRows(ANOMALIES);
    // An unsubscribe spike is bad; a click spike is not.
    expect(rows.find((r) => r.id.startsWith("unsubs"))?.tone).toBe("danger");
    expect(rows.find((r) => r.id.startsWith("clicks"))?.tone).toBe("warning");
    // A DROP in opens is bad, even though a drop in unsubs is not.
    expect(
      campaignAnomalyRows({
        anomalies: [{ metric: "opens", direction: "drop", value: 2, mean: 40 }],
      })[0]?.tone,
    ).toBe("danger");
  });

  it("ignores rows whose metric or direction it cannot name", () => {
    expect(
      campaignAnomalyRows({
        anomalies: [
          { metric: "gremlins", direction: "spike", value: 1 },
          { metric: "opens", direction: "sideways", value: 1 },
          {},
        ],
      }),
    ).toEqual([]);
  });

  it("omits the multiple rather than dividing by a zero baseline", () => {
    const rows = campaignAnomalyRows({
      anomalies: [{ metric: "opens", direction: "spike", value: 5, mean: 0 }],
    });
    expect(rows[0]?.multiple).toBeNull();
    expect(rows[0]?.message).not.toContain("Infinity");
  });

  it("is bounded", () => {
    const anomalies = Array.from({ length: 30 }, (_, i) => ({
      hour: `h${i}`,
      metric: "opens",
      direction: "drop",
      value: 1,
      mean: 10,
      z_score: i,
    }));
    expect(campaignAnomalyRows({ anomalies }, 3)).toHaveLength(3);
  });

  it("survives a missing response", () => {
    expect(campaignAnomalyRows(null)).toEqual([]);
  });
});

describe("campaignAnomalySummary", () => {
  it("says plainly when nothing was unusual", () => {
    expect(campaignAnomalySummary([], false)).toContain(
      "No hour of this send behaved unusually",
    );
  });

  it("counts the rows worth acting on separately from the total", () => {
    const rows = campaignAnomalyRows({
      anomalies: [
        { metric: "unsubs", direction: "spike", value: 9, mean: 1, z_score: 5 },
        { metric: "clicks", direction: "spike", value: 9, mean: 1, z_score: 4 },
      ],
    });
    expect(campaignAnomalySummary(rows, false)).toBe(
      "2 unusual hours detected, 1 worth acting on.",
    );
  });

  it("admits a truncated analysis window", () => {
    expect(campaignAnomalySummary([], true)).toContain(
      "Only part of the send window was analysed.",
    );
  });
});
