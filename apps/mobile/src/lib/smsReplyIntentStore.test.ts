import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  completeSmsReplyIntent,
  inspectSmsReplyIntent,
  inspectSmsReplyIntentForIdentity,
  markSmsReplyIntentReconciliation,
  prepareSmsReplyIntent,
  smsReplyThreadHash,
} from "./smsReplyIntentStore";

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: vi.fn(),
  randomUUID: vi.fn(),
}));

const PHONE = "+15552345678";
const IDENTITY = '["https://api.test","tenant","user","admin"]';
const scope = { identityFingerprint: IDENTITY, phoneE164: PHONE };
let stored: string | null;

function fakeHash(value: string): string {
  let seed = 0x811c9dc5;
  for (const char of value)
    seed = Math.imul(seed ^ char.charCodeAt(0), 0x01000193);
  return (seed >>> 0).toString(16).padStart(8, "0").repeat(8);
}

beforeEach(() => {
  stored = null;
  vi.mocked(Crypto.randomUUID).mockReset();
  vi.mocked(Crypto.randomUUID).mockReturnValue(
    "11111111-1111-4111-8111-111111111111",
  );
  vi.mocked(Crypto.digestStringAsync).mockReset();
  vi.mocked(Crypto.digestStringAsync).mockImplementation(
    async (_algorithm, value) => fakeHash(value),
  );
  vi.mocked(SecureStore.getItemAsync).mockReset();
  vi.mocked(SecureStore.setItemAsync).mockReset();
  vi.mocked(SecureStore.deleteItemAsync).mockReset();
  vi.mocked(SecureStore.getItemAsync).mockImplementation(async () => stored);
  vi.mocked(SecureStore.setItemAsync).mockImplementation(
    async (_key, value) => {
      stored = value;
    },
  );
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async () => {
    stored = null;
  });
});

