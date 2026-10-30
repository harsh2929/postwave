import { apiIdentityGenerationIsCurrent } from "./api-identity-transition";
import { canonicalApiBaseUrl } from "./config";
import { vaultDelete, vaultReadJSON, vaultSetJSON } from "./secure-vault";
import type { Me } from "./store";
import {
  validateWebhookPlaygroundHistoricalEventType,
  validateWebhookPlaygroundRawJSONObject,
} from "./api/webhook-playground-contract";
import { WEBHOOK_PLAYGROUND_FIRE_RECOVERY_SCOPE_RE } from "./webhook-playground-fire-recovery-scope";

const VERSION = 1;
const STORAGE_KEY_PREFIX = "webhook-playground-fire-recovery.v1.";
const ENCRYPTED_STORAGE_PREFIX = `postwave.desktop.vault.v1:${STORAGE_KEY_PREFIX}`;
const QUARANTINE_PREFIX =
  "postwave.webhook-playground-fire-recovery-quarantine.v1:";
const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RECOVERY_SCOPE_RE = /^v1-(?:session|api-key)-[0-9a-f]{64}$/u;
const CONTROL_RE = /\p{Cc}/u;
const API_KEY_CREDENTIAL_FINGERPRINT_RE =
  /^(?:[a-f0-9]{64}|api-credential:sha256:[a-f0-9]{64})$/u;
const MAX_IDEMPOTENCY_KEY_BYTES = 255;
const MAX_PAYLOAD_JSON_BYTES = 262_144;
const MAX_PAYLOAD_BASE64_CHARS = 4 * Math.ceil(MAX_PAYLOAD_JSON_BYTES / 3);
const CANONICAL_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder("utf-8", { fatal: true });

type RecoveryMe = Pick<
  Me,
  | "credentialFingerprint"
  | "credentialSource"
  | "tenant"
  | "user"
  | "webhookPlaygroundRecoveryScope"
>;

/**
 * The exact caller-known request identity needed to reconcile or safely replay
 * one live webhook playground fire. UI-only labels and duplicate payload text
 * are deliberately excluded so two representations cannot drift.
 */
export interface WebhookPlaygroundFireSnapshot {
  readonly fireId: string;
  readonly idempotencyKey: string;
  readonly webhookId: string;
  readonly expectedWebhookConfigVersion: number;
  readonly eventType: string;
  readonly payloadJSON: string;
}

export interface WebhookPlaygroundFireRecoveryAuthority {
  readonly apiBaseUrl: string;
  readonly apiIdentityGeneration: number;
  readonly credentialSource: "session" | "api-key";
  readonly principal: string;
  readonly scope: string;
  readonly tenant: string;
}

export type WebhookPlaygroundFireRecoveryInventory =
  | "clear"
  | "held"
  | "unavailable";

export type WebhookPlaygroundFireRecoveryScopedInventory =
  | "clear"
  | "current"
  | "foreign"
  | "mixed"
  | "unavailable";

export type WebhookPlaygroundFireRecoveryHoldReason =
  | "identity-unresolved"
  | "identity-changed"
  | "snapshot-invalid"
  | "vault-unavailable"
  | "vault-corrupt"
  | "foreign-checkpoint"
  | "checkpoint-exists"
  | "checkpoint-conflict"
  | "checkpoint-mismatch";

export type WebhookPlaygroundFireRecoveryLoadResult =
  | { status: "clear" }
  | { status: "ready"; snapshot: WebhookPlaygroundFireSnapshot }
  | {
      status: "held";
      reason:
        | "identity-unresolved"
        | "identity-changed"
        | "vault-unavailable"
        | "vault-corrupt"
        | "foreign-checkpoint";
    };

export type WebhookPlaygroundFireRecoveryPrepareResult =
  | { status: "ready"; snapshot: WebhookPlaygroundFireSnapshot }
  | {
      status: "held";
      reason:
        | "identity-unresolved"
        | "identity-changed"
        | "snapshot-invalid"
        | "vault-unavailable"
        | "vault-corrupt"
        | "foreign-checkpoint"
        | "checkpoint-exists"
        | "checkpoint-conflict";
    };

