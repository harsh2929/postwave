import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  archiveConversation,
  assignConversation,
  getConversationContext,
  listConversationMessages,
  listConversations,
  listSmsSenders,
  markConversationRead,
  replyToConversation,
  setSmsSenderPaused,
  smsSnoozeUntilError,
  snoozeConversation,
  unarchiveConversation,
  unsnoozeConversation,
} from "./smsInbox";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

const TENANT = "11111111-1111-4111-8111-111111111111";
const PHONE = "+15552345678";
const SNAPSHOT = "2026-08-21T10:00:00Z";
const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const SENDER = "44444444-4444-4444-8444-444444444444";
const LIST = "55555555-5555-4555-8555-555555555555";
const REPLY_MESSAGE = "77777777-7777-4777-8777-777777777777";

function message() {
  return {
    id: MESSAGE_ID,
    tenant_id: TENANT,
    sender_profile_id: SENDER,
    phone_e164: PHONE,
    provider: "twilio",
    provider_message_id: "SM1",
    direction: "outbound",
    body: "On its way",
    segments: 1,
    status: "accepted",
    cost_micros: 7900,
    created_at: "2026-08-21T09:00:00Z",
  };
}

function replyMessage() {
  return {
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
  };
}

beforeEach(() => {
  rawRequest.mockReset();
});

