import { describe, expect, it } from "vitest";

import { inboxRealityHistoryFromStats } from "./inboxRealityHistory";

describe("inboxRealityHistoryFromStats", () => {
  it("derives gross ratios over gross sends", () => {
    expect(
      inboxRealityHistoryFromStats({
        emails_sent_30d: 1000,
        opens_total_30d: 300,
        clicks_total_30d: 40,
        bounces_total_30d: 5,
      }),
    ).toEqual({
      OpenRate: 0.3,
      ClickRate: 0.04,
      BounceRate: 0.005,
      SendVolume: 1000,
    });
  });

  it("returns null rather than a zeroed history when nothing has been sent", () => {
    // A first-time sender with an invented "0% open rate" is forecast into the
    // spam folder by the predictor. No history is the honest input.
    expect(inboxRealityHistoryFromStats({ emails_sent_30d: 0 })).toBeNull();
    expect(inboxRealityHistoryFromStats({})).toBeNull();
    expect(inboxRealityHistoryFromStats(undefined)).toBeNull();
    expect(inboxRealityHistoryFromStats(null)).toBeNull();
  });

  it("omits a ratio it cannot compute instead of sending zero", () => {
    const history = inboxRealityHistoryFromStats({
      emails_sent_30d: 500,
      opens_total_30d: 100,
    });
    expect(history).toEqual({ OpenRate: 0.2, SendVolume: 500 });
    expect(history).not.toHaveProperty("ClickRate");
    expect(history).not.toHaveProperty("BounceRate");
  });

  it("clamps a lagging denominator instead of reporting above 100%", () => {
    const history = inboxRealityHistoryFromStats({
      emails_sent_30d: 10,
      opens_total_30d: 40,
    });
    expect(history?.OpenRate).toBe(1);
  });

  it("refuses impossible counts", () => {
    expect(
      inboxRealityHistoryFromStats({
        emails_sent_30d: 100,
        opens_total_30d: -5,
        clicks_total_30d: Number.NaN,
      }),
    ).toEqual({ SendVolume: 100 });
    expect(
      inboxRealityHistoryFromStats({ emails_sent_30d: Number.NaN }),
    ).toBeNull();
  });
});
