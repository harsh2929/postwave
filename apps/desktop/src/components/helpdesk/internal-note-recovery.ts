import type { ApiErr } from "../../lib/api/result";
import { canonicalApiBaseUrl } from "../../lib/config";
import { desktopRouteIdentityScope } from "../../lib/desktop-route-runtime";
import { inspectInternalNoteOperationExclusion } from "../../lib/helpdesk-internal-note-operation";
import {
  vaultDelete,
  vaultReadJSON,
  vaultSetJSON,
} from "../../lib/secure-vault";

const VERSION = 3;
const LEGACY_VERSION = 2;
const MAX_INTENTS = 32;
const QUARANTINE_PREFIX = "postwave.helpdesk-note-quarantine.v3:";
const LEGACY_QUARANTINE_PREFIX = "postwave.helpdesk-note-quarantine.v2:";
const ENCRYPTED_INTENT_STORAGE_PREFIXES = [
  "postwave.desktop.vault.v1:helpdesk-internal-note-intents.v2.",
  "postwave.desktop.vault.v1:helpdesk-internal-note-intents.v3.",
] as const;
const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RECOVERY_SCOPE_RE = /^v3-session-[0-9a-f]{16}$/u;
const LEGACY_RECOVERY_SCOPE_RE = /^v2-session-[0-9a-f]{16}$/u;

interface StoredIntent {
  signature: string;
  conversationId: string;
  idempotencyKey: string;
  state: "prepared" | "unknown";
  createdAt: string;
  updatedAt: string;
}

interface StoredEnvelope {
  version: typeof VERSION;
  intents: StoredIntent[];
}

interface LegacyStoredEnvelope {
  version: typeof LEGACY_VERSION;
  intents: StoredIntent[];
}

export interface InternalNoteRecoveryAuthority {
  apiBaseUrl: string;
  apiIdentityGeneration: number;
  legacyV2Scope: string;
  scope: string;
  tenant: string;
  user: string;
}

export type InternalNoteRecoveryInventory = "clear" | "held" | "unavailable";

/**
 * Process-wide, content-free checkpoint inventory for sign-out review. A
 * stored v2/v3 ciphertext or quarantine marker represents authority that a
 * privacy wipe would destroy, even while the Helpdesk route is unmounted.
 */
export function inspectInternalNoteRecoveryInventory(): InternalNoteRecoveryInventory {
  if (typeof window === "undefined") return "unavailable";
  try {
    const storage = window.localStorage;
    const length = storage.length;
    if (!Number.isSafeInteger(length) || length < 0) return "unavailable";
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (key === null) return "unavailable";
      if (
        ENCRYPTED_INTENT_STORAGE_PREFIXES.some((prefix) =>
          key.startsWith(prefix),
        ) ||
        key.startsWith(LEGACY_QUARANTINE_PREFIX) ||
        key.startsWith(QUARANTINE_PREFIX)
      ) {
        return "held";
      }
    }
    return "clear";
  } catch {
    return "unavailable";
  }
}

export type InternalNotePrepareResult =
  | { status: "ready"; signature: string; idempotencyKey: string }
  | {
      status: "held";
      reason:
        | "identity-unresolved"
        | "sign-out-in-progress"
        | "vault-unavailable"
        | "vault-corrupt"
        | "intent-capacity-reached"
        | "unresolved-intent"
        | "legacy-scope-held";
    };

function storageKey(identityScope: string): string {
  return `helpdesk-internal-note-intents.v3.${identityScope}`;
}

function legacyStorageKey(identityScope: string): string {
  return `helpdesk-internal-note-intents.v2.${identityScope}`;
}

/**
 * Canonical transport authority for durable intent ownership. The full base
 * path is retained because Moosewave supports path-prefixed API gateways.
 */
export function canonicalNoteRecoveryApiBaseUrl(
  apiBaseUrl: string | null | undefined,
): string | null {
  return canonicalApiBaseUrl(apiBaseUrl);
}

function legacySessionNoteRecoveryScope(
  user: string | null | undefined,
  tenant: string | null | undefined,
): string | null {
  if (
    typeof user !== "string" ||
    typeof tenant !== "string" ||
    !CANONICAL_UUID_RE.test(user) ||
    !CANONICAL_UUID_RE.test(tenant)
  ) {
    return null;
  }
  const fingerprint = desktopRouteIdentityScope(
    `helpdesk-note-recovery-v2\u001fsession-user\u001f${user}`,
    tenant,
  );
  return fingerprint ? `v2-session-${fingerprint}` : null;
}

