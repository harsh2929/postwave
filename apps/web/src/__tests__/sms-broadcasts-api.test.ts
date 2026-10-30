// SPDX-License-Identifier: AGPL-3.0-only
//
// Transport contract for the SMS broadcast family: literal /api/v1/sms/
// broadcasts paths, encoded ids, exact request bodies, and the tenant-bound
// decode of the list envelope (dispatch verdict included).
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelSmsBroadcast,
  createSmsBroadcast,
  decodeSmsBroadcastsPage,
  deleteSmsBroadcast,
  getSmsBroadcast,
  getSmsBroadcastProgress,
  listSmsBroadcasts,
  sendSmsBroadcast,
  updateSmsBroadcast,
} from "@/lib/sms-api";

const TENANT = "00000000-0000-0000-0000-000000000001";
const ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const ROW = {
  id: ID,
  name: "June flash sale",
  body: "Hi there",
  list_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"],
  status: "draft",
  sent_count: 0,
  failed_count: 0,
  held_count: 0,
  segments_per_message: 1,
  created_at: "2026-09-01T09:00:00Z",
  updated_at: "2026-09-01T09:00:00Z",
};
const UPSERT = {
  name: "June flash sale",
  body: "Hi there",
  sender_profile_id: "",
  list_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"],
  segment_id: "",
  tag: "",
  scheduled_at: null,
};

interface Captured {
  method: string;
  url: string;
  body: unknown;
}

function stubFetch(payload: unknown): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url,
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SMS broadcasts transport", () => {
  it("lists one bounded page against the literal route and decodes the dispatch verdict", async () => {
    const calls = stubFetch({
      tenantId: TENANT,
      items: [ROW],
      nextCursor: "v1.abc",
      snapshotAt: "2026-09-05T10:00:00Z",
      broadcastDispatchAvailable: false,
      broadcastDispatchUnavailableReason: "sms_broadcast_dispatch_release_held",
    });
    const page = await listSmsBroadcasts({ tenantId: TENANT, cursor: "v1.prev" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/sms/broadcasts");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("cursor")).toBe("v1.prev");
    expect(page.items[0]?.name).toBe("June flash sale");
    expect(page.items[0]?.scheduled_at).toBeNull();
    expect(page.nextCursor).toBe("v1.abc");
    expect(page.broadcastDispatchAvailable).toBe(false);
    expect(page.broadcastDispatchUnavailableReason).toBe(
      "sms_broadcast_dispatch_release_held",
    );
  });

  it("refuses a list response bound to another tenant or missing the verdict", () => {
    expect(() =>
      decodeSmsBroadcastsPage(
        {
          tenantId: "00000000-0000-0000-0000-000000000009",
          items: [],
          snapshotAt: "2026-09-05T10:00:00Z",
          broadcastDispatchAvailable: true,
        },
        TENANT,
      ),
    ).toThrow(/different tenant/);
    expect(() =>
      decodeSmsBroadcastsPage(
        { tenantId: TENANT, items: [], snapshotAt: "2026-09-05T10:00:00Z" },
        TENANT,
      ),
    ).toThrow(/dispatch-readiness verdict/);
  });

  it("rejects an oversized page, a malformed cursor, and a non-UUID id before transport", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // Guards throw before any promise is minted, like listSmsSuppressions.
    expect(() => listSmsBroadcasts({ tenantId: TENANT, limit: 201 })).toThrow(
      /1 to 200/,
    );
    expect(() =>
      listSmsBroadcasts({ tenantId: TENANT, cursor: "../etc" }),
    ).toThrow(/cursor is invalid/);
    expect(() => getSmsBroadcast("not-a-uuid")).toThrow(
      /canonical lowercase UUID/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the exact upsert body to create and patches it to the encoded id", async () => {
    const calls = stubFetch(ROW);
    await createSmsBroadcast(UPSERT);
    await updateSmsBroadcast(ID, { ...UPSERT, name: "Renamed" });
    expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ["POST", "/api/v1/sms/broadcasts"],
      ["PATCH", `/api/v1/sms/broadcasts/${ID}`],
    ]);
    expect(calls[0].body).toEqual(UPSERT);
    expect(calls[1].body).toEqual({ ...UPSERT, name: "Renamed" });
  });

  it("reads, cancels, deletes, and polls progress on the id-scoped routes", async () => {
    const calls = stubFetch({ ...ROW, ok: true, status: "sending", sent: 1, failed: 0, held: 0, total: 5 });
    await getSmsBroadcast(ID);
    await cancelSmsBroadcast(ID);
    await deleteSmsBroadcast(ID);
    const progress = await getSmsBroadcastProgress(ID);
    expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ["GET", `/api/v1/sms/broadcasts/${ID}`],
      ["POST", `/api/v1/sms/broadcasts/${ID}/cancel`],
      ["DELETE", `/api/v1/sms/broadcasts/${ID}`],
      ["GET", `/api/v1/sms/broadcasts/${ID}/progress`],
    ]);
    // Cancel carries no body: the server reads nothing from it.
    expect(calls[1].body).toBeUndefined();
    expect(progress).toEqual({
      status: "sending",
      sent: 1,
      failed: 0,
      held: 0,
      total: 5,
    });
  });

  it("refuses a deletion receipt that does not confirm ok", async () => {
    stubFetch({ ok: false });
    await expect(deleteSmsBroadcast(ID)).rejects.toThrow(/deletion receipt/);
  });

  it("sends against the literal …/send route with no body and decodes the enqueue receipt (messaging-29)", async () => {
    const calls = stubFetch({
      broadcast: { ...ROW, status: "sending" },
      progress: { status: "sending", sent: 0, failed: 0, held: 0, total: 120 },
      enqueued: 120,
    });
    const out = await sendSmsBroadcast(ID);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe(`/api/v1/sms/broadcasts/${ID}/send`);
    // Send carries no body: the server claims draft|scheduled → sending itself.
    expect(calls[0].body).toBeUndefined();
    expect(out.enqueued).toBe(120);
    expect(out.broadcast.status).toBe("sending");
    expect(out.progress.total).toBe(120);
    expect(() => sendSmsBroadcast("not-a-uuid")).toThrow(/canonical lowercase UUID/);
  });

  it("refuses a send receipt without the enqueue counter", async () => {
    stubFetch({ broadcast: ROW, progress: { status: "sending", sent: 0, failed: 0, held: 0, total: 1 } });
    await expect(sendSmsBroadcast(ID)).rejects.toThrow(/enqueued/);
  });
});