describe("durable SMS reply intents", () => {
  it("stores only digests and keeps the key after reload without permitting replay", async () => {
    const first = await prepareSmsReplyIntent({
      scope,
      senderProfileId: "sender-1",
      listId: "list-1",
      body: "Private draft body",
    });
    expect(stored).not.toContain(PHONE);
    expect(stored).not.toContain("Private draft body");
    expect(stored).not.toContain("sender-1");
    expect(stored).not.toContain("list-1");

    const reloaded = await inspectSmsReplyIntent(scope);
    expect(reloaded).toMatchObject({
      status: "current",
      record: { idempotencyKey: first.idempotencyKey },
    });
    await expect(
      prepareSmsReplyIntent({
        scope,
        senderProfileId: "sender-1",
        listId: "list-1",
        body: "Private draft body",
      }),
    ).rejects.toThrow(/must not be retried/u);
    expect(Crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it("holds a different draft or conversation until a definitive persisted receipt", async () => {
    const pending = await prepareSmsReplyIntent({
      scope,
      senderProfileId: "s1",
      listId: "l1",
      body: "one",
    });
    await expect(
      prepareSmsReplyIntent({
        scope,
        senderProfileId: "s1",
        listId: "l1",
        body: "two",
      }),
    ).rejects.toThrow(/must not be retried/u);
    await expect(
      inspectSmsReplyIntent({ ...scope, phoneE164: "+15559876543" }),
    ).resolves.toMatchObject({ status: "other_thread" });
    await completeSmsReplyIntent(scope, pending.idempotencyKey);
    await expect(inspectSmsReplyIntent(scope)).resolves.toEqual({
      status: "none",
    });
  });

  it("persists reconciliation as non-retriable and clears only a definitive exact key", async () => {
    const pending = await prepareSmsReplyIntent({
      scope,
      senderProfileId: "s1",
      listId: "l1",
      body: "one",
    });
    await markSmsReplyIntentReconciliation(scope, pending.idempotencyKey);
    await expect(
      prepareSmsReplyIntent({
        scope,
        senderProfileId: "s1",
        listId: "l1",
        body: "one",
      }),
    ).rejects.toThrow(/must not be retried/u);
    await expect(completeSmsReplyIntent(scope, "wrong-key")).rejects.toThrow(
      /changed/u,
    );
    expect(stored).not.toBeNull();
    await completeSmsReplyIntent(scope, pending.idempotencyKey);
    expect(stored).toBeNull();
  });

  it("retains an unresolved pending key beyond 24 hours with no replay or invented client expiry", async () => {
    const pending = await prepareSmsReplyIntent({
      scope,
      senderProfileId: "s1",
      listId: "l1",
      body: "one",
    });
    const legacy = JSON.parse(stored ?? "{}") as Record<string, unknown>;
    legacy.createdAt = "2024-01-01T00:00:00Z";
    // Older builds wrote this field. It must not expire or erase the key.
    legacy.retrySafeUntil = "2024-01-01T23:00:00Z";
    stored = JSON.stringify(legacy);

    await expect(inspectSmsReplyIntent(scope)).resolves.toMatchObject({
      status: "current",
      record: { idempotencyKey: pending.idempotencyKey, state: "pending" },
    });
    await expect(
      prepareSmsReplyIntent({
        scope,
        senderProfileId: "s1",
        listId: "l1",
        body: "one",
      }),
    ).rejects.toThrow(/must not be retried/u);
    expect(Crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it("keeps an old reconciliation receipt held beyond 24 hours", async () => {
    const pending = await prepareSmsReplyIntent({
      scope,
      senderProfileId: "s1",
      listId: "l1",
      body: "one",
    });
    await markSmsReplyIntentReconciliation(scope, pending.idempotencyKey);
    const legacy = JSON.parse(stored ?? "{}") as Record<string, unknown>;
    legacy.createdAt = "2024-01-01T00:00:00Z";
    legacy.retrySafeUntil = "2024-01-01T23:00:00Z";
    stored = JSON.stringify(legacy);

    await expect(inspectSmsReplyIntent(scope)).resolves.toMatchObject({
      status: "current",
      record: { state: "reconciliation_required" },
    });
    await expect(
      prepareSmsReplyIntent({
        scope,
        senderProfileId: "s1",
        listId: "l1",
        body: "one",
      }),
    ).rejects.toThrow(/must not be retried/u);
  });

  it("retains a zero-detail global hold across identity changes", async () => {
    await prepareSmsReplyIntent({
      scope,
      senderProfileId: "s1",
      listId: "l1",
      body: "one",
    });
    const original = stored;
    const otherScope = {
      identityFingerprint: "another-identity",
      phoneE164: "+15559876543",
    };
    await expect(inspectSmsReplyIntent(otherScope)).resolves.toEqual({
      status: "other_identity",
    });
    expect(stored).toBe(original);
    await expect(
      prepareSmsReplyIntent({
        scope: otherScope,
        senderProfileId: "other-sender",
        listId: "other-list",
        body: "other body",
      }),
    ).rejects.toThrow(/Another workspace identity/u);
    expect(stored).toBe(original);
    expect(stored).not.toContain("another-identity");
    expect(stored).not.toContain("other body");
    expect(Crypto.randomUUID).toHaveBeenCalledTimes(1);
  });
});

describe("identity-scoped inbox summary", () => {
  it("reports none / held-with-thread-hash / other_identity without a phone", async () => {
    await expect(
      inspectSmsReplyIntentForIdentity(IDENTITY),
    ).resolves.toEqual({ status: "none" });

    const prepared = await prepareSmsReplyIntent({
      scope,
      senderProfileId: "44444444-4444-4444-8444-444444444444",
      listId: "55555555-5555-4555-8555-555555555555",
      body: "hello",
    });
    const held = await inspectSmsReplyIntentForIdentity(IDENTITY);
    expect(held).toEqual({
      status: "held",
      state: "pending",
      threadHash: await smsReplyThreadHash(PHONE),
      createdAt: prepared.createdAt,
    });
    // The summary exposes a HASH, never the phone itself.
    expect(JSON.stringify(held)).not.toContain(PHONE);

    await expect(
      inspectSmsReplyIntentForIdentity("someone-else"),
    ).resolves.toEqual({ status: "other_identity", state: "pending" });
  });

  it("reports storage_unavailable instead of throwing on a corrupt slot", async () => {
    stored = "{not json";
    await expect(
      inspectSmsReplyIntentForIdentity(IDENTITY),
    ).resolves.toEqual({ status: "storage_unavailable" });
  });
});
