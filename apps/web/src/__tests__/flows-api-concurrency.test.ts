// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, etag?: string, status = 200): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (etag) headers.set("ETag", etag);
  return new Response(JSON.stringify(body), { status, headers });
}

function flow(id: string, etag: string) {
  return {
    id,
    etag,
    name: "Welcome",
    status: "draft",
    version: 1,
    graph: { nodes: [] },
    created_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
  };
}

describe("flow authoring concurrency", () => {
  it("uses the exact validator paired with a list representation", async () => {
    const { flowsApi } = await import("@/lib/flows-api");
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ items: [flow("flow-1", '"flow:flow-1:v1"')] }),
      )
      .mockResolvedValueOnce(
        jsonResponse(flow("flow-1", '"flow:flow-1:v2"'), '"flow:flow-1:v2"'),
      );

    await flowsApi.listAll();
    await flowsApi.update("flow-1", { name: "Renamed" });

    const [, init] = fetchMock.mock.calls[1]!;
    expect(new Headers((init as RequestInit).headers).get("If-Match")).toBe(
      '"flow:flow-1:v1"',
    );
  });

  it("refuses an update when no representation token exists", async () => {
    const { flowsApi } = await import("@/lib/flows-api");

    await expect(
      flowsApi.update("not-loaded", { name: "Unsafe" }),
    ).rejects.toThrow(/Reload this flow/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects weak validators instead of weakening If-Match", async () => {
    const { flowsApi } = await import("@/lib/flows-api");
    fetchMock.mockResolvedValueOnce(
      jsonResponse(flow("flow-weak", 'W/"flow:flow-weak:v1"')),
    );

    await flowsApi.get("flow-weak");
    await expect(
      flowsApi.update("flow-weak", { name: "Unsafe" }),
    ).rejects.toThrow(/Reload this flow/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("discards a stale token and will not retry without a reload", async () => {
    const { flowsApi } = await import("@/lib/flows-api");
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(flow("flow-2", '"flow:flow-2:v1"'), '"flow:flow-2:v1"'),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "precondition_failed",
              message: "reload and retry",
            },
          },
          undefined,
          412,
        ),
      );

    await flowsApi.get("flow-2");
    await expect(flowsApi.update("flow-2", { name: "A" })).rejects.toThrow();
    await expect(flowsApi.update("flow-2", { name: "A" })).rejects.toThrow(
      /Reload this flow/i,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rotates the token across draft creation and publish", async () => {
    const { flowsApi } = await import("@/lib/flows-api");
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(flow("flow-3", '"flow:flow-3:v1"'), '"flow:flow-3:v1"'),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            id: "version-2",
            flow_id: "flow-3",
            version: 2,
            status: "draft",
            graph: { nodes: [] },
            generated_by: "human",
            created_at: "2026-09-03T00:00:01Z",
          },
          '"flow:flow-3:v2"',
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(flow("flow-3", '"flow:flow-3:v3"'), '"flow:flow-3:v3"'),
      );

    await flowsApi.get("flow-3");
    await flowsApi.createVersion("flow-3", {
      graph: { nodes: [] },
      generated_by: "human",
    });
    await flowsApi.publish("flow-3");

    const [, createVersionInit] = fetchMock.mock.calls[1]!;
    const [, publishInit] = fetchMock.mock.calls[2]!;
    expect(
      new Headers((createVersionInit as RequestInit).headers).get("If-Match"),
    ).toBe('"flow:flow-3:v1"');
    expect(
      new Headers((publishInit as RequestInit).headers).get("If-Match"),
    ).toBe('"flow:flow-3:v2"');
  });

  it("encodes flow and version ids before building mutation paths", async () => {
    const { flowsApi, flowWebUrl } = await import("@/lib/flows-api");
    fetchMock.mockResolvedValueOnce(
      jsonResponse(flow("flow/one", '"flow:flow-one:v1"'), '"flow:flow-one:v1"'),
    );

    await flowsApi.get("flow/one");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("flow%2Fone");
    expect(
      flowWebUrl("flow/one?draft#section", "https://app.moosewave.com"),
    ).toBe(
      "https://app.moosewave.com/app/flows/flow%2Fone%3Fdraft%23section",
    );
  });
});
