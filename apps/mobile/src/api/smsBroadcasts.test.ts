import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSmsBroadcast,
  deleteSmsBroadcast,
  getSmsBroadcastProgress,
  listSmsBroadcasts,
  updateSmsBroadcast,
} from "./smsBroadcasts";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

const TENANT = "11111111-1111-4111-8111-111111111111";
const ID = "44444444-4444-4444-8444-444444444444";
const AT = "2026-08-21T09:00:00Z";

function broadcast() {
  return {
    id: ID,
    name: "August promo",
    body: "",
    list_ids: [],
    status: "draft",
    sent_count: 0,
    failed_count: 0,
    held_count: 0,
    segments_per_message: 0,
    created_at: AT,
    updated_at: AT,
  };
}

beforeEach(() => {
  rawRequest.mockReset();
});

describe("broadcasts transport", () => {
  it("lists with an optional cursor only", async () => {
    rawRequest.mockResolvedValue({
      data: {
        tenantId: TENANT,
        items: [broadcast()],
        snapshotAt: AT,
        broadcastDispatchAvailable: false,
        broadcastDispatchUnavailableReason:
          "sms_broadcast_dispatch_release_held",
      },
      error: null,
    });
    await listSmsBroadcasts({ tenantId: TENANT, cursor: "c1" });
    expect(rawRequest.mock.calls[0]?.[1]).toBe(
      "/api/v1/sms/broadcasts?cursor=c1",
    );
  });

  it("creates a named draft and never mounts a send path", async () => {
    rawRequest.mockResolvedValue({ data: broadcast(), error: null });
    await createSmsBroadcast({
      tenantId: TENANT,
      draft: { name: " August promo ", body: "", tag: "" },
    });
    expect(rawRequest.mock.calls[0]?.[0]).toBe("POST");
    expect(rawRequest.mock.calls[0]?.[1]).toBe("/api/v1/sms/broadcasts");
    expect(rawRequest.mock.calls[0]?.[2]).toEqual({
      name: "August promo",
      body: "",
      tag: "",
    });
    await expect(
      createSmsBroadcast({ tenantId: TENANT, draft: { body: "hi" } }),
    ).rejects.toThrow(/needs a name/);
  });

  it("PATCHes only the supplied fields and blocks a second audience dimension", async () => {
    rawRequest.mockResolvedValue({ data: broadcast(), error: null });
    await updateSmsBroadcast({
      tenantId: TENANT,
      id: ID,
      draft: { body: "new copy" },
      existing: { listIds: [], segmentId: undefined },
    });
    expect(rawRequest.mock.calls[0]?.[0]).toBe("PATCH");
    expect(rawRequest.mock.calls[0]?.[2]).toEqual({ body: "new copy" });
    await expect(
      updateSmsBroadcast({
        tenantId: TENANT,
        id: ID,
        draft: { tag: "vip" },
        existing: {
          listIds: ["55555555-5555-4555-8555-555555555555"],
          segmentId: undefined,
        },
      }),
    ).rejects.toThrow(/one audience dimension/);
    expect(rawRequest).toHaveBeenCalledTimes(1);
  });

  it("deletes and reads progress", async () => {
    rawRequest.mockResolvedValue({ data: { ok: true }, error: null });
    await deleteSmsBroadcast({ tenantId: TENANT, id: ID });
    expect(rawRequest.mock.calls[0]?.[0]).toBe("DELETE");
    expect(rawRequest.mock.calls[0]?.[1]).toBe(`/api/v1/sms/broadcasts/${ID}`);

    rawRequest.mockResolvedValue({
      data: { status: "sent", sent: 3, failed: 0, held: 0, total: 3 },
      error: null,
    });
    const progress = await getSmsBroadcastProgress({ tenantId: TENANT, id: ID });
    expect(rawRequest.mock.calls[1]?.[1]).toBe(
      `/api/v1/sms/broadcasts/${ID}/progress`,
    );
    expect(progress.total).toBe(3);
  });
});
