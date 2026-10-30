/**
 * smsPolicies — the window math is a port of the Go gate, so the tests pin the
 * SAME cases quiet_hours_test.go pins: whole-day, same-day, overnight, and the
 * "started yesterday" arm that decides whether a 21:00→09:00 window is still
 * holding at 07:00 on a day that is NOT in `days`.
 *
 * The unknown-timezone arm gets its own coverage because it is the one that
 * could quietly lie: a device that cannot resolve a zone must produce `null`,
 * never `false`.
 */
import { describe, expect, it } from "vitest";

import {
  canToggleSmsKeywordResponse,
  daysLabel,
  keywordActionLabel,
  minuteLabel,
  parseKeywordResponses,
  parseQuietHoursRules,
  quietHoursSummary,
  quietRuleActive,
  windowLabel,
  zonedNow,
  type SmsQuietHoursRule,
} from "./smsPolicies";

function rule(over: Partial<SmsQuietHoursRule> = {}): SmsQuietHoursRule {
  return {
    id: "qh_1",
    label: "Night",
    countryCode: "",
    startMinute: 21 * 60,
    endMinute: 9 * 60,
    days: [0, 1, 2, 3, 4, 5, 6],
    timezone: "UTC",
    enabled: true,
    createdAt: "2026-08-21T09:00:00Z",
    updatedAt: "2026-08-21T09:00:00Z",
    ...over,
  };
}

function keywordWire(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "22222222-2222-4222-8222-222222222222",
    keyword: "SALE",
    response_body:
      "You are unsubscribed from SMS marketing messages from this sender.",
    response_text:
      "You are unsubscribed from SMS marketing messages from this sender.",
    action: "opt_out",
    enabled: true,
    autoReplyDispatchAvailable: false,
    autoReplyDispatchUnavailableReason: "sms_auto_reply_dispatch_release_held",
    opt_in_count: 0,
    created_at: "2026-08-21T09:00:00Z",
    updated_at: "2026-08-21T09:00:00Z",
    ...over,
  };
}

const TENANT = "22222222-2222-4222-8222-222222222222";

function quietWire(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenant_id: TENANT,
    label: "Night",
    country_code: "US",
    start_minute: 1260,
    end_minute: 540,
    start_local: "21:00",
    end_local: "09:00",
    days: [1, 2, 3],
    timezone: "America/New_York",
    enabled: true,
    created_at: "2026-08-21T09:00:00Z",
    updated_at: "2026-08-21T09:00:00Z",
    ...over,
  };
}

/** 2026-07-15 is a Wednesday (weekday 3). */
function utc(hour: number, minute = 0, day = 15): number {
  return Date.UTC(2026, 6, day, hour, minute, 0);
}

describe("parseQuietHoursRules", () => {
  it("strictly reads the tenant-bound complete-list envelope", () => {
    const parsed = parseQuietHoursRules(
      { tenantId: TENANT, items: [quietWire()] },
      TENANT,
    );
    expect(parsed).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        label: "Night",
        countryCode: "US",
        startMinute: 1260,
        endMinute: 540,
        days: [1, 2, 3],
        timezone: "America/New_York",
        enabled: true,
        createdAt: "2026-08-21T09:00:00Z",
        updatedAt: "2026-08-21T09:00:00Z",
      },
    ]);
  });

  it.each([
    null,
    [],
    { error: "nope" },
    { tenantId: TENANT, items: [], extra: true },
    {
      tenantId: TENANT,
      items: Array.from({ length: 257 }, () => quietWire()),
    },
    { tenantId: "33333333-3333-4333-8333-333333333333", items: [] },
  ])("rejects a malformed or oversized envelope", (payload) => {
    expect(() => parseQuietHoursRules(payload, TENANT)).toThrow(
      /quiet-hours envelope/u,
    );
  });

  it.each([
    quietWire({ tenant_id: "33333333-3333-4333-8333-333333333333" }),
    quietWire({ id: "11111111-1111-1111-8111-111111111111" }),
    quietWire({ country_code: "us" }),
    quietWire({ start_minute: 1260.5 }),
    quietWire({ start_minute: "1260" }),
    quietWire({ start_local: "21:01" }),
    quietWire({ days: [1, 1, 2] }),
    quietWire({ days: [2, 1] }),
    quietWire({ days: [1, "2"] }),
    quietWire({ timezone: " Not/AZone" }),
    quietWire({ timezone: "Not/AZone" }),
    quietWire({ label: "Night\u202Eevil" }),
    quietWire({ created_at: "1999-12-31T23:59:59Z" }),
    quietWire({ created_at: "2000-01-01T00:00:00+14:00" }),
    quietWire({ updated_at: "2026-08-20T09:00:00Z" }),
    { ...quietWire(), surprise: true },
  ])("rejects poison instead of coercing a quiet-hours row", (row) => {
    expect(() =>
      parseQuietHoursRules({ tenantId: TENANT, items: [row] }, TENANT),
    ).toThrow(
      /quiet-hours row/u,
    );
  });

  it("rejects duplicate IDs and server-order drift", () => {
    expect(() =>
      parseQuietHoursRules(
        { tenantId: TENANT, items: [quietWire(), quietWire()] },
        TENANT,
      ),
    ).toThrow(/quiet-hours row/u);
    expect(() =>
      parseQuietHoursRules(
        {
          tenantId: TENANT,
          items: [
            quietWire({ created_at: "2026-08-22T09:00:00Z" }),
            quietWire({
              id: "33333333-3333-4333-8333-333333333333",
              created_at: "2026-08-21T09:00:00Z",
            }),
          ],
        },
        TENANT,
      ),
    ).toThrow(/quiet-hours row/u);
  });
});

