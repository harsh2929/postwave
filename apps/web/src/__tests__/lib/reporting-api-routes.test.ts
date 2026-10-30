// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks }));

const { reportingApi } = await import("@/lib/reporting-api");

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
});

describe("reporting API mounted-route contract", () => {
  it("loads the metric registry from the mounted discovery route", async () => {
    mocks.get.mockResolvedValue({ items: [{ key: "campaign.opens" }] });

    await expect(reportingApi.metricRegistry()).resolves.toEqual([
      { key: "campaign.opens" },
    ]);
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/reporting/metric-registry",
      { signal: undefined },
    );
  });

  it("runs a definition through its mounted nested action", async () => {
    mocks.post.mockResolvedValue({ id: "run-1", rows: [] });

    await reportingApi.run("definition/one");

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/reporting/definitions/definition%2Fone/runs",
      {},
      {
        idempotencyKey: undefined,
        maxAttempts: 1,
        requireOnline: true,
        signal: undefined,
      },
    );
  });

  it("binds frozen mutation transport and fresh readback options", async () => {
    const signal = new AbortController().signal;
    mocks.post.mockResolvedValue({ rows: [] });
    mocks.get.mockResolvedValue({ id: "run-1" });

    await reportingApi.preview(
      { metrics: [{ key: "opens" }] },
      { signal, idempotencyKey: "intent-1" },
    );
    await reportingApi.getRun("run/one", { signal, fresh: true });

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/reporting/preview",
      { metrics: [{ key: "opens" }] },
      {
        signal,
        idempotencyKey: "intent-1",
        requireOnline: true,
        maxAttempts: 1,
      },
    );
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/reporting/runs/run%2Fone", {
      signal,
      cache: "no-store",
      requireOnline: true,
      maxAttempts: 1,
    });
  });
});
