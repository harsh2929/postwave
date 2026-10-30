// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Durable reply-intent checkpoint for the SMS composers (desktop
 * apps/desktop/src/components/sms/sms-reply-recovery.ts). One send attempt =
 * one idempotency key, minted here and checkpointed BEFORE the request leaves
 * so a reload, a tab crash or a timed-out response can never mint a second key
 * for the same draft and double-send an SMS.
 *
 * State machine per intent (keyed by a SHA-256 signature of phone + sender +
 * body + media + list):
 *   prepared → settled (removed) once the server returns a terminal outcome;
 *   prepared → unknown when the outcome cannot be proven; held forever until
 *              an operator reconciles it (no replay, no new key);
 *   prepared → request-identity-conflict | another-intent-pending on the two
 *              durable server holds (never freed automatically).
 *
 * Web has no OS keychain, so the checkpoint lives in localStorage and is
 * minimized accordingly: it holds the request signature, a phone DIGEST (never
 * the number), the key and the state. The body is never stored.
 */

import { createSmsReplyIntentKey, type SmsReplyRequest } from "./sms-reply-intent";

const STORAGE_VERSION = 1;
const MAX_INTENTS_PER_IDENTITY = 32;
const STORAGE_PREFIX = "postwave.web.sms-reply-intents.v1:";
const QUARANTINE_VALUE = "corrupt-reply-intent-vault";
export const SMS_REPLY_RECOVERY_CHANGE_EVENT =
  "postwave:sms-reply-recovery-change";

type StoredState =
  | "prepared"
  | "unknown"
  | "request-identity-conflict"
  | "another-intent-pending";

interface StoredSmsReplyIntent {
  signature: string;
  phoneDigest: string;
  idempotencyKey: string;
  runtimeId: string;
  state: StoredState;
  createdAt: string;
  updatedAt: string;
}

interface StoredEnvelope {
  version: typeof STORAGE_VERSION;
  intents: StoredSmsReplyIntent[];
}

interface QuarantineEnvelope {
  version: typeof STORAGE_VERSION;
  quarantined: typeof QUARANTINE_VALUE;
}

export interface SmsReplyIntentInput {
  phone: string;
  request: SmsReplyRequest;
}

export interface SmsReplyRecoverySummary {
  signature: string;
  phoneDigest: string;
  idempotencyKey: string;
  state: StoredState;
  createdAt: string;
}

export type SmsReplyHeldReason =
  | "identity-unresolved"
  | "vault-unavailable"
  | "vault-corrupt"
  | "recovered-after-restart"
  | "outcome-unknown"
  | "intent-capacity-reached"
  | "checkpoint-update-failed"
  | "checkpoint-clear-failed"
  | "request-identity-conflict"
  | "another-intent-pending";

export type SmsReplyPrepareResult =
  | {
      status: "ready";
      signature: string;
      idempotencyKey: string;
      recovered: boolean;
    }
  | {
      status: "held";
      signature?: string;
      idempotencyKey?: string;
      reason: SmsReplyHeldReason;
    };

export type SmsReplyRecoveryHold = Extract<
  SmsReplyPrepareResult,
  { status: "held" }
>;

/** Minimal synchronous key/value surface (localStorage-shaped). */
export interface SmsReplyRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface SmsReplyRecoveryOptions {
  runtimeId: string;
  now?: () => number;
  createKey?: () => string;
  /** Returns null when no storage is available (SSR, blocked storage). */
  storage: () => SmsReplyRecoveryStorage | null;
}

const SIGNATURE_RE = /^[A-Za-z0-9_-]{43}$/u;
const DIGEST_RE = /^[0-9a-f]{64}$/u;

function validIntent(value: unknown): value is StoredSmsReplyIntent {
  if (!value || typeof value !== "object") return false;
  const intent = value as Partial<StoredSmsReplyIntent>;
  return (
    typeof intent.signature === "string" &&
    SIGNATURE_RE.test(intent.signature) &&
    typeof intent.phoneDigest === "string" &&
    DIGEST_RE.test(intent.phoneDigest) &&
    typeof intent.idempotencyKey === "string" &&
    intent.idempotencyKey.length > 0 &&
    new TextEncoder().encode(intent.idempotencyKey).byteLength <= 255 &&
    typeof intent.runtimeId === "string" &&
    intent.runtimeId.length > 0 &&
    (intent.state === "prepared" ||
      intent.state === "unknown" ||
      intent.state === "request-identity-conflict" ||
      intent.state === "another-intent-pending") &&
    typeof intent.createdAt === "string" &&
    Number.isFinite(Date.parse(intent.createdAt)) &&
    typeof intent.updatedAt === "string" &&
    Number.isFinite(Date.parse(intent.updatedAt))
  );
}

