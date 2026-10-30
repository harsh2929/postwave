// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { get: mocks.get },
}));

import {
  getCostAggregate,
  getCostLedgerPage,
  parseCostAggregateResponse,
  parseCostLedgerPage,
} from "@/lib/api-usage-api";
import {
  getFromNameSuggestions,
  parseFromNamePickerResponse,
} from "@/lib/from-name-picker-api";
import {
  getClvDashboard,
  parseClvDashboard,
} from "@/lib/predictive-api";

const NOW = "2026-08-30T10:00:00Z";

function fromNameRow(rank: number, name = `Sender ${rank}`) {
  return {
    from_name: name,
    campaigns_using: 4,
    total_recipients: 1_000,
    opens: 430,
    clicks: 70,
    complaints: 1,
    open_rate: 0.43,
    click_rate: 0.07,
    complaint_rate: 0.001,
    confidence: 0.7,
    rank,
  };
}

function clvDashboard() {
  return {
    profile_count: 3,
    scored_profiles: 2,
    total_clv_cents: 12_000,
    predicted_clv_cents: 4_000,
    avg_total_clv_cents: 4_000,
    percentiles: {
      p10_cents: 100,
      p25_cents: 500,
      p50_cents: 2_000,
      p75_cents: 5_000,
      p90_cents: 8_000,
      p99_cents: 10_000,
    },
    tiers: [
      {
        key: "champions",
        label: "Champions",
        profiles: 1,
        avg_total_clv_cents: 8_000,
        avg_churn_risk: 0.1,
      },
      {
        key: "at_risk",
        label: "At risk",
        profiles: 2,
        avg_total_clv_cents: 2_000,
        avg_churn_risk: 0.7,
      },
    ],
    last_calculated_at: NOW,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("from-name picker parity contract", () => {
  it("binds the bounded query and cancellation signal to the reports read", async () => {
    const controller = new AbortController();
    mocks.get.mockResolvedValueOnce({
      window_days: 180,
      min_campaigns: 2,
      from_names: [],
      count: 0,
    });

    await expect(
      getFromNameSuggestions({
        days: 180,
        minCampaigns: 2,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ count: 0, from_names: [] });

    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/from-name-picker?days=180&min_campaigns=2",
      { signal: controller.signal },
    );
  });

  it("uses rank identity rather than transport order for top performers", () => {
    const parsed = parseFromNamePickerResponse({
      window_days: 180,
      min_campaigns: 2,
      // The server currently scans in recipient order and attaches rank later.
      // A client calling the first five 'top' performers must normalize rank.
      from_names: [fromNameRow(2), fromNameRow(1)],
      count: 2,
    });

    expect(parsed.from_names.map((row) => row.rank)).toEqual([1, 2]);
  });

  it.each([
    ["window below the server floor", { window_days: 0 }],
    ["campaign floor below the server floor", { min_campaigns: 0 }],
  ])("rejects an impossible %s", (_label, patch) => {
    expect(() =>
      parseFromNamePickerResponse({
        window_days: 180,
        min_campaigns: 2,
        from_names: [],
        count: 0,
        ...patch,
      }),
    ).toThrow(/from-name picker/u);
  });

  it("rejects duplicate ranks instead of making performance identity ambiguous", () => {
    expect(() =>
      parseFromNamePickerResponse({
        window_days: 180,
        min_campaigns: 2,
        from_names: [fromNameRow(1, "A"), fromNameRow(1, "B")],
        count: 2,
      }),
    ).toThrow(/rank/u);
  });
});

describe("aggregate CLV data-minimization contract", () => {
  it("requests no identity previews and discards any unexpected preview PII", async () => {
    const controller = new AbortController();
    mocks.get.mockResolvedValueOnce({
      ...clvDashboard(),
      top_profiles: [
        {
          email: "private@example.test",
          subscriber_id: "subscriber-private",
        },
      ],
      at_risk_profiles: [{ email: "risk@example.test" }],
    });

    const result = await getClvDashboard(controller.signal);

    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/clv-dashboard?preview_limit=0",
      { signal: controller.signal },
    );
    expect(JSON.stringify(result)).not.toContain("private@example.test");
    expect(JSON.stringify(result)).not.toContain("subscriber-private");
    expect(Object.keys(result)).not.toContain("top_profiles");
    expect(Object.keys(result)).not.toContain("at_risk_profiles");
  });

  it("fails closed on internally inconsistent financial aggregates", () => {
    expect(() =>
      parseClvDashboard({
        ...clvDashboard(),
        scored_profiles: 4,
      }),
    ).toThrow(/scored profile count/u);

    expect(() =>
      parseClvDashboard({
        ...clvDashboard(),
        percentiles: {
          ...clvDashboard().percentiles,
          p75_cents: 100,
        },
      }),
    ).toThrow(/percentile ordering/u);

    expect(() =>
      parseClvDashboard({
        ...clvDashboard(),
        tiers: [{ ...clvDashboard().tiers[0], profiles: 1 }],
      }),
    ).toThrow(/tier population/u);
  });
});

describe("cost aggregate and ledger security contracts", () => {
  it("binds bounded filters and abort signals to aggregate and ledger reads", async () => {
    const controller = new AbortController();
    mocks.get
      .mockResolvedValueOnce({
        rows: [],
        since: NOW,
        group_by: "kind",
      })
      .mockResolvedValueOnce({ rows: [] });

    await getCostAggregate({
      since: "30d",
      groupBy: "kind",
      signal: controller.signal,
    });
    await getCostLedgerPage({
      since: "30d",
      cursor: "42",
      limit: 50,
      signal: controller.signal,
    });

    expect(mocks.get).toHaveBeenNthCalledWith(
      1,
      "/api/v1/costs?since=30d&by=kind",
      { signal: controller.signal },
    );
    expect(mocks.get).toHaveBeenNthCalledWith(
      2,
      "/api/v1/costs/ledger?since=30d&limit=50&cursor=42",
      { signal: controller.signal },
    );
  });

  it("keeps tenant IDs and ledger metadata out of the retained UI model", () => {
    const aggregate = parseCostAggregateResponse(
      {
        rows: [
          {
            apiKeyId: "key-1",
            actorType: "api_key",
            kind: "send",
            cents: 25,
            microcents: 250_000,
            quantity: 100,
            count: 4,
            tenantId: "tenant-private",
            metadata: { prompt: "private" },
          },
        ],
        since: NOW,
        group_by: "kind",
      },
      "kind",
    );
    const ledger = parseCostLedgerPage(
      {
        rows: [
          {
            id: 9,
            tenantId: "tenant-private",
            apiKeyId: "key-1",
            actorType: "api_key",
            kind: "send",
            cents: 25,
            quantity: 100,
            at: NOW,
            metadata: { recipient: "private@example.test" },
          },
        ],
        nextCursor: "9",
      },
      50,
    );

    expect(JSON.stringify({ aggregate, ledger })).not.toContain(
      "tenant-private",
    );
    expect(JSON.stringify({ aggregate, ledger })).not.toContain(
      "private@example.test",
    );
    expect(ledger.nextCursor).toBe("9");
  });

  it("rejects mismatched grouping, malformed cursors, and unsafe limits", async () => {
    expect(() =>
      parseCostAggregateResponse(
        { rows: [], since: NOW, group_by: "api_key_id" },
        "kind",
      ),
    ).toThrow(/group identity mismatch/u);
    expect(() =>
      parseCostLedgerPage(
        {
          rows: [
            {
              id: 9,
              kind: "send",
              cents: 1,
              quantity: 1,
              at: NOW,
            },
          ],
          nextCursor: "8",
        },
        50,
      ),
    ).toThrow(/cursor/u);

    await expect(
      getCostLedgerPage({ since: "30d", cursor: "0 OR 1=1" }),
    ).rejects.toThrow(/cursor/u);
    await expect(
      getCostLedgerPage({ since: "30d", limit: 101 }),
    ).rejects.toThrow(/page size/u);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
