import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCampaignABTest,
  listCampaigns,
  sendCampaign,
} from "@/lib/campaigns-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("campaign send transport", () => {
  it("uses the guarded queue endpoint for immediate sends", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET" });
        return new Response(
          JSON.stringify({
            campaign_id: "cmp/1",
            recipients_queued: 42,
            status: "sending",
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        );
      }),
    );

    await expect(sendCampaign("cmp/1")).resolves.toMatchObject({
      campaign_id: "cmp/1",
      recipients_queued: 42,
      status: "sending",
    });
    expect(calls).toEqual([
      {
        url: "http://localhost:8080/api/v1/campaigns/cmp%2F1/queue",
        method: "POST",
      },
    ]);
  });
});

describe("campaign list transport", () => {
  it("forwards a bounded overview limit", async () => {
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);

    await listCampaigns({ limit: 6 });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/campaigns?limit=6",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("campaign A/B creation transport", () => {
  it("uses the canonical create endpoint with its audience", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        parent: { id: "parent-1", name: "Launch test" },
        children: [{ id: "child-a" }, { id: "child-b" }, { id: "child-c" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createCampaignABTest({
      name: "Launch test",
      subject_variants: ["First", "Second", "Third"],
      audience_segment_id: "segment/one",
      body_html: "<p>Draft</p>",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://localhost:8080/api/v1/campaigns/ab-test");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Launch test",
      subject_variants: ["First", "Second", "Third"],
      audience_segment_id: "segment/one",
      body_html: "<p>Draft</p>",
    });
  });
});
