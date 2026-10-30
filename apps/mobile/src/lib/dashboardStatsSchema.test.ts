import { describe, expect, it } from "vitest";

import {
  DashboardPayloadError,
  dashboardNeedsAuditFallback,
  MAX_RECENT_AUDIT_ROWS,
  MAX_SPARKLINE_POINTS,
  isDashboardStatsPayload,
  normalizeAnomalies,
  normalizeSparklines,
  parseDashboardStats,
} from "./dashboardStatsSchema";

const ok = { subscribers_total: 10, campaigns_sent_30d: 2 };

describe("isDashboardStatsPayload", () => {
  it("refuses non-objects so a null body is never an all-zero workspace", () => {
    expect(isDashboardStatsPayload(null)).toBe(false);
    expect(isDashboardStatsPayload(undefined)).toBe(false);
    expect(isDashboardStatsPayload("")).toBe(false);
    expect(isDashboardStatsPayload(0)).toBe(false);
    expect(isDashboardStatsPayload([])).toBe(false);
    expect(isDashboardStatsPayload([ok])).toBe(false);
  });

  it("refuses an object carrying none of the contract's fields", () => {
    // The Go handler emits every count unconditionally, so `{}` is drift —
    // not a workspace that genuinely measured nothing.
    expect(isDashboardStatsPayload({})).toBe(false);
    expect(isDashboardStatsPayload({ unrelated: 1 })).toBe(false);
  });

  it("accepts the flat contract and the legacy nested shape", () => {
    expect(isDashboardStatsPayload(ok)).toBe(true);
    expect(isDashboardStatsPayload({ subscribers: { total: 4 } })).toBe(true);
    expect(isDashboardStatsPayload({ open_rate: { rate: 0.2 } })).toBe(true);
  });

  it("accepts a genuine measured zero", () => {
    expect(
      isDashboardStatsPayload({
        subscribers_total: 0,
        campaigns_sent_30d: 0,
        active_sequences_count: 0,
      }),
    ).toBe(true);
  });

  it("refuses impossible counts rather than rendering them", () => {
    expect(isDashboardStatsPayload({ subscribers_total: -1 })).toBe(false);
    expect(isDashboardStatsPayload({ subscribers_total: Number.NaN })).toBe(
      false,
    );
    expect(isDashboardStatsPayload({ subscribers_total: "12" })).toBe(false);
    expect(
      isDashboardStatsPayload({ subscribers_total: Number.POSITIVE_INFINITY }),
    ).toBe(false);
  });

  it("refuses a recent_audit / inbox_health / previous of the wrong type", () => {
    expect(isDashboardStatsPayload({ ...ok, recent_audit: "nope" })).toBe(false);
    expect(isDashboardStatsPayload({ ...ok, inbox_health: 5 })).toBe(false);
    expect(isDashboardStatsPayload({ ...ok, previous: [] })).toBe(false);
    // Explicit nulls are how the Go `omitempty` pointers serialise when unset.
    expect(isDashboardStatsPayload({ ...ok, inbox_health: null })).toBe(true);
    expect(isDashboardStatsPayload({ ...ok, recent_audit: null })).toBe(true);
  });
});

describe("parseDashboardStats", () => {
  it("throws a typed error on a null / 204 body", () => {
    expect(() => parseDashboardStats(null)).toThrow(DashboardPayloadError);
    expect(() => parseDashboardStats(undefined)).toThrow(DashboardPayloadError);
    expect(() => parseDashboardStats({})).toThrow(DashboardPayloadError);
  });

  it("keeps unknown forward-compatible fields intact", () => {
    const parsed = parseDashboardStats({ ...ok, future_metric: 9 }) as Record<
      string,
      unknown
    >;
    expect(parsed.future_metric).toBe(9);
    expect(parsed.subscribers_total).toBe(10);
  });

  it("caps and normalizes recent_audit rows", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: i,
      action: "campaign.sent",
      at: "2026-06-28T12:00:00Z",
    }));
    const parsed = parseDashboardStats({ ...ok, recent_audit: rows });
    expect(parsed.recent_audit).toHaveLength(MAX_RECENT_AUDIT_ROWS);
    expect(parsed.recent_audit?.[0]).toEqual({
      id: "0",
      action: "campaign.sent",
      at: "2026-06-28T12:00:00Z",
    });
  });

  it("drops audit rows that are not objects instead of rendering holes", () => {
    const parsed = parseDashboardStats({
      ...ok,
      recent_audit: [null, "x", { action: "a" }],
    });
    expect(parsed.recent_audit).toEqual([{ action: "a" }]);
  });
});

