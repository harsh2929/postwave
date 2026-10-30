// SPDX-License-Identifier: AGPL-3.0-only
//
// Transport + wire contract for the SMS conversation lookup family: server
// search (POST, body-only query, snapshot-bound cursor), per-phone
// subscriber/consent context, the audited conversations CSV, and the
// filter/sort identity of the conversation list.
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMocks }));

import {
  exportSmsConversationsCsv,
  getSmsConversationContext,
  listSmsConversations,
  searchSmsConversations,
} from "@/lib/sms-api";
import {
  decodeSmsConversationContext,
  mergeSmsConversationSearchPages,
  parseSmsConversationsExportTruth,
  smsSearchQueryProblem,
} from "@/lib/sms-conversation-lookup-contract";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const PHONE_A = "+15552345678";
const PHONE_B = "+15553456789";
const LIST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SNAPSHOT = "2026-09-10T10:00:00Z";

function row(phone: string, lastMessageAt: string) {
  return {
    phoneE164: phone,
    identityAmbiguous: false,
    lastMessagePreview: "Where is my order?",
    lastMessageAt,
    lastDirection: "inbound",
    messageCount: 3,
    unreadCount: 1,
    oldestUnreadAt: lastMessageAt,
    subscriberEmail: "ada@example.test",
  };
}

const CONTEXT = {
  tenantId: TENANT,
  phoneE164: PHONE_A,
  subscriberEmail: "ada@example.test",
  consentStatus: "opted_in",
  consentSource: "form",
  consentAt: "2026-08-01T09:00:00Z",
  consentMixed: false,
  identityAmbiguous: false,
  consentEvidenceSufficient: true,
  subscribedLists: 1,
  firstSeenAt: "2026-07-01T09:00:00Z",
  totalMessages: 42,
  suppressed: false,
  suppressionReversible: false,
  hasInboundThread: true,
  eligibleLists: [
    {
      id: LIST,
      name: "VIP texts",
      description: "Early access",
      consentSource: "form",
      consentAt: "2026-08-01T09:00:00Z",
    },
  ],
  replyDispatchAvailable: false,
  replyDispatchUnavailableReason: "sms_reply_dispatch_release_held",
};

const CSV =
  "phone_e164,last_message_at,message_count,last_inbound_at\n" +
  "'+15552345678,2026-09-10T09:00:00Z,3,2026-09-10T09:00:00Z\n" +
  "'+15553456789,2026-09-09T09:00:00Z,1,\n";

function exportHeaders(overrides: Record<string, string | null> = {}) {
  const base: Record<string, string | null> = {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition":
      'attachment; filename="postwave-sms-conversations-20260910-100000.csv"',
    "X-Postwave-Export-Limit": "10000",
    "X-Postwave-Export-As-Of": "2026-09-10T10:00:00.123Z",
    "X-Postwave-Export-Row-Count": "2",
    "X-Postwave-Truncated": "false",
    ...overrides,
  };
  const headers = new Headers();
  for (const [key, value] of Object.entries(base)) {
    if (value !== null) headers.set(key, value);
  }
  return headers;
}

function stubCsv(body: string, headers: Headers) {
  apiMocks.get.mockImplementationOnce(
    async (
      _path: string,
      opts?: { onResponse?: (response: Response) => void },
    ) => {
      opts?.onResponse?.(new Response(null, { status: 200, headers }));
      return body;
    },
  );
}

beforeEach(() => {
  apiMocks.get.mockReset();
  apiMocks.post.mockReset();
});

describe("SMS conversation search transport", () => {
  it("POSTs the trimmed query in the body to the literal route, never the URL", async () => {
    apiMocks.post.mockResolvedValueOnce({
      tenantId: TENANT,
      conversations: [row(PHONE_A, "2026-09-10T09:00:00Z")],
      nextCursor: "v1.next",
      snapshotAt: SNAPSHOT,
    });
    const controller = new AbortController();
    const page = await searchSmsConversations({
      tenantId: TENANT,
      query: "  ada@example  ",
      limit: 50,
      signal: controller.signal,
    });
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/api/v1/sms/conversations/search",
      { query: "ada@example", limit: 50 },
      { idempotencyKey: null, requireOnline: true, signal: controller.signal },
    );
    expect(page.conversations.map((c) => c.phoneE164)).toEqual([PHONE_A]);
    expect(page.nextCursor).toBe("v1.next");
  });

  it("sends the opaque continuation cursor in the body for the next page", async () => {
    apiMocks.post.mockResolvedValueOnce({
      tenantId: TENANT,
      conversations: [],
      snapshotAt: SNAPSHOT,
    });
    await searchSmsConversations({
      tenantId: TENANT,
      query: "order",
      cursor: "v1.next",
    });
    expect(apiMocks.post.mock.calls[0]?.[1]).toEqual({
      query: "order",
      limit: 50,
      cursor: "v1.next",
    });
  });

  it("refuses a query below the server's 3-character floor without a request", () => {
    expect(() =>
      searchSmsConversations({ tenantId: TENANT, query: "ad" }),
    ).toThrow("Type at least 3 characters to search.");
    expect(smsSearchQueryProblem("abc")).toBeNull();
    expect(smsSearchQueryProblem("ab\u200bc")).toMatch(/hidden or control/u);
    expect(apiMocks.post).not.toHaveBeenCalled();
  });

  it("fails closed on another tenant, disorder, or a changed search window", async () => {
    apiMocks.post.mockResolvedValueOnce({
      tenantId: OTHER_TENANT,
      conversations: [],
      snapshotAt: SNAPSHOT,
    });
    await expect(
      searchSmsConversations({ tenantId: TENANT, query: "order" }),
    ).rejects.toThrow(/another tenant/u);
    apiMocks.post.mockResolvedValueOnce({
      tenantId: TENANT,
      conversations: [
        row(PHONE_A, "2026-09-09T09:00:00Z"),
        row(PHONE_B, "2026-09-10T09:00:00Z"),
      ],
      snapshotAt: SNAPSHOT,
    });
    await expect(
      searchSmsConversations({ tenantId: TENANT, query: "order" }),
    ).rejects.toThrow(/out of order/u);
    expect(() =>
      mergeSmsConversationSearchPages([
        { tenantId: TENANT, conversations: [], snapshotAt: SNAPSHOT, nextCursor: "c" },
        { tenantId: TENANT, conversations: [], snapshotAt: "2026-09-10T11:00:00Z" },
      ]),
    ).toThrow(/search window changed/u);
  });
});

