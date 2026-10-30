import { describe, expect, it } from "vitest";

import {
  addCursor,
  boundedLimit,
  decodeSmsConversationStateReceipt,
  decodeSmsMarkReadReceipt,
  decodeSmsSenderPaused,
  requirePhone,
  requireSmsAssignee,
  requireSmsPauseReason,
  requireSmsReadBoundary,
  requireSmsReplyIdempotencyKey,
  requireUuid,
  smsConversationsQuery,
  smsMessagesQuery,
} from "./smsInboxContracts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SENDER = "44444444-4444-4444-8444-444444444444";
const PHONE = "+15552345678";

describe("argument validators", () => {
  it("bounds a page limit to 1..100 and defaults when absent", () => {
    expect(boundedLimit(undefined, 40)).toBe(40);
    expect(boundedLimit(1, 40)).toBe(1);
    expect(boundedLimit(100, 40)).toBe(100);
    expect(() => boundedLimit(0, 40)).toThrow(/1 to 100/u);
    expect(() => boundedLimit(101, 40)).toThrow(/1 to 100/u);
    expect(() => boundedLimit(1.5, 40)).toThrow(/1 to 100/u);
  });

  it("refuses a cursor carrying control characters, and skips an absent one", () => {
    const params = new URLSearchParams();
    addCursor(params, undefined);
    expect(params.has("cursor")).toBe(false);
    addCursor(params, "abc");
    expect(params.get("cursor")).toBe("abc");
    expect(() => addCursor(params, "a\u0000b")).toThrow(/cursor is invalid/u);
    expect(() => addCursor(params, "a\u007fb")).toThrow(/cursor is invalid/u);
    expect(() => addCursor(params, "")).toThrow(/cursor is invalid/u);
  });

  it("accepts only US/Canada E.164 phones", () => {
    expect(requirePhone(PHONE)).toBe(PHONE);
    expect(() => requirePhone("+445552345678")).toThrow(/US\/Canada/u);
    expect(() => requirePhone("+11552345678")).toThrow(/US\/Canada/u);
  });

  it("accepts only canonical lowercase UUIDv4, naming the field", () => {
    const hex = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(requireUuid(hex, "Tenant identity")).toBe(hex);
    expect(() => requireUuid(hex.toUpperCase(), "Tenant identity")).toThrow(
      "Tenant identity must be a canonical lowercase UUIDv4.",
    );
    expect(() => requireUuid("not-a-uuid", "Assignee")).toThrow(
      "Assignee must be a canonical lowercase UUIDv4.",
    );
  });
});

describe("query builders", () => {
  it("omits the default filter, always states sort/status/limit", () => {
    const q = smsConversationsQuery({});
    expect(q).toEqual({
      filter: "all",
      sort: "recent",
      status: "active",
      search: "sort=recent&status=active&limit=40",
    });
  });

  it("carries an explicit filter, status and cursor", () => {
    expect(
      smsConversationsQuery({
        filter: "unread",
        sort: "oldest_unread",
        status: "archived",
        limit: 5,
        cursor: "c1",
      }).search,
    ).toBe(
      "filter=unread&sort=oldest_unread&status=archived&limit=5&cursor=c1",
    );
  });

  it("refuses a filter, status or order the server does not define", () => {
    expect(() =>
      smsConversationsQuery({
        filter: "starred" as never,
      }),
    ).toThrow(/Unknown SMS conversation filter/u);
    expect(() => smsConversationsQuery({ status: "deleted" as never })).toThrow(
      /lifecycle status/u,
    );
    expect(() => smsConversationsQuery({ sort: "loudest" as never })).toThrow(
      /conversation order/u,
    );
  });

  it("defaults the messages page to 50", () => {
    expect(smsMessagesQuery({})).toBe("limit=50");
    expect(smsMessagesQuery({ limit: 2, cursor: "c" })).toBe(
      "limit=2&cursor=c",
    );
  });
});

