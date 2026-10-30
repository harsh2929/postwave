import { describe, expect, it } from "vitest";

import { WireShapeError } from "./deliverabilityContracts";
import {
  formatE164,
  parseDnsHealth,
  parseSenderReputation,
  parseSmsSuppressions,
  mergeSmsSuppressionPages,
  normalizeSmsSuppressionSearch,
  parseSuppressionAudit,
  parseSuppressionTrend,
  trendReasonTotals,
} from "./suppressionContracts";

const SMS_TENANT = "11111111-1111-4111-8111-111111111111";

describe("parseSuppressionAudit", () => {
  it("labels an automated entry 'system' rather than leaving it blank", () => {
    const page = parseSuppressionAudit({
      email: "ada@example.com",
      total: 2,
      items: [
        {
          id: "1",
          action: "add",
          reason: "hard_bounce",
          created_at: "2026-07-01",
        },
        { id: "2", action: "remove", actor: "alice@acme.com" },
      ],
    });
    expect(page.email).toBe("ada@example.com");
    expect(page.items[0]?.actor).toBe("system");
    expect(page.items[1]?.actor).toBe("alice@acme.com");
  });

  it("drops entries with no action and never reports a total below the rows", () => {
    const page = parseSuppressionAudit({
      total: 0,
      items: [{ action: "add" }, { reason: "x" }],
    });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
  });

  it("accepts a bare array response", () => {
    const page = parseSuppressionAudit([{ action: "add" }]);
    expect(page.items).toHaveLength(1);
    expect(page.email).toBe("");
  });

  it("throws on a scalar envelope", () => {
    expect(() => parseSuppressionAudit(12)).toThrow(WireShapeError);
  });
});

