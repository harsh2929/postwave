// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Durable reply intent (messaging-15/19/20 substrate): the checkpoint store
// mints exactly one key per request identity and never replays an unsettled
// one; the transport sends that key as the Idempotency-Key with one attempt
// against the literal reply route; uncertainty classes match desktop.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  post: vi.fn(
    async (
      _path: string,
      _body?: unknown,
      _opts?: {
        idempotencyKey?: string | null;
        maxAttempts?: number;
        requireOnline?: boolean;
      },
    ): Promise<unknown> => ({}),
  ),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, post: mocks.post } };
});

import { ApiError } from "@/lib/api";
import { recordSmsQuickReplyUse, replySmsConversation } from "@/lib/sms-api";
import {
  classifySmsReplyUncertainty,
  normalizeSmsUsCa,
  smsReplyBodyConstraint,
  smsReplyDispatchHoldCopy,
} from "@/lib/sms-reply-intent";
import {
  createSmsReplyRecoveryStore,
  type SmsReplyRecoveryStorage,
} from "@/lib/sms-reply-recovery";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PHONE = "+14155550123";
const OTHER_PHONE = "+14155550124";
const SENDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const LIST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const MSG = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const QUICK = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const SCOPE = `${TENANT}:user`;
const request = { sender_profile_id: SENDER, body: "Hi there", list_id: LIST };

function memoryStorage(): SmsReplyRecoveryStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const persisted = {
  disposition: "persisted",
  message: {
    id: MSG,
    tenant_id: TENANT,
    sender_profile_id: SENDER,
    provider: "twilio",
    provider_message_id: "SM123",
    direction: "outbound",
    segments: 1,
    status: "queued",
    cost_micros: 0,
    created_at: "2026-09-12T10:00:00Z",
  },
  providerReceipt: { provider: "twilio", providerMessageId: "SM123", status: "queued" },
};

beforeEach(() => {
  mocks.post.mockReset().mockResolvedValue(persisted);
});
afterEach(() => vi.clearAllMocks());

