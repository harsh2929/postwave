/**
 * Encrypted, PII-minimised recovery record for exactly one unresolved SMS reply.
 *
 * The body, phone, sender, list, tenant, and user never enter SecureStore. Only
 * SHA-256 digests plus the idempotency key are retained. A single global slot is
 * deliberate: an unresolved provider outcome blocks every new mobile reply,
 * including across logout or workspace changes, without revealing which
 * identity, thread, or draft owns the hold.
 */
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const STORAGE_KEY = "postwave.mobile.sms.reply-intent.v1";
const VERSION = 1;
const HASH = /^[a-f0-9]{64}$/u;
const KEY_CONTROL = /[\u0000-\u001f\u007f]/u;
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export type SmsReplyIntentState = "pending" | "reconciliation_required";

export interface StoredSmsReplyIntent {
  version: 1;
  identityHash: string;
  threadHash: string;
  signatureHash: string;
  idempotencyKey: string;
  state: SmsReplyIntentState;
  createdAt: string;
}

export type SmsReplyIntentInspection =
  | { status: "none" }
  | { status: "current"; record: StoredSmsReplyIntent }
  | { status: "other_identity" }
  | {
      status: "other_thread";
      state: SmsReplyIntentState;
    };

export interface SmsReplyIntentScope {
  identityFingerprint: string;
  phoneE164: string;
}

export class SmsReplyIntentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmsReplyIntentConflictError";
  }
}

let mutationQueue: Promise<void> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const task = mutationQueue.then(operation, operation);
  mutationQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export async function smsReplyIntentSignature(input: {
  senderProfileId: string;
  listId: string;
  body: string;
}): Promise<string> {
  return sha256(
    JSON.stringify([input.senderProfileId, input.listId, input.body.trim()]),
  );
}

export async function inspectSmsReplyIntent(
  scope: SmsReplyIntentScope,
): Promise<SmsReplyIntentInspection> {
  return serialized(async () => {
    const hashes = await scopeHashes(scope);
    const record = await readRecord();
    if (!record) return { status: "none" };
    if (record.identityHash !== hashes.identityHash) {
      return { status: "other_identity" };
    }
    return record.threadHash === hashes.threadHash
      ? { status: "current", record }
      : { status: "other_thread", state: record.state };
  });
}

/** Commit the recovery key before the network request is allowed to start. */
export async function prepareSmsReplyIntent(input: {
  scope: SmsReplyIntentScope;
  senderProfileId: string;
  listId: string;
  body: string;
}): Promise<StoredSmsReplyIntent> {
  return serialized(async () => {
    const hashes = await scopeHashes(input.scope);
    const signatureHash = await smsReplyIntentSignature(input);
    const record = await readRecord();
    if (record && record.identityHash !== hashes.identityHash) {
      throw new SmsReplyIntentConflictError(
        "Another workspace identity has an unresolved reply intent.",
      );
    }
    if (record) {
      if (record.threadHash !== hashes.threadHash) {
        throw new SmsReplyIntentConflictError(
          "Another conversation has an unresolved reply intent.",
        );
      }
      void signatureHash;
      throw new SmsReplyIntentConflictError(
        "This unresolved reply is held and must not be retried without server-authoritative replay evidence.",
      );
    }

    const createdAt = new Date().toISOString();
    const next: StoredSmsReplyIntent = {
      version: VERSION,
      identityHash: hashes.identityHash,
      threadHash: hashes.threadHash,
      signatureHash,
      idempotencyKey: `mobile-sms-reply-${Crypto.randomUUID()}`,
      state: "pending",
      createdAt,
    };
    await SecureStore.setItemAsync(
      STORAGE_KEY,
      JSON.stringify(next),
      SECURE_OPTIONS,
    );
    return next;
  });
}

export async function markSmsReplyIntentReconciliation(
  scope: SmsReplyIntentScope,
  idempotencyKey: string,
): Promise<StoredSmsReplyIntent> {
  return serialized(async () => {
    const hashes = await scopeHashes(scope);
    const record = await readRecord();
    if (
      !record ||
      record.identityHash !== hashes.identityHash ||
      record.threadHash !== hashes.threadHash ||
      record.idempotencyKey !== idempotencyKey
    ) {
      throw new SmsReplyIntentConflictError(
        "The reply recovery record changed.",
      );
    }
    const next = { ...record, state: "reconciliation_required" as const };
    await SecureStore.setItemAsync(
      STORAGE_KEY,
      JSON.stringify(next),
      SECURE_OPTIONS,
    );
    return next;
  });
}