describe("sender pause", () => {
  it("bounds the reason and trims it", () => {
    expect(requireSmsPauseReason(undefined)).toBe("");
    expect(requireSmsPauseReason("  carrier issue  ")).toBe("carrier issue");
    expect(() => requireSmsPauseReason("x".repeat(201))).toThrow(/200 safe/u);
    expect(() => requireSmsPauseReason("bad\u0007")).toThrow(/200 safe/u);
  });

  it("re-derives paused from either metadata location", () => {
    const expected = {
      senderId: SENDER,
      tenantId: TENANT,
      paused: true,
      label: "Pausing the sender",
    };
    expect(
      decodeSmsSenderPaused(
        { id: SENDER, metadata: { paused: true } },
        expected,
      ),
    ).toEqual({ id: SENDER, paused: true });
    expect(
      decodeSmsSenderPaused(
        { id: SENDER, metadata: { sending: { paused: true } } },
        expected,
      ),
    ).toEqual({ id: SENDER, paused: true });
  });

  it("treats a 200 that did not change the state as a failure", () => {
    expect(() =>
      decodeSmsSenderPaused(
        { id: SENDER, metadata: {} },
        {
          senderId: SENDER,
          tenantId: TENANT,
          paused: true,
          label: "Pausing the sender",
        },
      ),
    ).toThrow(/did not report this sender as paused/u);
    expect(() =>
      decodeSmsSenderPaused(
        { id: SENDER, metadata: { paused: true } },
        {
          senderId: SENDER,
          tenantId: TENANT,
          paused: false,
          label: "Resuming the sender",
        },
      ),
    ).toThrow(/did not report this sender as sending again/u);
  });

  it("refuses another sender or another workspace", () => {
    const expected = {
      senderId: SENDER,
      tenantId: TENANT,
      paused: true,
      label: "Pausing the sender",
    };
    expect(() =>
      decodeSmsSenderPaused(
        { id: TENANT, metadata: { paused: true } },
        expected,
      ),
    ).toThrow(/different sender profile/u);
    expect(() =>
      decodeSmsSenderPaused(
        { id: SENDER, tenant_id: SENDER, metadata: { paused: true } },
        expected,
      ),
    ).toThrow(/another workspace's sender profile/u);
    expect(() => decodeSmsSenderPaused([], expected)).toThrow(
      /invalid sender profile/u,
    );
  });
});

describe("lifecycle receipt", () => {
  const expected = { tenantId: TENANT, phoneE164: PHONE };

  it("accepts exactly {ok,tenantId,phoneE164} for the asked-for conversation", () => {
    expect(
      decodeSmsConversationStateReceipt(
        { ok: true, tenantId: TENANT, phoneE164: PHONE },
        expected,
        "Archiving the conversation",
      ),
    ).toEqual({ ok: true, tenantId: TENANT, phoneE164: PHONE });
  });

  it("refuses another tenant, another number, an extra key, or ok:false", () => {
    for (const raw of [
      { ok: true, tenantId: SENDER, phoneE164: PHONE },
      { ok: true, tenantId: TENANT, phoneE164: "+15559998888" },
      { ok: true, tenantId: TENANT, phoneE164: PHONE, extra: 1 },
      { ok: false, tenantId: TENANT, phoneE164: PHONE },
      null,
      [],
    ]) {
      expect(() =>
        decodeSmsConversationStateReceipt(raw, expected, "Archiving"),
      ).toThrow("Archiving returned an invalid receipt.");
    }
  });
});

describe("assignment and reply payloads", () => {
  it("maps null and empty to the server's unassign sentinel", () => {
    expect(requireSmsAssignee(null)).toBe("");
    expect(requireSmsAssignee("")).toBe("");
    expect(requireSmsAssignee(TENANT)).toBe(TENANT);
    expect(() => requireSmsAssignee("nope")).toThrow(/Assignee/u);
  });

  it("refuses an idempotency key that is empty, oversized or unsafe", () => {
    expect(requireSmsReplyIdempotencyKey("k1")).toBe("k1");
    expect(() => requireSmsReplyIdempotencyKey("")).toThrow(/intent key/u);
    expect(() => requireSmsReplyIdempotencyKey("a".repeat(256))).toThrow(
      /intent key/u,
    );
    expect(() => requireSmsReplyIdempotencyKey("a\nb")).toThrow(/intent key/u);
  });
});

describe("read boundary", () => {
  const ID_A = "22222222-2222-4222-8222-222222222222";
  const ID_B = "33333333-3333-4333-8333-333333333333";

  it("accepts 1..500 distinct ids", () => {
    expect(requireSmsReadBoundary([ID_A, ID_B])).toEqual([ID_A, ID_B]);
    expect(
      requireSmsReadBoundary(
        Array.from({ length: 500 }, () => ID_A).map(
          (_, i) => `${String(i).padStart(8, "0")}-2222-4222-8222-222222222222`,
        ),
      ),
    ).toHaveLength(500);
  });

  it("refuses an empty list, an oversized list, a duplicate and a non-uuid", () => {
    expect(() => requireSmsReadBoundary([])).toThrow(/1–500/u);
    expect(() =>
      requireSmsReadBoundary(Array.from({ length: 501 }, () => ID_A)),
    ).toThrow(/1–500/u);
    expect(() => requireSmsReadBoundary([ID_A, ID_A])).toThrow(
      /invalid or duplicate/u,
    );
    expect(() => requireSmsReadBoundary(["nope"])).toThrow(
      /invalid or duplicate/u,
    );
  });

  it("refuses an applied count that exceeds what was requested", () => {
    expect(decodeSmsMarkReadReceipt({ ok: true, applied: 2 }, 2)).toEqual({
      ok: true,
      applied: 2,
    });
    expect(decodeSmsMarkReadReceipt({ ok: true, applied: 0 }, 2)).toEqual({
      ok: true,
      applied: 0,
    });
    for (const raw of [
      { ok: true, applied: 3 },
      { ok: true, applied: -1 },
      { ok: true, applied: 1.5 },
      { ok: false, applied: 1 },
      { ok: true, applied: 1, extra: true },
      null,
    ]) {
      expect(() => decodeSmsMarkReadReceipt(raw, 2)).toThrow(
        "Marking as read returned an invalid receipt.",
      );
    }
  });
});
