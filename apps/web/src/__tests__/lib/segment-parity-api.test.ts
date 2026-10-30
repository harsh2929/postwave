// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks }));

import { buildLookalikeAudience } from "@/lib/data-operations-api";
import {
  SegmentParityContractError,
  compareSegmentPnL,
  getSavedSegmentAggregatePreview,
  getSegmentEngagementMetrics,
  getSegmentGrowthMetrics,
  listPresetSegmentMembers,
  listPresetSegmentRecipes,
  listSavedSegmentBookmarks,
  patchSavedSegmentBookmark,
} from "@/lib/segment-parity-api";

const NOW = "2026-08-30T10:00:00Z";
const tenant = "tenant-1";

beforeEach(() => vi.clearAllMocks());

describe("segment preset contracts", () => {
  it("binds cancellation, verifies counts, and pages from returned fullness", async () => {
    const controller = new AbortController();
    mocks.get
      .mockResolvedValueOnce({
        presets: [
          {
            key: "engaged_30d",
            label: "Engaged",
            description: "opened or clicked recently",
            count: 99,
          },
        ],
        count: 1,
      })
      .mockResolvedValueOnce({
        preset: "engaged_30d",
        label: "Engaged",
        subscribers: Array.from({ length: 25 }, (_, index) => ({
          id: `subscriber-${index}`,
          email: `member-${index}@example.test`,
          created_at: NOW,
          status: "enabled",
        })),
        count: 25,
        limit: 25,
        offset: 0,
      });

    await expect(
      listPresetSegmentRecipes(controller.signal),
    ).resolves.toHaveLength(1);
    await expect(
      listPresetSegmentMembers("engaged_30d", {
        limit: 25,
        offset: 0,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ hasNext: true, offset: 0, limit: 25 });

    expect(mocks.get).toHaveBeenNthCalledWith(1, "/api/v1/preset-segments", {
      signal: controller.signal,
    });
    expect(mocks.get).toHaveBeenNthCalledWith(
      2,
      "/api/v1/preset-segments/engaged_30d/list?limit=25&offset=0",
      { signal: controller.signal },
    );
  });

  it("rejects inconsistent envelopes and echoed preset identities", async () => {
    mocks.get
      .mockResolvedValueOnce({ presets: [], count: 1 })
      .mockResolvedValueOnce({
        preset: "cold_90d",
        label: "Cold",
        subscribers: [],
        count: 0,
        limit: 25,
        offset: 0,
      });
    await expect(listPresetSegmentRecipes()).rejects.toBeInstanceOf(
      SegmentParityContractError,
    );
    await expect(
      listPresetSegmentMembers("engaged_30d"),
    ).rejects.toBeInstanceOf(SegmentParityContractError);
  });
});

describe("performance comparison contracts", () => {
  it("enforces 2–5 distinct selections and exact P&L response membership", async () => {
    await expect(compareSegmentPnL(["one"], 90)).rejects.toThrow(
      /two to five/u,
    );
    await expect(compareSegmentPnL(["one", "one"], 90)).rejects.toThrow(
      /distinct/u,
    );
    await expect(
      compareSegmentPnL(["1", "2", "3", "4", "5", "6"], 90),
    ).rejects.toThrow(/two to five/u);

    mocks.get.mockResolvedValueOnce({
      items: [
        {
          segment_id: "one",
          member_count: 10,
          revenue_cents: 1000,
          revenue_per_member_cents: 100,
          currency: "USD",
        },
        {
          segment_id: "wrong",
          member_count: 10,
          revenue_cents: 500,
          currency: "USD",
        },
      ],
      window_days: 90,
      days: 90,
    });
    await expect(compareSegmentPnL(["one", "two"], 90)).rejects.toBeInstanceOf(
      SegmentParityContractError,
    );
  });

  it("strictly parses engagement and chronological growth with abort signals", async () => {
    const controller = new AbortController();
    mocks.get
      .mockResolvedValueOnce({
        segment_id: "one",
        window_days: 30,
        member_count: 10,
        sends: 8,
        opens: 4,
        clicks: 2,
        unsubs: 0,
        bounces: 1,
        complaints: 1,
        open_rate: 0.5,
        click_rate: 0.25,
        unsub_rate: 0,
        rate_basis: "delivery_outcome_events",
        generated_at: NOW,
      })
      .mockResolvedValueOnce({
        segment_id: "one",
        days: 30,
        series: [
          { date: "2026-08-01", evaluated_at: NOW, count: 8 },
          { date: "2026-08-30", evaluated_at: NOW, count: 10 },
        ],
        delta: 2,
        delta_pct: 25,
      });

    await expect(
      getSegmentEngagementMetrics("one", 30, controller.signal),
    ).resolves.toMatchObject({ sends: 8, openRate: 0.5 });
    await expect(
      getSegmentGrowthMetrics("one", 30, controller.signal),
    ).resolves.toMatchObject({ delta: 2, snapshots: 2 });
    expect(mocks.get).toHaveBeenLastCalledWith(
      "/api/v1/segments/one/growth?days=30",
      { signal: controller.signal },
    );
  });

  it("preserves signed revenue adjustments instead of treating refunds as a corrupt response", async () => {
    mocks.get.mockResolvedValueOnce({
      items: [
        {
          segment_id: "one",
          member_count: 10,
          revenue_cents: -500,
          revenue_per_member_cents: -50,
          currency: "USD",
        },
        {
          segment_id: "two",
          member_count: 5,
          revenue_cents: 1000,
          revenue_per_member_cents: 200,
          currency: "USD",
        },
      ],
      window_days: 90,
      days: 90,
    });
    const result = await compareSegmentPnL(["one", "two"], 90);
    expect(result.items[0]).toMatchObject({
      segmentId: "one",
      revenueCents: -500,
    });
  });
});

describe("saved-segment organizer security contracts", () => {
  const savedRow = {
    id: "saved-1",
    tenant_id: tenant,
    name: "VIP",
    description: "repeat customers",
    predicate_json: { secret: "not returned by the web parser" },
    is_pinned: true,
    pin_order: 0,
    visibility_scope: "personal",
    updated_at: NOW,
  };

  it("rejects cross-tenant rows and minimizes predicates from list results", async () => {
    mocks.get.mockResolvedValueOnce({
      items: [savedRow],
      total_items: 1,
      max_items: 200,
    });
    const result = await listSavedSegmentBookmarks(tenant);
    expect(result.items[0]).toMatchObject({ id: "saved-1", name: "VIP" });
    expect(JSON.stringify(result)).not.toContain("predicate_json");
    expect(JSON.stringify(result)).not.toContain("secret");

    mocks.get.mockResolvedValueOnce({
      items: [{ ...savedRow, tenant_id: "tenant-other" }],
      total_items: 1,
      max_items: 200,
    });
    await expect(listSavedSegmentBookmarks(tenant)).rejects.toBeInstanceOf(
      SegmentParityContractError,
    );
  });

  it("uses online single-attempt writes and verifies mutation identity", async () => {
    mocks.patch.mockResolvedValueOnce(savedRow);
    await expect(
      patchSavedSegmentBookmark(
        "saved-1",
        { isPinned: true, pinOrder: 0 },
        tenant,
      ),
    ).resolves.toMatchObject({ id: "saved-1", pinOrder: 0 });
    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/v1/segments/saved/saved-1",
      { is_pinned: true, pin_order: 0 },
      { requireOnline: true, maxAttempts: 1 },
    );
  });

  it("keeps saved previews aggregate-only and rejects impossible totals", async () => {
    mocks.get.mockResolvedValueOnce({
      id: "saved-1",
      count: 25,
      workspace_total: 100,
      workspace_percentage: 25,
      generated_at: NOW,
      subscribers: [{ email: "private@example.test" }],
    });
    const preview = await getSavedSegmentAggregatePreview("saved-1");
    expect(preview).toEqual({
      id: "saved-1",
      count: 25,
      workspaceTotal: 100,
      workspacePercentage: 25,
      generatedAt: NOW,
    });
    expect(JSON.stringify(preview)).not.toContain("private@example.test");

    mocks.get.mockResolvedValueOnce({
      id: "saved-1",
      count: 101,
      workspace_total: 100,
      workspace_percentage: 101,
      generated_at: NOW,
    });
    await expect(
      getSavedSegmentAggregatePreview("saved-1"),
    ).rejects.toBeInstanceOf(SegmentParityContractError);
  });
});