/**
 * Provenance-qualified durable note authority. V3 is deliberately
 * domain-separated from both actor-label/v1 and originless session/v2 scopes.
 */
export function sessionNoteRecoveryAuthority(
  user: string | null | undefined,
  tenant: string | null | undefined,
  apiBaseUrl: string | null | undefined,
  apiIdentityGeneration: number | null | undefined,
): InternalNoteRecoveryAuthority | null {
  if (
    typeof user !== "string" ||
    typeof tenant !== "string" ||
    !CANONICAL_UUID_RE.test(user) ||
    !CANONICAL_UUID_RE.test(tenant) ||
    !Number.isSafeInteger(apiIdentityGeneration) ||
    (apiIdentityGeneration ?? -1) < 0
  ) {
    return null;
  }
  const canonicalBaseUrl = canonicalNoteRecoveryApiBaseUrl(apiBaseUrl);
  const legacyV2Scope = legacySessionNoteRecoveryScope(user, tenant);
  if (!canonicalBaseUrl || !legacyV2Scope) return null;
  const fingerprint = desktopRouteIdentityScope(
    `helpdesk-note-recovery-v3\u001ffull-api-base\u001f${canonicalBaseUrl}\u001fsession-user\u001f${user}`,
    tenant,
  );
  return fingerprint
    ? {
        apiBaseUrl: canonicalBaseUrl,
        apiIdentityGeneration: apiIdentityGeneration as number,
        legacyV2Scope,
        scope: `v3-session-${fingerprint}`,
        tenant,
        user,
      }
    : null;
}

export function sessionNoteRecoveryScope(
  user: string | null | undefined,
  tenant: string | null | undefined,
  apiBaseUrl: string | null | undefined,
): string | null {
  return (
    sessionNoteRecoveryAuthority(user, tenant, apiBaseUrl, 0)?.scope ?? null
  );
}

function createKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function signature(
  conversationId: string,
  body: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ conversationId, body }),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  let binary = "";
  for (const byte of new Uint8Array(digest))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function isStoredIntent(value: unknown): value is StoredIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<StoredIntent>;
  return (
    typeof item.signature === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(item.signature) &&
    typeof item.conversationId === "string" &&
    CANONICAL_UUID_RE.test(item.conversationId) &&
    typeof item.idempotencyKey === "string" &&
    item.idempotencyKey.length > 0 &&
    item.idempotencyKey.length <= 255 &&
    (item.state === "prepared" || item.state === "unknown") &&
    typeof item.createdAt === "string" &&
    Number.isFinite(Date.parse(item.createdAt)) &&
    typeof item.updatedAt === "string" &&
    Number.isFinite(Date.parse(item.updatedAt))
  );
}

async function readCurrent(
  identityScope: string,
): Promise<
  | { status: "ready"; intents: StoredIntent[] }
  | { status: "missing" | "unavailable" | "corrupt" }
> {
  try {
    if (
      window.localStorage.getItem(`${QUARANTINE_PREFIX}${identityScope}`) ===
      "1"
    ) {
      return { status: "corrupt" };
    }
  } catch {
    return { status: "unavailable" };
  }
  const result = await vaultReadJSON<unknown>(storageKey(identityScope), {
    preserveCorrupt: true,
  });
  if (result.status !== "ready") {
    if (result.status === "corrupt") {
      try {
        window.localStorage.setItem(
          `${QUARANTINE_PREFIX}${identityScope}`,
          "1",
        );
      } catch {
        return { status: "unavailable" };
      }
    }
    return result;
  }
  const envelope = result.value as Partial<StoredEnvelope>;
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.version !== VERSION ||
    !Array.isArray(envelope.intents) ||
    envelope.intents.length > MAX_INTENTS ||
    !envelope.intents.every(isStoredIntent)
  ) {
    try {
      window.localStorage.setItem(`${QUARANTINE_PREFIX}${identityScope}`, "1");
    } catch {
      return { status: "unavailable" };
    }
    return { status: "corrupt" };
  }
  return { status: "ready", intents: envelope.intents };
}

async function readLegacyV2(
  identityScope: string | null | undefined,
): Promise<
  | { status: "ready"; intents: StoredIntent[] }
  | { status: "missing" | "unavailable" | "corrupt" }