describe("sms reply recovery store", () => {
  it("mints one key per request identity, holds a replay, and settles on a terminal result", async () => {
    let keys = 0;
    const storage = memoryStorage();
    const store = createSmsReplyRecoveryStore({
      runtimeId: "run-1",
      createKey: () => `key-${++keys}`,
      storage: () => storage,
    });
    const first = await store.prepare(SCOPE, { phone: PHONE, request });
    expect(first).toMatchObject({ status: "ready", idempotencyKey: "key-1" });
    // The same draft again is a replay: same key, held, no new key minted.
    const replay = await store.prepare(SCOPE, { phone: PHONE, request });
    expect(replay).toMatchObject({
      status: "held",
      reason: "outcome-unknown",
      idempotencyKey: "key-1",
    });
    // A different body to the same phone waits for the earlier intent.
    const other = await store.prepare(SCOPE, {
      phone: PHONE,
      request: { ...request, body: "Something else" },
    });
    expect(other).toMatchObject({ status: "held", reason: "another-intent-pending" });
    // A different phone is independent.
    const elsewhere = await store.prepare(SCOPE, { phone: OTHER_PHONE, request });
    expect(elsewhere).toMatchObject({ status: "ready", idempotencyKey: "key-2" });
    expect(keys).toBe(2);
    // The checkpoint never stores the number itself.
    const raw = [...storage.map.values()].join("\n");
    expect(raw).not.toContain(PHONE);
    expect(raw).not.toContain("Hi there");

    if (first.status !== "ready") throw new Error("unreachable");
    expect(await store.settle(SCOPE, first.signature)).toBe(true);
    const again = await store.prepare(SCOPE, { phone: PHONE, request });
    expect(again).toMatchObject({ status: "ready", idempotencyKey: "key-3" });
  });

  it("reports a recovered intent after a restart, and never frees a durable server hold", async () => {
    const storage = memoryStorage();
    const before = createSmsReplyRecoveryStore({
      runtimeId: "run-1",
      storage: () => storage,
    });
    const prepared = await before.prepare(SCOPE, { phone: PHONE, request });
    if (prepared.status !== "ready") throw new Error("unreachable");
    const after = createSmsReplyRecoveryStore({
      runtimeId: "run-2",
      storage: () => storage,
    });
    expect(await after.prepare(SCOPE, { phone: PHONE, request })).toMatchObject({
      status: "held",
      reason: "recovered-after-restart",
      idempotencyKey: prepared.idempotencyKey,
    });
    expect(
      await after.markRequestIdentityConflict(SCOPE, prepared.signature),
    ).toBe(true);
    expect(await after.prepare(SCOPE, { phone: PHONE, request })).toMatchObject({
      status: "held",
      reason: "request-identity-conflict",
    });
    expect(after.list(SCOPE)).toMatchObject({
      status: "ready",
      intents: [{ state: "request-identity-conflict" }],
    });
  });

  it("holds when storage is missing or corrupt, and quarantines the corrupt slot", async () => {
    const none = createSmsReplyRecoveryStore({
      runtimeId: "run-1",
      storage: () => null,
    });
    expect(await none.prepare(SCOPE, { phone: PHONE, request })).toMatchObject({
      status: "held",
      reason: "vault-unavailable",
    });
    expect(await none.prepare(null, { phone: PHONE, request })).toMatchObject({
      status: "held",
      reason: "identity-unresolved",
    });

    const storage = memoryStorage();
    storage.map.set(
      `postwave.web.sms-reply-intents.v1:${SCOPE}`,
      '{"version":1,"intents":[{"garbage":true}]}',
    );
    const corrupt = createSmsReplyRecoveryStore({
      runtimeId: "run-1",
      storage: () => storage,
    });
    expect(await corrupt.prepare(SCOPE, { phone: PHONE, request })).toMatchObject({
      status: "held",
      reason: "vault-corrupt",
    });
    expect(
      storage.map.get(`postwave.web.sms-reply-intents.v1:${SCOPE}`),
    ).toContain("corrupt-reply-intent-vault");
    // The quarantine marker is sticky: a later read still refuses to mint.
    expect(await corrupt.prepare(SCOPE, { phone: PHONE, request })).toMatchObject({
      status: "held",
      reason: "vault-corrupt",
    });
  });
});

