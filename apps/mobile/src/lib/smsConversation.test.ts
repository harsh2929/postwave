import { describe, expect, it } from "vitest";

import {
  conversationTitle,
  decodePhoneParam,
  decodeSmsConversationContext,
  decodeSmsConversationsPage,
  decodeSmsMessagesPage,
  decodeSmsReplyResponse,
  decodeSmsSenders,
  deliveryVerdict,
  isDefinitivePreProviderSmsReplyError,
  isEligibleSmsSender,
  isSupportedSmsReplyPhone,
  markConversationReadInPage,
  mergeSmsConversationPages,
  mergeSmsMessagePages,
  newSmsReplyIntentKey,
  safeSmsDisplayText,
  smsReplyBlockReason,
  threadPath,
} from "./smsConversation";

const TENANT = "11111111-1111-4111-8111-111111111111";

/**
 * What `listConversations` stamps onto a decoded page for a default request
 * (api/smsInbox.ts: filter "all", sort "recent", status "active").
 *
 * The decoder does not read the query identity off the wire — it echoes the
 * one the CALLER asked for, so a response can be matched to the request that
 * produced it and a stale page for one filter can never be applied to
 * another's view. That is why every call here has to supply it.
 */
const EXPECTED_QUERY = {
  tenantId: TENANT,
  query: { filter: "all", sort: "recent", status: "active" },
} as const;
const OLDEST_UNREAD_QUERY = {
  tenantId: TENANT,
  query: { filter: "unread", sort: "oldest_unread", status: "active" },
} as const;
const PHONE = "+15552345678";
const SNAPSHOT = "2026-08-21T10:00:00Z";
const MESSAGE_A = "11111111-1111-4111-8111-111111111111";
const MESSAGE_B = "22222222-2222-4222-8222-222222222222";
const MESSAGE_C = "33333333-3333-4333-8333-333333333333";
const SENDER = "44444444-4444-4444-8444-444444444444";
const LIST = "55555555-5555-4555-8555-555555555555";
const INTENT_MESSAGE = "66666666-6666-4666-8666-666666666666";
const REPLY_MESSAGE = "77777777-7777-4777-8777-777777777777";

function conversation(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    phoneE164: PHONE,
    identityAmbiguous: false,
    lastMessagePreview: "Need help",
    lastMessageAt: "2026-08-21T09:00:00Z",
    lastDirection: "inbound",
    messageCount: 4,
    unreadCount: 1,
    ...overrides,
  };
  // The decoder requires oldestUnreadAt to be PRESENT exactly when unreadCount
  // is non-zero, and to be no newer than either lastMessageAt or the response
  // cutoff. Deriving it here keeps every fixture internally consistent, so a
  // case that overrides unreadCount does not trip an invariant it was not
  // written to exercise. A case that wants the disagreement states it by
  // passing oldestUnreadAt explicitly.
  if (!("oldestUnreadAt" in overrides)) {
    if ((row.unreadCount as number) > 0) {
      // Tie it to the row's OWN lastMessageAt: that value is itself validated
      // against the cutoff, so this can never be newer than either bound no
      // matter what a case overrides.
      row.oldestUnreadAt = row.lastMessageAt;
    } else {
      delete row.oldestUnreadAt;
    }
  }
  return row;
}

function conversationPage(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_A,
    tenant_id: TENANT,
    sender_profile_id: SENDER,
    phone_e164: PHONE,
    provider: "twilio",
    provider_message_id: "SM1",
    direction: "inbound",
    body: "Is my order shipping?",
    segments: 1,
    status: "received",
    cost_micros: 0,
    created_at: "2026-08-21T09:00:00Z",
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    phoneE164: PHONE,
    consentStatus: "opted_in",
    subscribedLists: 1,
    totalMessages: 4,
    suppressed: false,
    suppressionReversible: false,
    hasInboundThread: true,
    consentMixed: false,
    identityAmbiguous: false,
    consentEvidenceSufficient: true,
    replyDispatchAvailable: true,
    eligibleLists: [
      {
        id: LIST,
        name: "Customer updates",
        description: "Transactional replies",
        consentSource: "double_optin",
        consentAt: "2026-08-20T08:00:00Z",
      },
    ],
    ...overrides,
  };
}

