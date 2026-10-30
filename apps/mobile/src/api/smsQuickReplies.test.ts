import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSmsQuickReply,
  deleteSmsQuickReply,
  listSmsQuickReplies,
  recordSmsQuickReplyUse,
} from "./smsQuickReplies";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

const TENANT = "11111111-1111-4111-8111-111111111111";
const ID = "44444444-4444-4444-8444-444444444444";
const AT = "2026-08-21T09:00:00Z";

function reply() {
  return {
    id: ID,
    label: "Refund policy",
    body: "Refunds are processed within 5 business days.",
    useCount: 0,
    createdAt: AT,
    updatedAt: AT,
  };
}

beforeEach(() => {
  rawRequest.mockReset();
});

describe("quick replies transport", () => {
  it("lists with no query parameters (the route 400s any)", async () => {
    rawRequest.mockResolvedValue({
      data: {
        tenantId: TENANT,
        replies: [reply()],
        snapshotAt: AT,
        truncated: false,
      },
      error: null,
    });
    const page = await listSmsQuickReplies({ tenantId: TENANT });
    expect(rawRequest.mock.calls[0]?.[1]).toBe("/api/v1/sms/quick-replies");
    expect(page.replies).toHaveLength(1);
  });

  it("creates with the validated label and body", async () => {
    rawRequest.mockResolvedValue({
      data: { tenantId: TENANT, reply: reply() },
      error: null,
    });
    await createSmsQuickReply({
      tenantId: TENANT,
      label: "Refund policy",
      body: "Refunds are processed within 5 business days.",
    });
    expect(rawRequest.mock.calls[0]?.[0]).toBe("POST");
    expect(rawRequest.mock.calls[0]?.[2]).toEqual({
      label: "Refund policy",
      body: "Refunds are processed within 5 business days.",
    });
  });

  it("refuses an invalid label before any request", async () => {
    await expect(
      createSmsQuickReply({ tenantId: TENANT, label: " x ", body: "hello" }),
    ).rejects.toThrow(/1 to 80/);
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it("deletes and records use against the id path", async () => {
    rawRequest.mockResolvedValue({
      data: { ok: true, tenantId: TENANT, id: ID },
      error: null,
    });
    await deleteSmsQuickReply({ tenantId: TENANT, id: ID });
    expect(rawRequest.mock.calls[0]?.[0]).toBe("DELETE");
    expect(rawRequest.mock.calls[0]?.[1]).toBe(
      `/api/v1/sms/quick-replies/${ID}`,
    );

    rawRequest.mockResolvedValue({
      data: { ok: true, tenantId: TENANT, id: ID, useCount: 1, lastUsedAt: AT },
      error: null,
    });
    const receipt = await recordSmsQuickReplyUse({ tenantId: TENANT, id: ID });
    expect(rawRequest.mock.calls[1]?.[1]).toBe(
      `/api/v1/sms/quick-replies/${ID}/use`,
    );
    expect(receipt.useCount).toBe(1);
  });
});
