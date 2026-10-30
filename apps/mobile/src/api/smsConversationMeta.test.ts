import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addSmsConversationTag,
  fetchSmsLifecycleToken,
  getSmsConversationActivity,
  listSmsConversationTags,
  removeSmsConversationTag,
  setSmsConversationNotes,
} from "./smsConversationMeta";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

const TENANT = "11111111-1111-4111-8111-111111111111";
const PHONE = "+15552345678";
const AT = "2026-08-21T09:00:00Z";
const SNAPSHOT = "2026-08-21T10:00:00Z";

beforeEach(() => {
  rawRequest.mockReset();
});

describe("tags transport", () => {
  it("lists via GET .../tags", async () => {
    rawRequest.mockResolvedValue({
      data: {
        tenantId: TENANT,
        phoneE164: PHONE,
        tags: [{ tag: "refund", createdAt: AT }],
        snapshotAt: SNAPSHOT,
        truncated: false,
      },
      error: null,
    });
    const page = await listSmsConversationTags({
      tenantId: TENANT,
      phoneE164: PHONE,
    });
    expect(rawRequest.mock.calls[0]?.[0]).toBe("GET");
    expect(rawRequest.mock.calls[0]?.[1]).toBe(
      `/api/v1/sms/conversations/${encodeURIComponent(PHONE)}/tags`,
    );
    expect(page.tags[0]?.tag).toBe("refund");
  });

  it("adds with the expectedAbsent precondition", async () => {
    rawRequest.mockResolvedValue({
      data: {
        ok: true,
        tenantId: TENANT,
        phoneE164: PHONE,
        tag: "vip",
        createdAt: AT,
        action: "add",
      },
      error: null,
    });
    await addSmsConversationTag({
      tenantId: TENANT,
      phoneE164: PHONE,
      tag: "vip",
    });
    expect(rawRequest.mock.calls[0]?.[0]).toBe("POST");
    expect(rawRequest.mock.calls[0]?.[2]).toEqual({
      tag: "vip",
      expectedAbsent: true,
    });
  });

  it("removes via DELETE with the tag in the BODY — never in the path", async () => {
    rawRequest.mockResolvedValue({
      data: {
        ok: true,
        tenantId: TENANT,
        phoneE164: PHONE,
        tag: "vip",
        createdAt: AT,
        action: "remove",
      },
      error: null,
    });
    await removeSmsConversationTag({
      tenantId: TENANT,
      phoneE164: PHONE,
      tag: "vip",
      expectedCreatedAt: AT,
    });
    expect(rawRequest.mock.calls[0]?.[0]).toBe("DELETE");
    // The retired /tags/{tag} path answers 410; the live path has no tag.
    expect(rawRequest.mock.calls[0]?.[1]).toBe(
      `/api/v1/sms/conversations/${encodeURIComponent(PHONE)}/tags`,
    );
    expect(rawRequest.mock.calls[0]?.[2]).toEqual({
      tag: "vip",
      expectedCreatedAt: AT,
    });
  });

  it("refuses an invalid tag before any request", async () => {
    await expect(
      addSmsConversationTag({ tenantId: TENANT, phoneE164: PHONE, tag: " x " }),
    ).rejects.toThrow(/1 to 64/);
    expect(rawRequest).not.toHaveBeenCalled();
  });
});

describe("notes transport", () => {
  it("POSTs the overwrite with the lifecycle CAS token", async () => {
    rawRequest.mockResolvedValue({
      data: {
        ok: true,
        tenantId: TENANT,
        phoneE164: PHONE,
        action: "notes",
        stateUpdatedAt: SNAPSHOT,
      },
      error: null,
    });
    const receipt = await setSmsConversationNotes({
      tenantId: TENANT,
      phoneE164: PHONE,
      notes: "customer promised refund",
      expectedUpdatedAt: AT,
    });
    expect(rawRequest.mock.calls[0]?.[1]).toBe(
      `/api/v1/sms/conversations/${encodeURIComponent(PHONE)}/notes`,
    );
    expect(rawRequest.mock.calls[0]?.[2]).toEqual({
      notes: "customer promised refund",
      expectedUpdatedAt: AT,
    });
    expect(receipt.stateUpdatedAt).toBe(SNAPSHOT);
  });

  it("sends explicit null for a never-touched conversation", async () => {
    rawRequest.mockResolvedValue({
      data: {
        ok: true,
        tenantId: TENANT,
        phoneE164: PHONE,
        action: "notes",
        stateUpdatedAt: SNAPSHOT,
      },
      error: null,
    });
    await setSmsConversationNotes({
      tenantId: TENANT,
      phoneE164: PHONE,
      notes: "note",
      expectedUpdatedAt: null,
    });
    expect(rawRequest.mock.calls[0]?.[2]).toEqual({
      notes: "note",
      expectedUpdatedAt: null,
    });
  });
});

describe("activity transport", () => {
  it("GETs and decodes the feed", async () => {
    rawRequest.mockResolvedValue({
      data: {
        tenantId: TENANT,
        phoneE164: PHONE,
        events: [],
        snapshotAt: SNAPSHOT,
        truncated: false,
        sourcePlanes: ["sms_consent_events", "sms_subscriptions_current"],
        historyComplete: false,
      },
      error: null,
    });
    const feed = await getSmsConversationActivity({
      tenantId: TENANT,
      phoneE164: PHONE,
    });
    expect(rawRequest.mock.calls[0]?.[1]).toBe(
      `/api/v1/sms/conversations/${encodeURIComponent(PHONE)}/activity`,
    );
    expect(feed.events).toEqual([]);
  });
});

describe("fetchSmsLifecycleToken", () => {
  it("asks the exact-phone search and returns the row's token", async () => {
    rawRequest.mockResolvedValue({
      data: {
        tenantId: TENANT,
        conversations: [
          {
            phoneE164: PHONE,
            identityAmbiguous: false,
            lastMessagePreview: "hello",
            lastMessageAt: AT,
            lastDirection: "inbound",
            messageCount: 1,
            unreadCount: 0,
            stateUpdatedAt: SNAPSHOT,
          },
        ],
        snapshotAt: SNAPSHOT,
      },
      error: null,
    });
    const token = await fetchSmsLifecycleToken({
      tenantId: TENANT,
      phoneE164: PHONE,
    });
    expect(rawRequest.mock.calls[0]?.[0]).toBe("POST");
    expect(rawRequest.mock.calls[0]?.[1]).toBe(
      "/api/v1/sms/conversations/search",
    );
    expect(rawRequest.mock.calls[0]?.[2]).toEqual({
      query: PHONE,
      limit: 50,
    });
    expect(token).toBe(SNAPSHOT);
  });

  it("returns null when the row carries no operator state", async () => {
    rawRequest.mockResolvedValue({
      data: {
        tenantId: TENANT,
        conversations: [
          {
            phoneE164: PHONE,
            identityAmbiguous: false,
            lastMessagePreview: "hello",
            lastMessageAt: AT,
            lastDirection: "inbound",
            messageCount: 1,
            unreadCount: 0,
          },
        ],
        snapshotAt: SNAPSHOT,
      },
      error: null,
    });
    await expect(
      fetchSmsLifecycleToken({ tenantId: TENANT, phoneE164: PHONE }),
    ).resolves.toBeNull();
  });
});