describe("SMS conversation context transport", () => {
  it("GETs the encoded phone's context and binds it to tenant + phone", async () => {
    apiMocks.get.mockResolvedValueOnce(CONTEXT);
    const context = await getSmsConversationContext({
      tenantId: TENANT,
      phoneE164: PHONE_A,
    });
    expect(apiMocks.get).toHaveBeenCalledWith(
      "/api/v1/sms/conversations/%2B15552345678/context",
      undefined,
    );
    expect(context.eligibleLists[0]?.name).toBe("VIP texts");
    expect(context.replyDispatchUnavailableReason).toBe(
      "sms_reply_dispatch_release_held",
    );
  });

  it("refuses a context for another phone or with contradictory consent", () => {
    expect(() =>
      decodeSmsConversationContext(CONTEXT, {
        tenantId: TENANT,
        phoneE164: PHONE_B,
      }),
    ).toThrow(/another phone/u);
    expect(() =>
      decodeSmsConversationContext(
        { ...CONTEXT, subscribedLists: 2 },
        { tenantId: TENANT, phoneE164: PHONE_A },
      ),
    ).toThrow(/contradict/u);
    expect(() =>
      decodeSmsConversationContext(
        { ...CONTEXT, suppressed: true },
        { tenantId: TENANT, phoneE164: PHONE_A },
      ),
    ).toThrow(/contradict/u);
  });
});

describe("SMS conversations CSV export transport", () => {
  it("sends the audit reason header once and returns the verified body with server truth", async () => {
    stubCsv(CSV, exportHeaders());
    const result = await exportSmsConversationsCsv({
      auditReason: "  Quarterly review  ",
    });
    expect(apiMocks.get).toHaveBeenCalledTimes(1);
    const [path, opts] = apiMocks.get.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/api/v1/sms/conversations.csv");
    expect(opts.headers).toEqual({
      Accept: "text/csv",
      "X-Postwave-Audit-Reason": "Quarterly review",
    });
    expect(opts.maxAttempts).toBe(1);
    expect(opts.requireOnline).toBe(true);
    expect(result.csv).toBe(CSV);
    expect(result.filename).toBe(
      "postwave-sms-conversations-20260910-100000.csv",
    );
    expect(result.truth).toEqual({
      limit: 10000,
      asOf: "2026-09-10T10:00:00.123Z",
      rowCount: 2,
      truncated: false,
    });
  });

  it("refuses a missing reason without a request", async () => {
    await expect(
      exportSmsConversationsCsv({ auditReason: "   " }),
    ).rejects.toThrow("Enter an audit reason for this export.");
    expect(apiMocks.get).not.toHaveBeenCalled();
  });

  it("refuses a file whose truth headers are missing or disagree with the body", async () => {
    stubCsv(CSV, exportHeaders({ "X-Postwave-Export-Row-Count": null }));
    await expect(
      exportSmsConversationsCsv({ auditReason: "Review" }),
    ).rejects.toThrow(/omitted or contradicted/u);
    stubCsv(CSV, exportHeaders({ "X-Postwave-Export-Row-Count": "3" }));
    await expect(
      exportSmsConversationsCsv({ auditReason: "Review" }),
    ).rejects.toThrow(/did not match/u);
    expect(
      parseSmsConversationsExportTruth(
        exportHeaders({ "X-Postwave-Truncated": "true" }),
      ),
    ).toBeNull();
  });

  it("falls back to a dated name when the server filename is not a plain .csv", async () => {
    stubCsv(
      CSV,
      exportHeaders({
        "Content-Disposition": 'attachment; filename="../../evil.sh"',
      }),
    );
    const result = await exportSmsConversationsCsv({ auditReason: "Review" });
    expect(result.filename).toBe("postwave-sms-conversations-2026-09-10.csv");
  });
});

describe("SMS conversation list filter + sort identity", () => {
  it("puts the chosen filter and sort on the list query", async () => {
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
    await listSmsConversations({
      tenantId: TENANT,
      filter: "unread",
      sort: "oldest_unread",
      status: "active",
      limit: 50,
    });
    expect(apiMocks.get).toHaveBeenCalledWith(
      "/api/v1/sms/conversations?filter=unread&sort=oldest_unread&status=active&limit=50",
      undefined,
    );
  });
});