export type WebhookPlaygroundFireRecoverySettleResult =
  | { status: "clear" | "cleared" }
  | {
      status: "held";
      reason:
        | "identity-unresolved"
        | "identity-changed"
        | "snapshot-invalid"
        | "vault-unavailable"
        | "vault-corrupt"
        | "foreign-checkpoint"
        | "checkpoint-mismatch";
    };

interface StoredFireEnvelope {
  version: typeof VERSION;
  scope: string;
  snapshot: StoredFireSnapshot;
}

interface StoredFireSnapshot {
  fireId: string;
  idempotencyKey: string;
  webhookId: string;
  expectedWebhookConfigVersion: number;
  eventType: string;
  payloadJSONBase64: string;
}

type AuthorityResolution =
  | { status: "ready"; authority: WebhookPlaygroundFireRecoveryAuthority }
  | { status: "held"; reason: "identity-unresolved" | "identity-changed" };

type CheckpointReadResult =
  | { status: "ready"; snapshot: WebhookPlaygroundFireSnapshot }
  | { status: "missing" }
  | { status: "unavailable" }
  | { status: "corrupt" };

let operationTail: Promise<void> = Promise.resolve();

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function storageKey(scope: string): string {
  return `${STORAGE_KEY_PREFIX}${scope}`;
}

function quarantineKey(scope: string): string {
  return `${QUARANTINE_PREFIX}${scope}`;
}

function validIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    utf8Bytes(value) <= MAX_IDEMPOTENCY_KEY_BYTES &&
    isWellFormedUnicode(value) &&
    !CONTROL_RE.test(value)
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string") &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function validEventType(value: unknown): value is string {
  try {
    return (
      validateWebhookPlaygroundHistoricalEventType(
        value,
        "fire snapshot eventType",
      ) === value
    );
  } catch {
    return false;
  }
}

function validPayloadJSON(value: unknown): value is string {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) {
    return false;
  }
  try {
    return (
      validateWebhookPlaygroundRawJSONObject(value, "fire snapshot payload")
        .rawJSON === value
    );
  } catch {
    return false;
  }
}

function encodePayloadJSON(payloadJSON: string): string | null {
  try {
    let binary = "";
    for (const byte of textEncoder.encode(payloadJSON)) {
      binary += String.fromCharCode(byte);
    }
    return globalThis.btoa(binary);
  } catch {
    return null;
  }
}

function decodePayloadJSON(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PAYLOAD_BASE64_CHARS ||
    !CANONICAL_BASE64_RE.test(value)
  ) {
    return null;
  }
  try {
    const binary = globalThis.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    if (bytes.byteLength > MAX_PAYLOAD_JSON_BYTES) return null;
    const payloadJSON = fatalTextDecoder.decode(bytes);
    return validPayloadJSON(payloadJSON) &&
      encodePayloadJSON(payloadJSON) === value
      ? payloadJSON
      : null;
  } catch {
    return null;
  }
}

function normalizeSnapshotValue(
  value: unknown,
): WebhookPlaygroundFireSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(snapshot, [
      "fireId",
      "idempotencyKey",
      "webhookId",
      "expectedWebhookConfigVersion",
      "eventType",
      "payloadJSON",
    ]) ||
    typeof snapshot.fireId !== "string" ||
    !CANONICAL_UUID_RE.test(snapshot.fireId) ||
    !validIdempotencyKey(snapshot.idempotencyKey) ||
    typeof snapshot.webhookId !== "string" ||
    !CANONICAL_UUID_RE.test(snapshot.webhookId) ||
    !Number.isSafeInteger(snapshot.expectedWebhookConfigVersion) ||
    (snapshot.expectedWebhookConfigVersion as number) < 1 ||
    !validEventType(snapshot.eventType) ||
    !validPayloadJSON(snapshot.payloadJSON)
  ) {
    return null;
  }
  return {
    fireId: snapshot.fireId,
    idempotencyKey: snapshot.idempotencyKey,
    webhookId: snapshot.webhookId,
    expectedWebhookConfigVersion:
      snapshot.expectedWebhookConfigVersion as number,
    eventType: snapshot.eventType,
    payloadJSON: snapshot.payloadJSON,
  };
}

