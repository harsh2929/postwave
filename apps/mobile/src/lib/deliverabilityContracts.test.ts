import { describe, expect, it } from "vitest";

import {
  itemsOf,
  nullableNumber,
  numberOr,
  parseCustomDomains,
  parseDeliverabilityHub,
  parseDmarcInsights,
  parseDmarcReports,
  parseSendingStatus,
  WireShapeError,
} from "./deliverabilityContracts";

describe("coercion primitives", () => {
  it("accepts numeric strings but never NaN", () => {
    expect(numberOr("42", 0)).toBe(42);
    expect(numberOr("", 7)).toBe(7);
    expect(numberOr("abc", 7)).toBe(7);
    expect(numberOr(Number.NaN, 7)).toBe(7);
    expect(numberOr(null, 7)).toBe(7);
  });

  it("keeps null distinct from zero for optional caps", () => {
    expect(nullableNumber(null)).toBeNull();
    expect(nullableNumber(undefined)).toBeNull();
    expect(nullableNumber("")).toBeNull();
    expect(nullableNumber(0)).toBe(0);
    expect(nullableNumber("5000")).toBe(5000);
  });

  it("reads every envelope shape the backend ships and rejects garbage", () => {
    expect(itemsOf([1, 2], "x")).toEqual([1, 2]);
    expect(itemsOf({ items: [1] }, "x")).toEqual([1]);
    expect(itemsOf({ domains: [1] }, "x")).toEqual([1]);
    expect(itemsOf({ total: 0 }, "x")).toEqual([]);
    expect(() => itemsOf("nope", "custom domain")).toThrow(WireShapeError);
    expect(() => itemsOf(null, "custom domain")).toThrow(/custom domain/);
  });
});

