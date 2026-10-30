// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";

import { previewContentOptimizer } from "@/lib/content-optimizer-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("content optimizer preview transport", () => {
  it("forwards cancellation to the preview request", async () => {
    const controller = new AbortController();
    const captured: { signal: AbortSignal | null } = { signal: null };
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        captured.signal = init?.signal ?? null;
        return response;
      }),
    );

    const preview = previewContentOptimizer(
      "campaign/one",
      {},
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(captured.signal).not.toBeNull());
    expect(captured.signal?.aborted).toBe(false);
    controller.abort();
    expect(captured.signal?.aborted).toBe(true);
    resolveResponse(
      Response.json({
        campaign_id: "campaign-one",
        method: "thompson",
        primary_metric: "open_rate",
        exploration_rate: 0.1,
        min_sample_per_arm: 100,
        recommended_arms: [],
        generated_at: "2026-08-27T00:00:00.000Z",
      }),
    );
    await expect(preview).resolves.toMatchObject({
      campaign_id: "campaign-one",
    });
  });
});
