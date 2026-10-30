import { describe, expect, it } from "vitest";

import {
  decodeSmsConversations,
  decodeSmsMessages,
  mergeSmsConversationPages,
  mergeSmsMessagePages,
  safeSmsText,
  smsDeliveryLabel,
} from "@/lib/sms-inbox-contract";

const TENANT = "11111111-1111-4111-8111-111111111111";
const DEMO_TENANT = "00000000-0000-0000-0000-000000000001";
const PHONE = "+15552345678";
const SNAPSHOT = "2026-08-21T10:00:00Z";
const RECENT_QUERY = {
  tenantId: TENANT,
  query: { filter: "all", sort: "recent", status: "active" },
} as const;
const OLDEST_UNREAD_QUERY = {
  tenantId: TENANT,
  query: { filter: "unread", sort: "oldest_unread", status: "active" },
} as const;

function conversation(over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    phoneE164: PHONE,
    identityAmbiguous: false,
    lastMessagePreview: "Need help",
    lastMessageAt: "2026-08-21T09:00:00Z",
    lastDirection: "inbound",
    messageCount: 2,
    unreadCount: 1,
    ...over,
  };
  if (!("oldestUnreadAt" in over)) {
    if ((row.unreadCount as number) > 0) {
      row.oldestUnreadAt = row.lastMessageAt;
    } else {
      delete row.oldestUnreadAt;
    }
  }
  return row;
}

function conversationPage(over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    conversations: [conversation()],
    snapshotAt: SNAPSHOT,
    unreadTotal: 1,
    unknownTotal: 1,
    totalConversations: 1,
    activeTotal: 1,
    snoozedTotal: 0,
    archivedTotal: 0,
    ...over,
  };
}

function message(over: Record<string, unknown> = {}) {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    tenant_id: TENANT,
    phone_e164: PHONE,
    provider: "twilio",
    direction: "inbound",
    body: "Can you help?",
    segments: 1,
    status: "received",
    cost_micros: 0,
    created_at: "2026-08-21T09:00:00Z",
    ...over,
  };
}

