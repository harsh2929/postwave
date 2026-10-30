/** Device-encrypted, PII-minimised recovery for unresolved internal notes. */
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

import { normalizeHelpdeskIdempotencyKey } from "@/lib/helpdesk";

const STORAGE_KEY = "postwave.mobile.helpdesk.note-intents.v2";
const STORE_VERSION = 2 as const;
export const HELPDESK_NOTE_INTENT_PRINCIPAL_CAPACITY = 4;
export const HELPDESK_NOTE_INTENT_GLOBAL_CAPACITY = 16;
const HASH_RE = /^[a-f0-9]{64}$/u;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UNSAFE_SCOPE_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export interface HelpdeskNoteIntentScope {
  recoveryPrincipal: string;
  conversationId: string;
}

export interface StoredHelpdeskNoteIntent {
  identityHash: string;
  conversationHash: string;
  bodyHash: string;
  idempotencyKey: string;
  createdAt: string;
}

interface StoredHelpdeskNoteIntentEnvelope {
  version: typeof STORE_VERSION;
  intents: StoredHelpdeskNoteIntent[];
}

export type HelpdeskNoteIntentInspection =
  | { status: "none" }
  | { status: "current"; record: StoredHelpdeskNoteIntent }
  | { status: "principal_capacity_reached"; capacity: number }
  | { status: "device_capacity_reached"; capacity: number };

export class HelpdeskNoteIntentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelpdeskNoteIntentConflictError";
  }
}

let queue: Promise<void> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const task = queue.then(operation, operation);
  queue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export async function inspectHelpdeskNoteIntent(
  scope: HelpdeskNoteIntentScope,
): Promise<HelpdeskNoteIntentInspection> {
  return serialized(async () => {
    const hashes = await scopeHashes(scope);
    const envelope = await readEnvelope();
    const current = matchingIntent(envelope.intents, hashes);
    if (current) return { status: "current", record: current };
    if (
      countPrincipalIntents(envelope.intents, hashes.identityHash) >=
      HELPDESK_NOTE_INTENT_PRINCIPAL_CAPACITY
    ) {
      return {
        status: "principal_capacity_reached",
        capacity: HELPDESK_NOTE_INTENT_PRINCIPAL_CAPACITY,
      };
    }
    if (envelope.intents.length >= HELPDESK_NOTE_INTENT_GLOBAL_CAPACITY) {
      return {
        status: "device_capacity_reached",
        capacity: HELPDESK_NOTE_INTENT_GLOBAL_CAPACITY,
      };
    }
    return { status: "none" };
  });
}