describe("parseSuppressionTrend", () => {
  const payload = {
    days: 30,
    points: [
      { date: "2026-07-01", count: 2, by_reason: { hard_bounce: 2 } },
      { date: "2026-07-02", count: "3", by_reason: { complaint: 3 } },
      { date: "2026-07-03", count: 0, by_reason: {} },
    ],
  };

  it("coerces counts and sums the window", () => {
    const trend = parseSuppressionTrend(payload);
    expect(trend.points).toHaveLength(3);
    expect(trend.total).toBe(5);
    expect(trend.days).toBe(30);
  });

  it("sums only the trailing 7 zero-filled days for the weekly tile", () => {
    const points = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-07-${String(i + 1).padStart(2, "0")}`,
      count: 1,
    }));
    const trend = parseSuppressionTrend({ points, days: 10 });
    expect(trend.total).toBe(10);
    expect(trend.last7).toBe(7);
  });

  it("skips points with no date and drops zero/negative reason buckets", () => {
    const trend = parseSuppressionTrend({
      points: [{ count: 5 }, { date: "2026-07-01", by_reason: { x: 0, y: 2 } }],
    });
    expect(trend.points).toHaveLength(1);
    expect(trend.points[0]?.byReason).toEqual({ y: 2 });
  });

  it("ranks the reason mix highest-first with a stable tiebreak", () => {
    expect(trendReasonTotals(parseSuppressionTrend(payload))).toEqual([
      { reason: "complaint", count: 3 },
      { reason: "hard_bounce", count: 2 },
    ]);
  });
});

describe("parseSmsSuppressions", () => {
  it("accepts an authoritative canonical non-v4 tenant id", () => {
    const tenantId = "00000000-0000-0000-0000-000000000001";
    expect(
      parseSmsSuppressions(
        {
          tenantId,
          items: [],
          total: 0,
          snapshotAt: "2026-08-21T11:00:00Z",
        },
        tenantId,
      ),
    ).toMatchObject({ tenantId });
  });

  it("strictly reads canonical reversible and locked rows", () => {
    const page = parseSmsSuppressions(
      {
        tenantId: SMS_TENANT,
        items: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            phone_e164: "+15552345678",
            reason: "manual",
            source: "manual",
            created_at: "2026-08-21T10:00:00Z",
            reversible: true,
          },
          {
            id: "11111111-1111-4111-8111-111111111111",
            phone_e164: "+15559876543",
            reason: "stop_keyword",
            source: "twilio",
            created_at: "2026-08-21T09:00:00Z",
            reversible: false,
            locked_reason: "carrier_or_system_authority",
          },
        ],
        total: 2,
        snapshotAt: "2026-08-21T11:00:00Z",
      },
      SMS_TENANT,
    );
    const rows = page.items;
    expect(rows.map((r) => r.phone)).toEqual(["+15552345678", "+15559876543"]);
    expect(rows[0]?.reversible).toBe(true);
    expect(rows[1]?.lockedReason).toBe("carrier_or_system_authority");
  });

  it.each([
    ["legacy array", []],
    [
      "missing reversible",
      {
        tenantId: SMS_TENANT,
        items: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            phone_e164: "+15552345678",
          },
        ],
        total: 1,
        snapshotAt: "2026-08-21T11:00:00Z",
      },
    ],
    [
      "false manual claim",
      {
        tenantId: SMS_TENANT,
        items: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            phone_e164: "+15552345678",
            reason: "manual",
            source: "manual",
            created_at: "2026-08-21T10:00:00Z",
            reversible: false,
            locked_reason: "carrier_or_system_authority",
          },
        ],
        total: 1,
        snapshotAt: "2026-08-21T11:00:00Z",
      },
    ],
    [
      "unlocked STOP",
      {
        tenantId: SMS_TENANT,
        items: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            phone_e164: "+15552345678",
            reason: "stop_keyword",
            source: "twilio",
            created_at: "2026-08-21T10:00:00Z",
            reversible: true,
          },
        ],
        total: 1,
        snapshotAt: "2026-08-21T11:00:00Z",
      },
    ],
  ])("fails closed for %s", (_label, payload) => {
    expect(() => parseSmsSuppressions(payload, SMS_TENANT)).toThrow(
      /unexpected SMS suppression/u,
    );
  });

  it("rejects invented enums, locked authority, tenant identity and short cursor pages", () => {
    const locked = {
      id: "11111111-1111-4111-8111-111111111111",
      phone_e164: "+12025550101",
      reason: "stop_keyword",
      source: "twilio",
      created_at: "2026-08-21T10:00:00Z",
      reversible: false,
      locked_reason: "carrier_or_system_authority",
    };
    const envelope = {
      tenantId: SMS_TENANT,
      items: [locked],
      total: 2,
      snapshotAt: "2026-08-21T11:00:00Z",
    };
    for (const row of [
      { ...locked, reason: "invented" },
      { ...locked, source: "provider_webhook" },
      { ...locked, locked_reason: "support_override" },
    ]) {
      expect(() =>
        parseSmsSuppressions({ ...envelope, items: [row] }, SMS_TENANT),
      ).toThrow(/unexpected SMS suppression/u);
    }
    expect(() => parseSmsSuppressions(envelope, "tenant")).toThrow(
      /unexpected SMS suppression/u,
    );
    expect(() =>
      parseSmsSuppressions(
        { ...envelope, nextCursor: "opaque" },
        SMS_TENANT,
        100,
      ),
    ).toThrow(/unexpected SMS suppression/u);
  });

  it("keeps the reported cutoff total separate from a page and rejects overlap or cross-cutoff pages", () => {
    const first = parseSmsSuppressions(
      {
        tenantId: SMS_TENANT,
        items: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            phone_e164: "+15552345678",
            reason: "manual",
            source: "manual",
            created_at: "2026-08-21T10:00:00Z",
            reversible: true,
          },
        ],
        total: 2,
        nextCursor: "v1.b3BhcXVl",
        snapshotAt: "2026-08-21T11:00:00Z",
      },
      SMS_TENANT,
      1,
    );
    const second = parseSmsSuppressions(
      {
        tenantId: SMS_TENANT,
        items: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            phone_e164: "+15559876543",
            reason: "stop_keyword",
            source: "twilio",
            created_at: "2026-08-21T09:00:00Z",
            reversible: false,
            locked_reason: "carrier_or_system_authority",
          },
        ],
        total: 2,
        snapshotAt: "2026-08-21T11:00:00Z",
      },
      SMS_TENANT,
    );
    expect(mergeSmsSuppressionPages([first])).toMatchObject({
      items: expect.any(Array),
      total: 2,
      hasMore: true,
    });
    expect(mergeSmsSuppressionPages([first, second]).items).toHaveLength(2);
    expect(() => mergeSmsSuppressionPages([first, first])).toThrow(
      /unexpected SMS suppression/u,
    );
    expect(() =>
      mergeSmsSuppressionPages([
        first,
        { ...second, snapshotAt: "2026-08-21T12:00:00Z" },
      ]),
    ).toThrow(/unexpected SMS suppression/u);
  });

  it("rejects a truncated terminal page and non-US/Canada rows", () => {
    const truncated = parseSmsSuppressions(
      {
        tenantId: SMS_TENANT,
        items: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            phone_e164: "+15552345678",
            reason: "manual",
            source: "manual",
            created_at: "2026-08-21T10:00:00Z",
            reversible: true,
          },
        ],
        total: 2,
        snapshotAt: "2026-08-21T11:00:00Z",
      },
      SMS_TENANT,
    );
    expect(() => mergeSmsSuppressionPages([truncated])).toThrow(
      /unexpected SMS suppression/u,
    );
    expect(() =>
      parseSmsSuppressions(
        {
          tenantId: SMS_TENANT,
          items: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              phone_e164: "+447700900123",
              reason: "manual",
              source: "manual",
              created_at: "2026-08-21T10:00:00Z",
              reversible: true,
            },
          ],
          total: 1,
          snapshotAt: "2026-08-21T11:00:00Z",
        },
        SMS_TENANT,
      ),
    ).toThrow(/unexpected SMS suppression/u);
    expect(() =>
      parseSmsSuppressions(
        {
          tenantId: SMS_TENANT,
          items: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              phone_e164: "+15551234567",
              reason: "manual",
              source: "manual",
              created_at: "2026-08-21T10:00:00Z",
              reversible: true,
            },
          ],
          total: 1,
          snapshotAt: "2026-08-21T11:00:00Z",
        },
        SMS_TENANT,
      ),
    ).toThrow(/unexpected SMS suppression/u);
  });

  it("matches the Go time.Time/UUIDv4 fixture and rejects removed wire fields", () => {
    const row = {
      id: "22222222-2222-4222-8222-222222222222",
      phone_e164: "+15552345678",
      reason: "manual",
      source: "manual",
      created_at: "2026-08-21T15:30:00.123456+05:30",
      reversible: true,
    };
    const envelope = {
      tenantId: SMS_TENANT,
      items: [row],
      total: 1,
      snapshotAt: "2026-08-21T10:00:01.000000Z",
    };
    expect(parseSmsSuppressions(envelope, SMS_TENANT).items[0]?.createdAt).toBe(
      row.created_at,
    );
    expect(() =>
      parseSmsSuppressions(
        { ...envelope, tenantId: "99999999-9999-4999-8999-999999999999" },
        SMS_TENANT,
      ),
    ).toThrow(/unexpected SMS suppression/u);
    expect(() =>
      parseSmsSuppressions(
        { ...envelope, items: [{ ...row, source_event_id: "provider-event" }] },
        SMS_TENANT,
      ),
    ).toThrow(/unexpected SMS suppression/u);
    expect(() =>
      parseSmsSuppressions(
        { ...envelope, items: [{ ...row, phone: "+15552345678" }] },
        SMS_TENANT,
      ),
    ).toThrow(/unexpected SMS suppression/u);
    expect(() =>
      parseSmsSuppressions(
        {
          ...envelope,
          items: [{ ...row, id: "22222222-2222-1222-8222-222222222222" }],
        },
        SMS_TENANT,
      ),
    ).toThrow(/unexpected SMS suppression/u);
    expect(() =>
      parseSmsSuppressions(
        {
          ...envelope,
          items: [{ ...row, created_at: "2026-08-21 10:00:00+00" }],
        },
        SMS_TENANT,
      ),
    ).toThrow(/unexpected SMS suppression/u);
  });

  it("enforces the cursor grammar, projection window, and exact-phone uniqueness", () => {
    const row = {
      id: "22222222-2222-4222-8222-222222222222",
      phone_e164: "+12025550101",
      reason: "manual",
      source: "manual",
      created_at: "2026-08-21T10:00:00Z",
      reversible: true,
    };
    const page = {
      tenantId: SMS_TENANT,
      items: [row],
      total: 1,
      snapshotAt: "2026-08-21T11:00:00Z",
    };
    for (const nextCursor of ["opaque", "v2.token", "v1.bad.token", "v1."]) {
      expect(() =>
        parseSmsSuppressions({ ...page, total: 2, nextCursor }, SMS_TENANT, 1),
      ).toThrow(/unexpected SMS suppression/u);
    }
    for (const timestamp of [
      "1999-12-31T23:59:59Z",
      "2100-01-01T00:00:00Z",
      "2000-01-01T00:00:00+14:00",
      "2099-12-31T23:59:59-14:00",
      "2026-08-21T10:00:00+14:01",
    ]) {
      expect(() =>
        parseSmsSuppressions(
          { ...page, items: [{ ...row, created_at: timestamp }] },
          SMS_TENANT,
        ),
      ).toThrow(/unexpected SMS suppression/u);
    }
    expect(
      parseSmsSuppressions(page, SMS_TENANT, 100, "+12025550101").total,
    ).toBe(1);
    expect(() =>
      parseSmsSuppressions(
        { ...page, total: 2 },
        SMS_TENANT,
        100,
        "+12025550101",
      ),
    ).toThrow(/unexpected SMS suppression/u);
    expect(() =>
      parseSmsSuppressions(
        { ...page, items: [{ ...row, phone_e164: "+12025550102" }] },
        SMS_TENANT,
        100,
        "+12025550101",
      ),
    ).toThrow(/unexpected SMS suppression/u);
  });
});

describe("formatE164", () => {
  it("groups a NANP number", () => {
    expect(formatE164("+15552345678")).toBe("+1 555 234 5678");
  });

  it("groups other country codes without losing digits", () => {
    const pretty = formatE164("+447700900123");
    expect(pretty.replace(/\s/g, "")).toBe("+447700900123");
  });

  it("returns anything non-E.164 untouched", () => {
    expect(formatE164("555-1234")).toBe("555-1234");
    expect(formatE164("")).toBe("");
    expect(formatE164("+1")).toBe("+1");
  });
});

describe("normalizeSmsSuppressionSearch", () => {
  it("accepts only a blank filter or an exact US/Canada number", () => {
    expect(normalizeSmsSuppressionSearch("")).toBe("");
    expect(normalizeSmsSuppressionSearch("(555) 234-5678")).toBe(
      "+15552345678",
    );
    expect(normalizeSmsSuppressionSearch("+1 555 234 5678")).toBe(
      "+15552345678",
    );
    expect(normalizeSmsSuppressionSearch("55512")).toBeNull();
    expect(normalizeSmsSuppressionSearch("(155) 234-5678")).toBeNull();
    expect(normalizeSmsSuppressionSearch("(555) 123-4567")).toBeNull();
    expect(normalizeSmsSuppressionSearch("+44 7700 900123")).toBeNull();
    for (const spoof of [
      "evil5552345678",
      "+ +15552345678",
      "+1+5552345678",
      "+15552345678\u202e",
      "５５５２３４５６７８",
      "+15552345678\n",
      "\t+15552345678",
    ]) {
      expect(normalizeSmsSuppressionSearch(spoof)).toBeNull();
    }
  });
});

describe("parseSenderReputation", () => {
  it("clamps the score and drops rows with no domain", () => {
    const rows = parseSenderReputation({
      domains: [
        { domain: "mail.acme.com", score: 178, grade: "Good" },
        { score: 50 },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.score).toBe(100);
  });
});

describe("parseDnsHealth", () => {
  it("keeps per-mechanism timestamps as null when unset", () => {
    const [row] = parseDnsHealth({
      items: [
        {
          domain: "mail.acme.com",
          verify_state: "partial",
          dkim_verified_at: "2026-07-01T00:00:00Z",
          is_stale: true,
        },
      ],
    });
    expect(row?.spf_verified_at).toBeNull();
    expect(row?.dkim_verified_at).toBe("2026-07-01T00:00:00Z");
    expect(row?.isStale).toBe(true);
  });
});
