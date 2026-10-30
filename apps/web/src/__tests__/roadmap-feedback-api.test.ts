// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { submitRoadmapFeedback } from "@/lib/roadmap-feedback-api";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("submitRoadmapFeedback", () => {
  it("encodes the form slug and sends only the structured double-opt-in fields", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        ok: true,
        state: "pending-confirmation",
        message: "check your email",
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    await expect(
      submitRoadmapFeedback(
        "roadmap/qualification",
        "person@example.com",
        "Regional data controls",
      ),
    ).resolves.toBe("pending-confirmation");

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/public/forms/roadmap%2Fqualification/submit");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({
      email: "person@example.com",
      customFields: { cf_requirement: "Regional data controls" },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("parses subscribed success and rejects malformed, HTTP, and network responses", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true, state: "subscribed" }))
      .mockResolvedValueOnce(
        Response.json({ ok: true, state: "already-subscribed" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 422 }))
      .mockRejectedValueOnce(new Error("network unavailable"));
    vi.stubGlobal("fetch", fetcher);

    await expect(
      submitRoadmapFeedback("roadmap", "a@example.com", "One"),
    ).resolves.toBe("subscribed");
    await expect(
      submitRoadmapFeedback("roadmap", "b@example.com", "Two"),
    ).resolves.toBeNull();
    await expect(
      submitRoadmapFeedback("roadmap", "c@example.com", "Three"),
    ).resolves.toBeNull();
    await expect(
      submitRoadmapFeedback("roadmap", "d@example.com", "Four"),
    ).resolves.toBeNull();
  });

  it("accepts a recorded response that did not subscribe", async () => {
    // A form whose consent checkbox is left unticked answers "received": the
    // feedback is on file and nobody is subscribed. It is a success, not an
    // error to retry.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ok: true, state: "received" })),
    );
    await expect(
      submitRoadmapFeedback("roadmap", "e@example.com", "Five"),
    ).resolves.toBe("received");
  });

  it("aborts a stalled public submission after the bounded timeout", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_path: string, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }),
    );

    const result = submitRoadmapFeedback(
      "roadmap",
      "person@example.com",
      "Provider evidence",
    );
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toBeNull();
    expect(requestSignal?.aborted).toBe(true);
  });
});