describe("SMS inbox request shaping", () => {
  it("binds the opaque cursor to an explicit filter/status/limit request", async () => {
    rawRequest.mockResolvedValue({
      data: {
        tenantId: TENANT,
        conversations: [],
        snapshotAt: SNAPSHOT,
        unreadTotal: 0,
        unknownTotal: 0,
        totalConversations: 0,
        activeTotal: 0,
        snoozedTotal: 0,
        archivedTotal: 0,
      },
      error: null,
    });
    const signal = new AbortController().signal;
    await listConversations({
      tenantId: TENANT,
      filter: "unread",
      sort: "oldest_unread",
      status: "archived",
      limit: 25,
      cursor: "opaque-cursor",
      signal,
    });
    const path = String(rawRequest.mock.calls[0]?.[1]);
    expect(path).toContain("filter=unread");
    expect(path).toContain("sort=oldest_unread");
    expect(path).toContain("status=archived");
    expect(path).toContain("limit=25");
    expect(path).toContain("cursor=opaque-cursor");
    expect(rawRequest.mock.calls[0]?.[3]).toMatchObject({ signal });
    expect(path).not.toContain("before_at");
  });

  it("passes tenant and phone into the strict messages decoder", async () => {
    rawRequest.mockResolvedValue({
      data: { tenantId: TENANT, messages: [message()], snapshotAt: SNAPSHOT },
      error: null,
    });
    await expect(
      listConversationMessages({ phoneE164: PHONE, tenantId: TENANT }),
    ).resolves.toMatchObject({
      messages: [{ tenantId: TENANT, phoneE164: PHONE }],
    });

    rawRequest.mockResolvedValue({
      data: {
        tenantId: TENANT,
        messages: [
          {
            ...message(),
            tenant_id: "99999999-9999-4999-8999-999999999999",
          },
        ],
        snapshotAt: SNAPSHOT,
      },
      error: null,
    });
    await expect(
      listConversationMessages({ phoneE164: PHONE, tenantId: TENANT }),
    ).rejects.toThrow(/another tenant/u);
  });

  it("strictly decodes context and sender tenant identity", async () => {
    rawRequest
      .mockResolvedValueOnce({
        data: {
          tenantId: TENANT,
          phoneE164: PHONE,
          consentStatus: "opted_in",
          subscribedLists: 1,
          totalMessages: 2,
          suppressed: false,
          suppressionReversible: false,
          hasInboundThread: true,
          consentMixed: false,
          identityAmbiguous: false,
          consentEvidenceSufficient: true,
          replyDispatchAvailable: true,
          eligibleLists: [
            { id: LIST, name: "Updates", description: "Transactional" },
          ],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          tenantId: TENANT,
          items: [
            {
              id: SENDER,
              tenant_id: TENANT,
              provider: "twilio",
              country: "US",
              sender_type: "10dlc",
              registration_status: "approved",
              metadata: {},
              created_at: "2026-08-20T08:00:00Z",
              updated_at: "2026-08-21T08:00:00Z",
            },
          ],
        },
        error: null,
      });
    await expect(
      getConversationContext({ phoneE164: PHONE, tenantId: TENANT }),
    ).resolves.toMatchObject({
      eligibleLists: [{ id: LIST }],
    });
    await expect(listSmsSenders({ tenantId: TENANT })).resolves.toMatchObject([
      { tenantId: TENANT, paused: false },
    ]);
  });

  it("marks only the exact decoded inbound UUID boundary", async () => {
    rawRequest.mockResolvedValue({
      data: { ok: true, applied: 1 },
      error: null,
    });
    const signal = new AbortController().signal;
    await expect(
      markConversationRead({
        phoneE164: PHONE,
        messageIds: [MESSAGE_ID],
        signal,
      }),
    ).resolves.toEqual({ ok: true, applied: 1 });
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/sms/conversations/%2B15552345678/mark-read",
      { message_ids: [MESSAGE_ID] },
      { signal },
    );
    expect(JSON.stringify(rawRequest.mock.calls[0])).not.toMatch(
      /snapshot|now|before/u,
    );
  });

  it("rejects an invalid read boundary before the network", async () => {
    await expect(
      markConversationRead({
        phoneE164: PHONE,
        messageIds: [MESSAGE_ID, MESSAGE_ID],
      }),
    ).rejects.toThrow(/duplicate/u);
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it.each(["+11552345678", "+15551234567"])(
    "rejects non-NXX NANP phone %s before transport",
    async (phoneE164) => {
      await expect(
        listConversationMessages({ phoneE164, tenantId: TENANT }),
      ).rejects.toThrow(/US\/Canada/u);
      expect(rawRequest).not.toHaveBeenCalled();
    },
  );

  it("rejects an expanded mark-read receipt instead of accepting wire drift", async () => {
    rawRequest.mockResolvedValue({
      data: { ok: true, applied: 1, swept_at: SNAPSHOT },
      error: null,
    });
    await expect(
      markConversationRead({ phoneE164: PHONE, messageIds: [MESSAGE_ID] }),
    ).rejects.toThrow(/invalid receipt/u);
  });
});

describe("reply safety", () => {
  it("sends the exact sender/list/body with one stable Idempotency-Key", async () => {
    rawRequest.mockResolvedValue({
      data: {
        disposition: "persisted",
        message: replyMessage(),
        providerReceipt: {
          provider: "twilio",
          providerMessageId: "SM1",
          status: "accepted",
        },
      },
      error: null,
    });
    const signal = new AbortController().signal;
    await replyToConversation({
      phoneE164: PHONE,
      tenantId: TENANT,
      senderProfileId: SENDER,
      listId: LIST,
      body: " On its way ",
      idempotencyKey: "mobile-reply-intent-1",
      signal,
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/sms/conversations/%2B15552345678/reply",
      { sender_profile_id: SENDER, list_id: LIST, body: "On its way" },
      { idempotencyKey: "mobile-reply-intent-1", signal },
    );
  });

  it.each([
    ["unsupported country", { phoneE164: "+442071838750" }],
    ["missing sender", { senderProfileId: "" }],
    ["missing consent list", { listId: "" }],
    ["empty body", { body: "   " }],
    ["NUL body", { body: "bad\u0000body" }],
    ["invalid Unicode scalar", { body: "\ud800" }],
    ["product body limit", { body: "🚚".repeat(1_601) }],
    ["control-bearing key", { idempotencyKey: "bad\nkey" }],
  ])("fails %s before any network send", async (_label, override) => {
    await expect(
      replyToConversation({
        phoneE164: PHONE,
        tenantId: TENANT,
        senderProfileId: SENDER,
        listId: LIST,
        body: "Hello",
        idempotencyKey: "intent-1",
        ...override,
      }),
    ).rejects.toThrow();
    expect(rawRequest).not.toHaveBeenCalled();
  });
});

/**
 * Conversation lifecycle (snooze / archive / assign).
 *
 * The inbox has always rendered Snoozed and Archived filters with live server
 * counts and had no verb to move a row into either. These pin the request
 * SHAPES against the handler's own contract (inbox_extras.go:54-58, 86-137) and
 * the receipt check, which is the part that decides whether the screen is
 * allowed to say the change happened.
 */
describe("SMS conversation lifecycle writes", () => {
  const OK = { ok: true, tenantId: TENANT, phoneE164: PHONE };
  const OTHER_USER = "66666666-6666-4666-8666-666666666666";

  it("sends an RFC3339 deadline for a snooze and returns the checked receipt", async () => {
    rawRequest.mockResolvedValueOnce({ data: OK });
    const until = new Date(Date.now() + 3_600_000).toISOString();

    const receipt = await snoozeConversation({
      phoneE164: PHONE,
      tenantId: TENANT,
      until,
    });

    expect(receipt).toEqual(OK);
    const [method, path, body] = rawRequest.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(method).toBe("POST");
    expect(path).toBe(
      `/api/v1/sms/conversations/${encodeURIComponent(PHONE)}/snooze`,
    );
    expect(body).toEqual({ until });
  });

  it("refuses a snooze the handler could only reject, without sending it", async () => {
    await expect(
      snoozeConversation({
        phoneE164: PHONE,
        tenantId: TENANT,
        until: new Date(Date.now() - 1_000).toISOString(),
      }),
    ).rejects.toThrow(/future/iu);
    await expect(
      snoozeConversation({
        phoneE164: PHONE,
        tenantId: TENANT,
        until: new Date(Date.now() + 400 * 24 * 3_600_000).toISOString(),
      }),
    ).rejects.toThrow(/366 days/iu);
    await expect(
      snoozeConversation({
        phoneE164: PHONE,
        tenantId: TENANT,
        until: "not a date",
      }),
    ).rejects.toThrow(/valid date/iu);
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it("mirrors the handler's own bounds in smsSnoozeUntilError", () => {
    const now = Date.UTC(2026, 7, 27, 12, 0, 0);
    expect(smsSnoozeUntilError(new Date(now + 1).toISOString(), now)).toBeNull();
    expect(smsSnoozeUntilError(new Date(now).toISOString(), now)).not.toBeNull();
    expect(
      smsSnoozeUntilError(
        new Date(now + 366 * 24 * 3_600_000).toISOString(),
        now,
      ),
    ).toBeNull();
    expect(
      smsSnoozeUntilError(
        new Date(now + 366 * 24 * 3_600_000 + 1).toISOString(),
        now,
      ),
    ).not.toBeNull();
  });

  it("sends no body at all for the three empty-body verbs", async () => {
    for (const [verb, run] of [
      ["unsnooze", unsnoozeConversation],
      ["archive", archiveConversation],
      ["unarchive", unarchiveConversation],
    ] as const) {
      rawRequest.mockReset();
      rawRequest.mockResolvedValueOnce({ data: OK });
      await run({ phoneE164: PHONE, tenantId: TENANT });
      const [method, path, body] = rawRequest.mock.calls[0] as [
        string,
        string,
        unknown,
      ];
      expect(method).toBe("POST");
      expect(path).toBe(
        `/api/v1/sms/conversations/${encodeURIComponent(PHONE)}/${verb}`,
      );
      expect(body).toBeUndefined();
    }
  });

  it("assigns with a canonical uuid and unassigns with an empty userId", async () => {
    rawRequest.mockResolvedValueOnce({ data: OK });
    await assignConversation({
      phoneE164: PHONE,
      tenantId: TENANT,
      userId: OTHER_USER,
    });
    expect(rawRequest.mock.calls[0]?.[2]).toEqual({ userId: OTHER_USER });

    rawRequest.mockReset();
    rawRequest.mockResolvedValueOnce({ data: OK });
    await assignConversation({
      phoneE164: PHONE,
      tenantId: TENANT,
      userId: null,
    });
    expect(rawRequest.mock.calls[0]?.[2]).toEqual({ userId: "" });
  });

  it("refuses an assignee that is not a canonical uuid rather than sending it", async () => {
    await expect(
      assignConversation({
        phoneE164: PHONE,
        tenantId: TENANT,
        userId: "sam@example.test",
      }),
    ).rejects.toThrow(/UUIDv4/u);
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it("rejects a receipt acknowledged for another tenant, number, or shape", async () => {
    for (const bad of [
      { ok: true, tenantId: SENDER, phoneE164: PHONE },
      { ok: true, tenantId: TENANT, phoneE164: "+15559998888" },
      { ok: false, tenantId: TENANT, phoneE164: PHONE },
      { ok: true, tenantId: TENANT, phoneE164: PHONE, applied: 1 },
      [OK],
    ]) {
      rawRequest.mockReset();
      rawRequest.mockResolvedValueOnce({ data: bad });
      await expect(
        archiveConversation({ phoneE164: PHONE, tenantId: TENANT }),
      ).rejects.toThrow(/invalid receipt/iu);
    }
  });
});

/**
 * Sender pause / resume — `ScopeAdmin`, handlers.go:152-153, not release-held.
 *
 * The riskiest failure is a 200 that did not change anything being painted as
 * "paused": an operator who believes a number has stopped sending will stop
 * looking for the reason it has not.
 */
describe("SMS sender pause", () => {
  function senderProfile(over: Record<string, unknown> = {}) {
    return {
      id: SENDER,
      tenant_id: TENANT,
      provider: "twilio",
      country: "US",
      sender_type: "long_code",
      registration_status: "approved",
      created_at: "2026-08-21T09:00:00Z",
      updated_at: "2026-08-21T09:05:00Z",
      ...over,
    };
  }

  it("posts to /pause and confirms the sender came back paused", async () => {
    rawRequest.mockResolvedValueOnce({
      data: senderProfile({ metadata: { sending: { paused: true } } }),
    });

    const out = await setSmsSenderPaused({
      senderId: SENDER,
      tenantId: TENANT,
      paused: true,
      reason: "carrier complaint",
    });

    expect(out).toEqual({ id: SENDER, paused: true });
    const [method, path, body] = rawRequest.mock.calls[0] as [
      string,
      string,
      unknown,
    ];
    expect(method).toBe("POST");
    expect(path).toBe(`/api/v1/sms/senders/${SENDER}/pause`);
    expect(body).toEqual({ reason: "carrier complaint" });
  });

  it("posts to /resume and confirms the sender is no longer paused", async () => {
    rawRequest.mockResolvedValueOnce({
      data: senderProfile({ metadata: { sending: { paused: false } } }),
    });

    const out = await setSmsSenderPaused({
      senderId: SENDER,
      tenantId: TENANT,
      paused: false,
    });

    expect(out).toEqual({ id: SENDER, paused: false });
    expect(rawRequest.mock.calls[0]?.[1]).toBe(
      `/api/v1/sms/senders/${SENDER}/resume`,
    );
    expect(rawRequest.mock.calls[0]?.[2]).toEqual({});
  });

  it("reads the legacy top-level metadata.paused flag the list decoder also honours", async () => {
    rawRequest.mockResolvedValueOnce({
      data: senderProfile({ metadata: { paused: true } }),
    });
    await expect(
      setSmsSenderPaused({ senderId: SENDER, tenantId: TENANT, paused: true }),
    ).resolves.toEqual({ id: SENDER, paused: true });
  });

  it("fails rather than claiming a pause the server did not report", async () => {
    rawRequest.mockResolvedValueOnce({
      data: senderProfile({ metadata: { sending: { paused: false } } }),
    });
    await expect(
      setSmsSenderPaused({ senderId: SENDER, tenantId: TENANT, paused: true }),
    ).rejects.toThrow(/did not report this sender as paused/iu);
  });

  it("refuses a profile belonging to another sender or another workspace", async () => {
    rawRequest.mockResolvedValueOnce({
      data: senderProfile({ id: LIST, metadata: { sending: { paused: true } } }),
    });
    await expect(
      setSmsSenderPaused({ senderId: SENDER, tenantId: TENANT, paused: true }),
    ).rejects.toThrow(/different sender profile/iu);

    rawRequest.mockReset();
    rawRequest.mockResolvedValueOnce({
      data: senderProfile({
        tenant_id: LIST,
        metadata: { sending: { paused: true } },
      }),
    });
    await expect(
      setSmsSenderPaused({ senderId: SENDER, tenantId: TENANT, paused: true }),
    ).rejects.toThrow(/another workspace/iu);
  });
});
