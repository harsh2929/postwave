import { describe, expect, it, vi } from "vitest";

// useDashboard.ts imports @/api/client (RN-bound); the test only exercises
// the pure pick* selectors, so stub the client module so the import resolves.
vi.mock("@/api/client", () => ({ getClient: vi.fn() }));
vi.mock("@/hooks/useOnlineQueryGate", () => ({ useOnlineQueryGate: vi.fn() }));
// The offline-snapshot path pulls in netinfo (via connectivity) and
// expo-secure-store, neither of which parses in the node environment.
vi.mock("@/lib/connectivity", () => ({ isProbablyOnline: () => true }));
vi.mock("@/lib/secureVault", () => ({
  vaultGetJSON: vi.fn(async () => null),
  vaultSetJSON: vi.fn(async () => undefined),
  vaultScopeForClient: vi.fn(() => "scope"),
}));

// eslint-disable-next-line import/first
import {
  DEFAULT_DASHBOARD_RANGE,
  dashboardStatsPath,
  isDashboardRange,
  mapAuditRowToDashboardEvent,
  pickActiveSequences,
  pickBounceRate,
  pickCampaignsSent30d,
  pickClickRate,
  pickOpenRate,
  pickPreviousBounceRate,
  pickAnomaly,
  pickPreviousOpenRate,
  pickPreviousSubscribersDelta,
  pickSparkline,
  pickSubscribersDelta30d,
  pickSubscribersTotal,
  type DashboardStats,
} from "./useDashboard";

describe("dashboardStatsPath", () => {
  it("defaults to the 30-day window with comparison AND sparklines on", () => {
    // compare=true is what feeds the tiles' period-over-period deltas.
    // sparklines=true is ONE flag carrying TWO facts the phone had neither of:
    // the daily buckets under the subscribers tile and the server's bounce
    // anomaly flag. The handler's own default is true and the repo serves the
    // buckets from a cached singleflight, so this is parity, not a new cost.
    expect(dashboardStatsPath()).toBe(
      "/api/v1/dashboard/stats?range=30d&compare=true&sparklines=true",
    );
    expect(DEFAULT_DASHBOARD_RANGE).toBe("30d");
  });

  it("expresses every window the server accepts", () => {
    expect(dashboardStatsPath({ range: "7d" })).toContain("range=7d");
    expect(dashboardStatsPath({ range: "90d" })).toContain("range=90d");
    expect(dashboardStatsPath({ range: "7d", compare: false })).toBe(
      "/api/v1/dashboard/stats?range=7d&compare=false&sparklines=true",
    );
    expect(dashboardStatsPath({ sparklines: false })).toContain(
      "sparklines=false",
    );
  });

  it("guards the range enum at the boundary", () => {
    expect(isDashboardRange("7d")).toBe(true);
    expect(isDashboardRange("365d")).toBe(false);
    expect(isDashboardRange(undefined)).toBe(false);
  });
});

describe("absence is not zero", () => {
  it("returns null — never 0 — when a count is missing", () => {
    // A null body or an envelope-shape drift used to resolve as a confident
    // "0 subscribers · 0 sent · 0 sequences" workspace.
    expect(pickSubscribersTotal(undefined)).toBeNull();
    expect(pickSubscribersTotal({})).toBeNull();
    expect(pickCampaignsSent30d({})).toBeNull();
    expect(pickActiveSequences({})).toBeNull();
  });

  it("still reports a genuine measured zero", () => {
    expect(pickSubscribersTotal({ subscribers_total: 0 })).toBe(0);
    expect(pickCampaignsSent30d({ campaigns_sent_30d: 0 })).toBe(0);
    expect(pickActiveSequences({ active_sequences_count: 0 })).toBe(0);
  });

  it("falls back to the legacy nested shape", () => {
    expect(pickSubscribersTotal({ subscribers: { total: 42 } })).toBe(42);
    expect(pickCampaignsSent30d({ campaigns_sent: { this_month: 3 } })).toBe(3);
    expect(pickActiveSequences({ active_sequences: { count: 3 } })).toBe(3);
  });
});

describe("pickSubscribersDelta30d", () => {
  it("reports net subscriber change, including declines", () => {
    expect(
      pickSubscribersDelta30d({
        subscribers_added_30d: 12,
        subscribers_unsubbed_30d: 20,
      }),
    ).toBe(-8);
    expect(
      pickSubscribersDelta30d({
        subscribers_added_30d: 20,
        subscribers_unsubbed_30d: 5,
      }),
    ).toBe(15);
  });
});

describe("pickOpenRate", () => {
  it("never divides opens by CAMPAIGN COUNT (that yields absurd >100% rates)", () => {
    // 500 opens across 3 campaigns must NOT be reported as 166 (16,600%).
    // Campaign count is not a valid denominator for an open RATE.
    const stats: DashboardStats = {
      opens_total_30d: 500,
      campaigns_sent_30d: 3,
    };
    expect(pickOpenRate(stats)).toBeNull();
  });

  it("uses authoritative unique opens over unique delivered recipients", () => {
    expect(
      pickOpenRate({
        unique_opens_30d: 125,
        unique_delivered_30d: 500,
        opens_total_30d: 900,
        emails_sent_30d: 600,
      }),
    ).toBe(0.25);
  });

  it("falls back to unique sent when delivered is not computed", () => {
    expect(
      pickOpenRate({ unique_opens_30d: 50, unique_sent_30d: 200 }),
    ).toBe(0.25);
  });

  it("refuses a proxy-inflated ratio rather than clamping it to a believable 100%", () => {
    // opens > delivered means the denominator is wrong or lagging. Rendering
    // "100%" would hide a data-integrity problem behind a plausible number.
    expect(
      pickOpenRate({ unique_opens_30d: 14, unique_delivered_30d: 10 }),
    ).toBeNull();
  });

  it("clamps only the LEGACY precomputed rate, which has no counts to check", () => {
    expect(pickOpenRate({ open_rate: { rate: 1.4 } })).toBe(1);
    expect(pickOpenRate({ open_rate: { rate: 0.42 } })).toBe(0.42);
  });

  it("does not derive a rate from gross opens and sent events", () => {
    expect(
      pickOpenRate({ opens_total_30d: 125, emails_sent_30d: 500 }),
    ).toBeNull();
  });

  it("returns null (→ '—') when no authoritative rate is available", () => {
    expect(pickOpenRate(undefined)).toBeNull();
    expect(pickOpenRate({})).toBeNull();
    expect(pickOpenRate({ open_rate: { rate: Number.NaN } })).toBeNull();
  });
});

