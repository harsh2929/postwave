import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  delete: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: apiMocks }));

import {
  addSmsConversationTag,
  archiveSmsConversation,
  bulkMutateSmsConversations,
  getSmsConversationActivity,
  listSmsConversationTags,
  removeSmsConversationTag,
  snoozeSmsConversation,
} from "@/lib/sms-api";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const PHONE = "+14155550100";
const PHONE_TWO = "+14155550101";
const VERSION = "2026-08-29T10:00:00.123456Z";
const NEXT_VERSION = "2026-08-29T10:01:00.123456Z";
const UNTIL = "2027-01-02T10:00:00Z";

function stateReceipt(
  phoneE164 = PHONE,
  action = "archive",
  over: Record<string, unknown> = {},
) {
  return {
    ok: true,
    tenantId: TENANT,
    phoneE164,
    action,
    archivedAt: "2026-08-29T10:00:59Z",
    stateUpdatedAt: NEXT_VERSION,
    ...over,
  };
}

beforeEach(() => {
  apiMocks.delete.mockReset();
  apiMocks.get.mockReset();
  apiMocks.post.mockReset();
});

describe("web SMS inbox state API", () => {
  it("sends an explicit null first-write precondition and decodes the exact receipt", async () => {
    apiMocks.post.mockResolvedValueOnce(stateReceipt());

    await expect(
      archiveSmsConversation({
        tenantId: TENANT,
        phoneE164: PHONE,
        expectedUpdatedAt: null,
      }),
    ).resolves.toMatchObject({
      tenantId: TENANT,
      phoneE164: PHONE,
      action: "archive",
      stateUpdatedAt: NEXT_VERSION,
    });
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/api/v1/sms/conversations/%2B14155550100/archive",
      { expectedUpdatedAt: null },
      { maxAttempts: 1, requireOnline: true },
    );
  });

  it("rejects cross-tenant, wrong-action, and transition-inconsistent receipts", async () => {
    apiMocks.post
      .mockResolvedValueOnce(stateReceipt(PHONE, "archive", { tenantId: OTHER_TENANT }))
      .mockResolvedValueOnce(stateReceipt(PHONE, "unarchive"))
      .mockResolvedValueOnce(
        stateReceipt(PHONE, "snooze", {
          archivedAt: undefined,
          snoozeUntil: "2027-01-03T10:00:00Z",
        }),
      );

    await expect(
      archiveSmsConversation({
        tenantId: TENANT,
        phoneE164: PHONE,
        expectedUpdatedAt: VERSION,
      }),
    ).rejects.toThrow(/another tenant/u);
    await expect(
      archiveSmsConversation({
        tenantId: TENANT,
        phoneE164: PHONE,
        expectedUpdatedAt: VERSION,
      }),
    ).rejects.toThrow(/wrong action/u);
    await expect(
      snoozeSmsConversation({
        tenantId: TENANT,
        phoneE164: PHONE,
        expectedUpdatedAt: VERSION,
        until: UNTIL,
      }),
    ).rejects.toThrow(/requested transition/u);
  });

  it("rejects non-RFC3339 and impossible request versions before transport", () => {
    expect(() =>
      archiveSmsConversation({
        tenantId: TENANT,
        phoneE164: PHONE,
        expectedUpdatedAt: "August 29, 2026 10:00:00 UTC",
      }),
    ).toThrow(/exact loaded stateUpdatedAt/u);
    expect(() =>
      snoozeSmsConversation({
        tenantId: TENANT,
        phoneE164: PHONE,
        expectedUpdatedAt: VERSION,
        until: "2027-02-30T10:00:00Z",
      }),
    ).toThrow(/future RFC3339/u);
    expect(apiMocks.post).not.toHaveBeenCalled();
  });

  it("uses one CAS target per bulk row and rejects partial or reordered receipts", async () => {
    apiMocks.post.mockResolvedValueOnce({
      ok: true,
      tenantId: TENANT,
      action: "archive",
      applied: 2,
      receipts: [
        stateReceipt(PHONE),
        stateReceipt(PHONE_TWO, "archive", {
          archivedAt: "2026-08-29T10:01:01Z",
          stateUpdatedAt: "2026-08-29T10:01:02Z",
        }),
      ],
    });
    const conversations = [
      { phoneE164: PHONE, expectedUpdatedAt: VERSION },
      { phoneE164: PHONE_TWO, expectedUpdatedAt: null },
    ];

    await expect(
      bulkMutateSmsConversations({
        tenantId: TENANT,
        action: "archive",
        conversations,
      }),
    ).resolves.toMatchObject({
      applied: 2,
      receipts: expect.arrayContaining([
        expect.objectContaining({ phoneE164: PHONE }),
      ]),
    });
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/api/v1/sms/conversations/bulk",
      { conversations, action: "archive" },
      { maxAttempts: 1, requireOnline: true },
    );

    apiMocks.post.mockResolvedValueOnce({
      ok: true,
      tenantId: TENANT,
      action: "archive",
      applied: 1,
      receipts: [stateReceipt(PHONE)],
    });
    await expect(
      bulkMutateSmsConversations({
        tenantId: TENANT,
        action: "archive",
        conversations,
      }),
    ).rejects.toThrow(/receipt count|partial/u);

    apiMocks.post.mockResolvedValueOnce({
      ok: true,
      tenantId: TENANT,
      action: "archive",
      applied: 2,
      receipts: [stateReceipt(PHONE_TWO), stateReceipt(PHONE)],
    });
    await expect(
      bulkMutateSmsConversations({
        tenantId: TENANT,
        action: "archive",
        conversations,
      }),
    ).rejects.toThrow(/wrong phone identity/u);
  });

  it("CAS-protects tag removal and decodes only the documented evidence planes", async () => {
    const createdAt = "2026-08-29T09:00:00Z";
    const snapshotAt = "2026-08-29T10:00:00Z";
    apiMocks.get
      .mockResolvedValueOnce({
        tenantId: TENANT,
        phoneE164: PHONE,
        tags: [{ tag: "priority", createdAt }],
        snapshotAt,
        truncated: false,
      })
      .mockResolvedValueOnce({
        tenantId: TENANT,
        phoneE164: PHONE,
        events: [
          {
            kind: "consent",
            at: createdAt,
            title: "Consent granted",
            meta: {
              evidenceId: "22222222-2222-4222-8222-222222222222",
              source: "form",
            },
          },
        ],
        snapshotAt,
        truncated: false,
        sourcePlanes: ["sms_consent_events", "sms_subscriptions_current"],
        historyComplete: false,
      });
    apiMocks.post.mockResolvedValueOnce({
      ok: true,
      tenantId: TENANT,
      phoneE164: PHONE,
      tag: "vip",
      createdAt,
      action: "add",
    });
    apiMocks.delete.mockResolvedValueOnce({
      ok: true,
      tenantId: TENANT,
      phoneE164: PHONE,
      tag: "priority",
      createdAt,
      action: "remove",
    });

    await expect(
      listSmsConversationTags({ tenantId: TENANT, phoneE164: PHONE }),
    ).resolves.toMatchObject({ tags: [{ tag: "priority" }] });
    await addSmsConversationTag({
      tenantId: TENANT,
      phoneE164: PHONE,
      tag: "vip",
    });
    await removeSmsConversationTag({
      tenantId: TENANT,
      phoneE164: PHONE,
      tag: "priority",
      expectedCreatedAt: createdAt,
    });
    await expect(
      getSmsConversationActivity({ tenantId: TENANT, phoneE164: PHONE }),
    ).resolves.toMatchObject({
      historyComplete: false,
      sourcePlanes: ["sms_consent_events", "sms_subscriptions_current"],
    });

    expect(apiMocks.post).toHaveBeenCalledWith(
      "/api/v1/sms/conversations/%2B14155550100/tags",
      { tag: "vip", expectedAbsent: true },
      { maxAttempts: 1, requireOnline: true },
    );
    expect(apiMocks.delete).toHaveBeenCalledWith(
      "/api/v1/sms/conversations/%2B14155550100/tags",
      {
        body: { tag: "priority", expectedCreatedAt: createdAt },
        maxAttempts: 1,
        requireOnline: true,
      },
    );
  });
});