function normalizeSnapshot(
  value: unknown,
): WebhookPlaygroundFireSnapshot | null {
  try {
    return normalizeSnapshotValue(value);
  } catch {
    return null;
  }
}

function storedSnapshot(
  snapshot: WebhookPlaygroundFireSnapshot,
): StoredFireSnapshot | null {
  const payloadJSONBase64 = encodePayloadJSON(snapshot.payloadJSON);
  return payloadJSONBase64
    ? {
        fireId: snapshot.fireId,
        idempotencyKey: snapshot.idempotencyKey,
        webhookId: snapshot.webhookId,
        expectedWebhookConfigVersion: snapshot.expectedWebhookConfigVersion,
        eventType: snapshot.eventType,
        payloadJSONBase64,
      }
    : null;
}

function normalizeStoredSnapshot(
  value: unknown,
): WebhookPlaygroundFireSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const snapshot = value as Record<string, unknown>;
    if (
      !hasOnlyKeys(snapshot, [
        "fireId",
        "idempotencyKey",
        "webhookId",
        "expectedWebhookConfigVersion",
        "eventType",
        "payloadJSONBase64",
      ])
    ) {
      return null;
    }
    const payloadJSON = decodePayloadJSON(snapshot.payloadJSONBase64);
    if (!payloadJSON) return null;
    return normalizeSnapshot({
      fireId: snapshot.fireId,
      idempotencyKey: snapshot.idempotencyKey,
      webhookId: snapshot.webhookId,
      expectedWebhookConfigVersion: snapshot.expectedWebhookConfigVersion,
      eventType: snapshot.eventType,
      payloadJSON,
    });
  } catch {
    return null;
  }
}

function deriveAuthority(
  me: RecoveryMe,
  apiBaseUrl: string,
  apiIdentityGeneration: number,
): WebhookPlaygroundFireRecoveryAuthority | null {
  const credentialSource = me.credentialSource;
  const canonicalBase = canonicalApiBaseUrl(apiBaseUrl);
  if (
    (credentialSource !== "session" && credentialSource !== "api-key") ||
    !canonicalBase ||
    typeof me.tenant !== "string" ||
    !CANONICAL_UUID_RE.test(me.tenant) ||
    !Number.isSafeInteger(apiIdentityGeneration) ||
    apiIdentityGeneration < 0
  ) {
    return null;
  }
  const principal =
    credentialSource === "session" ? me.user : me.credentialFingerprint;
  if (typeof principal !== "string") return null;
  if (
    (credentialSource === "session" && !CANONICAL_UUID_RE.test(principal)) ||
    (credentialSource === "api-key" &&
      !API_KEY_CREDENTIAL_FINGERPRINT_RE.test(principal))
  ) {
    return null;
  }
  const identityScope = me.webhookPlaygroundRecoveryScope;
  if (
    typeof identityScope !== "string" ||
    !WEBHOOK_PLAYGROUND_FIRE_RECOVERY_SCOPE_RE.test(identityScope)
  ) {
    return null;
  }
  return Object.freeze({
    apiBaseUrl: canonicalBase,
    apiIdentityGeneration,
    credentialSource,
    principal,
    scope: `v1-${credentialSource}-${identityScope}`,
    tenant: me.tenant,
  });
}

/** Build one current, provenance-qualified authority from `/Me` identity. */
export function createWebhookPlaygroundFireRecoveryAuthority(
  me: RecoveryMe | null | undefined,
  apiBaseUrl: string | null | undefined,
  apiIdentityGeneration: number | null | undefined,
): WebhookPlaygroundFireRecoveryAuthority | null {
  if (
    !me ||
    typeof apiBaseUrl !== "string" ||
    typeof apiIdentityGeneration !== "number" ||
    !apiIdentityGenerationIsCurrent(apiIdentityGeneration)
  ) {
    return null;
  }
  try {
    return deriveAuthority(me, apiBaseUrl, apiIdentityGeneration);
  } catch {
    return null;
  }
}