/** Clear only after a definitive persisted receipt for this exact key. */
export async function completeSmsReplyIntent(
  scope: SmsReplyIntentScope,
  idempotencyKey: string,
): Promise<void> {
  return serialized(async () => {
    const hashes = await scopeHashes(scope);
    const record = await readRecord();
    if (!record) return;
    if (
      record.identityHash !== hashes.identityHash ||
      record.threadHash !== hashes.threadHash ||
      record.idempotencyKey !== idempotencyKey
    ) {
      throw new SmsReplyIntentConflictError(
        "The reply recovery record changed.",
      );
    }
    await SecureStore.deleteItemAsync(STORAGE_KEY, SECURE_OPTIONS);
  });
}

async function scopeHashes(scope: SmsReplyIntentScope): Promise<{
  identityHash: string;
  threadHash: string;
}> {
  if (
    !scope.identityFingerprint ||
    !/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(scope.phoneE164)
  ) {
    throw new Error("Invalid SMS reply intent scope.");
  }
  const [identityHash, threadHash] = await Promise.all([
    sha256(scope.identityFingerprint),
    sha256(scope.phoneE164),
  ]);
  return { identityHash, threadHash };
}

async function sha256(value: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
}

async function readRecord(): Promise<StoredSmsReplyIntent | null> {
  const raw = await SecureStore.getItemAsync(STORAGE_KEY, SECURE_OPTIONS);
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("SMS reply recovery storage is corrupt.");
  }
  if (!isRecord(value))
    throw new Error("SMS reply recovery storage is invalid.");
  return value;
}

function isRecord(value: unknown): value is StoredSmsReplyIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const created =
    typeof row.createdAt === "string" ? Date.parse(row.createdAt) : Number.NaN;
  return (
    row.version === VERSION &&
    typeof row.identityHash === "string" &&
    HASH.test(row.identityHash) &&
    typeof row.threadHash === "string" &&
    HASH.test(row.threadHash) &&
    typeof row.signatureHash === "string" &&
    HASH.test(row.signatureHash) &&
    typeof row.idempotencyKey === "string" &&
    row.idempotencyKey.length > 0 &&
    utf8Bytes(row.idempotencyKey) <= 255 &&
    !KEY_CONTROL.test(row.idempotencyKey) &&
    (row.state === "pending" || row.state === "reconciliation_required") &&
    Number.isFinite(created) &&
    created <= Date.now() + 5 * 60 * 1_000
  );
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const point of value) {
    const code = point.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/**
 * Inbox-level, identity-scoped view of the single reply-intent slot.
 *
 * READ-ONLY and PII-preserving: it exposes the stored THREAD HASH, never a
 * phone. The inbox may hash the phones it already legitimately displays (via
 * `smsReplyThreadHash`) to find which visible row carries the hold; a hold on
 * a conversation outside the loaded page stays unnamed by construction.
 */
export type SmsInboxHoldSummary =
  | { status: "none" }
  | { status: "storage_unavailable" }
  | { status: "other_identity"; state: SmsReplyIntentState }
  | {
      status: "held";
      state: SmsReplyIntentState;
      threadHash: string;
      createdAt: string;
    };

export async function inspectSmsReplyIntentForIdentity(
  identityFingerprint: string,
): Promise<SmsInboxHoldSummary> {
  if (!identityFingerprint) return { status: "storage_unavailable" };
  return serialized(async () => {
    let record: StoredSmsReplyIntent | null;
    let identityHash: string;
    try {
      [record, identityHash] = await Promise.all([
        readRecord(),
        sha256(identityFingerprint),
      ]);
    } catch {
      return { status: "storage_unavailable" };
    }
    if (!record) return { status: "none" };
    if (record.identityHash !== identityHash) {
      return { status: "other_identity", state: record.state };
    }
    return {
      status: "held",
      state: record.state,
      threadHash: record.threadHash,
      createdAt: record.createdAt,
    };
  });
}

/** The store's thread digest for one displayed phone, for hold matching. */
export async function smsReplyThreadHash(phoneE164: string): Promise<string> {
  return sha256(phoneE164);
}
