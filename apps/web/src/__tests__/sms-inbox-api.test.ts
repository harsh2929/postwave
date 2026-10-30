import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMocks }));

import {
  listSmsConversationMessages,
  listSmsConversations,
  markSmsConversationRead,
} from "@/lib/sms-api";

const TENANT = "11111111-1111-4111-8111-111111111111";
const DEMO_TENANT = "00000000-0000-0000-0000-000000000001";
const PHONE = "+15552345678";
const SNAPSHOT = "2026-08-21T10:00:00Z";

beforeEach(() => {
  apiMocks.get.mockReset();
  apiMocks.post.mockReset();
});

describe("web SMS inbox API boundary", () => {
  it("forwards AbortSignal and only the opaque cursor grammar", async () => {
    apiMocks.get.mockResolvedValueOnce({
      tenantId: TENANT,
      conversations: [],
      snapshotAt: SNAPSHOT,
      unreadTotal: 0,
      unknownTotal: 0,
      totalConversations: 0,
      activeTotal: 0,
      snoozedTotal: 0,
      archivedTotal: 0,
    });
    const controller = new AbortController();
    await listSmsConversations({
      tenantId: TENANT,
      limit: 50,
      cursor: "opaque cursor",
      signal: controller.signal,
    });
    expect(apiMocks.get).toHaveBeenCalledWith(
      "/api/v1/sms/conversations?filter=all&sort=recent&status=active&limit=50&cursor=opaque+cursor",
      { signal: controller.signal },
    );
    expect(apiMocks.get.mock.calls[0]?.[0]).not.toContain("before_at");
    expect(apiMocks.get.mock.calls[0]?.[0]).not.toContain("snapshot_at");
  });

  it("tenant-binds the decoded thread and rejects old bare envelopes", async () => {
    apiMocks.get.mockResolvedValueOnce({ tenantId: TENANT, messages: [] });
    await expect(
      listSmsConversationMessages(PHONE, TENANT, { limit: 100 }),
    ).rejects.toThrow(/snapshotAt/u);
    expect(apiMocks.get.mock.calls[0]?.[0]).toBe(
      "/api/v1/sms/conversations/%2B15552345678/messages?limit=100",
    );
  });

  it("accepts the authoritative canonical non-v4 demo tenant", async () => {
    apiMocks.get
      .mockResolvedValueOnce({
        tenantId: DEMO_TENANT,
        conversations: [],
        snapshotAt: SNAPSHOT,
        unreadTotal: 0,
        unknownTotal: 0,
        totalConversations: 0,
        activeTotal: 0,
        snoozedTotal: 0,
        archivedTotal: 0,
      })
      .mockResolvedValueOnce({
        tenantId: DEMO_TENANT,
        messages: [],
        snapshotAt: SNAPSHOT,
      });

    await expect(
      listSmsConversations({ tenantId: DEMO_TENANT }),
    ).resolves.toMatchObject({ tenantId: DEMO_TENANT });
    await expect(
      listSmsConversationMessages(PHONE, DEMO_TENANT),
    ).resolves.toMatchObject({ tenantId: DEMO_TENANT });
    expect(apiMocks.get).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid tenant, phone, and cursor inputs before transport", async () => {
    expect(() =>
      listSmsConversations({ tenantId: "tenant", cursor: "opaque" }),
    ).toThrow(/canonical lowercase tenant UUID/u);
    expect(() =>
      listSmsConversationMessages(
        PHONE,
        "00000000-0000-0000-0000-00000000000A",
      ),
    ).toThrow(/canonical lowercase tenant UUID/u);
    expect(() =>
      listSmsConversations({ tenantId: TENANT, cursor: "bad\nvalue" }),
    ).toThrow(/cursor/u);
    expect(() => listSmsConversationMessages("+442071838750", TENANT)).toThrow(
      /US\/Canada/u,
    );
    expect(() => listSmsConversationMessages("+11552345678", TENANT)).toThrow(
      /US\/Canada/u,
    );
    expect(() => listSmsConversationMessages("+15551234567", TENANT)).toThrow(
      /US\/Canada/u,
    );
    expect(() =>
      markSmsConversationRead(PHONE, ["33333333-3333-1333-8333-333333333333"]),
    ).toThrow(/message UUIDs/u);
    expect(apiMocks.get).not.toHaveBeenCalled();
    expect(apiMocks.post).not.toHaveBeenCalled();
  });

  it("posts only a unique exact inbound message boundary and forwards abort", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const controller = new AbortController();
    apiMocks.post.mockResolvedValueOnce({ ok: true, applied: 1 });

    await expect(
      markSmsConversationRead(PHONE, [id], { signal: controller.signal }),
    ).resolves.toEqual({ ok: true, applied: 1 });
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/api/v1/sms/conversations/%2B15552345678/mark-read",
      { message_ids: [id] },
      { signal: controller.signal },
    );
    expect(JSON.stringify(apiMocks.post.mock.calls[0])).not.toContain(
      "snapshotAt",
    );

    expect(() => markSmsConversationRead(PHONE, [id, id])).toThrow(/unique/u);
    expect(apiMocks.post).toHaveBeenCalledTimes(1);
  });
});