describe("strict conversation decoder", () => {
  it("accepts the frozen cursor/cutoff/count envelope without treating the cutoff as repeatable-read", () => {
    expect(
      decodeSmsConversationsPage(
        conversationPage({ nextCursor: "opaque-v1" }),
        EXPECTED_QUERY,
      ),
    ).toMatchObject({
      snapshotAt: SNAPSHOT,
      nextCursor: "opaque-v1",
      conversations: [{ phoneE164: PHONE, lastDirection: "inbound" }],
    });
  });

  it.each([
    ["coerced count", conversationPage({ unreadTotal: "1" })],
    [
      "unknown direction",
      conversationPage({
        conversations: [conversation({ lastDirection: "sideways" })],
      }),
    ],
    [
      "bad timestamp",
      conversationPage({
        conversations: [conversation({ lastMessageAt: "today" })],
      }),
    ],
    [
      "impossible timestamp",
      conversationPage({
        conversations: [
          conversation({ lastMessageAt: "2026-02-30T09:00:00Z" }),
        ],
      }),
    ],
    [
      "duplicate phone",
      conversationPage({ conversations: [conversation(), conversation()] }),
    ],
    ["inconsistent lifecycle totals", conversationPage({ activeTotal: 0 })],
    ["control-bearing cursor", conversationPage({ nextCursor: "bad\nvalue" })],
  ])("rejects %s instead of coercing or dropping it", (_label, payload) => {
    expect(() => decodeSmsConversationsPage(payload, EXPECTED_QUERY)).toThrow(
      /Invalid SMS response/u,
    );
  });

  it("rejects recent-first rows in the wrong order", () => {
    expect(
      () =>
        decodeSmsConversationsPage(
          conversationPage({
            conversations: [
              conversation({
                phoneE164: "+15552340001",
                lastMessageAt: "2026-08-20T00:00:00Z",
              }),
              conversation({
                phoneE164: "+15552340002",
                lastMessageAt: "2026-08-21T00:00:00Z",
              }),
            ],
            totalConversations: 2,
            activeTotal: 2,
            unreadTotal: 2,
            unknownTotal: 2,
          }),
          EXPECTED_QUERY,
        ),
      // The decoder now names the ORDER THAT WAS REQUESTED rather than
      // hard-coding "recent-first", because sort is part of the query identity
      // the caller stamps on the request ("recent" vs "oldest_unread").
    ).toThrow(/out of requested order/u);
  });

  it("requires oldestUnreadAt exactly for unread rows and validates oldest-unread ordering", () => {
    expect(() =>
      decodeSmsConversationsPage(
        conversationPage({
          conversations: [conversation({ oldestUnreadAt: undefined })],
        }),
        EXPECTED_QUERY,
      ),
    ).toThrow(/oldestUnreadAt/u);
    expect(() =>
      decodeSmsConversationsPage(
        conversationPage({
          conversations: [
            conversation({ unreadCount: 0, oldestUnreadAt: SNAPSHOT }),
          ],
        }),
        EXPECTED_QUERY,
      ),
    ).toThrow(/oldestUnreadAt/u);
    expect(() =>
      decodeSmsConversationsPage(
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
    ).toThrow(/out of requested order/u);
  });

  it("accepts Unicode-safe previews and preserves an explicit oversize omission", () => {
    expect(
      decodeSmsConversationsPage(
        conversationPage({
          conversations: [
            conversation({ lastMessagePreview: "🚚".repeat(512) }),
          ],
        }),
        EXPECTED_QUERY,
      ).conversations[0]?.lastMessagePreview,
    ).toBe("🚚".repeat(512));
    expect(
      decodeSmsConversationsPage(
        conversationPage({
          conversations: [
            conversation({
              lastMessagePreview: "",
              lastMessagePreviewOmittedReason: "body_exceeds_inbox_limit",
            }),
          ],
        }),
        EXPECTED_QUERY,
      ).conversations[0],
    ).toMatchObject({
      lastMessagePreview: "",
      lastMessagePreviewOmittedReason: "body_exceeds_inbox_limit",
    });
    expect(
      decodeSmsConversationsPage(
        conversationPage({
          conversations: [
            conversation({
              lastMessagePreview: "",
              lastMessagePreviewOmittedReason: "legacy_body_unavailable",
            }),
          ],
        }),
        EXPECTED_QUERY,
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
        decodeSmsConversationsPage(
          conversationPage({ conversations: [poisoned] }),
          EXPECTED_QUERY,
        ),
      ).toThrow(/Invalid SMS response/u);
    }
  });
});

describe("strict message decoder and page chain", () => {
  it("keeps reverse-chronological wire order until pages are merged", () => {
    const page = decodeSmsMessagesPage(
      {
        tenantId: TENANT,
        messages: [
          message({ id: MESSAGE_B, created_at: "2026-08-21T09:02:00Z" }),
          message({ id: MESSAGE_A, created_at: "2026-08-21T09:01:00Z" }),
        ],
        snapshotAt: SNAPSHOT,
      },
      { tenantId: TENANT, phoneE164: PHONE },
    );
    expect(page.messages.map((row) => row.id)).toEqual([MESSAGE_B, MESSAGE_A]);
    expect(mergeSmsMessagePages([page]).messages.map((row) => row.id)).toEqual([
      MESSAGE_A,
      MESSAGE_B,
    ]);
  });

  it.each([
    [
      "another tenant",
      message({ tenant_id: "99999999-9999-4999-8999-999999999999" }),
    ],
    ["another phone", message({ phone_e164: "+15552340000" })],
    ["unknown direction", message({ direction: "unknown" })],
    ["missing segments", { ...message(), segments: undefined }],
    ["invalid timestamp", message({ created_at: "whenever" })],
  ])("fails closed for %s", (_label, row) => {
    expect(() =>
      decodeSmsMessagesPage(
        { tenantId: TENANT, messages: [row], snapshotAt: SNAPSHOT },
        { tenantId: TENANT, phoneE164: PHONE },
      ),
    ).toThrow(/Invalid SMS response/u);
  });

  it("rejects duplicate, unordered, overlapping, and cross-cutoff messages", () => {
    const decode = (rows: unknown[], snapshotAt = SNAPSHOT) =>
      decodeSmsMessagesPage(
        { tenantId: TENANT, messages: rows, snapshotAt },
        { tenantId: TENANT, phoneE164: PHONE },
      );
    expect(() => decode([message(), message()])).toThrow(/duplicates/u);
    expect(() =>
      decode([
        message({ id: MESSAGE_A, created_at: "2026-08-21T09:00:00Z" }),
        message({ id: MESSAGE_B, created_at: "2026-08-21T09:01:00Z" }),
      ]),
    ).toThrow(/newest-first/u);
    const first = decode([message({ id: MESSAGE_C })]);
    expect(() => mergeSmsMessagePages([first, first])).toThrow(/overlap/u);
    expect(() =>
      mergeSmsMessagePages([
        first,
        decode(
          [message({ id: MESSAGE_B, created_at: "2026-08-21T08:00:00Z" })],
          "2026-08-21T10:01:00Z",
        ),
      ]),
    ).toThrow(/another response cutoff/u);
  });

  it("enforces the exact UTF-8/code-point body contract without truncating", () => {
    const decodeBody = (body: string, body_omitted_reason?: unknown) =>
      decodeSmsMessagesPage(
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
    expect(() => decodeBody("")).toThrow(/body/u);
    expect(() => decodeBody(" \t\n")).toThrow(/body contract/u);

    expect(
      decodeBody("", "body_exceeds_inbox_limit").messages[0],
    ).toMatchObject({
      body: "",
      bodyOmittedReason: "body_exceeds_inbox_limit",
    });
    expect(decodeBody("", "legacy_body_unavailable").messages[0]).toMatchObject(
      {
        body: "",
        bodyOmittedReason: "legacy_body_unavailable",
      },
    );
    expect(() =>
      decodeBody("invented legacy content", "legacy_body_unavailable"),
    ).toThrow(/body contract/u);
    expect(() => decodeBody("", "unknown_reason")).toThrow(
      /body_omitted_reason/u,
    );
  });

  it("requires tenant-bound envelopes and canonical lowercase UUIDv4 values", () => {
    expect(() =>
      decodeSmsMessagesPage(
        {
          tenantId: "99999999-9999-4999-8999-999999999999",
          messages: [message()],
          snapshotAt: SNAPSHOT,
        },
        { tenantId: TENANT, phoneE164: PHONE },
      ),
    ).toThrow(/another tenant/u);
    expect(() =>
      decodeSmsMessagesPage(
        {
          tenantId: TENANT,
          messages: [message({ id: "11111111-1111-1111-8111-111111111111" })],
          snapshotAt: SNAPSHOT,
        },
        { tenantId: TENANT, phoneE164: PHONE },
      ),
    ).toThrow(/UUIDv4/u);
  });
});

describe("consent, suppression, sender, and receipt truth", () => {
  it("requires the context's suppression and eligible-list facts", () => {
    expect(
      decodeSmsConversationContext(context(), {
        tenantId: TENANT,
        phoneE164: PHONE,
      }),
    ).toMatchObject({
      consentStatus: "opted_in",
      suppressed: false,
      hasInboundThread: true,
      eligibleLists: [{ id: LIST }],
    });
    expect(() =>
      decodeSmsConversationContext(
        { ...context(), suppressed: undefined },
        { tenantId: TENANT, phoneE164: PHONE },
      ),
    ).toThrow(/suppressed/u);
    expect(() =>
      decodeSmsConversationContext(
        { ...context(), phoneE164: "+15552340000" },
        { tenantId: TENANT, phoneE164: PHONE },
      ),
    ).toThrow(/another phone/u);
  });

  it("requires sender tenant equality and derives paused eligibility", () => {
    const raw = {
      tenantId: TENANT,
      items: [
        {
          id: SENDER,
          tenant_id: TENANT,
          provider: "twilio",
          country: "US",
          sender_type: "10dlc",
          registration_status: "approved",
          phone_number: PHONE,
          metadata: { sending: { paused: true } },
          created_at: "2026-08-20T08:00:00Z",
          updated_at: "2026-08-21T08:00:00Z",
        },
      ],
    };
    const [sender] = decodeSmsSenders(raw, TENANT);
    expect(sender?.paused).toBe(true);
    expect(isEligibleSmsSender(sender!)).toBe(false);
    expect(
      isEligibleSmsSender({
        ...sender!,
        country: "GB",
        paused: false,
      }),
    ).toBe(false);
    expect(() => decodeSmsSenders(raw, "other")).toThrow(/another tenant/u);
  });

  it("decodes the persisted message and exact provider receipt from 201", () => {
    expect(
      decodeSmsReplyResponse(
        {
          disposition: "persisted",
          message: {
            id: REPLY_MESSAGE,
            tenant_id: TENANT,
            sender_profile_id: SENDER,
            provider: "twilio",
            provider_message_id: "SM1",
            direction: "outbound",
            segments: 1,
            status: "accepted",
            cost_micros: 7900,
            created_at: "2026-08-21T09:00:00Z",
          },
          providerReceipt: {
            provider: "twilio",
            providerMessageId: "SM1",
            status: "accepted",
          },
        },
        { tenantId: TENANT, senderProfileId: SENDER },
      ),
    ).toMatchObject({
      disposition: "persisted",
      message: { tenantId: TENANT, direction: "outbound", costMicros: 7900 },
      providerReceipt: { providerMessageId: "SM1", status: "accepted" },
    });
  });

  it("treats a 202 reconciliation receipt as terminal uncertainty", () => {
    expect(
      decodeSmsReplyResponse(
        {
          disposition: "reconciliation_required",
          code: "reply_reconciliation_required",
          intentMessageId: INTENT_MESSAGE,
          providerReceipt: {
            provider: "twilio",
            status: "accepted",
          },
        },
        { tenantId: TENANT, senderProfileId: SENDER },
      ),
    ).toMatchObject({
      disposition: "reconciliation_required",
      intentMessageId: INTENT_MESSAGE,
      providerReceipt: { provider: "twilio", status: "accepted" },
    });
  });

  it("requires a provider message id only for a persisted receipt", () => {
    expect(() =>
      decodeSmsReplyResponse(
        {
          disposition: "persisted",
          message: {
            id: REPLY_MESSAGE,
            tenant_id: TENANT,
            sender_profile_id: SENDER,
            provider: "twilio",
            provider_message_id: "SM1",
            direction: "outbound",
            segments: 1,
            status: "accepted",
            cost_micros: 1,
            created_at: "2026-08-21T09:00:00Z",
          },
          providerReceipt: { provider: "twilio", status: "accepted" },
        },
        { tenantId: TENANT, senderProfileId: SENDER },
      ),
    ).toThrow(/providerMessageId/u);
  });

  it("rejects privacy-expanded reply receipts and non-v4 intent IDs", () => {
    expect(() =>
      decodeSmsReplyResponse(
        {
          disposition: "reconciliation_required",
          code: "reply_reconciliation_required",
          intentMessageId: INTENT_MESSAGE,
          body: "must never be echoed",
          providerReceipt: { provider: "twilio", status: "unknown" },
        },
        { tenantId: TENANT, senderProfileId: SENDER },
      ),
    ).toThrow(/not part of the contract/u);
    expect(() =>
      decodeSmsReplyResponse(
        {
          disposition: "reconciliation_required",
          code: "reply_reconciliation_required",
          intentMessageId: "66666666-6666-1666-8666-666666666666",
          providerReceipt: { provider: "twilio", status: "unknown" },
        },
        { tenantId: TENANT, senderProfileId: SENDER },
      ),
    ).toThrow(/UUIDv4/u);
  });

  it("locks replies on every uncertainty and unsupported market", () => {
    const allowedContext = decodeSmsConversationContext(context(), {
      tenantId: TENANT,
      phoneE164: PHONE,
    });
    const eligible = [
      {
        id: SENDER,
        tenantId: TENANT,
        provider: "twilio",
        country: "US",
        senderType: "10dlc",
        registrationStatus: "approved",
        paused: false,
      },
    ];
    const reason = (overrides: Record<string, unknown> = {}) =>
      smsReplyBlockReason({
        phoneE164: PHONE,
        online: true,
        context: allowedContext,
        contextFailed: false,
        sendersFailed: false,
        eligibleSenders: eligible,
        ...overrides,
      });
    expect(reason()).toBeNull();
    expect(reason({ online: false })).toMatch(/Offline/u);
    expect(reason({ phoneE164: "+442071838750" })).toMatch(/US and Canada/u);
    expect(reason({ contextFailed: true })).toMatch(
      /Consent status unavailable/u,
    );
    expect(reason({ sendersFailed: true })).toMatch(
      /Sender status unavailable/u,
    );
    expect(
      reason({
        context: {
          ...allowedContext,
          replyDispatchAvailable: false,
          replyDispatchUnavailableReason: "sms_reply_dispatch_release_held",
        },
      }),
    ).toMatch(/release-held/u);
    expect(
      reason({ context: { ...allowedContext, suppressed: true } }),
    ).toMatch(/Suppressed/u);
    expect(
      reason({ context: { ...allowedContext, consentStatus: "opted_out" } }),
    ).toMatch(/opted out/u);
    expect(
      reason({ context: { ...allowedContext, eligibleLists: [] } }),
    ).toMatch(/no currently opted-in/u);
    expect(
      reason({ context: { ...allowedContext, identityAmbiguous: true } }),
    ).toMatch(/multiple subscriber/u);
    expect(
      reason({ context: { ...allowedContext, consentMixed: true } }),
    ).toMatch(/conflicts/u);
    expect(
      reason({
        context: {
          ...allowedContext,
          consentEvidenceSufficient: false,
          eligibleLists: [],
        },
      }),
    ).toMatch(/insufficient/u);
    expect(reason({ eligibleSenders: [] })).toMatch(/No approved/u);
  });
});

describe("display, navigation, and delivery safety", () => {
  it("removes bidi overrides, preserves RTL and emoji, isolates, and caps by code point", () => {
    const value = safeSmsDisplayText("مرحبا\u202Eabc🚚", 8);
    expect(value.startsWith("\u2068")).toBe(true);
    expect(value.endsWith("\u2069")).toBe(true);
    expect(value).toContain("مرحبا");
    expect(value).not.toContain("\u202E");
    expect(Array.from(safeSmsDisplayText("🚚".repeat(4), 2))).toContain("…");
    const longToken = safeSmsDisplayText("x".repeat(10_000), 240);
    expect(Array.from(longToken)).toHaveLength(243);
    expect(longToken).toContain("…");
  });

  it("round-trips only a valid E.164 route parameter", () => {
    const path = threadPath(PHONE);
    expect(decodePhoneParam(path.split("/").at(-1))).toBe(PHONE);
    expect(decodePhoneParam("%E0%A4%A")).toBe("");
    expect(decodePhoneParam("not-a-phone")).toBe("");
    expect(isSupportedSmsReplyPhone(PHONE)).toBe(true);
    expect(isSupportedSmsReplyPhone("+11552345678")).toBe(false);
    expect(isSupportedSmsReplyPhone("+15551234567")).toBe(false);
    expect(isSupportedSmsReplyPhone("+442071838750")).toBe(false);
  });

  it("does not turn unknown delivery states into delivered", () => {
    expect(deliveryVerdict("delivered")).toBe("delivered");
    expect(deliveryVerdict("sent")).toBe("sent");
    expect(deliveryVerdict("accepted")).toBe("accepted");
    expect(deliveryVerdict("queued")).toBe("queued");
    expect(deliveryVerdict("reconciliation_required")).toBe("reconciliation");
    expect(deliveryVerdict("undelivered")).toBe("failed");
    expect(deliveryVerdict("new_provider_state")).toBe("sending");
  });

  it("prefers a linked subscriber title and mints a PII-free bounded intent key", () => {
    expect(
      conversationTitle({
        phoneE164: PHONE,
        subscriberEmail: "ada@example.test",
      }),
    ).toBe("ada@example.test");
    const key = newSmsReplyIntentKey();
    expect(key.length).toBeLessThanOrEqual(255);
    expect(key).not.toContain(PHONE);
  });
});

describe("page merge and read projection", () => {
  it("does not merge conversation pages across response cutoffs or overlap", () => {
    const first = decodeSmsConversationsPage(
      conversationPage({
        nextCursor: "next",
        totalConversations: 2,
        activeTotal: 2,
        unreadTotal: 2,
        unknownTotal: 2,
      }),
      EXPECTED_QUERY,
    );
    const second = decodeSmsConversationsPage(
      conversationPage({
        conversations: [
          conversation({
            phoneE164: "+15552340000",
            lastMessageAt: "2026-08-20T09:00:00Z",
          }),
        ],
        totalConversations: 2,
        activeTotal: 2,
        unreadTotal: 2,
        unknownTotal: 2,
      }),
      EXPECTED_QUERY,
    );
    expect(
      mergeSmsConversationPages([first, second]).conversations,
    ).toHaveLength(2);
    expect(() => mergeSmsConversationPages([first, first])).toThrow(/overlap/u);
    expect(() =>
      mergeSmsConversationPages([
        { ...first, snapshotAt: "2026-08-21T11:00:00Z" },
        second,
      ]),
    ).toThrow(/another response cutoff/u);
    expect(() =>
      mergeSmsConversationPages([
        first,
        {
          ...second,
          tenantId: "99999999-9999-4999-8999-999999999999",
        },
      ]),
    ).toThrow(/another response cutoff/u);
    expect(() =>
      mergeSmsConversationPages([{ ...first, unknownTotal: 1 }, second]),
    ).toThrow(/another response cutoff/u);
    expect(() =>
      mergeSmsConversationPages([
        first,
        {
          ...second,
          query: { ...second.query, filter: "unknown" },
        },
      ]),
    ).toThrow(/another response cutoff/u);
  });

  it("clears one unread conversation, not N unread messages", () => {
    const page = decodeSmsConversationsPage(
      conversationPage({ conversations: [conversation({ unreadCount: 4 })] }),
      EXPECTED_QUERY,
    );
    const next = markConversationReadInPage(page, PHONE);
    expect(next?.conversations[0]?.unreadCount).toBe(0);
    expect(next?.conversations[0]?.oldestUnreadAt).toBeUndefined();
    expect(next?.unreadTotal).toBe(0);
    expect(markConversationReadInPage(next, PHONE)).toBe(next);
    expect(markConversationReadInPage(undefined, PHONE)).toBeUndefined();
  });
});

describe("reply failure certainty", () => {
  it("retires only exact pre-provider failures", () => {
    for (const code of [
      "sms_reply_dispatch_release_held",
      "sms_financial_reservation_unavailable",
      "consent_required",
      "list_selection_required",
      "reply_blocked",
    ]) {
      expect(isDefinitivePreProviderSmsReplyError({ code, status: 503 })).toBe(
        true,
      );
    }

    for (const code of [
      "idempotency_complete_failed",
      "reply_reconciliation_required",
      "reply_reconciliation_pending",
      "reply_intent_terminal",
      "unknown_server_failure",
    ]) {
      expect(isDefinitivePreProviderSmsReplyError({ code, status: 500 })).toBe(
        false,
      );
    }
    expect(
      isDefinitivePreProviderSmsReplyError(new Error("network lost")),
    ).toBe(false);
  });
});