/** Reuses a key only when principal, conversation, and exact body all match. */
export async function prepareHelpdeskNoteIntent(input: {
  scope: HelpdeskNoteIntentScope;
  body: string;
}): Promise<StoredHelpdeskNoteIntent> {
  return serialized(async () => {
    const hashes = await scopeHashes(input.scope);
    const bodyHash = await sha256(input.body.trim());
    const envelope = await readEnvelope();
    const current = matchingIntent(envelope.intents, hashes);
    if (current) {
      if (current.bodyHash !== bodyHash) {
        throw new HelpdeskNoteIntentConflictError(
          "Re-enter the exact unresolved note before retrying; a different note cannot reuse its key.",
        );
      }
      return current;
    }
    if (
      countPrincipalIntents(envelope.intents, hashes.identityHash) >=
      HELPDESK_NOTE_INTENT_PRINCIPAL_CAPACITY
    ) {
      throw new HelpdeskNoteIntentConflictError(
        `This account already holds ${HELPDESK_NOTE_INTENT_PRINCIPAL_CAPACITY} unresolved internal-note recovery keys on this device. Reconcile an originating thread before recording another note.`,
      );
    }
    if (envelope.intents.length >= HELPDESK_NOTE_INTENT_GLOBAL_CAPACITY) {
      throw new HelpdeskNoteIntentConflictError(
        `This device already holds ${HELPDESK_NOTE_INTENT_GLOBAL_CAPACITY} unresolved internal-note recovery keys across signed-in accounts. Reconcile an originating thread before recording another note.`,
      );
    }

    const next: StoredHelpdeskNoteIntent = {
      identityHash: hashes.identityHash,
      conversationHash: hashes.conversationHash,
      bodyHash,
      idempotencyKey: "mobile-helpdesk-note-" + Crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await writeEnvelope({
      version: STORE_VERSION,
      intents: [...envelope.intents, next],
    });
    return next;
  });
}

export async function completeHelpdeskNoteIntent(
  scope: HelpdeskNoteIntentScope,
  idempotencyKey: string,
): Promise<void> {
  return serialized(async () => {
    const hashes = await scopeHashes(scope);
    const envelope = await readEnvelope();
    if (envelope.intents.length === 0) return;
    const index = envelope.intents.findIndex(
      (intent) =>
        intent.identityHash === hashes.identityHash &&
        intent.conversationHash === hashes.conversationHash &&
        intent.idempotencyKey === idempotencyKey,
    );
    if (index < 0) {
      throw new HelpdeskNoteIntentConflictError(
        "The internal-note recovery record changed.",
      );
    }
    await writeEnvelope({
      version: STORE_VERSION,
      intents: envelope.intents.filter(
        (_, intentIndex) => intentIndex !== index,
      ),
    });
  });
}

function matchingIntent(
  intents: readonly StoredHelpdeskNoteIntent[],
  hashes: { identityHash: string; conversationHash: string },
): StoredHelpdeskNoteIntent | null {
  return (
    intents.find(
      (intent) =>
        intent.identityHash === hashes.identityHash &&
        intent.conversationHash === hashes.conversationHash,
    ) ?? null
  );
}

function countPrincipalIntents(
  intents: readonly StoredHelpdeskNoteIntent[],
  identityHash: string,
): number {
  return intents.filter((intent) => intent.identityHash === identityHash)
    .length;
}

async function scopeHashes(scope: HelpdeskNoteIntentScope): Promise<{
  identityHash: string;
  conversationHash: string;
}> {
  if (
    typeof scope.recoveryPrincipal !== "string" ||
    !scope.recoveryPrincipal ||
    scope.recoveryPrincipal !== scope.recoveryPrincipal.trim() ||
    scope.recoveryPrincipal.length > 2048 ||
    UNSAFE_SCOPE_RE.test(scope.recoveryPrincipal) ||
    !UUID_RE.test(scope.conversationId)
  ) {
    throw new Error("Invalid Helpdesk internal-note scope.");
  }
  const [identityHash, conversationHash] = await Promise.all([
    sha256(scope.recoveryPrincipal),
    sha256(scope.conversationId),
  ]);
  return { identityHash, conversationHash };
}

async function sha256(value: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
}

async function readEnvelope(): Promise<StoredHelpdeskNoteIntentEnvelope> {
  const raw = await SecureStore.getItemAsync(STORAGE_KEY, SECURE_OPTIONS);
  if (!raw) return { version: STORE_VERSION, intents: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Helpdesk internal-note recovery storage is corrupt.");
  }
  if (!validEnvelope(parsed)) {
    throw new Error("Helpdesk internal-note recovery storage is invalid.");
  }
  return parsed;
}

async function writeEnvelope(
  envelope: StoredHelpdeskNoteIntentEnvelope,
): Promise<void> {
  if (envelope.intents.length === 0) {
    await SecureStore.deleteItemAsync(STORAGE_KEY, SECURE_OPTIONS);
    return;
  }
  await SecureStore.setItemAsync(
    STORAGE_KEY,
    JSON.stringify(envelope),
    SECURE_OPTIONS,
  );
}

function validEnvelope(
  value: unknown,
): value is StoredHelpdeskNoteIntentEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (
    envelope.version !== STORE_VERSION ||
    !Array.isArray(envelope.intents) ||
    envelope.intents.length > HELPDESK_NOTE_INTENT_GLOBAL_CAPACITY ||
    !envelope.intents.every(validIntent)
  ) {
    return false;
  }
  const scopes = new Set<string>();
  const keys = new Set<string>();
  const principalCounts = new Map<string, number>();
  for (const value of envelope.intents) {
    const intent = value as StoredHelpdeskNoteIntent;
    const scope = `${intent.identityHash}:${intent.conversationHash}`;
    if (scopes.has(scope) || keys.has(intent.idempotencyKey)) return false;
    scopes.add(scope);
    keys.add(intent.idempotencyKey);
    const principalCount = (principalCounts.get(intent.identityHash) ?? 0) + 1;
    if (principalCount > HELPDESK_NOTE_INTENT_PRINCIPAL_CAPACITY) return false;
    principalCounts.set(intent.identityHash, principalCount);
  }
  return true;
}

function validIntent(value: unknown): value is StoredHelpdeskNoteIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const created =
    typeof row.createdAt === "string" ? Date.parse(row.createdAt) : Number.NaN;
  let keyValid = false;
  if (typeof row.idempotencyKey === "string") {
    try {
      keyValid =
        normalizeHelpdeskIdempotencyKey(row.idempotencyKey) ===
        row.idempotencyKey;
    } catch {
      keyValid = false;
    }
  }
  return (
    typeof row.identityHash === "string" &&
    HASH_RE.test(row.identityHash) &&
    typeof row.conversationHash === "string" &&
    HASH_RE.test(row.conversationHash) &&
    typeof row.bodyHash === "string" &&
    HASH_RE.test(row.bodyHash) &&
    typeof row.idempotencyKey === "string" &&
    keyValid &&
    row.idempotencyKey.startsWith("mobile-helpdesk-note-") &&
    Number.isFinite(created) &&
    created <= Date.now() + 5 * 60_000
  );
}