describe("sparklines and anomalies", () => {
  it("drops a series that is not an array of counts, without failing the payload", () => {
    // A real deployment has already been observed sending
    // `sparklines: { opens: "1,3,5" }`. A decorative trend line is not worth
    // failing the six headline numbers over — but it is DROPPED, not coerced.
    const parsed = parseDashboardStats({
      ...ok,
      sparklines: {
        subscribers: [1, 2, 3],
        opens: "1,3,5",
        clicks: [1, Number.NaN, 3],
        bounces: [1, -4, 3],
      },
    });
    expect(parsed.sparklines).toEqual({ subscribers: [1, 2, 3] });
    expect(parsed.subscribers_total).toBe(10);
  });

  it("omits the field entirely when nothing survived", () => {
    expect(
      parseDashboardStats({ ...ok, sparklines: { opens: "nope" } }).sparklines,
    ).toBeUndefined();
    expect(
      parseDashboardStats({ ...ok, sparklines: [1, 2, 3] }).sparklines,
    ).toBeUndefined();
    expect(parseDashboardStats(ok).sparklines).toBeUndefined();
  });

  it("refuses an absurdly long series rather than holding it in memory", () => {
    const parsed = parseDashboardStats({
      ...ok,
      sparklines: {
        subscribers: Array.from({ length: MAX_SPARKLINE_POINTS + 1 }, () => 1),
        opens: Array.from({ length: MAX_SPARKLINE_POINTS }, () => 1),
      },
    });
    expect(parsed.sparklines?.subscribers).toBeUndefined();
    expect(parsed.sparklines?.opens).toHaveLength(MAX_SPARKLINE_POINTS);
  });

  it("keeps only real booleans — a truthy string is not a detection", () => {
    const parsed = parseDashboardStats({
      ...ok,
      anomalies: { bounces: true, opens: "true", clicks: 1, subs: false },
    });
    expect(parsed.anomalies).toEqual({ bounces: true, subs: false });
    expect(parseDashboardStats({ ...ok, anomalies: null }).anomalies).toBe(
      undefined,
    );
  });

  it("exposes the normalizers for the SSE/frame path as well as the fetch path", () => {
    expect(normalizeSparklines({ a: [0, 0, 0] })).toEqual({ a: [0, 0, 0] });
    expect(normalizeSparklines("x")).toBeUndefined();
    expect(normalizeAnomalies({ a: true })).toEqual({ a: true });
    expect(normalizeAnomalies(42)).toBeUndefined();
  });
});

/**
 * Round-trip-shape guard for the dashboard's activity feed.
 *
 * The feed's production source is the dedicated /audit read. Deciding whether
 * to make it from the stats query's LOADING flag put that read one full round
 * trip behind the stats read on the landing screen, on every launch. The
 * answer must come from the payload alone, so an in-flight stats read (no
 * payload) still says YES and the two go out together.
 */
describe("dashboardNeedsAuditFallback", () => {
  it("says yes while the stats read is still in flight", () => {
    // The regression this exists for: re-deriving the answer from
    // `!stats.isLoading` makes this case false and re-serialises the feed.
    expect(dashboardNeedsAuditFallback(undefined)).toBe(true);
  });

  it("says yes when the payload landed without recent_audit", () => {
    expect(dashboardNeedsAuditFallback({})).toBe(true);
    expect(dashboardNeedsAuditFallback(null)).toBe(true);
  });

  it("stands down only when the payload actually carries rows", () => {
    expect(
      dashboardNeedsAuditFallback({ recent_audit: [{ id: "1" }] }),
    ).toBe(false);
    // An empty array is still an answer from the server: it means "no recent
    // activity", not "I did not send the field".
    expect(dashboardNeedsAuditFallback({ recent_audit: [] })).toBe(false);
  });
});