> {
  if (!identityScope || !LEGACY_RECOVERY_SCOPE_RE.test(identityScope)) {
    return { status: "missing" };
  }
  try {
    if (
      window.localStorage.getItem(
        `${LEGACY_QUARANTINE_PREFIX}${identityScope}`,
      ) === "1"
    ) {
      return { status: "corrupt" };
    }
  } catch {
    return { status: "unavailable" };
  }
  const result = await vaultReadJSON<unknown>(legacyStorageKey(identityScope), {
    preserveCorrupt: true,
  });
  if (result.status !== "ready") {
    if (result.status === "corrupt") {
      try {
        window.localStorage.setItem(
          `${LEGACY_QUARANTINE_PREFIX}${identityScope}`,
          "1",
        );
      } catch {
        return { status: "unavailable" };
      }
    }
    return result;
  }
  const envelope = result.value as Partial<LegacyStoredEnvelope>;
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.version !== LEGACY_VERSION ||
    !Array.isArray(envelope.intents) ||
    envelope.intents.length > MAX_INTENTS ||
    !envelope.intents.every(isStoredIntent)
  ) {
    try {
      window.localStorage.setItem(
        `${LEGACY_QUARANTINE_PREFIX}${identityScope}`,
        "1",
      );
    } catch {
      return { status: "unavailable" };
    }
    return { status: "corrupt" };
  }
  return { status: "ready", intents: envelope.intents };
}

async function legacyConversationState(
  legacyIdentityScope: string | null | undefined,
  conversationId: string,
): Promise<"clear" | "held" | "unavailable" | "corrupt"> {
  const envelope = await readLegacyV2(legacyIdentityScope);
  if (envelope.status !== "ready") {
    return envelope.status === "missing" ? "clear" : envelope.status;
  }
  return envelope.intents.some(
    (intent) => intent.conversationId === conversationId,
  )
    ? "held"
    : "clear";
}

async function write(
  identityScope: string,
  intents: StoredIntent[],
): Promise<boolean> {
  try {
    if (intents.length === 0) vaultDelete(storageKey(identityScope));
    else {
      await vaultSetJSON(storageKey(identityScope), {
        version: VERSION,
        intents,
      } satisfies StoredEnvelope);
    }
    return true;
  } catch {
    return false;
  }
}

