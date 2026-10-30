/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, invalidateApiUrlCache } from "../../lib/api-client";

describe("audit count query and runtime contract", () => {
  beforeEach(() => {
    window.localStorage.clear();
    invalidateApiUrlCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses canonical snake_case filters and forwards the caller signal", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      (_input: string | URL | Request, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const signal = controller.signal;

    const pending = api.getAuditCount(
      {
        actorType: "agent",
        actorLabel: "Agent One",
        action: "campaign.pause",
        resourceType: "campaign",
        resourceId: "campaign/42",
        since: "2026-08-01T00:00:00Z",
      },
      { signal },
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe(
      "http://localhost:8080/api/v1/audit/count?actor_type=agent&actor_label=Agent+One&action=campaign.pause&resource_type=campaign&resource_id=campaign%2F42&since=2026-08-01T00%3A00%3A00Z",
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
    resolveFetch(
      new Response(JSON.stringify({ totalEstimate: 42, confidence: "exact" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(pending).resolves.toEqual({
      data: { totalEstimate: 42, confidence: "exact" },
    });
    expect(String(input)).not.toContain("actorType");
    expect(String(input)).not.toContain("resourceId");
  });

  it("fails closed when a successful count body is conflicting or invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              totalEstimate: 42,
              confidence: "exact",
              total: 41,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
      ),
    );

    await expect(api.getAuditCount({})).resolves.toMatchObject({
      error: { kind: "parse", code: "invalid_audit_payload" },
      retryability: "manual",
    });
  });
});