describe("pickClickRate / pickBounceRate", () => {
  it("computes click rate against delivered recipients", () => {
    expect(
      pickClickRate({ unique_clicks_30d: 40, unique_delivered_30d: 800 }),
    ).toBe(0.05);
  });

  it("computes bounce rate against SENT, never delivered", () => {
    // A bounce is by definition not delivered; using delivered as the
    // denominator would inflate the rate.
    expect(
      pickBounceRate({
        unique_bounces_30d: 10,
        unique_sent_30d: 1000,
        unique_delivered_30d: 990,
      }),
    ).toBe(0.01);
  });

  it("returns null when the denominator is absent or zero", () => {
    expect(pickBounceRate({ unique_bounces_30d: 10 })).toBeNull();
    expect(
      pickBounceRate({ unique_bounces_30d: 0, unique_sent_30d: 0 }),
    ).toBeNull();
    expect(pickClickRate({})).toBeNull();
  });
});

describe("previous-window pickers", () => {
  it("derives the comparison net add and rates from the compare payload", () => {
    const stats: DashboardStats = {
      subscribers_total: 10,
      previous: {
        subscribers_added: 30,
        subscribers_unsubbed: 12,
        unique_opens: 100,
        unique_delivered: 500,
        unique_bounces: 5,
        unique_sent: 500,
      },
    };
    expect(pickPreviousSubscribersDelta(stats)).toBe(18);
    expect(pickPreviousOpenRate(stats)).toBe(0.2);
    expect(pickPreviousBounceRate(stats)).toBe(0.01);
  });

  it("returns null when the server did not send a comparison window", () => {
    expect(pickPreviousSubscribersDelta({ subscribers_total: 1 })).toBeNull();
    expect(pickPreviousOpenRate({ subscribers_total: 1 })).toBeNull();
    expect(pickPreviousBounceRate(undefined)).toBeNull();
  });
});

describe("mapAuditRowToDashboardEvent", () => {
  it("normalizes audit rows into dashboard feed events", () => {
    expect(
      mapAuditRowToDashboardEvent({
        id: 42,
        action: "campaign.sent",
        actorLabel: "Ava",
        actorType: "user",
        at: "2026-06-28T12:00:00Z",
      }),
    ).toEqual({
      id: "42",
      action: "campaign.sent",
      actor: "Ava",
      at: "2026-06-28T12:00:00Z",
      description: "Campaign sent",
    });
  });

  it("falls back to actor type and generic action labels", () => {
    expect(
      mapAuditRowToDashboardEvent({
        id: "evt-1",
        actorLabel: " ",
        actorType: "system",
      }),
    ).toMatchObject({
      id: "evt-1",
      action: "activity",
      actor: "system",
      description: "Event",
    });
  });
});

describe("sparklines and anomalies (?sparklines=true)", () => {
  it("refuses to draw a trend from fewer than three points", () => {
    // sparklinePoints centres a constant series, so a one- or two-day-old
    // workspace would otherwise paint a confident flat line across the tile.
    expect(
      pickSparkline({ sparklines: { subscribers: [4, 5] } }, "subscribers"),
    ).toBeNull();
    expect(
      pickSparkline({ sparklines: { subscribers: [4, 5, 6] } }, "subscribers"),
    ).toEqual([4, 5, 6]);
    expect(pickSparkline(undefined, "subscribers")).toBeNull();
    expect(pickSparkline({}, "subscribers")).toBeNull();
  });

  it("keeps series separate per metric", () => {
    const stats: DashboardStats = {
      sparklines: { subscribers: [1, 2, 3], bounces: [9, 9, 9] },
    };
    expect(pickSparkline(stats, "bounces")).toEqual([9, 9, 9]);
    expect(pickSparkline(stats, "opens")).toBeNull();
  });

  it("treats an unevaluated anomaly map as 'no spike', never as a spike", () => {
    // The server populates `anomalies` ONLY with sparklines=true. An absent
    // flag means "not evaluated" — rendering that as a warning badge would
    // put a red pill on every workspace running an older gateway.
    expect(pickAnomaly(undefined, "bounces")).toBe(false);
    expect(pickAnomaly({}, "bounces")).toBe(false);
    expect(pickAnomaly({ anomalies: {} }, "bounces")).toBe(false);
    expect(pickAnomaly({ anomalies: { bounces: false } }, "bounces")).toBe(
      false,
    );
    expect(pickAnomaly({ anomalies: { bounces: true } }, "bounces")).toBe(true);
    // Only the flagged metric is flagged.
    expect(pickAnomaly({ anomalies: { bounces: true } }, "opens")).toBe(false);
  });
});
