import { describe, expect, it } from "vitest";

import {
  decodeBestSendTime,
  decodeSchedulePreview,
  decodeSegmentBest,
  decodeSegmentHeatmap,
  decodeSubscriberPattern,
  isWeeklyGrid,
} from "../components/sendtime/contract";

function weeklyGrid(): number[][] {
  return Array.from({ length: 7 }, () => Array(24).fill(0));
}

function preview() {
  return {
    campaign_id: "11111111-1111-4111-8111-111111111111",
    scheduled: 3,
    within_days: 7,
    tenant_mean: 33,
    truncated: false,
    hard_cap: 50_000,
    strategy: "per_recipient",
    reference_at: "2026-07-26T10:00:00.000Z",
    distribution: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: hour === 9 ? 3 : 0,
    })),
    max_per_minute: 2,
    max_per_day: 3,
    peak_day_utc: "2026-07-27",
    tier_cap_today: 100,
    warmup_cap_breach: false,
    counted_at: "2026-07-26T10:00:00.000Z",
  };
}

describe("Send-time runtime contracts", () => {
  it("accepts only a complete finite 7 × 24 weekly grid", () => {
    expect(isWeeklyGrid(weeklyGrid())).toBe(true);
    expect(
      isWeeklyGrid(Array.from({ length: 6 }, () => Array(24).fill(0))),
    ).toBe(false);
    const invalid = weeklyGrid();
    invalid[2][7] = Number.POSITIVE_INFINITY;
    expect(isWeeklyGrid(invalid)).toBe(false);
  });

  it("rejects scalar and heatmap sentinels outside their documented ranges", () => {
    expect(
      decodeBestSendTime({
        best_hour_utc: 167,
        computed_at: "2026-07-26T10:00:00.000Z",
        sample_size: 5,
      }),
    ).not.toBeNull();
    expect(
      decodeBestSendTime({
        best_hour_utc: 168,
        computed_at: "2026-07-26T10:00:00.000Z",
        sample_size: 5,
      }),
    ).toBeNull();
    expect(
      decodeBestSendTime({
        best_hour_utc: 33,
        sample_size: 5,
      }),
    ).toBeNull();

    expect(
      decodeSegmentBest({
        best_hour_utc: "09:00",
        confidence: 0.75,
        sample_size: 96,
        computed_at: "2026-07-26T10:00:00.000Z",
      }),
    ).not.toBeNull();
    expect(
      decodeSegmentBest({
        best_hour_utc: "9am",
        confidence: 1.2,
        sample_size: 96,
        computed_at: "not-a-date",
      }),
    ).toBeNull();
  });

  it("requires valid coordinates and optional secondary windows", () => {
    const heatmap = {
      grid: weeklyGrid(),
      subscribers_with_data: 96,
      best_dow: 1,
      best_hour: 9,
      computed_at: "2026-07-26T10:00:00.000Z",
    };
    expect(decodeSegmentHeatmap(heatmap)).not.toBeNull();
    expect(decodeSegmentHeatmap({ ...heatmap, secondary_dow: 7 })).toBeNull();
    expect(
      decodeSegmentHeatmap({
        ...heatmap,
        secondary_dow: 2,
        has_secondary_window: true,
      }),
    ).toBeNull();
    expect(
      decodeSegmentHeatmap({
        ...heatmap,
        secondary_dow: 2,
        secondary_hour: 14,
        has_secondary_window: false,
      }),
    ).toBeNull();

    const pattern = {
      grid: weeklyGrid(),
      sample_size: 12,
      best_dow: 1,
      best_hour: 9,
      computed_at: "2026-07-26T10:00:00.000Z",
    };
    expect(decodeSubscriberPattern(pattern)).not.toBeNull();
    expect(decodeSubscriberPattern({ ...pattern, sample_size: -1 })).toBeNull();
    expect(
      decodeSubscriberPattern({
        ...pattern,
        secondary_dow: 2,
        secondary_hour: 14,
        bimodal: false,
      }),
    ).toBeNull();
  });

  it("accepts a self-consistent aggregate preview", () => {
    expect(decodeSchedulePreview(preview())).toEqual(preview());
  });

  it.each([
    ["unknown strategy", { strategy: "mystery" }],
    ["non-UUID campaign", { campaign_id: "campaign-1" }],
    ["short model window", { within_days: 1 }],
    [
      "unordered distribution",
      { distribution: [...preview().distribution].reverse() },
    ],
    [
      "distribution total mismatch",
      {
        distribution: preview().distribution.map((bucket) => ({
          ...bucket,
          count: 0,
        })),
      },
    ],
    ["impossible peak", { max_per_day: 4 }],
    ["malformed timestamp", { counted_at: "tomorrow-ish" }],
  ])("rejects %s", (_label, mutation) => {
    expect(decodeSchedulePreview({ ...preview(), ...mutation })).toBeNull();
  });
});