type ReadResult =
  | { status: "ready"; value: StoredEnvelope }
  | { status: "missing" }
  | { status: "unavailable" }
  | { status: "corrupt" };

function parseEnvelope(raw: string | null): ReadResult {
  if (raw === null) return { status: "missing" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "corrupt" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "corrupt" };
  }
  const envelope = value as Partial<StoredEnvelope> & {
    quarantined?: unknown;
  };
  if (
    envelope.version === STORAGE_VERSION &&
    envelope.quarantined === QUARANTINE_VALUE &&
    Object.keys(envelope).length === 2
  ) {
    return { status: "corrupt" };
  }
  if (
    Object.keys(envelope).some((key) => key !== "version" && key !== "intents") ||
    envelope.version !== STORAGE_VERSION ||
    !Array.isArray(envelope.intents) ||
    !envelope.intents.every(validIntent)
  ) {
    return { status: "corrupt" };
  }
  return {
    status: "ready",
    value: { version: STORAGE_VERSION, intents: envelope.intents },
  };
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return new Uint8Array(digest);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Canonical request identity: every field the server hashes for its own key. */
export async function smsReplyIntentSignature(
  input: SmsReplyIntentInput,
): Promise<string> {
  return base64Url(
    await sha256(
      JSON.stringify({
        phone: input.phone,
        senderProfileId: input.request.sender_profile_id,
        body: input.request.body,
        mediaUrl: input.request.media_url ?? "",
        listId: input.request.list_id,
      }),
    ),
  );
}

async function phoneDigest(phone: string): Promise<string> {
  return hex(await sha256(`sms-reply-phone:${phone}`));
}

