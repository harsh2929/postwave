import { describe, expect, it } from "vitest";

import {
  parseRunCount,
  parseSoftBounceStats,
  parseSpamTrapHits,
  parseSpamTrapRunReceipt,
  parseSpamTrapStats,
} from "../../components/deliverability/remediation-response-contract";

describe("deliverability remediation response contracts", () => {
  it("accepts complete finite counter payloads", () => {
    expect(
      parseSpamTrapStats({
        hits_last_30_days: 12,
        blocklisted_count: 7,
        eligible_now: 2,
        observed_at: "2026-07-17T12:00:00Z",
      }),
    ).toEqual({
      hits_last_30_days: 12,
      blocklisted_count: 7,
      eligible_now: 2,
      observed_at: "2026-07-17T12:00:00Z",
    });
    expect(
      parseSoftBounceStats({
        disabled_count: 8,
        eligible_now: 3,
        eligible_suppressions_now: 2,
        recovery_window_days: 14,
        automatic_reactivation_active: false,
      }),
    ).toEqual({
      disabled_count: 8,
      eligible_now: 3,
      eligible_suppressions_now: 2,
      recovery_window_days: 14,
      automatic_reactivation_active: false,
    });
  });

  it("rejects missing, negative, fractional, and non-finite counters", () => {
    expect(parseSpamTrapStats({})).toBeNull();
    expect(
      parseSpamTrapStats({
        hits_last_30_days: Number.NaN,
        blocklisted_count: 0,
        eligible_now: 0,
        observed_at: "2026-07-17T12:00:00Z",
      }),
    ).toBeNull();
    expect(
      parseSoftBounceStats({
        disabled_count: -1,
        eligible_now: 0,
        eligible_suppressions_now: 0,
        recovery_window_days: 14,
        automatic_reactivation_active: false,
      }),
    ).toBeNull();
    expect(
      parseSoftBounceStats({
        disabled_count: 1.5,
        eligible_now: 0,
        eligible_suppressions_now: 0,
        recovery_window_days: 14,
        automatic_reactivation_active: false,
      }),
    ).toBeNull();
  });

  it("validates the complete spam-trap hits envelope and rows", () => {
    const payload = {
      hits: [
        {
          email: "trap@example.test",
          first_hit_at: "2026-07-01T00:00:00Z",
          last_hit_at: "2026-07-02T00:00:00Z",
          hit_count: 2,
        },
      ],
      count: 1,
    };
    expect(parseSpamTrapHits(payload)).toEqual([
      {
        masked_email: "t•••@example.test",
        first_hit_at: "2026-07-01T00:00:00Z",
        last_hit_at: "2026-07-02T00:00:00Z",
        hit_count: 2,
        row_key: "0:t•••@example.test:2026-07-02T00:00:00Z",
      },
    ]);
    expect(parseSpamTrapHits({ hits: [{}], count: 1 })).toBeNull();
    expect(parseSpamTrapHits({ items: [], count: 0 })).toBeNull();
    expect(parseSpamTrapHits({ ...payload, count: 2 })).toBeNull();
  });

  it("rejects malformed mutation result counts instead of reporting zero", () => {
    expect(parseRunCount({ blocklisted: 0 }, "blocklisted")).toBe(0);
    expect(parseRunCount({ recovered: 3 }, "recovered")).toBe(3);
    expect(parseRunCount({}, "recovered")).toBeNull();
    expect(
      parseRunCount({ recovered: Number.POSITIVE_INFINITY }, "recovered"),
    ).toBeNull();
  });

  it("requires a server timestamp in spam-trap mutation receipts", () => {
    expect(
      parseSpamTrapRunReceipt({
        blocklisted: 3,
        completed_at: "2026-07-17T12:30:00Z",
      }),
    ).toEqual({
      blocklisted: 3,
      completed_at: "2026-07-17T12:30:00Z",
    });
    expect(parseSpamTrapRunReceipt({ blocklisted: 3 })).toBeNull();
  });
});