describe("lookalike creation contract", () => {
  it("requires acknowledgement and sends the complete bounded intent once", async () => {
    await expect(
      buildLookalikeAudience({
        seed_segment_id: "seed-1",
        size: 1000,
        confidence_threshold: 0.75,
        data_use_acknowledged: false as true,
      }),
    ).rejects.toThrow(/acknowledgement/u);
    expect(mocks.post).not.toHaveBeenCalled();

    const controller = new AbortController();
    mocks.post.mockResolvedValueOnce({
      id: "lookalike-1",
      name: "Modeled VIPs",
      seed_segment_id: "seed-1",
      size_requested: 1000,
      member_count: 950,
      seed_count: 80,
      confidence_threshold: 0.75,
      model_version: "v1",
      status: "ready",
      created_at: NOW,
      updated_at: NOW,
    });
    await expect(
      buildLookalikeAudience(
        {
          seed_segment_id: "seed-1",
          name: " Modeled VIPs ",
          size: 1000,
          confidence_threshold: 0.75,
          data_use_acknowledged: true,
        },
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({ id: "lookalike-1", member_count: 950 });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/audiences/lookalike",
      {
        seed_segment_id: "seed-1",
        name: "Modeled VIPs",
        size: 1000,
        confidence_threshold: 0.75,
        data_use_acknowledged: true,
      },
      { signal: controller.signal, requireOnline: true, maxAttempts: 1 },
    );
  });

  it("fails closed when the receipt does not echo the seed intent", async () => {
    mocks.post.mockResolvedValueOnce({
      id: "lookalike-1",
      name: "Wrong",
      seed_segment_id: "different-seed",
      size_requested: 1000,
      member_count: 900,
      seed_count: 80,
      confidence_threshold: null,
      model_version: "v1",
      status: "ready",
      created_at: NOW,
      updated_at: NOW,
    });
    await expect(
      buildLookalikeAudience({
        seed_segment_id: "seed-1",
        size: 1000,
        data_use_acknowledged: true,
      }),
    ).rejects.toThrow(/invalid lookalike receipt/u);
  });
});
