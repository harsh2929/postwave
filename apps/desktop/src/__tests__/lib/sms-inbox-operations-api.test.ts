import { describe, expect, it } from "vitest";

import { api } from "../../lib/api-client";
import type { ApiResult } from "../../lib/api/result";
import {
  createSmsInboxOperationsMethods,
  type SmsInboxOperationsDependencies,
  type SmsInboxRequester,
  type SmsInboxRequestOptions,
} from "../../lib/api/sms-inbox-operations";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: SmsInboxRequestOptions | undefined;
}

const METHOD_NAMES = [
  "listSMSConversations",
  "listSMSConversationMessages",
  "replySMSConversation",
  "markSMSConversationRead",
  "getSMSConversationContext",
  "snoozeSMSConversation",
  "unsnoozeSMSConversation",
  "archiveSMSConversation",
  "unarchiveSMSConversation",
  "assignSMSConversation",
  "setSMSConversationNotes",
  "listSMSConversationTags",
  "addSMSConversationTag",
  "removeSMSConversationTag",
  "getSMSConversationActivity",
  "bulkSMSConversationAction",
  "searchSMSConversations",
  "smsConversationsCsvUrl",
  "listSMSQuickReplies",
  "createSMSQuickReply",
  "updateSMSQuickReply",
  "deleteSMSQuickReply",
  "recordSMSQuickReplyUse",
  "listSMSSenders",
] as const;

const METHOD_NAME_SET = new Set<string>(METHOD_NAMES);

function createHarness(responses: ApiResult<unknown>[] = []) {
  const calls: RequestCall[] = [];
  const state = { apiUrlReads: 0 };
  const queuedResponses = [...responses];

  const request: SmsInboxRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: SmsInboxRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (queuedResponses.shift() ?? { data: {} }) as ApiResult<T>;
  };

  const dependencies: SmsInboxOperationsDependencies = {
    request,
    getTenantId: () => "11111111-1111-4111-8111-111111111111",
    getApiUrl: () => {
      state.apiUrlReads += 1;
      return "https://api.example.test";
    },
  };

  return {
    calls,
    methods: createSmsInboxOperationsMethods(dependencies),
    state,
  };
}

