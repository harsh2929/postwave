// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: mocks }));

import {
  getFeedbackHistory,
  listDomainSetups,
  listRetryEvents,
  runSoftBounceCleanup,
} from "@/lib/deliverability-operations-api";

const TENANT_ID = "22222222-2222-4222-8222-222222222222";

describe("deliverability operations wire contracts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fails closed when an items envelope is null", async () => {
    mocks.get.mockResolvedValue({ items: null });
    await expect(listDomainSetups()).rejects.toThrow(
      "Invalid domain setup items",
    );
  });

  it("bounds retry evidence to 50 and validates every row", async () => {
    mocks.get.mockResolvedValue({ items: [] });
    await expect(listRetryEvents(TENANT_ID)).resolves.toEqual([]);
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/intelligent-retry/events?limit=50",
    );
  });

  it("rejects the whole retry envelope when any row belongs to another tenant", async () => {
    const event = (tenantId: string, id: string) => ({
      id,
      tenant_id: tenantId,
      campaign_id: "campaign-1",
      subscriber_email: "recipient@example.test",
      reason: "frequency_cap",
      status: "pending",
      retry_after: "2026-09-02T10:00:00Z",
      attempts: 1,
      created_at: "2026-09-02T09:00:00Z",
      updated_at: "2026-09-02T09:01:00Z",
    });
    mocks.get.mockResolvedValue({
      items: [event(TENANT_ID, "retry-1"), event("wrong-tenant", "retry-2")],
    });

    await expect(listRetryEvents(TENANT_ID)).rejects.toThrow(
      "Invalid retry event tenant id",
    );
  });

  it("sends subscriber PII only in the feedback request body", async () => {
    mocks.post.mockResolvedValue({ bounces: [], complaints: [] });
    await expect(getFeedbackHistory("person@example.test")).resolves.toEqual({
      bounces: [],
      complaints: [],
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/feedback/history",
      { email: "person@example.test" },
      {
        cache: "no-store",
        requireOnline: true,
        maxAttempts: 1,
        signal: undefined,
      },
    );
    expect(mocks.post.mock.calls[0][0]).not.toContain("person@example.test");
  });

  it("requires the cleanup receipt to contain both server counts", async () => {
    mocks.post.mockResolvedValue({ expired_suppressions: 2 });
    await expect(runSoftBounceCleanup()).rejects.toThrow(
      "Invalid recovered count",
    );
  });

  it("rejects oversized evidence arrays and impossible reactivation receipts", async () => {
    mocks.get.mockResolvedValue({
      items: Array.from({ length: 51 }, () => ({})),
    });
    await expect(listRetryEvents(TENANT_ID)).rejects.toThrow(
      "Invalid retry event items",
    );

    mocks.post.mockResolvedValue({ recovered: 1, expired_suppressions: 2 });
    await expect(runSoftBounceCleanup()).rejects.toThrow(
      "Invalid recovered count",
    );
  });

  it("rejects malformed feedback identities before a network request", async () => {
    await expect(getFeedbackHistory("not an email")).rejects.toThrow(
      "Invalid subscriber email",
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
