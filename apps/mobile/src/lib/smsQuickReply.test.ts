import { describe, expect, it } from "vitest";

import {
  decodeSmsQuickRepliesPage,
  decodeSmsQuickReplyDelete,
  decodeSmsQuickReplyMutation,
  decodeSmsQuickReplyUse,
  smsQuickReplyBodyError,
  smsQuickReplyLabelError,
} from "./smsQuickReply";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ID = "44444444-4444-4444-8444-444444444444";
const AT = "2026-08-21T09:00:00Z";
const SNAPSHOT = "2026-08-21T10:00:00Z";

function reply(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    label: "Refund policy",
    body: "Refunds are processed within 5 business days.",
    useCount: 3,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

describe("validators", () => {
  it("mirrors the server label gate", () => {
    expect(smsQuickReplyLabelError("Refund policy")).toBeNull();
    expect(smsQuickReplyLabelError("")).toContain("1 to 80");
    expect(smsQuickReplyLabelError(" x ")).toContain("1 to 80");
    expect(smsQuickReplyLabelError("a".repeat(81))).toContain("80");
  });

  it("rejects an empty or contract-violating body", () => {
    expect(smsQuickReplyBodyError("hello")).toBeNull();
    expect(smsQuickReplyBodyError("   ")).toContain("empty");
    expect(smsQuickReplyBodyError("a".repeat(5000))).toContain("contract");
  });
});

describe("decodeSmsQuickRepliesPage", () => {
  const page = (over: Record<string, unknown> = {}) => ({
    tenantId: TENANT,
    replies: [reply()],
    snapshotAt: SNAPSHOT,
    truncated: false,
    ...over,
  });

  it("decodes the ranked library", () => {
    const decoded = decodeSmsQuickRepliesPage(page(), { tenantId: TENANT });
    expect(decoded.replies[0]?.label).toBe("Refund policy");
    expect(decoded.replies[0]?.useCount).toBe(3);
  });

  it("refuses another tenant, duplicates, and unknown keys", () => {
    expect(() =>
      decodeSmsQuickRepliesPage(page(), {
        tenantId: "99999999-9999-4999-8999-999999999999",
      }),
    ).toThrow(/another tenant/);
    expect(() =>
      decodeSmsQuickRepliesPage(page({ replies: [reply(), reply()] }), {
        tenantId: TENANT,
      }),
    ).toThrow(/duplicates/);
    expect(() =>
      decodeSmsQuickRepliesPage(page({ extra: 1 }), { tenantId: TENANT }),
    ).toThrow(/not part of the contract/);
  });
});

describe("mutation receipts", () => {
  it("checks the create/update envelope", () => {
    const decoded = decodeSmsQuickReplyMutation(
      { tenantId: TENANT, reply: reply() },
      { tenantId: TENANT },
    );
    expect(decoded.id).toBe(ID);
    expect(() =>
      decodeSmsQuickReplyMutation(
        { tenantId: TENANT, reply: reply() },
        { tenantId: TENANT, id: "55555555-5555-4555-8555-555555555555" },
      ),
    ).toThrow(/another reply/);
  });

  it("checks the delete receipt", () => {
    expect(
      decodeSmsQuickReplyDelete(
        { ok: true, tenantId: TENANT, id: ID },
        { tenantId: TENANT, id: ID },
      ),
    ).toEqual({ tenantId: TENANT, id: ID });
    expect(() =>
      decodeSmsQuickReplyDelete(
        { ok: true, tenantId: TENANT, id: ID },
        { tenantId: TENANT, id: "55555555-5555-4555-8555-555555555555" },
      ),
    ).toThrow(/does not match/);
  });

  it("checks the use receipt", () => {
    const decoded = decodeSmsQuickReplyUse(
      { ok: true, tenantId: TENANT, id: ID, useCount: 4, lastUsedAt: AT },
      { tenantId: TENANT, id: ID },
    );
    expect(decoded.useCount).toBe(4);
    expect(() =>
      decodeSmsQuickReplyUse(
        { ok: false, tenantId: TENANT, id: ID, useCount: 4, lastUsedAt: AT },
        { tenantId: TENANT, id: ID },
      ),
    ).toThrow(/not ok/);
  });
});