function resolveAuthorityValue(
  value: WebhookPlaygroundFireRecoveryAuthority | null | undefined,
): AuthorityResolution {
  if (
    !value ||
    typeof value.scope !== "string" ||
    !RECOVERY_SCOPE_RE.test(value.scope)
  ) {
    return { status: "held", reason: "identity-unresolved" };
  }
  const expected = deriveAuthority(
    {
      credentialFingerprint:
        value.credentialSource === "api-key" ? value.principal : null,
      credentialSource: value.credentialSource,
      tenant: value.tenant,
      user: value.credentialSource === "session" ? value.principal : "api-key",
      webhookPlaygroundRecoveryScope: value.scope.slice(
        `v1-${value.credentialSource}-`.length,
      ),
    },
    value.apiBaseUrl,
    value.apiIdentityGeneration,
  );
  if (
    !expected ||
    expected.scope !== value.scope ||
    expected.apiBaseUrl !== value.apiBaseUrl ||
    expected.credentialSource !== value.credentialSource ||
    expected.principal !== value.principal ||
    expected.tenant !== value.tenant
  ) {
    return { status: "held", reason: "identity-unresolved" };
  }
  if (!apiIdentityGenerationIsCurrent(value.apiIdentityGeneration)) {
    return { status: "held", reason: "identity-changed" };
  }
  return { status: "ready", authority: expected };
}

function resolveAuthority(
  value: WebhookPlaygroundFireRecoveryAuthority | null | undefined,
): AuthorityResolution {
  try {
    return resolveAuthorityValue(value);
  } catch {
    return { status: "held", reason: "identity-unresolved" };
  }
}

function quarantineStatus(scope: string): "clear" | "marked" | "unavailable" {
  if (typeof window === "undefined") return "unavailable";
  try {
    return window.localStorage.getItem(quarantineKey(scope)) === null
      ? "clear"
      : "marked";
  } catch {
    return "unavailable";
  }
}

function markQuarantined(scope: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(quarantineKey(scope), "1");
    return window.localStorage.getItem(quarantineKey(scope)) === "1";
  } catch {
    return false;
  }
}

export function inspectWebhookPlaygroundFireRecoveryScopeInventory(
  scope: string,
): WebhookPlaygroundFireRecoveryScopedInventory {
  if (!RECOVERY_SCOPE_RE.test(scope) || typeof window === "undefined") {
    return "unavailable";
  }
  const currentEncryptedKey = `${ENCRYPTED_STORAGE_PREFIX}${scope}`;
  const currentQuarantineKey = quarantineKey(scope);
  try {
    const storage = window.localStorage;
    const length = storage.length;
    if (!Number.isSafeInteger(length) || length < 0) return "unavailable";
    let current = false;
    let foreign = false;
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (key === null) return "unavailable";
      if (key.startsWith(ENCRYPTED_STORAGE_PREFIX)) {
        if (key === currentEncryptedKey) current = true;
        else foreign = true;
      } else if (key.startsWith(QUARANTINE_PREFIX)) {
        if (key === currentQuarantineKey) current = true;
        else foreign = true;
      }
    }
    if (current && foreign) return "mixed";
    if (current) return "current";
    return foreign ? "foreign" : "clear";
  } catch {
    return "unavailable";
  }
}

function scopedArtifactHoldReason(
  scope: string,
): "foreign-checkpoint" | "vault-unavailable" | null {
  const status = inspectWebhookPlaygroundFireRecoveryScopeInventory(scope);
  return status === "foreign" || status === "mixed"
    ? "foreign-checkpoint"
    : status === "unavailable"
      ? "vault-unavailable"
      : null;
}

async function readCheckpoint(scope: string): Promise<CheckpointReadResult> {
  const quarantine = quarantineStatus(scope);
  if (quarantine === "unavailable") return { status: "unavailable" };
  if (quarantine === "marked") return { status: "corrupt" };
  let result: Awaited<ReturnType<typeof vaultReadJSON<unknown>>>;
  try {
    result = await vaultReadJSON<unknown>(storageKey(scope), {
      preserveCorrupt: true,
    });
  } catch {
    return { status: "unavailable" };
  }
  if (result.status === "corrupt") {
    return markQuarantined(scope)
      ? { status: "corrupt" }
      : { status: "unavailable" };
  }
  if (result.status !== "ready") return result;
  const envelope = result.value;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return markQuarantined(scope)
      ? { status: "corrupt" }
      : { status: "unavailable" };
  }
  const record = envelope as Record<string, unknown>;
  const snapshot = normalizeStoredSnapshot(record.snapshot);
  if (
    !hasOnlyKeys(record, ["version", "scope", "snapshot"]) ||
    record.version !== VERSION ||
    record.scope !== scope ||
    !snapshot
  ) {
    return markQuarantined(scope)
      ? { status: "corrupt" }
      : { status: "unavailable" };
  }
  return { status: "ready", snapshot };
}