export const internalNoteRecovery = {
  async prepare(
    identityScope: string | null,
    conversationId: string,
    body: string,
    legacyIdentityScope?: string | null,
  ): Promise<InternalNotePrepareResult> {
    if (inspectInternalNoteOperationExclusion() === "sign-out-active") {
      return { status: "held", reason: "sign-out-in-progress" };
    }
    if (!identityScope || !RECOVERY_SCOPE_RE.test(identityScope))
      return { status: "held", reason: "identity-unresolved" };
    if (!CANONICAL_UUID_RE.test(conversationId)) {
      return { status: "held", reason: "identity-unresolved" };
    }
    const legacyState = await legacyConversationState(
      legacyIdentityScope,
      conversationId,
    );
    if (legacyState === "held") {
      return { status: "held", reason: "legacy-scope-held" };
    }
    if (legacyState === "unavailable") {
      return { status: "held", reason: "vault-unavailable" };
    }
    if (legacyState === "corrupt") {
      return { status: "held", reason: "vault-corrupt" };
    }
    const bodySignature = await signature(conversationId, body);
    const envelope = await readCurrent(identityScope);
    if (envelope.status === "unavailable") {
      return { status: "held", reason: "vault-unavailable" };
    }
    if (envelope.status === "corrupt") {
      return { status: "held", reason: "vault-corrupt" };
    }
    const intents = envelope.status === "ready" ? envelope.intents : [];
    // Ordinary preparation never replays a recovered intent. Route41's durable
    // server ledger makes an exact same-key replay safe only after the separate
    // explicit-review path below; a fresh key is never minted after restart.
    if (
      intents.some(
        (intent) =>
          intent.signature === bodySignature ||
          intent.conversationId === conversationId,
      )
    ) {
      return { status: "held", reason: "unresolved-intent" };
    }
    if (intents.length >= MAX_INTENTS) {
      return { status: "held", reason: "intent-capacity-reached" };
    }
    const now = new Date().toISOString();
    const created: StoredIntent = {
      signature: bodySignature,
      conversationId,
      idempotencyKey: createKey(),
      state: "prepared",
      createdAt: now,
      updatedAt: now,
    };
    if (!(await write(identityScope, [...intents, created]))) {
      return { status: "held", reason: "vault-unavailable" };
    }
    return {
      status: "ready",
      signature: bodySignature,
      idempotencyKey: created.idempotencyKey,
    };
  },

  /**
   * Recover an explicitly reviewed exact-body intent. This never creates or
   * mutates a key: it returns the encrypted checkpoint's original key only
   * when the principal scope, conversation, and body hash all match. The
   * caller must keep this behind a separate review gesture; ordinary prepare
   * remains non-replaying.
   */
  async reviewExactReplay(
    identityScope: string | null,
    conversationId: string,
    body: string,
    legacyIdentityScope?: string | null,
  ): Promise<InternalNotePrepareResult> {
    if (inspectInternalNoteOperationExclusion() === "sign-out-active") {
      return { status: "held", reason: "sign-out-in-progress" };
    }
    if (
      !identityScope ||
      !RECOVERY_SCOPE_RE.test(identityScope) ||
      !CANONICAL_UUID_RE.test(conversationId)
    ) {
      return { status: "held", reason: "identity-unresolved" };
    }
    const legacyState = await legacyConversationState(
      legacyIdentityScope,
      conversationId,
    );
    if (legacyState === "held") {
      return { status: "held", reason: "legacy-scope-held" };
    }
    if (legacyState === "unavailable") {
      return { status: "held", reason: "vault-unavailable" };
    }
    if (legacyState === "corrupt") {
      return { status: "held", reason: "vault-corrupt" };
    }
    const bodySignature = await signature(conversationId, body);
    const envelope = await readCurrent(identityScope);
    if (envelope.status !== "ready") {
      const reason =
        envelope.status === "unavailable"
          ? "vault-unavailable"
          : envelope.status === "corrupt"
            ? "vault-corrupt"
            : "unresolved-intent";
      return { status: "held", reason };
    }
    const intent = envelope.intents.find(
      (candidate: StoredIntent) =>
        candidate.conversationId === conversationId &&
        candidate.signature === bodySignature,
    );
    if (!intent) {
      return { status: "held", reason: "unresolved-intent" };
    }
    return {
      status: "ready",
      signature: intent.signature,
      idempotencyKey: intent.idempotencyKey,
    };
  },

  async markUnknown(
    identityScope: string | null,
    intentSignature: string,
  ): Promise<boolean> {
    if (!identityScope || !RECOVERY_SCOPE_RE.test(identityScope)) return false;
    const envelope = await readCurrent(identityScope);
    if (envelope.status !== "ready") return false;
    const now = new Date().toISOString();
    return write(
      identityScope,
      envelope.intents.map((intent) =>
        intent.signature === intentSignature
          ? { ...intent, state: "unknown", updatedAt: now }
          : intent,
      ),
    );
  },

  async settle(
    identityScope: string | null,
    intentSignature: string,
  ): Promise<boolean> {
    if (!identityScope || !RECOVERY_SCOPE_RE.test(identityScope)) return false;
    const envelope = await readCurrent(identityScope);
    if (envelope.status !== "ready") return false;
    return write(
      identityScope,
      envelope.intents.filter((intent) => intent.signature !== intentSignature),
    );
  },

  async hasHeldConversation(
    identityScope: string | null,
    conversationId: string,
    legacyIdentityScope?: string | null,
  ): Promise<"clear" | "held" | "legacy" | "unavailable" | "corrupt"> {
    if (!identityScope || !RECOVERY_SCOPE_RE.test(identityScope))
      return "unavailable";
    const legacyState = await legacyConversationState(
      legacyIdentityScope,
      conversationId,
    );
    if (legacyState === "held") return "legacy";
    if (legacyState === "unavailable" || legacyState === "corrupt") {
      return legacyState;
    }
    const envelope = await readCurrent(identityScope);
    if (envelope.status === "unavailable" || envelope.status === "corrupt") {
      return envelope.status;
    }
    const intents = envelope.status === "ready" ? envelope.intents : [];
    return intents.some((intent) => intent.conversationId === conversationId)
      ? "held"
      : "clear";
  },
};

export function internalNoteOutcomeIsUnknown(
  error: ApiErr["error"] | null | undefined,
): boolean {
  return (
    error?.kind === "network" ||
    error?.kind === "timeout" ||
    error?.kind === "parse" ||
    error?.status === 409 ||
    error?.status === 410 ||
    error?.code === "internal_note_result_unavailable" ||
    error?.code === "idempotency_complete_failed" ||
    error?.code === "idempotency_key_request_mismatch" ||
    error?.code === "idempotency_key_conflict" ||
    (typeof error?.status === "number" && error.status >= 500)
  );
}