describe("parseKeywordResponses", () => {
  it.each([
    { items: [] },
    { tenantId: "33333333-3333-4333-8333-333333333333", items: [] },
    { tenantId: TENANT, items: [], extra: true },
  ])("rejects an unbound or malformed empty keyword envelope", (payload) => {
    expect(() => parseKeywordResponses(payload, TENANT)).toThrow(
      /keyword-response envelope/u,
    );
  });

  it("strictly projects the independent inbound-state and reply-dispatch fields", () => {
    const [parsed] = parseKeywordResponses(
      { tenantId: TENANT, items: [keywordWire({ opt_in_count: 12 })] },
      TENANT,
    );
    expect(parsed?.keyword).toBe("SALE");
    expect(parsed?.action).toBe("opt_out");
    expect(parsed?.optInCount).toBe(12);
    expect(parsed?.autoReplyDispatchAvailable).toBe(false);
    expect(parsed?.autoReplyDispatchUnavailableReason).toBe(
      "sms_auto_reply_dispatch_release_held",
    );
  });

  it("rejects missing availability evidence and reason mismatches", () => {
    const missing: Record<string, unknown> = keywordWire();
    delete missing.autoReplyDispatchAvailable;
    expect(() =>
      parseKeywordResponses({ tenantId: TENANT, items: [missing] }, TENANT),
    ).toThrow(
      /keyword-response row/u,
    );
    expect(() =>
      parseKeywordResponses(
        {
          tenantId: TENANT,
          items: [
            keywordWire({
              autoReplyDispatchUnavailableReason: "unknown_hold",
            }),
          ],
        },
        TENANT,
      ),
    ).toThrow(/keyword-response row/u);
  });

  it.each([
    keywordWire({ action: "opt_in" }),
    keywordWire({ autoReplyDispatchAvailable: true }),
    keywordWire({ tenant_id: "33333333-3333-4333-8333-333333333333" }),
    keywordWire({ keyword: "sale" }),
    keywordWire({ keyword: "BAD WORD" }),
    keywordWire({ keyword: "STOP" }),
    keywordWire({ keyword: "SALE\u202E" }),
    keywordWire({ response_body: "\0", response_text: "\0" }),
    keywordWire({ response_text: "different" }),
    keywordWire({ created_at: "2100-01-01T00:00:00Z" }),
    keywordWire({ created_at: "2099-12-31T23:59:59-14:00" }),
    keywordWire({ updated_at: "2026-08-20T09:00:00Z" }),
    { ...keywordWire(), surprise: true },
  ])("rejects keyword projection poison", (row) => {
    expect(() =>
      parseKeywordResponses({ tenantId: TENANT, items: [row] }, TENANT),
    ).toThrow(
      /keyword-response row/u,
    );
  });

  it("keeps only current actions and only opt-out rows actionable", () => {
    const parsed = parseKeywordResponses(
      {
        tenantId: TENANT,
        items: [
          keywordWire({ action: "opt_out", keyword: "NO" }),
          keywordWire({
            id: "33333333-3333-4333-8333-333333333333",
            action: "reply_only",
            keyword: "SALE",
          }),
        ],
      },
      TENANT,
    );
    expect(parsed.map((row) => row.action)).toEqual(["opt_out", "reply_only"]);
    expect(canToggleSmsKeywordResponse(parsed[0]!)).toBe(true);
    expect(canToggleSmsKeywordResponse(parsed[1]!)).toBe(false);
  });

  it("rejects duplicate IDs, duplicate keywords, and list-order drift", () => {
    expect(() =>
      parseKeywordResponses(
        { tenantId: TENANT, items: [keywordWire(), keywordWire()] },
        TENANT,
      ),
    ).toThrow(/keyword-response row/u);
    expect(() =>
      parseKeywordResponses(
        {
          tenantId: TENANT,
          items: [
            keywordWire({ keyword: "ZED" }),
            keywordWire({
              id: "33333333-3333-4333-8333-333333333333",
              keyword: "ALPHA",
            }),
          ],
        },
        TENANT,
      ),
    ).toThrow(/keyword-response row/u);
  });
});