describe("replySmsConversation transport", () => {
  it("POSTs the literal reply route with the caller's key as one online attempt", async () => {
    const outcome = await replySmsConversation({
      phoneE164: PHONE,
      request: { ...request, body: "  Hi there  " },
      idempotencyKey: "intent-key-1",
    });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [path, body, opts] = mocks.post.mock.calls[0]!;
    expect(path).toBe("/api/v1/sms/conversations/%2B14155550123/reply");
    expect(body).toEqual({
      sender_profile_id: SENDER,
      body: "Hi there",
      list_id: LIST,
    });
    expect(opts).toEqual({
      idempotencyKey: "intent-key-1",
      maxAttempts: 1,
      requireOnline: true,
    });
    expect(outcome).toMatchObject({
      disposition: "persisted",
      message: { id: MSG, status: "queued" },
      providerReceipt: { providerMessageId: "SM123" },
    });
  });

  it("decodes the reconciliation disposition and refuses anything else", async () => {
    mocks.post.mockResolvedValueOnce({
      disposition: "reconciliation_required",
      code: "reply_reconciliation_required",
      intentMessageId: MSG,
      providerReceipt: { provider: "twilio", status: "unknown" },
    });
    await expect(
      replySmsConversation({ phoneE164: PHONE, request, idempotencyKey: "k" }),
    ).resolves.toMatchObject({
      disposition: "reconciliation_required",
      intentMessageId: MSG,
    });
    mocks.post.mockResolvedValueOnce({ disposition: "sent" });
    await expect(
      replySmsConversation({ phoneE164: PHONE, request, idempotencyKey: "k" }),
    ).rejects.toThrow("unknown disposition");
  });

  it("refuses locally what the server would 400, before any request", async () => {
    const attempts = [
      () => replySmsConversation({ phoneE164: "+1415555", request, idempotencyKey: "k" }),
      () => replySmsConversation({ phoneE164: PHONE, request, idempotencyKey: "" }),
      () =>
        replySmsConversation({
          phoneE164: PHONE,
          request: { ...request, sender_profile_id: "nope" },
          idempotencyKey: "k",
        }),
      () =>
        replySmsConversation({
          phoneE164: PHONE,
          request: { ...request, list_id: "" },
          idempotencyKey: "k",
        }),
      () =>
        replySmsConversation({
          phoneE164: PHONE,
          request: { ...request, body: "   " },
          idempotencyKey: "k",
        }),
      () =>
        replySmsConversation({
          phoneE164: PHONE,
          request: { ...request, media_url: "http://insecure.example/a.png" },
          idempotencyKey: "k",
        }),
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrow();
    }
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("records a saved-reply use against the literal /use route", async () => {
    mocks.post.mockResolvedValueOnce({
      ok: true,
      tenantId: TENANT,
      id: QUICK,
      useCount: 4,
      lastUsedAt: "2026-09-12T10:00:00Z",
    });
    await expect(recordSmsQuickReplyUse(QUICK)).resolves.toEqual({
      ok: true,
      tenantId: TENANT,
      id: QUICK,
      useCount: 4,
      lastUsedAt: "2026-09-12T10:00:00Z",
    });
    const [path, body, opts] = mocks.post.mock.calls[0]!;
    expect(path).toBe(`/api/v1/sms/quick-replies/${QUICK}/use`);
    expect(body).toBeUndefined();
    expect(opts).toEqual({ requireOnline: true });
    expect(() => recordSmsQuickReplyUse("not-a-uuid")).toThrow();
  });
});

describe("reply intent vocabulary", () => {
  it("classifies uncertainty exactly as desktop does", () => {
    const err = (status: number, code?: string, kind?: string) =>
      new ApiError("x", status, undefined, {
        ...(code ? { code } : {}),
        ...(kind ? { kind: kind as never } : {}),
      });
    expect(classifySmsReplyUncertainty(err(503, "sms_reply_dispatch_release_held"))).toBeNull();
    expect(classifySmsReplyUncertainty(err(503, "sms_financial_reservation_unavailable"))).toBeNull();
    expect(classifySmsReplyUncertainty(err(409, "consent_required"))).toBeNull();
    expect(classifySmsReplyUncertainty(err(0, undefined, "offline"))).toBeNull();
    expect(classifySmsReplyUncertainty(err(409, "idempotency_key_request_mismatch"))).toBe(
      "request-identity-conflict",
    );
    expect(classifySmsReplyUncertainty(err(409, "reply_reconciliation_pending"))).toBe(
      "another-intent-pending",
    );
    expect(classifySmsReplyUncertainty(err(202, "reply_reconciliation_required"))).toBe(
      "outcome-unknown",
    );
    expect(classifySmsReplyUncertainty(err(502))).toBe("outcome-unknown");
    expect(classifySmsReplyUncertainty(err(0, undefined, "timeout"))).toBe("outcome-unknown");
    expect(classifySmsReplyUncertainty(new Error("decode failed"))).toBe("outcome-unknown");
  });

  it("normalizes US/CA input, bounds the body, and names the release hold", () => {
    expect(normalizeSmsUsCa("(415) 555-0123")).toBe("+14155550123");
    expect(normalizeSmsUsCa("+1 415 555 0123")).toBe("+14155550123");
    expect(normalizeSmsUsCa("+44 20 7946 0958")).toBeNull();
    expect(smsReplyBodyConstraint("  ").error).toBe("Enter a message body.");
    expect(smsReplyBodyConstraint("a".repeat(4_801)).error).toContain("4,800");
    expect(smsReplyBodyConstraint("ok").error).toBeNull();
    expect(smsReplyDispatchHoldCopy("sms_reply_dispatch_release_held")).toBe(
      "Live SMS reply dispatch is release-held while durable provider reconciliation and budget settlement are unavailable. No provider request can be started.",
    );
  });
});