function snapshotsMatch(
  left: WebhookPlaygroundFireSnapshot,
  right: WebhookPlaygroundFireSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation, operation);
  operationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Process-wide content-free inventory for sign-out guards. Any ciphertext or
 * quarantine marker means a privacy purge would destroy recovery evidence.
 */
export function inspectWebhookPlaygroundFireRecoveryInventory(): WebhookPlaygroundFireRecoveryInventory {
  if (typeof window === "undefined") return "unavailable";
  try {
    const storage = window.localStorage;
    const length = storage.length;
    if (!Number.isSafeInteger(length) || length < 0) return "unavailable";
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (key === null) return "unavailable";
      if (
        key.startsWith(ENCRYPTED_STORAGE_PREFIX) ||
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

export const webhookPlaygroundFireRecovery = {
  load(
    authority: WebhookPlaygroundFireRecoveryAuthority | null | undefined,
  ): Promise<WebhookPlaygroundFireRecoveryLoadResult> {
    return exclusive(async () => {
      const resolved = resolveAuthority(authority);
      if (resolved.status === "held") return resolved;
      const initialArtifactHold = scopedArtifactHoldReason(
        resolved.authority.scope,
      );
      if (initialArtifactHold) {
        return { status: "held", reason: initialArtifactHold };
      }
      const checkpoint = await readCheckpoint(resolved.authority.scope);
      if (
        !apiIdentityGenerationIsCurrent(
          resolved.authority.apiIdentityGeneration,
        )
      ) {
        return { status: "held", reason: "identity-changed" };
      }
      const finalArtifactHold = scopedArtifactHoldReason(
        resolved.authority.scope,
      );
      if (finalArtifactHold) {
        return { status: "held", reason: finalArtifactHold };
      }
      if (checkpoint.status === "missing") return { status: "clear" };
      if (checkpoint.status === "unavailable") {
        return { status: "held", reason: "vault-unavailable" };
      }
      if (checkpoint.status === "corrupt") {
        return { status: "held", reason: "vault-corrupt" };
      }
      return { status: "ready", snapshot: checkpoint.snapshot };
    });
  },

  prepare(
    authority: WebhookPlaygroundFireRecoveryAuthority | null | undefined,
    value: WebhookPlaygroundFireSnapshot,
  ): Promise<WebhookPlaygroundFireRecoveryPrepareResult> {
    return exclusive(async () => {
      const resolved = resolveAuthority(authority);
      if (resolved.status === "held") return resolved;
      const snapshot = normalizeSnapshot(value);
      if (!snapshot) return { status: "held", reason: "snapshot-invalid" };
      const initialArtifactHold = scopedArtifactHoldReason(
        resolved.authority.scope,
      );
      if (initialArtifactHold) {
        return { status: "held", reason: initialArtifactHold };
      }
      const existing = await readCheckpoint(resolved.authority.scope);
      if (
        !apiIdentityGenerationIsCurrent(
          resolved.authority.apiIdentityGeneration,
        )
      ) {
        return { status: "held", reason: "identity-changed" };
      }
      const existingArtifactHold = scopedArtifactHoldReason(
        resolved.authority.scope,
      );
      if (existingArtifactHold) {
        return { status: "held", reason: existingArtifactHold };
      }
      if (existing.status === "unavailable") {
        return { status: "held", reason: "vault-unavailable" };
      }
      if (existing.status === "corrupt") {
        return { status: "held", reason: "vault-corrupt" };
      }
      if (existing.status === "ready") {
        return {
          status: "held",
          reason: snapshotsMatch(existing.snapshot, snapshot)
            ? "checkpoint-exists"
            : "checkpoint-conflict",
        };
      }
      const encodedSnapshot = storedSnapshot(snapshot);
      if (!encodedSnapshot) {
        return { status: "held", reason: "vault-unavailable" };
      }
      try {
        await vaultSetJSON(storageKey(resolved.authority.scope), {
          version: VERSION,
          scope: resolved.authority.scope,
          snapshot: encodedSnapshot,
        } satisfies StoredFireEnvelope);
      } catch {
        return { status: "held", reason: "vault-unavailable" };
      }
      if (
        !apiIdentityGenerationIsCurrent(
          resolved.authority.apiIdentityGeneration,
        )
      ) {
        return { status: "held", reason: "identity-changed" };
      }
      const persisted = await readCheckpoint(resolved.authority.scope);
      if (
        !apiIdentityGenerationIsCurrent(
          resolved.authority.apiIdentityGeneration,
        )
      ) {
        return { status: "held", reason: "identity-changed" };
      }
      const finalArtifactHold = scopedArtifactHoldReason(
        resolved.authority.scope,
      );
      if (finalArtifactHold) {
        return { status: "held", reason: finalArtifactHold };
      }
      if (
        persisted.status === "unavailable" ||
        persisted.status === "missing"
      ) {
        return { status: "held", reason: "vault-unavailable" };
      }
      if (persisted.status === "corrupt") {
        return { status: "held", reason: "vault-corrupt" };
      }
      if (!snapshotsMatch(persisted.snapshot, snapshot)) {
        return { status: "held", reason: "checkpoint-conflict" };
      }
      return { status: "ready", snapshot: persisted.snapshot };
    });
  },

  settle(
    authority: WebhookPlaygroundFireRecoveryAuthority | null | undefined,
    value: WebhookPlaygroundFireSnapshot,
  ): Promise<WebhookPlaygroundFireRecoverySettleResult> {
    return exclusive(async () => {
      const resolved = resolveAuthority(authority);
      if (resolved.status === "held") return resolved;
      const snapshot = normalizeSnapshot(value);
      if (!snapshot) return { status: "held", reason: "snapshot-invalid" };
      const initialArtifactHold = scopedArtifactHoldReason(
        resolved.authority.scope,
      );
      if (initialArtifactHold) {
        return { status: "held", reason: initialArtifactHold };
      }
      const existing = await readCheckpoint(resolved.authority.scope);
      if (
        !apiIdentityGenerationIsCurrent(
          resolved.authority.apiIdentityGeneration,
        )
      ) {
        return { status: "held", reason: "identity-changed" };
      }
      const existingArtifactHold = scopedArtifactHoldReason(
        resolved.authority.scope,
      );
      if (existingArtifactHold) {
        return { status: "held", reason: existingArtifactHold };
      }
      if (existing.status === "missing") return { status: "clear" };
      if (existing.status === "unavailable") {
        return { status: "held", reason: "vault-unavailable" };
      }
      if (existing.status === "corrupt") {
        return { status: "held", reason: "vault-corrupt" };
      }
      if (!snapshotsMatch(existing.snapshot, snapshot)) {
        return { status: "held", reason: "checkpoint-mismatch" };
      }
      try {
        vaultDelete(storageKey(resolved.authority.scope));
      } catch {
        return { status: "held", reason: "vault-unavailable" };
      }
      const deleted = await readCheckpoint(resolved.authority.scope);
      if (
        !apiIdentityGenerationIsCurrent(
          resolved.authority.apiIdentityGeneration,
        )
      ) {
        return { status: "held", reason: "identity-changed" };
      }
      if (deleted.status === "corrupt") {
        return { status: "held", reason: "vault-corrupt" };
      }
      if (deleted.status !== "missing") {
        return { status: "held", reason: "vault-unavailable" };
      }
      const finalArtifactHold = scopedArtifactHoldReason(
        resolved.authority.scope,
      );
      if (finalArtifactHold) {
        return { status: "held", reason: finalArtifactHold };
      }
      return { status: "cleared" };
    });
  },
} as const;
