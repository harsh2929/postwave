/**
 * The transport seam for the usage/cost dashboard, driven with exactly what
 * rawRequest resolves to — the {data, error} envelope.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchApiUsageKeys,
  fetchApiUsageSummary,
  fetchApiUsageTimeseries,
  fetchCostAggregates,
  fetchCostLedgerPage,
} from "./apiUsage";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("api-usage reads unwrap the response envelope", () => {
  it("summary asks ?days= and returns normalised fields", async () => {
    rawRequest.mockResolvedValue({
      data: { window_days: 7, total_sends: 5, total_cost_cents: 90 },
      error: null,
    });
    const s = await fetchApiUsageSummary(7);
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/api-usage/summary?days=7",
    );
    expect(s.totalCostCents).toBe(90);
  });

  it("keys and timeseries hit their sibling routes", async () => {
    rawRequest.mockResolvedValue({ data: { keys: [], points: [] }, error: null });
    await fetchApiUsageKeys(30);
    await fetchApiUsageTimeseries(90);
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/api-usage/keys?days=30",
    );
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/api-usage/timeseries?days=90",
    );
  });

  it("aggregates use the <n>d since param and the by dimension", async () => {
    rawRequest.mockResolvedValue({
      data: { rows: [{ kind: "email_send", cents: 5, quantity: 1, count: 1 }] },
      error: null,
    });
    const rows = await fetchCostAggregates(30, "kind");
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/costs?since=30d&by=kind",
    );
    expect(rows[0]?.kind).toBe("email_send");
  });

  it("ledger pages: no cursor on page one, cursor thereafter, limit 50", async () => {
    rawRequest.mockResolvedValue({
      data: { rows: [{ id: 9, kind: "x", cents: 1, quantity: 1, at: "" }], nextCursor: "9" },
      error: null,
    });
    const page = await fetchCostLedgerPage(30, null);
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/costs/ledger?since=30d&limit=50",
    );
    expect(page.nextCursor).toBe("9");

    await fetchCostLedgerPage(30, "9");
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/costs/ledger?since=30d&cursor=9&limit=50",
    );
  });

  it("surfaces a failed read with its status instead of an empty result", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "forbidden", status: 403 },
    });
    await expect(fetchApiUsageSummary(30)).rejects.toMatchObject({
      message: "forbidden",
      status: 403,
    });
    await expect(fetchCostLedgerPage(30, null)).rejects.toMatchObject({
      status: 403,
    });
  });
});