describe("web SMS inbox wire contract", () => {
  it("accepts a single known-identity active conversation", () => {
    expect(
      decodeSmsConversations(
        conversationPage({
          conversations: [
            conversation({
              subscriberEmail: "reader@example.test",
              messageCount: 1,
            }),
          ],
          unknownTotal: 0,
        }),
        RECENT_QUERY,
      ),
    ).toMatchObject({
      unknownTotal: 0,
      conversations: [{ subscriberEmail: "reader@example.test" }],
    });
  });

  it("requires an explicit lifecycle version whenever operator state is present", () => {
    expect(
      decodeSmsConversations(
        conversationPage({
          conversations: [
            conversation({
              assigneeUserId: "22222222-2222-4222-8222-222222222222",
              stateUpdatedAt: "2026-08-21T08:30:00Z",
            }),
          ],
        }),
        RECENT_QUERY,
      ).conversations[0],
    ).toMatchObject({ stateUpdatedAt: "2026-08-21T08:30:00Z" });

    expect(() =>
      decodeSmsConversations(
        conversationPage({
          conversations: [
            conversation({
              assigneeUserId: "22222222-2222-4222-8222-222222222222",
            }),
          ],
        }),
        RECENT_QUERY,
      ),
    ).toThrow(/stateUpdatedAt/u);
  });

  it("accepts canonical non-v4 tenant identities without weakening entity UUIDs", () => {
    const demoQuery = {
      tenantId: DEMO_TENANT,
      query: RECENT_QUERY.query,
    } as const;
    expect(
      decodeSmsConversations(
        conversationPage({ tenantId: DEMO_TENANT }),
        demoQuery,
      ),
    ).toMatchObject({ tenantId: DEMO_TENANT });
    expect(
      decodeSmsMessages(
        {
          tenantId: DEMO_TENANT,
          messages: [message({ tenant_id: DEMO_TENANT })],
          snapshotAt: SNAPSHOT,
        },
        { tenantId: DEMO_TENANT, phoneE164: PHONE },
      ),
    ).toMatchObject({
      tenantId: DEMO_TENANT,
      messages: [{ tenant_id: DEMO_TENANT }],
    });

    expect(() =>
      decodeSmsMessages(
        {
          tenantId: DEMO_TENANT,
          messages: [
            message({
              id: "bbbbbbbb-bbbb-1bbb-8bbb-bbbbbbbbbbbb",
              tenant_id: DEMO_TENANT,
            }),
          ],
          snapshotAt: SNAPSHOT,
        },
        { tenantId: DEMO_TENANT, phoneE164: PHONE },
      ),
    ).toThrow(/canonical lowercase UUIDv4/u);
    expect(() =>
      decodeSmsConversations(
        conversationPage({
          tenantId: DEMO_TENANT,
          conversations: [
            conversation({
              assigneeUserId: "22222222-2222-1222-8222-222222222222",
            }),
          ],
        }),
        demoQuery,
      ),
    ).toThrow(/canonical lowercase UUIDv4/u);
  });

  it("rejects malformed and cross-tenant envelopes", () => {
    expect(() =>
      decodeSmsConversations(
        conversationPage({ tenantId: "tenant" }),
        RECENT_QUERY,
      ),
    ).toThrow(/canonical lowercase tenant UUID/u);
    expect(() =>
      decodeSmsConversations(
        conversationPage({
          tenantId: "99999999-9999-4999-8999-999999999999",
        }),
        RECENT_QUERY,
      ),
    ).toThrow(/belongs to another tenant/u);
    expect(() =>
      decodeSmsMessages(
        { tenantId: "tenant", messages: [], snapshotAt: SNAPSHOT },
        { tenantId: TENANT, phoneE164: PHONE },
      ),
    ).toThrow(/canonical lowercase tenant UUID/u);
  });

  it("decodes the frozen cursor/cutoff/count envelopes without treating the cutoff as repeatable-read", () => {
    expect(
      decodeSmsConversations(
        conversationPage({ nextCursor: "opaque" }),
        RECENT_QUERY,
      ),
    ).toMatchObject({
      snapshotAt: SNAPSHOT,
      nextCursor: "opaque",
      activeTotal: 1,
    });
    expect(
      decodeSmsMessages(
        {
          tenantId: TENANT,
          messages: [message()],
          snapshotAt: SNAPSHOT,
          nextCursor: "older",
        },
        { tenantId: TENANT, phoneE164: PHONE },
      ),
    ).toMatchObject({ nextCursor: "older", messages: [{ tenant_id: TENANT }] });
  });

  it.each([
    ["coerced totals", conversationPage({ activeTotal: "1" })],
    [
      "duplicate phone",
      conversationPage({ conversations: [conversation(), conversation()] }),
    ],
    [
      "future row",
      conversationPage({
        conversations: [
          conversation({ lastMessageAt: "2026-08-22T00:00:00Z" }),
        ],
      }),
    ],
    [
      "impossible timestamp",
      conversationPage({
        conversations: [
          conversation({ lastMessageAt: "2026-02-30T00:00:00Z" }),
        ],
      }),
    ],
    ["old envelope", { conversations: [], nextBefore: "legacy" }],
  ])(
    "rejects %s rather than manufacturing an empty or complete inbox",
    (_label, payload) => {
      expect(() => decodeSmsConversations(payload, RECENT_QUERY)).toThrow(
        /Invalid SMS inbox response/u,
      );
    },
  );

  it("rejects cross-tenant, cross-phone, duplicate, and unordered messages", () => {
    const decode = (rows: unknown[]) =>
      decodeSmsMessages(
        { tenantId: TENANT, messages: rows, snapshotAt: SNAPSHOT },
        { tenantId: TENANT, phoneE164: PHONE },
      );
    expect(() =>
      decode([
        message({
          tenant_id: "99999999-9999-4999-8999-999999999999",
        }),
      ]),
    ).toThrow(/identity/u);
    expect(() => decode([message({ phone_e164: "+15559876543" })])).toThrow(
      /identity/u,
    );
    expect(() => decode([message({ phone_e164: "+15551234567" })])).toThrow(
      /identity/u,
    );
    expect(() => decode([message(), message()])).toThrow(/duplicate/u);
    expect(() =>
      decode([
        message({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          created_at: "2026-08-21T08:00:00Z",
        }),
        message({
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          created_at: "2026-08-21T09:00:00Z",
        }),
      ]),
    ).toThrow(/order/u);
  });

  it("rejects NANP rows whose area code or exchange begins with 0/1", () => {
    expect(() =>
      decodeSmsConversations(
        conversationPage({
          conversations: [conversation({ phoneE164: "+11552345678" })],
        }),
        RECENT_QUERY,
      ),
    ).toThrow(/Invalid SMS inbox response/u);
    expect(() =>
      decodeSmsConversations(
        conversationPage({
          conversations: [conversation({ phoneE164: "+15551234567" })],
        }),
        RECENT_QUERY,
      ),
    ).toThrow(/Invalid SMS inbox response/u);
  });

  it("never merges pages across a response cutoff, total, duplicate, or order boundary", () => {
    const first = decodeSmsConversations(
      conversationPage({
        nextCursor: "next",
        totalConversations: 2,
        activeTotal: 2,
        unreadTotal: 2,
        unknownTotal: 2,
      }),
      RECENT_QUERY,
    );
    const second = decodeSmsConversations(
      conversationPage({
        conversations: [
          conversation({
            phoneE164: "+15559876543",
            lastMessageAt: "2026-08-21T08:00:00Z",
          }),
        ],
        totalConversations: 2,
        activeTotal: 2,
        unreadTotal: 2,
        unknownTotal: 2,
      }),
      RECENT_QUERY,
    );
    expect(
      mergeSmsConversationPages([first, second]).conversations,
    ).toHaveLength(2);
    expect(() => mergeSmsConversationPages([first, first])).toThrow(/overlap/u);
    expect(() =>
      mergeSmsConversationPages([
        first,
        { ...second, snapshotAt: "2026-08-21T11:00:00Z" },
      ]),
    ).toThrow(/cross/u);
    expect(() =>
      mergeSmsConversationPages([
        first,
        {
          ...second,
          query: { ...second.query, filter: "unknown" },
        },
      ]),
    ).toThrow(/cross/u);

    const snoozed = decodeSmsConversations(
      conversationPage({
        conversations: [
          conversation({
            snoozeUntil: "2026-08-22T10:00:00Z",
            stateUpdatedAt: "2026-08-21T09:30:00Z",
          }),
        ],
        activeTotal: 0,
        snoozedTotal: 1,
      }),
      {
        tenantId: TENANT,
        query: { filter: "all", sort: "recent", status: "snoozed" },
      },
    );
    expect(mergeSmsConversationPages([snoozed])).toMatchObject({
      totalConversations: 1,
      activeTotal: 0,
      snoozedTotal: 1,
      archivedTotal: 0,
    });

    const messages = decodeSmsMessages(
      { tenantId: TENANT, messages: [message()], snapshotAt: SNAPSHOT },
      { tenantId: TENANT, phoneE164: PHONE },
    );
    expect(() => mergeSmsMessagePages([messages, messages])).toThrow(
      /overlap/u,
    );
  });

  it("requires oldestUnreadAt exactly for unread rows and validates oldest-unread ordering", () => {
    expect(() =>
      decodeSmsConversations(
        conversationPage({
          conversations: [conversation({ oldestUnreadAt: undefined })],
        }),
        RECENT_QUERY,
      ),
    ).toThrow(/Invalid SMS inbox response/u);
    expect(() =>
      decodeSmsConversations(
        conversationPage({
          conversations: [
            conversation({ unreadCount: 0, oldestUnreadAt: SNAPSHOT }),
          ],
        }),
        RECENT_QUERY,
      ),
    ).toThrow(/Invalid SMS inbox response/u);
    expect(() =>
      decodeSmsConversations(
        conversationPage({
          conversations: [
            conversation({
              phoneE164: "+15552340001",
              oldestUnreadAt: "2026-08-21T08:30:00Z",
            }),
            conversation({
              phoneE164: "+15552340002",
              oldestUnreadAt: "2026-08-21T08:00:00Z",
            }),
          ],
          totalConversations: 2,
          activeTotal: 2,
          unreadTotal: 2,
          unknownTotal: 2,
        }),
        OLDEST_UNREAD_QUERY,
      ),
    ).toThrow(/order/u);
  });

  it("accepts Unicode-safe previews and preserves an explicit oversize omission", () => {
    expect(
      decodeSmsConversations(
        conversationPage({
          conversations: [
            conversation({ lastMessagePreview: "🚚".repeat(512) }),
          ],
        }),
        RECENT_QUERY,
      ).conversations[0]?.lastMessagePreview,
    ).toBe("🚚".repeat(512));
    expect(
      decodeSmsConversations(
        conversationPage({
          conversations: [
            conversation({
              lastMessagePreview: "",
              lastMessagePreviewOmittedReason: "body_exceeds_inbox_limit",
            }),
          ],
        }),
        RECENT_QUERY,
      ).conversations[0],
    ).toMatchObject({
      lastMessagePreview: "",
      lastMessagePreviewOmittedReason: "body_exceeds_inbox_limit",
    });
    expect(
      decodeSmsConversations(
        conversationPage({
          conversations: [
            conversation({
              lastMessagePreview: "",
              lastMessagePreviewOmittedReason: "legacy_body_unavailable",
            }),
          ],
        }),
        RECENT_QUERY,
      ).conversations[0],
    ).toMatchObject({
      lastMessagePreview: "",
      lastMessagePreviewOmittedReason: "legacy_body_unavailable",
    });
    for (const poisoned of [
      conversation({ lastMessagePreview: "" }),
      conversation({ lastMessagePreview: " \t\n" }),
      conversation({ lastMessagePreview: "🚚".repeat(513) }),
      conversation({ lastMessagePreview: "bad\u0000preview" }),
      conversation({ lastMessagePreview: "\ud800" }),
      conversation({
        lastMessagePreview: "not empty",
        lastMessagePreviewOmittedReason: "body_exceeds_inbox_limit",
      }),
    ]) {
      expect(() =>
        decodeSmsConversations(
          conversationPage({ conversations: [poisoned] }),
          RECENT_QUERY,
        ),
      ).toThrow(/Invalid SMS inbox response/u);
    }
  });

  it("rejects poisoned bodies at either exact bound and preserves explicit omission", () => {
    const decodeBody = (body: string, body_omitted_reason?: unknown) =>
      decodeSmsMessages(
        {
          tenantId: TENANT,
          messages: [
            message({
              body,
              ...(body_omitted_reason !== undefined
                ? { body_omitted_reason }
                : {}),
            }),
          ],
          snapshotAt: SNAPSHOT,
        },
        { tenantId: TENANT, phoneE164: PHONE },
      );

    expect(decodeBody("🚚".repeat(4_096)).messages[0]?.body).toHaveLength(
      8_192,
    );
    expect(decodeBody("a".repeat(4_800)).messages[0]?.body).toHaveLength(4_800);
    expect(() => decodeBody("🚚".repeat(4_097))).toThrow(/body contract/u);
    expect(() => decodeBody("a".repeat(4_801))).toThrow(/body contract/u);
    expect(() => decodeBody("bad\u0000body")).toThrow(/body contract/u);
    expect(() => decodeBody("\ud800")).toThrow(/body contract/u);
    expect(() => decodeBody("")).toThrow(/body contract/u);
    expect(() => decodeBody(" \t\n")).toThrow(/body contract/u);
    expect(
      decodeBody("", "body_exceeds_inbox_limit").messages[0],
    ).toMatchObject({
      body: "",
      body_omitted_reason: "body_exceeds_inbox_limit",
    });
    expect(decodeBody("", "legacy_body_unavailable").messages[0]).toMatchObject(
      {
        body: "",
        body_omitted_reason: "legacy_body_unavailable",
      },
    );
    expect(() =>
      decodeBody("invented legacy content", "legacy_body_unavailable"),
    ).toThrow(/body_omitted_reason/u);
  });

  it("isolates hostile display text and keeps sent distinct from delivered", () => {
    const safe = safeSmsText("مرحبا\u202Eabc🚚", 8);
    expect(safe).toContain("مرحبا");
    expect(safe).not.toContain("\u202E");
    expect(Array.from(safeSmsText("🚚".repeat(4), 2))).toContain("…");
    expect(Array.from(safeSmsText("x".repeat(10_000), 240))).toHaveLength(241);
    expect(smsDeliveryLabel("outbound", "sent")).toMatch(/^Sent/u);
    expect(smsDeliveryLabel("outbound", "sent")).not.toMatch(/^Delivered/u);
    expect(smsDeliveryLabel("inbound", "delivered")).toBe("Received");
  });
});