export function createSmsReplyRecoveryStore({
  runtimeId,
  now = Date.now,
  createKey = createSmsReplyIntentKey,
  storage,
}: SmsReplyRecoveryOptions) {
  const storageKey = (scope: string): string => `${STORAGE_PREFIX}${scope}`;

  const notifyChanged = (): void => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(SMS_REPLY_RECOVERY_CHANGE_EVENT));
    }
  };

  const read = (scope: string): ReadResult => {
    const store = storage();
    if (!store) return { status: "unavailable" };
    let raw: string | null;
    try {
      raw = store.getItem(storageKey(scope));
    } catch {
      return { status: "unavailable" };
    }
    const parsed = parseEnvelope(raw);
    if (parsed.status !== "corrupt") return parsed;
    // Pin the corruption so a later read cannot look like a clean, empty
    // checkpoint and mint a replacement key for an intent that may have sent.
    try {
      store.setItem(
        storageKey(scope),
        JSON.stringify({
          version: STORAGE_VERSION,
          quarantined: QUARANTINE_VALUE,
        } satisfies QuarantineEnvelope),
      );
      notifyChanged();
    } catch {
      // The marker could not be written; the read still reports corrupt.
    }
    return { status: "corrupt" };
  };

  const write = (scope: string, intents: StoredSmsReplyIntent[]): boolean => {
    const store = storage();
    if (!store) return false;
    try {
      if (intents.length === 0) {
        store.removeItem(storageKey(scope));
      } else {
        store.setItem(
          storageKey(scope),
          JSON.stringify({
            version: STORAGE_VERSION,
            intents,
          } satisfies StoredEnvelope),
        );
      }
    } catch {
      return false;
    }
    notifyChanged();
    return true;
  };

  const prepare = async (
    scope: string | null,
    input: SmsReplyIntentInput,
  ): Promise<SmsReplyPrepareResult> => {
    if (!scope) return { status: "held", reason: "identity-unresolved" };
    const signature = await smsReplyIntentSignature(input);
    const digest = await phoneDigest(input.phone);
    const envelope = read(scope);
    if (envelope.status === "unavailable") {
      return { status: "held", signature, reason: "vault-unavailable" };
    }
    if (envelope.status === "corrupt") {
      return { status: "held", signature, reason: "vault-corrupt" };
    }
    const intents = envelope.status === "ready" ? envelope.value.intents : [];
    const existing = intents.find((intent) => intent.signature === signature);
    if (existing) {
      const reason: SmsReplyHeldReason =
        existing.state === "unknown"
          ? "outcome-unknown"
          : existing.state === "request-identity-conflict"
            ? "request-identity-conflict"
            : existing.state === "another-intent-pending"
              ? "another-intent-pending"
              : existing.runtimeId === runtimeId
                ? "outcome-unknown"
                : "recovered-after-restart";
      return {
        status: "held",
        signature,
        idempotencyKey: existing.idempotencyKey,
        reason,
      };
    }
    const unresolvedForPhone = intents.find(
      (intent) => intent.phoneDigest === digest,
    );
    if (unresolvedForPhone) {
      return {
        status: "held",
        signature: unresolvedForPhone.signature,
        idempotencyKey: unresolvedForPhone.idempotencyKey,
        reason: "another-intent-pending",
      };
    }
    if (intents.length >= MAX_INTENTS_PER_IDENTITY) {
      return { status: "held", signature, reason: "intent-capacity-reached" };
    }
    const timestamp = new Date(now()).toISOString();
    const created: StoredSmsReplyIntent = {
      signature,
      phoneDigest: digest,
      idempotencyKey: createKey(),
      runtimeId,
      state: "prepared",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (!write(scope, [...intents, created])) {
      return { status: "held", signature, reason: "vault-unavailable" };
    }
    return {
      status: "ready",
      signature,
      idempotencyKey: created.idempotencyKey,
      recovered: false,
    };
  };

  const mutate = (
    scope: string | null,
    transform: (intents: StoredSmsReplyIntent[]) => StoredSmsReplyIntent[],
  ): boolean => {
    if (!scope) return false;
    const envelope = read(scope);
    if (envelope.status !== "ready") return envelope.status === "missing";
    const before = envelope.value.intents;
    const after = transform(before);
    if (
      after.length === before.length &&
      after.every((intent, index) => intent === before[index])
    ) {
      return false;
    }
    return write(scope, after);
  };

  const transition = (
    scope: string | null,
    signature: string,
    state: Exclude<StoredState, "prepared">,
  ): Promise<boolean> =>
    Promise.resolve(
      mutate(scope, (intents) =>
        intents.map((intent) =>
          intent.signature === signature
            ? { ...intent, state, updatedAt: new Date(now()).toISOString() }
            : intent,
        ),
      ),
    );

  return {
    prepare,
    markUnknown: (scope: string | null, signature: string) =>
      transition(scope, signature, "unknown"),
    markRequestIdentityConflict: (scope: string | null, signature: string) =>
      transition(scope, signature, "request-identity-conflict"),
    markAnotherIntentPending: (scope: string | null, signature: string) =>
      transition(scope, signature, "another-intent-pending"),
    settle: (scope: string | null, signature: string): Promise<boolean> =>
      Promise.resolve(
        mutate(scope, (intents) =>
          intents.filter((intent) => intent.signature !== signature),
        ),
      ),
    list: (
      scope: string | null,
    ):
      | { status: "ready"; intents: SmsReplyRecoverySummary[] }
      | {
          status: "identity-unresolved" | "vault-unavailable" | "vault-corrupt";
        } => {
      if (!scope) return { status: "identity-unresolved" };
      const envelope = read(scope);
      if (envelope.status === "unavailable")
        return { status: "vault-unavailable" };
      if (envelope.status === "corrupt") return { status: "vault-corrupt" };
      const intents = envelope.status === "ready" ? envelope.value.intents : [];
      return {
        status: "ready",
        intents: intents.map((intent) => ({
          signature: intent.signature,
          phoneDigest: intent.phoneDigest,
          idempotencyKey: intent.idempotencyKey,
          state: intent.state,
          createdAt: intent.createdAt,
        })),
      };
    },
  };
}

export type SmsReplyRecoveryStore = ReturnType<
  typeof createSmsReplyRecoveryStore
>;

function browserStorage(): SmsReplyRecoveryStorage | null {
  if (typeof window === "undefined") return null;
  try {
    const store = window.localStorage;
    if (!store) return null;
    return store;
  } catch {
    return null;
  }
}

/** Process-wide store: one runtime id per page load (a reload = a restart). */
export const smsReplyRecovery = createSmsReplyRecoveryStore({
  runtimeId: createSmsReplyIntentKey(),
  storage: browserStorage,
});