describe("labels", () => {
  it("renders minutes as 24-hour clock time and refuses nonsense", () => {
    expect(minuteLabel(0)).toBe("00:00");
    expect(minuteLabel(21 * 60)).toBe("21:00");
    expect(minuteLabel(9 * 60 + 5)).toBe("09:05");
    expect(minuteLabel(-1)).toBe("—");
    expect(minuteLabel(1440)).toBe("—");
  });

  it("names common day sets instead of listing seven abbreviations", () => {
    expect(daysLabel([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(daysLabel([1, 2, 3, 4, 5])).toBe("Weekdays");
    expect(daysLabel([0, 6])).toBe("Weekends");
    expect(daysLabel([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(daysLabel([])).toBe("No days");
  });

  it("renders a start==end window as All day, not a zero-length one", () => {
    expect(windowLabel(rule({ startMinute: 540, endMinute: 540 }))).toBe(
      "All day",
    );
    expect(windowLabel(rule())).toBe("21:00 – 09:00");
  });

  it("says what a keyword action does", () => {
    expect(keywordActionLabel("opt_out")).toBe("Opt-out state rule");
    expect(keywordActionLabel("reply_only")).toBe(
      "Stored reply — dispatch held",
    );
  });
});

describe("zonedNow", () => {
  it("resolves wall-clock time in a real IANA zone", () => {
    // 2026-07-15 12:00 UTC is 08:00 in New York (EDT, UTC-4), same Wednesday.
    expect(zonedNow(utc(12), "America/New_York")).toEqual({
      minute: 8 * 60,
      weekday: 3,
    });
  });

  it("crosses the date line into the previous local day", () => {
    // 2026-07-15 02:00 UTC is 22:00 on Tuesday the 14th in New York.
    expect(zonedNow(utc(2), "America/New_York")).toEqual({
      minute: 22 * 60,
      weekday: 2,
    });
  });

  it("returns null for an unresolvable zone rather than guessing", () => {
    expect(zonedNow(utc(12), "Not/AZone")).toBeNull();
    expect(zonedNow(utc(12), "  ")).toBeNull();
    expect(zonedNow(Number.NaN, "UTC")).toBeNull();
  });
});

describe("quietRuleActive — conservative quiet-hours projection", () => {
  it("is inert when the rule is disabled", () => {
    expect(quietRuleActive(rule({ enabled: false }), utc(23))).toBe(false);
  });

  it("returns unknown for malformed enabled rules instead of fail-opening", () => {
    expect(quietRuleActive(rule({ startMinute: 5000 }), utc(23))).toBeNull();
    expect(quietRuleActive(rule({ endMinute: -1 }), utc(23))).toBeNull();
    expect(quietRuleActive(rule({ days: [] }), utc(23))).toBeNull();
    expect(quietRuleActive(rule({ countryCode: "US" }), utc(23))).toBeNull();
  });

  it("holds inside a same-day window and releases at its end", () => {
    const r = rule({ startMinute: 9 * 60, endMinute: 17 * 60 });
    expect(quietRuleActive(r, utc(9))).toBe(true);
    expect(quietRuleActive(r, utc(16, 59))).toBe(true);
    expect(quietRuleActive(r, utc(17))).toBe(false);
    expect(quietRuleActive(r, utc(8, 59))).toBe(false);
  });

  it("holds across midnight for an overnight window", () => {
    const r = rule();
    expect(quietRuleActive(r, utc(21))).toBe(true);
    expect(quietRuleActive(r, utc(23, 30))).toBe(true);
    expect(quietRuleActive(r, utc(1))).toBe(true);
    expect(quietRuleActive(r, utc(8, 59))).toBe(true);
    expect(quietRuleActive(r, utc(9))).toBe(false);
    expect(quietRuleActive(r, utc(12))).toBe(false);
  });

  it("uses the STARTING day: a Tuesday-only window still holds Wednesday morning", () => {
    // days=[2] is Tuesday. 2026-07-15 07:00 UTC is Wednesday, so the window
    // cannot have started today — but it started yesterday and runs to 09:00.
    const r = rule({ days: [2] });
    expect(quietRuleActive(r, utc(7))).toBe(true);
    expect(quietRuleActive(r, utc(22))).toBe(false);
  });

  it("covers the whole listed day when start equals end", () => {
    const r = rule({ startMinute: 540, endMinute: 540, days: [3] });
    expect(quietRuleActive(r, utc(0, 1))).toBe(true);
    expect(quietRuleActive(r, utc(23, 59))).toBe(true);
    expect(quietRuleActive(r, utc(12, 0, 16))).toBe(false); // Thursday
  });

  it("returns null — not false — when the zone cannot be evaluated", () => {
    expect(quietRuleActive(rule({ timezone: "Mars/Olympus" }), utc(23))).toBe(
      null,
    );
    expect(quietRuleActive(rule({ timezone: "" }), utc(23))).toBeNull();
  });

  it("returns unknown around DST gap/fold boundaries owned by the backend", () => {
    const spring = rule({
      days: [6],
      startMinute: 21 * 60,
      endMinute: 2 * 60 + 30,
      timezone: "America/New_York",
    });
    expect(
      quietRuleActive(spring, Date.parse("2024-03-10T06:45:00Z")),
    ).toBeNull();

    const fall = rule({
      days: [6],
      startMinute: 21 * 60,
      endMinute: 1 * 60 + 30,
      timezone: "America/New_York",
    });
    expect(
      quietRuleActive(fall, Date.parse("2024-11-03T05:15:00Z")),
    ).toBeNull();
    expect(
      quietRuleActive(fall, Date.parse("2024-11-03T06:15:00Z")),
    ).toBeNull();
  });
});

describe("quietHoursSummary", () => {
  it("makes no live-delivery claim when no stored rule exists", () => {
    const summary = quietHoursSummary([], utc(23));
    expect(summary.holding).toBe(false);
    expect(summary.sentence).toContain(
      "No stored quiet-hours rule is configured",
    );
    expect(summary.sentence).toContain("no live-delivery claim");
  });

  it("distinguishes configured-but-off from absent", () => {
    const summary = quietHoursSummary([rule({ enabled: false })], utc(23));
    expect(summary.holding).toBe(false);
    expect(summary.sentence).toContain("switched off");
  });

  it("names the holding window", () => {
    const summary = quietHoursSummary([rule({ label: "US night" })], utc(23));
    expect(summary.holding).toBe(true);
    expect(summary.tone).toBe("warning");
    expect(summary.sentence).toContain("US night");
  });

  it("counts multiple active windows", () => {
    const summary = quietHoursSummary(
      [
        rule({ id: "a", label: "US night" }),
        rule({ id: "b", label: "EU night" }),
      ],
      utc(23),
    );
    expect(summary.holding).toBe(true);
    expect(summary.sentence).toContain("2 windows");
  });

  it("reports unknown rather than 'not holding' when a zone is unevaluable", () => {
    const summary = quietHoursSummary(
      [rule({ timezone: "Mars/Olympus" })],
      utc(12),
    );
    expect(summary.holding).toBeNull();
    expect(summary.tone).toBe("neutral");
    expect(summary.sentence).toContain("unknown");
  });

  it("prefers a real active window over an unevaluable sibling", () => {
    const summary = quietHoursSummary(
      [rule({ id: "a", timezone: "Mars/Olympus" }), rule({ id: "b" })],
      utc(23),
    );
    expect(summary.holding).toBe(true);
  });

  it("reports only stored-rule evaluation when every enabled rule is idle", () => {
    const summary = quietHoursSummary([rule()], utc(12));
    expect(summary.holding).toBe(false);
    expect(summary.tone).toBe("success");
    expect(summary.sentence).toContain(
      "No stored quiet-hours rule evaluates active",
    );
    expect(summary.sentence).toContain("no live-delivery claim");
  });
});
