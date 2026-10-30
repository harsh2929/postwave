import { beforeEach, describe, expect, it, vi } from "vitest";

import { bulkSmsConversationAction, searchSmsConversations } from "./smsInboxOps";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

const TENANT = "11111111-1111-4111-8111-111111111111";
const PHONE = "+15552345678";
const SNAPSHOT = "2026-08-21T10:00:00Z";

beforeEach(() => {
  rawRequest.mockReset();
});

describe("searchSmsConversations", () => {
  it("POSTs the query in the body — never in a URL", async () => {
    rawRequest.mockResolvedValue({
      data: {
        tenantId: TENANT,
        conversations: [],
        snapshotAt: SNAPSHOT,
      },
      error: null,
    });
    const signal = new AbortController().signal;
    const page = await searchSmsConversations({
      tenantId: TENANT,
      query: "  refund  ",
      cursor: "c1",
      limit: 50,
      signal,
    });
    expect(rawRequest.mock.calls[0]?.[0]).toBe("POST");
    expect(rawRequest.mock.calls[0]?.[1]).toBe(
      "/api/v1/sms/conversations/search",
    );
    expect(rawRequest.mock.calls[0]?.[2]).toEqual({
      query: "refund",
      cursor: "c1",
      limit: 50,
    });
    expect(rawRequest.mock.calls[0]?.[3]).toMatchObject({ signal });
    expect(page.conversations).toEqual([]);
  });

  it("refuses an invalid query before any request leaves the device", async () => {
    await expect(
      searchSmsConversations({ tenantId: TENANT, query: "ab" }),
    ).rejects.toThrow(/at least 3/);
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it("surfaces the server error envelope as SmsInboxError", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "forbidden", code: "not_authorized" },
    });
    await expect(
      searchSmsConversations({ tenantId: TENANT, query: "refund" }),
    ).rejects.toMatchObject({
      name: "SmsInboxError",
      status: 403,
      code: "not_authorized",
    });
  });
});

describe("bulkSmsConversationAction", () => {
  it("POSTs per-target CAS tokens and decodes the receipt", async () => {
    rawRequest.mockResolvedValue({
      data: {
        ok: true,
        tenantId: TENANT,
        action: "archive",
        applied: 1,
        receipts: [
          {
            ok: true,
            tenantId: TENANT,
            phoneE164: PHONE,
            action: "archive",
            archivedAt: SNAPSHOT,
            stateUpdatedAt: SNAPSHOT,
          },
        ],
      },
      error: null,
    });
    const receipt = await bulkSmsConversationAction({
      tenantId: TENANT,
      conversations: [{ phoneE164: PHONE, expectedUpdatedAt: null }],
      action: "archive",
    });
    expect(rawRequest.mock.calls[0]?.[1]).toBe("/api/v1/sms/conversations/bulk");
    expect(rawRequest.mock.calls[0]?.[2]).toEqual({
      conversations: [{ phoneE164: PHONE, expectedUpdatedAt: null }],
      action: "archive",
    });
    expect(receipt.applied).toBe(1);
  });

  it("refuses an invalid selection before any request", async () => {
    await expect(
      bulkSmsConversationAction({
        tenantId: TENANT,
        conversations: [],
        action: "archive",
      }),
    ).rejects.toThrow(/at least one/);
    expect(rawRequest).not.toHaveBeenCalled();
  });
});