describe("SMS inbox operations API extraction contracts", () => {
  it("retains the exact ordered 24-method inventory without eager work", () => {
    const { calls, methods, state } = createHarness();

    expect(Object.keys(methods)).toEqual(METHOD_NAMES);
    expect(
      Object.keys(api).filter((name) => METHOD_NAME_SET.has(name)),
    ).toEqual(METHOD_NAMES);
    for (const name of METHOD_NAMES) {
      expect(typeof methods[name]).toBe("function");
      expect(methods[name].name).toBe(name);
      expect(typeof api[name]).toBe("function");
      expect(api[name].name).toBe(name);
    }
    expect(calls).toEqual([]);
    expect(state.apiUrlReads).toBe(0);
  });

  it("preserves thread listing, messages, reply safety, read state, and context", async () => {
    const { calls, methods } = createHarness();
    const phone = "+1 555/0100";
    const reply = {
      sender_profile_id: "sender/one",
      body: "Hello Ada",
      media_url: "https://cdn.example.test/image one.png",
      list_id: "list/one",
    };

    await methods.listSMSConversations({
      cursor: "v1.list-cursor",
      limit: 25,
      filter: "unread",
      sort: "oldest_unread",
      status: "archived",
      tag: "high value",
    });
    await methods.listSMSConversationMessages(phone, {
      cursor: "v1.message-cursor",
      limit: 50,
    });
    await methods.replySMSConversation(phone, reply, "reply-key-1");
    await methods.markSMSConversationRead(phone, [
      "22222222-2222-4222-8222-222222222222",
    ]);
    await methods.getSMSConversationContext(phone);

    const thread = "/api/v1/sms/conversations/%2B1%20555%2F0100";
    expect(calls).toEqual([
      {
        path: "/api/v1/sms/conversations?cursor=v1.list-cursor&limit=25&filter=unread&sort=oldest_unread&status=archived&tag=high+value",
        init: undefined,
        opts: undefined,
      },
      {
        path: `${thread}/messages?cursor=v1.message-cursor&limit=50`,
        init: undefined,
        opts: undefined,
      },
      {
        path: `${thread}/reply`,
        init: {
          method: "POST",
          headers: { "Idempotency-Key": "reply-key-1" },
          body: JSON.stringify(reply),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: `${thread}/mark-read`,
        init: {
          method: "POST",
          body: JSON.stringify({
            message_ids: ["22222222-2222-4222-8222-222222222222"],
          }),
        },
        opts: undefined,
      },
      { path: `${thread}/context`, init: undefined, opts: undefined },
    ]);
  });

  it("preserves snooze, archive, assignment, and notes lifecycle transports", async () => {
    const { calls, methods } = createHarness();
    const phone = "+15550100";

    await methods.snoozeSMSConversation(phone, "2026-07-17T08:00:00Z");
    await methods.unsnoozeSMSConversation(phone);
    await methods.archiveSMSConversation(phone);
    await methods.unarchiveSMSConversation(phone);
    await methods.assignSMSConversation(phone, "user/one");
    await methods.setSMSConversationNotes(phone, "Priority / follow-up");

    const thread = "/api/v1/sms/conversations/%2B15550100";
    expect(calls).toEqual([
      {
        path: `${thread}/snooze`,
        init: {
          method: "POST",
          body: JSON.stringify({
            until: "2026-07-17T08:00:00Z",
            expectedUpdatedAt: null,
          }),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: `${thread}/unsnooze`,
        init: {
          method: "POST",
          body: JSON.stringify({ expectedUpdatedAt: null }),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: `${thread}/archive`,
        init: {
          method: "POST",
          body: JSON.stringify({ expectedUpdatedAt: null }),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: `${thread}/unarchive`,
        init: {
          method: "POST",
          body: JSON.stringify({ expectedUpdatedAt: null }),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: `${thread}/assign`,
        init: {
          method: "POST",
          body: JSON.stringify({
            userId: "user/one",
            expectedUpdatedAt: null,
          }),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: `${thread}/notes`,
        init: {
          method: "POST",
          body: JSON.stringify({
            notes: "Priority / follow-up",
            expectedUpdatedAt: null,
          }),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
    ]);
  });

  it("preserves tags, activity, bulk action, search, and CSV transports", async () => {
    const { calls, methods, state } = createHarness();
    const phone = "+15550100";
    const bulkInput = {
      phones: [phone, "+15550101"],
      action: "snooze" as const,
      until: "2026-07-17T08:00:00Z",
    };

    await methods.listSMSConversationTags(phone);
    await methods.addSMSConversationTag(phone, "priority/vip");
    await methods.removeSMSConversationTag(phone, "priority/vip");
    await methods.getSMSConversationActivity(phone);
    await methods.bulkSMSConversationAction(bulkInput);
    await methods.searchSMSConversations({
      query: "invoice paid/urgent",
      limit: 75,
    });
    expect(methods.smsConversationsCsvUrl()).toBe(
      "https://api.example.test/api/v1/sms/conversations.csv",
    );

    const thread = "/api/v1/sms/conversations/%2B15550100";
    expect(state.apiUrlReads).toBe(1);
    expect(calls).toEqual([
      { path: `${thread}/tags`, init: undefined, opts: undefined },
      {
        path: `${thread}/tags`,
        init: {
          method: "POST",
          body: JSON.stringify({ tag: "priority/vip", expectedAbsent: true }),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: `${thread}/tags`,
        init: {
          method: "DELETE",
          body: JSON.stringify({
            tag: "priority/vip",
            expectedCreatedAt: "",
          }),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      { path: `${thread}/activity`, init: undefined, opts: undefined },
      {
        path: "/api/v1/sms/conversations/bulk",
        init: {
          method: "POST",
          body: JSON.stringify({
            conversations: bulkInput.phones.map((phoneE164) => ({
              phoneE164,
              expectedUpdatedAt: null,
            })),
            action: bulkInput.action,
            until: bulkInput.until,
          }),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: "/api/v1/sms/conversations/search",
        init: {
          method: "POST",
          body: JSON.stringify({ query: "invoice paid/urgent", limit: 75 }),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
    ]);
  });

  it("strictly binds conversation-tag reads and mutations", async () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const phone = "+14155550100";
    const createdAt = "2026-08-21T10:00:00Z";
    const valid = createHarness([
      {
        data: {
          tenantId,
          phoneE164: phone,
          tags: [{ tag: "priority", createdAt }],
          snapshotAt: "2026-08-21T10:01:00Z",
          truncated: false,
        },
      },
      {
        data: {
          ok: true,
          tenantId,
          phoneE164: phone,
          tag: "priority",
          createdAt,
          action: "add",
        },
      },
      {
        data: {
          ok: true,
          tenantId,
          phoneE164: phone,
          tag: "priority",
          createdAt,
          action: "remove",
        },
      },
    ]);
    await expect(
      valid.methods.listSMSConversationTags(phone),
    ).resolves.toMatchObject({ data: { tenantId, phoneE164: phone } });
    await expect(
      valid.methods.addSMSConversationTag(phone, "priority"),
    ).resolves.toMatchObject({ data: { ok: true, createdAt } });
    await expect(
      valid.methods.removeSMSConversationTag(phone, "priority", createdAt),
    ).resolves.toMatchObject({ data: { ok: true } });

    for (const poisoned of [
      {
        tenantId,
        phoneE164: phone,
        tags: [{ tag: "safe\u202Etxt", createdAt }],
        snapshotAt: createdAt,
        truncated: false,
      },
      {
        tenantId: "22222222-2222-4222-8222-222222222222",
        phoneE164: phone,
        tags: [],
        snapshotAt: createdAt,
        truncated: false,
      },
      {
        tenantId,
        phoneE164: phone,
        tags: [
          { tag: "b", createdAt },
          { tag: "a", createdAt },
        ],
        snapshotAt: createdAt,
        truncated: false,
      },
    ]) {
      const harness = createHarness([{ data: poisoned }]);
      const response = await harness.methods.listSMSConversationTags(phone);
      expect(response.error?.code).toBe("invalid_sms_inbox_response");
      expect(response.data).toBeUndefined();
    }
  });

  it("preserves quick-reply CRUD, usage recording, and sender listing", async () => {
    const { calls, methods } = createHarness();
    const createInput = { label: "Welcome", body: "Welcome aboard" };
    const updateInput = { label: "Warm welcome", body: "Glad you're here" };
    const abort = new AbortController();

    await methods.listSMSQuickReplies();
    await methods.createSMSQuickReply(createInput);
    await methods.updateSMSQuickReply("reply/one", updateInput);
    await methods.deleteSMSQuickReply("reply/one");
    await methods.recordSMSQuickReplyUse("reply/one");
    await methods.listSMSSenders({ signal: abort.signal });

    expect(calls).toEqual([
      { path: "/api/v1/sms/quick-replies", init: undefined, opts: undefined },
      {
        path: "/api/v1/sms/quick-replies",
        init: { method: "POST", body: JSON.stringify(createInput) },
        opts: undefined,
      },
      {
        path: "/api/v1/sms/quick-replies/reply%2Fone",
        init: { method: "PATCH", body: JSON.stringify(updateInput) },
        opts: undefined,
      },
      {
        path: "/api/v1/sms/quick-replies/reply%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/sms/quick-replies/reply%2Fone/use",
        init: { method: "POST" },
        opts: undefined,
      },
      {
        path: "/api/v1/sms/senders",
        init: undefined,
        opts: { signal: abort.signal },
      },
    ]);
  });

  it("retains default-query elision and passes request errors through unchanged", async () => {
    const expectedError = {
      error: { kind: "http" as const, status: 503, message: "Unavailable" },
    };
    const { calls, methods } = createHarness([expectedError]);

    await expect(
      methods.listSMSConversations({
        limit: 0,
        filter: "all",
        sort: "recent",
        status: "active",
      }),
    ).resolves.toBe(expectedError);
    await methods.listSMSConversationMessages("+15550100", { limit: 0 });
    await methods.searchSMSConversations({ query: "Ada" });

    expect(calls.map(({ path }) => path)).toEqual([
      "/api/v1/sms/conversations",
      "/api/v1/sms/conversations/%2B15550100/messages",
      "/api/v1/sms/conversations/search",
    ]);
  });

  it("decodes message evidence at the exact byte/rune boundary without truncation", async () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const phone = "+12025550118";
    const envelope = (
      body: string,
      body_omitted_reason?:
        | "body_exceeds_inbox_limit"
        | "legacy_body_unavailable",
    ) => ({
      data: {
        tenantId,
        messages: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            tenant_id: tenantId,
            phone_e164: phone,
            provider: "twilio",
            direction: "inbound",
            body,
            ...(body_omitted_reason ? { body_omitted_reason } : {}),
            segments: 1,
            status: "received",
            cost_micros: 0,
            created_at: "2026-08-21T12:00:00Z",
          },
        ],
        snapshotAt: "2026-08-21T12:00:00Z",
      },
    });
    const decode = async (
      response: ApiResult<unknown>,
    ): Promise<ApiResult<unknown>> => {
      const { methods } = createHarness([response]);
      return methods.listSMSConversationMessages(phone, { limit: 1 });
    };

    await expect(decode(envelope("x".repeat(4_800)))).resolves.toMatchObject({
      data: { messages: [{ body: "x".repeat(4_800) }] },
    });
    await expect(decode(envelope("🧑".repeat(4_096)))).resolves.toMatchObject({
      data: { messages: [{ body: "🧑".repeat(4_096) }] },
    });
    await expect(
      decode(envelope("", "body_exceeds_inbox_limit")),
    ).resolves.toMatchObject({
      data: {
        messages: [
          { body: "", body_omitted_reason: "body_exceeds_inbox_limit" },
        ],
      },
    });
    await expect(
      decode(envelope("", "legacy_body_unavailable")),
    ).resolves.toMatchObject({
      data: {
        messages: [
          { body: "", body_omitted_reason: "legacy_body_unavailable" },
        ],
      },
    });

    for (const invalid of [
      envelope(""),
      envelope(" \t\n"),
      envelope("x".repeat(4_801)),
      envelope("🧑".repeat(4_097)),
      envelope("synthetic\u0000body"),
      envelope("invented truncation", "body_exceeds_inbox_limit"),
      envelope("invented legacy content", "legacy_body_unavailable"),
    ]) {
      await expect(decode(invalid)).resolves.toMatchObject({
        error: { code: "invalid_sms_inbox_response" },
      });
    }
  });
});