describe("parseDmarcReports", () => {
  it("coerces numeric STRINGS so the summary adds instead of concatenating", () => {
    const [row] = parseDmarcReports({
      items: [
        {
          id: 1,
          domain: "acme.com",
          passCount: "3100",
          failCount: "2",
          receivedAt: "2026-07-01T00:00:00Z",
        },
      ],
    });
    expect(row?.passCount).toBe(3100);
    expect(row?.failCount).toBe(2);
    expect((row?.passCount ?? 0) + (row?.failCount ?? 0)).toBe(3102);
  });

  it("sorts newest-first and tolerates a missing receivedAt", () => {
    const rows = parseDmarcReports([
      { id: "a", receivedAt: "2026-06-01T00:00:00Z" },
      { id: "b", receivedAt: "2026-07-01T00:00:00Z" },
      { id: "c", dateEnd: "2026-05-01T00:00:00Z" },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("defaults absent counts to zero rather than NaN", () => {
    const [row] = parseDmarcReports([{ id: "a" }]);
    expect(row?.passCount).toBe(0);
    expect(row?.failCount).toBe(0);
  });
});

describe("parseCustomDomains", () => {
  it("normalises the DNS record list and drops malformed entries", () => {
    const [row] = parseCustomDomains({
      items: [
        {
          id: "d1",
          domain: "mail.acme.com",
          purpose: "links",
          verified: false,
          dns_records: [
            { type: "TXT", name: "x", value: "v=spf1" },
            "not-a-record",
          ],
        },
      ],
    });
    expect(row?.dnsRecords).toHaveLength(1);
    expect(row?.verifiedAt).toBeNull();
  });

  it("falls back to the domain as an id so keyExtractor never collides", () => {
    const [row] = parseCustomDomains([{ domain: "a.com" }]);
    expect(row?.id).toBe("a.com");
  });
});

describe("parseSendingStatus", () => {
  it("keeps unavailable counter telemetry absent instead of inventing zero", () => {
    const status = parseSendingStatus({
      tenant_id: "11111111-1111-4111-8111-111111111111",
      quiet_hours_per_recipient: true,
      counter_authoritative: false,
      counter_source: "unavailable",
      counter_scope: "unavailable",
      cap_coordination_state: "unavailable",
      cap_coordination_ready: false,
      cap_coordination_matches_settings: false,
    });
    expect(status.inQuietHours).toBeNull();
    expect(status.maxSendsPerHour).toBeNull();
    expect(status.bucketCount).toBeNull();
    expect(status.counterAuthoritative).toBe(false);
  });

  it("rejects an invented authoritative counter outside the current contract", () => {
    const value = {
      tenant_id: "11111111-1111-4111-8111-111111111111",
      max_sends_per_hour: 5000,
      bucket_count: 3210,
      window_resets_at: "2026-07-25T12:00:00Z",
      in_quiet_hours: true,
      quiet_hours_start: "22:00",
      quiet_hours_end: "07:00",
      quiet_hours_tz: "America/New_York",
      quiet_hours_per_recipient: true,
      counter_authoritative: true,
      counter_source: "tiered-rate-limiter",
      counter_scope: "shared",
      cap_coordination_state: "ready",
      cap_coordination_ready: true,
      cap_coordination_cap: 5000,
      cap_coordination_matches_settings: true,
    };
    expect(() => parseSendingStatus(value)).toThrow(WireShapeError);
  });

  it.each([
    ["missing required authority fields", {}],
    [
      "a numeric-string counter",
      {
        tenant_id: "11111111-1111-4111-8111-111111111111",
        quiet_hours_per_recipient: true,
        bucket_count: "0",
        counter_authoritative: true,
        counter_source: "redis",
        counter_scope: "shared",
        window_resets_at: "2026-07-25T12:00:00Z",
        cap_coordination_state: "unavailable",
        cap_coordination_ready: false,
        cap_coordination_matches_settings: false,
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(() => parseSendingStatus(value)).toThrow(WireShapeError);
  });
});

describe("parseDeliverabilityHub", () => {
  it("clamps the score and drops non-numeric history points", () => {
    const hub = parseDeliverabilityHub({
      score: 140,
      history: [10, "20", null, 30],
    });
    expect(hub.score).toBe(100);
    expect(hub.history).toEqual([10, 20, 30]);
  });

  it("keeps the auto-throttle reason and severity-bearing breaches", () => {
    const hub = parseDeliverabilityHub({
      score: 62,
      grade: "Fair",
      auto_throttled: true,
      auto_throttle_reason: "complaint rate over 0.3%",
      breaches: [
        { code: "c1", severity: "critical", title: "Complaint rate" },
        { severity: "info" },
      ],
      totals: { sends_7d: "1200" },
    });
    expect(hub.autoThrottled).toBe(true);
    expect(hub.autoThrottleReason).toContain("0.3%");
    expect(hub.breaches).toHaveLength(1);
    expect(hub.sends7d).toBe(1200);
  });

  it("throws rather than rendering an empty hub for a broken envelope", () => {
    expect(() => parseDeliverabilityHub("boom")).toThrow(WireShapeError);
  });
});

describe("parseDmarcInsights", () => {
  it("reads the nested alignment / disposition blocks", () => {
    const insights = parseDmarcInsights({
      domain: "acme.com",
      alignment: { alignedPct: 0.92 },
      disposition: { none: 10, quarantine: 2, reject: 1 },
      series: [{ date: "2026-07-01", alignedPct: 0.9, messages: 100 }],
      topFailingSources: [{ sourceIp: "203.0.113.7", messages: 3100 }],
      suggestions: [
        { code: "spf", severity: "action", action: "Add include:" },
      ],
      latestPolicy: "none",
    });
    expect(insights.alignedPct).toBeCloseTo(0.92);
    expect(insights.disposition.quarantine).toBe(2);
    expect(insights.series).toHaveLength(1);
    expect(insights.topFailingSources[0]?.sourceIp).toBe("203.0.113.7");
    expect(insights.suggestions[0]?.action).toBe("Add include:");
  });

  it("survives a response with every optional block missing", () => {
    const insights = parseDmarcInsights({ domain: "acme.com" });
    expect(insights.alignedPct).toBe(0);
    expect(insights.suggestions).toEqual([]);
    expect(insights.topFailingSources).toEqual([]);
    expect(insights.series).toEqual([]);
  });

  it("drops a suggestion with no action text", () => {
    const insights = parseDmarcInsights({
      suggestions: [{ code: "x", severity: "info" }],
    });
    expect(insights.suggestions).toEqual([]);
  });
});
