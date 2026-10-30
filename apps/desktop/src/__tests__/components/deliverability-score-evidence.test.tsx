import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ScoreCard } from "../../components/deliverability/ScoreCard";
import { SnapshotHistoryCard } from "../../components/deliverability/SnapshotHistoryCard";
import type {
  DeliverabilityHubHistoryResponse,
  DeliverabilityHubSummary,
} from "../../lib/api-client";

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => false,
}));

vi.mock("../../lib/api-client", () => ({
  deliverabilityHubApi: {
    repairOverride: vi.fn(),
  },
}));

const qualifiedSummary: DeliverabilityHubSummary = {
  tenant_id: "00000000-0000-0000-0000-000000000001",
  score: 92,
  grade: "A",
  status: "Healthy",
  trend: "up",
  trend_delta: 2,
  trend_reference_at: "2026-07-26T00:00:00Z",
  history: [90, 92],
  bounce_rate: 0.002,
  complaint_rate: 0.0002,
  engagement_rate: 0.4,
  opens_machine_pct: 0.1,
  event_rate_scope: "campaigns",
  model_version: "campaign-cohort-v2-2026-08-02",
  sample_qualified: true,
  minimum_sample_sends: 1_000,
  window_days: 30,
  breaches: [],
  auto_throttled: false,
  totals: { sends_7d: 1_500, sends_30d: 4_000 },
  computed_at: "2026-08-02T00:00:00Z",
};

describe("deliverability score evidence presentation", () => {
  it("does not present an under-sampled rate observation as qualified", () => {
    const html = renderToStaticMarkup(
      <ScoreCard
        summary={{
          ...qualifiedSummary,
          score: 100,
          grade: "A",
          status: "Insufficient data",
          trend: "flat",
          trend_delta: 0,
          trend_reference_at: undefined,
          sample_qualified: false,
          totals: { sends_7d: 50, sends_30d: 125 },
        }}
        loading={false}
      />,
    );

    expect(html).toContain("Rate sample is not qualified yet");
    expect(html).toContain("125 of 1,000 successful campaign sends");
    expect(html).toContain("do not affect the score");
    expect(html).toContain("No qualified 7-day baseline");
    expect(html).not.toContain('data-tone="healthy"');
  });

  it("labels a same-model qualified comparison", () => {
    const html = renderToStaticMarkup(
      <ScoreCard summary={qualifiedSummary} loading={false} />,
    );

    expect(html).toContain("Up 2 points");
    expect(html).not.toContain("Rate sample is not qualified yet");
    expect(html).toContain('data-tone="healthy"');
  });

  it("refuses to chart unqualified snapshots as score history", () => {
    const history: DeliverabilityHubHistoryResponse = {
      snapshots: [
        {
          sampled_at: "2026-08-02T00:00:00Z",
          score: 100,
          model_version: "campaign-cohort-v2-2026-08-02",
          sample_qualified: false,
          sample_size: 125,
        },
      ],
      window_days: 30,
      count: 1,
      model_version: "campaign-cohort-v2-2026-08-02",
    };

    const html = renderToStaticMarkup(
      <SnapshotHistoryCard data={history} loading={false} />,
    );
    expect(html).toContain("No comparable samples yet");
    expect(html).toContain("125 successful campaign sends");
    expect(html).not.toContain("<svg");
  });

  it("charts only qualified observations and discloses exclusions", () => {
    const model = "campaign-cohort-v2-2026-08-02";
    const history: DeliverabilityHubHistoryResponse = {
      snapshots: [
        {
          sampled_at: "2026-08-01T00:00:00Z",
          score: 100,
          model_version: model,
          sample_qualified: false,
          sample_size: 500,
        },
        {
          sampled_at: "2026-08-02T00:00:00Z",
          score: 90,
          model_version: model,
          sample_qualified: true,
          sample_size: 1_100,
        },
      ],
      window_days: 30,
      count: 2,
      model_version: model,
    };

    const html = renderToStaticMarkup(
      <SnapshotHistoryCard data={history} loading={false} />,
    );
    expect(html).toContain("1 comparable sample");
    expect(html).toContain("1 unqualified observation excluded");
    expect(html).toContain("<svg");
  });
});
