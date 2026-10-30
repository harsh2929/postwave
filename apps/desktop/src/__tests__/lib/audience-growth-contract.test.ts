import { describe, expect, it } from "vitest";

import {
  AUDIENCE_GROWTH_METRIC_CONTRACT_VERSION,
  audienceGrowthApi,
  isAudienceGrowthResponse,
} from "../../lib/api/audience-growth";

const validResponse = {
  days: 30,
  series: [
    {
      date: "2026-07-14",
      evaluated_at: "2026-07-14T00:00:00.000Z",
      total: 120,
      added: 4,
      unsubbed: 1,
      lapsed: 0,
    },
  ],
  metric_contract_version: AUDIENCE_GROWTH_METRIC_CONTRACT_VERSION,
  unavailable_metrics: ["lapsed" as const],
  partial_metrics: ["unsubbed" as const],
  total_added: 4,
  total_unsubbed: 1,
  delta: 0,
  delta_pct: 0,
  note: "Daily snapshot",
};

describe("audience growth runtime contract", () => {
  it("accepts the complete finite response shape", () => {
    expect(isAudienceGrowthResponse(validResponse)).toBe(true);
  });

  it("rejects successful but incomplete payloads before render", () => {
    expect(isAudienceGrowthResponse({})).toBe(false);
    expect(
      isAudienceGrowthResponse({ ...validResponse, series: undefined }),
    ).toBe(false);
    expect(
      isAudienceGrowthResponse({
        ...validResponse,
        unavailable_metrics: undefined,
      }),
    ).toBe(false);
    expect(
      isAudienceGrowthResponse({
        ...validResponse,
        partial_metrics: undefined,
      }),
    ).toBe(false);
    expect(
      isAudienceGrowthResponse({
        ...validResponse,
        metric_contract_version: undefined,
      }),
    ).toBe(false);
    expect(
      isAudienceGrowthResponse({
        ...validResponse,
        metric_contract_version: "legacy-heuristic-v1",
      }),
    ).toBe(false);
  });

  it("rejects non-finite metrics and malformed points", () => {
    expect(
      isAudienceGrowthResponse({ ...validResponse, delta_pct: Number.NaN }),
    ).toBe(false);
    expect(
      isAudienceGrowthResponse({
        ...validResponse,
        series: [{ ...validResponse.series[0], added: "4" }],
      }),
    ).toBe(false);
  });

  it("rejects ambiguous chronology, negative counts, and contradictory totals", () => {
    const secondPoint = {
      ...validResponse.series[0],
      date: "2026-07-15",
      evaluated_at: "2026-07-15T00:00:00.000Z",
      total: 123,
      added: 3,
      unsubbed: 0,
    };
    const twoPointResponse = {
      ...validResponse,
      series: [...validResponse.series, secondPoint],
      total_added: 7,
      total_unsubbed: 1,
      delta: 3,
      delta_pct: 2.5,
    };
    expect(isAudienceGrowthResponse(twoPointResponse)).toBe(true);
    expect(
      isAudienceGrowthResponse({
        ...twoPointResponse,
        series: [...twoPointResponse.series].reverse(),
      }),
    ).toBe(false);
    expect(
      isAudienceGrowthResponse({
        ...twoPointResponse,
        series: [
          { ...twoPointResponse.series[0], added: -1 },
          twoPointResponse.series[1],
        ],
      }),
    ).toBe(false);
    expect(
      isAudienceGrowthResponse({ ...twoPointResponse, total_added: 8 }),
    ).toBe(false);
    expect(isAudienceGrowthResponse({ ...twoPointResponse, delta: 4 })).toBe(
      false,
    );
    expect(
      isAudienceGrowthResponse({ ...twoPointResponse, delta_pct: 2.6 }),
    ).toBe(false);
    expect(isAudienceGrowthResponse({ ...twoPointResponse, days: 1 })).toBe(
      false,
    );
  });

  it("rejects impossible dates, future snapshots, and ambiguous evaluation order", () => {
    expect(
      isAudienceGrowthResponse({
        ...validResponse,
        series: [{ ...validResponse.series[0], date: "2026-02-31" }],
      }),
    ).toBe(false);
    expect(
      isAudienceGrowthResponse({
        ...validResponse,
        series: [
          {
            ...validResponse.series[0],
            evaluated_at: "2026-07-14T23:30:00.000-02:00",
          },
        ],
      }),
    ).toBe(false);
    expect(
      isAudienceGrowthResponse({
        ...validResponse,
        series: [
          {
            ...validResponse.series[0],
            evaluated_at: "2999-01-01T00:00:00.000Z",
          },
        ],
      }),
    ).toBe(false);
    const secondPoint = {
      ...validResponse.series[0],
      date: "2026-07-15",
      evaluated_at: "2026-07-13T00:00:00.000Z",
      total: 121,
      added: 0,
      unsubbed: 0,
    };
    expect(
      isAudienceGrowthResponse({
        ...validResponse,
        series: [...validResponse.series, secondPoint],
        total_added: 4,
        total_unsubbed: 1,
        delta: 1,
        delta_pct: 100 / 120,
      }),
    ).toBe(false);
  });

  it("requires unavailable flows to remain explicit zero placeholders with an explanation", () => {
    expect(
      isAudienceGrowthResponse({
        ...validResponse,
        unavailable_metrics: [],
      }),
    ).toBe(false);
    expect(
      isAudienceGrowthResponse({
        ...validResponse,
        partial_metrics: [],
      }),
    ).toBe(false);
    expect(
      isAudienceGrowthResponse({
        ...validResponse,
        unavailable_metrics: ["lapsed", "lapsed"],
      }),
    ).toBe(false);
    expect(
      isAudienceGrowthResponse({
        ...validResponse,
        note: undefined,
      }),
    ).toBe(false);
    expect(
      isAudienceGrowthResponse({
        ...validResponse,
        series: [{ ...validResponse.series[0], lapsed: 1 }],
      }),
    ).toBe(false);
    expect(
      isAudienceGrowthResponse({
        ...validResponse,
        unavailable_metrics: ["unsupported"],
      }),
    ).toBe(false);
    expect(
      isAudienceGrowthResponse({
        ...validResponse,
        partial_metrics: ["unsubbed", "unsubbed"],
      }),
    ).toBe(false);
    expect(
      isAudienceGrowthResponse({
        ...validResponse,
        partial_metrics: ["lapsed"],
      }),
    ).toBe(false);
  });

  it("rejects invalid windows locally before transport", async () => {
    for (const days of [0, -1, 1.5, 366, Number.NaN]) {
      await expect(audienceGrowthApi.get({ days })).resolves.toMatchObject({
        error: {
          status: 400,
          code: "invalid_audience_growth_window",
        },
      });
    }
  });
});
