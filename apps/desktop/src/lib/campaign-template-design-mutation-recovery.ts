import { opaqueVaultKey } from "./opaque-vault-key";
import { registerPrivateSessionReset } from "./private-session-state";
import {
  vaultDelete,
  vaultDeletePrefix,
  vaultReadJSON,
  vaultSetJSON,
} from "./secure-vault";

export type CampaignTemplateDesignMutationOperation =
  | "archive"
  | "create-campaign"
  | "refine"
  | "retry"
  | "save";

export type CampaignTemplateDesignMutationPayload = Record<string, unknown> & {
  design_id: string;
};

export interface CampaignTemplateDesignPendingMutation {
  operation: CampaignTemplateDesignMutationOperation;
  fingerprint: string;
  payload: CampaignTemplateDesignMutationPayload;
  key: string;
  createdAt: string;
}

export type CampaignTemplateDesignPendingMutationRead =
  | { state: "empty" }
  | { state: "invalid" }
  | { state: "unavailable" }
  | {
      state: "ready";
      mutation: CampaignTemplateDesignPendingMutation;
    };

export type CampaignTemplateDesignMutationPreparation =
  | {
      ok: true;
      mutation: CampaignTemplateDesignPendingMutation;
      reused: boolean;
    }
  | {
      ok: false;
      reason:
        | "fingerprint-unavailable"
        | "identity-unavailable"
        | "pending-mutation-conflict"
        | "recovery-record-invalid"
        | "storage-unavailable";
    };

type RecoveryStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

interface StoredMutation {
  version: 1;
  operation: CampaignTemplateDesignMutationOperation;
  fingerprint: string;
  payload: CampaignTemplateDesignMutationPayload;
  key: string;
  createdAt: string;
}

const STORAGE_PREFIX = "postwave.template-design-mutation.v1";
const IDENTITY_SCOPE_RE = /^[a-f0-9]{16}$/u;
const FINGERPRINT_RE = /^template-mutation:sha256:[a-f0-9]{64}$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const OPERATIONS = new Set<CampaignTemplateDesignMutationOperation>([
  "archive",
  "create-campaign",
  "refine",
  "retry",
  "save",
]);
const MAX_RECORD_BYTES = 64 * 1_024;
const MAX_PAYLOAD_BYTES = 32 * 1_024;
const MAX_KEY_BYTES = 255;
const MAX_DESIGN_ID_BYTES = 255;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

function storageKey(identityScope: string): string | null {
  return IDENTITY_SCOPE_RE.test(identityScope)
    ? `${STORAGE_PREFIX}.${identityScope}`
    : null;
}

function removeLegacyPlaintextRecord(key: string): boolean {
  try {
    window.localStorage.removeItem(key);
    return window.localStorage.getItem(key) === null;
  } catch {
    return false;
  }
}

function invalidMarkerKey(key: string): string {
  return `${key}.invalid`;
}

function invalidMarkerState(key: string): "clear" | "invalid" | "unavailable" {
  try {
    return window.localStorage.getItem(invalidMarkerKey(key)) === null
      ? "clear"
      : "invalid";
  } catch {
    return "unavailable";
  }
}

function persistInvalidMarker(
  key: string,
): CampaignTemplateDesignPendingMutationRead {
  try {
    const markerKey = invalidMarkerKey(key);
    window.localStorage.setItem(markerKey, "1");
    return window.localStorage.getItem(markerKey) === "1"
      ? { state: "invalid" }
      : { state: "unavailable" };
  } catch {
    return { state: "unavailable" };
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function validMutationKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.trim() === value &&
    !CONTROL_RE.test(value) &&
    byteLength(value) <= MAX_KEY_BYTES
  );
}

function validDesignId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.trim() === value &&
    !CONTROL_RE.test(value) &&
    byteLength(value) <= MAX_DESIGN_ID_BYTES
  );
}

function serializePayload(value: unknown): {
  payload: CampaignTemplateDesignMutationPayload;
  serialized: string;
} | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || byteLength(serialized) > MAX_PAYLOAD_BYTES) return null;
    const parsed: unknown = JSON.parse(serialized);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const payload = parsed as CampaignTemplateDesignMutationPayload;
    if (!validDesignId(payload.design_id)) return null;
    return { payload, serialized };
  } catch {
    return null;
  }
}

function decodeStoredMutation(raw: string, now: number): StoredMutation | null {
  if (byteLength(raw) > MAX_RECORD_BYTES) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const operation = record.operation;
    const createdAt = record.createdAt;
    const payload = serializePayload(record.payload);
    if (
      !hasOnlyKeys(record, [
        "version",
        "operation",
        "fingerprint",
        "payload",
        "key",
        "createdAt",
      ]) ||
      record.version !== 1 ||
      typeof operation !== "string" ||
      !OPERATIONS.has(operation as CampaignTemplateDesignMutationOperation) ||
      typeof record.fingerprint !== "string" ||
      !FINGERPRINT_RE.test(record.fingerprint) ||
      !payload ||
      !validMutationKey(record.key) ||
      typeof createdAt !== "string" ||
      !Number.isFinite(Date.parse(createdAt)) ||
      now - Date.parse(createdAt) < 0 ||
      now - Date.parse(createdAt) > MAX_AGE_MS
    ) {
      return null;
    }
    return {
      version: 1,
      operation: operation as CampaignTemplateDesignMutationOperation,
      fingerprint: record.fingerprint,
      payload: payload.payload,
      key: record.key,
      createdAt,
    };
  } catch {
    return null;
  }
}

async function mutationFingerprint(
  operation: CampaignTemplateDesignMutationOperation,
  serializedPayload: string,
): Promise<string | null> {
  return opaqueVaultKey(
    "template-mutation",
    JSON.stringify([operation, serializedPayload]),
  );
}

function toPublicMutation(
  mutation: StoredMutation,
): CampaignTemplateDesignPendingMutation {
  return {
    operation: mutation.operation,
    fingerprint: mutation.fingerprint,
    payload: mutation.payload,
    key: mutation.key,
    createdAt: mutation.createdAt,
  };
}

async function readStoredMutation(
  key: string,
  storage: RecoveryStorage | undefined,
  now: number,
): Promise<CampaignTemplateDesignPendingMutationRead> {
  let raw: string | null = null;
  let legacyPlaintext = false;
  if (storage) {
    try {
      raw = storage.getItem(key);
    } catch {
      return { state: "unavailable" };
    }
  } else {
    const marker = invalidMarkerState(key);
    if (marker === "invalid") return { state: "invalid" };
    if (marker === "unavailable") return { state: "unavailable" };
    const read = await vaultReadJSON<unknown>(key);
    if (read.status === "missing") {
      try {
        raw = window.localStorage.getItem(key);
        legacyPlaintext = raw !== null;
      } catch {
        return { state: "unavailable" };
      }
      if (raw === null) return { state: "empty" };
    }
    if (read.status === "unavailable") return { state: "unavailable" };
    if (read.status === "corrupt") return persistInvalidMarker(key);
    if (read.status === "ready") {
      try {
        const serialized = JSON.stringify(read.value);
        if (typeof serialized !== "string") return persistInvalidMarker(key);
        raw = serialized;
        if (
          window.localStorage.getItem(key) !== null &&
          !removeLegacyPlaintextRecord(key)
        ) {
          return { state: "unavailable" };
        }
      } catch {
        return persistInvalidMarker(key);
      }
    }
  }
  if (raw === null) return { state: "empty" };
  const mutation = decodeStoredMutation(raw, now);
  if (!mutation) {
    if (legacyPlaintext && !removeLegacyPlaintextRecord(key)) {
      return { state: "unavailable" };
    }
    return storage ? { state: "invalid" } : persistInvalidMarker(key);
  }
  const payload = serializePayload(mutation.payload);
  if (!payload) {
    if (legacyPlaintext && !removeLegacyPlaintextRecord(key)) {
      return { state: "unavailable" };
    }
    return storage ? { state: "invalid" } : persistInvalidMarker(key);
  }
  const fingerprint = await mutationFingerprint(
    mutation.operation,
    payload.serialized,
  );
  if (!fingerprint) return { state: "unavailable" };
  if (fingerprint !== mutation.fingerprint) {
    if (legacyPlaintext && !removeLegacyPlaintextRecord(key)) {
      return { state: "unavailable" };
    }
    return storage ? { state: "invalid" } : persistInvalidMarker(key);
  }
  if (legacyPlaintext) {
    try {
      await vaultSetJSON(key, mutation);
      if (!removeLegacyPlaintextRecord(key)) {
        return { state: "unavailable" };
      }
    } catch {
      return { state: "unavailable" };
    }
  }
  return { state: "ready", mutation: toPublicMutation(mutation) };
}

export async function readCampaignTemplateDesignPendingMutation(
  identityScope: string | null,
  storage?: RecoveryStorage,
  now = Date.now(),
): Promise<CampaignTemplateDesignPendingMutationRead> {
  if (!identityScope) return { state: "unavailable" };
  const key = storageKey(identityScope);
  if (!key) return { state: "unavailable" };
  return readStoredMutation(key, storage, now);
}

/**
 * Durably checkpoint a mutation before dispatch. A different unresolved
 * mutation is never overwritten: the server must be reconciled first.
 */
export async function prepareCampaignTemplateDesignMutation(
  identityScope: string | null,
  operation: CampaignTemplateDesignMutationOperation,
  payloadValue: CampaignTemplateDesignMutationPayload,
  createKey: () => string,
  storage?: RecoveryStorage,
  now = Date.now(),
): Promise<CampaignTemplateDesignMutationPreparation> {
  if (!identityScope) return { ok: false, reason: "identity-unavailable" };
  const key = storageKey(identityScope);
  if (!key) return { ok: false, reason: "identity-unavailable" };
  const payload = serializePayload(payloadValue);
  if (!payload) return { ok: false, reason: "recovery-record-invalid" };
  const fingerprint = await mutationFingerprint(operation, payload.serialized);
  if (!fingerprint || !FINGERPRINT_RE.test(fingerprint)) {
    return { ok: false, reason: "fingerprint-unavailable" };
  }

  const existing = await readStoredMutation(key, storage, now);
  if (existing.state === "invalid") {
    return { ok: false, reason: "recovery-record-invalid" };
  }
  if (existing.state === "unavailable") {
    return { ok: false, reason: "storage-unavailable" };
  }
  if (existing.state === "ready") {
    if (
      existing.mutation.operation === operation &&
      existing.mutation.fingerprint === fingerprint
    ) {
      return { ok: true, mutation: existing.mutation, reused: true };
    }
    return { ok: false, reason: "pending-mutation-conflict" };
  }

  const idempotencyKey = createKey();
  if (!validMutationKey(idempotencyKey)) {
    return { ok: false, reason: "storage-unavailable" };
  }
  const stored: StoredMutation = {
    version: 1,
    operation,
    fingerprint,
    payload: payload.payload,
    key: idempotencyKey,
    createdAt: new Date(now).toISOString(),
  };
  const raw = JSON.stringify(stored);
  if (byteLength(raw) > MAX_RECORD_BYTES) {
    return { ok: false, reason: "recovery-record-invalid" };
  }
  if (storage) {
    try {
      storage.setItem(key, raw);
      if (storage.getItem(key) !== raw) {
        return { ok: false, reason: "storage-unavailable" };
      }
    } catch {
      return { ok: false, reason: "storage-unavailable" };
    }
  } else {
    try {
      await vaultSetJSON(key, stored);
      const verified = await readStoredMutation(key, undefined, now);
      if (
        verified.state !== "ready" ||
        verified.mutation.fingerprint !== stored.fingerprint ||
        verified.mutation.key !== stored.key
      ) {
        return { ok: false, reason: "storage-unavailable" };
      }
    } catch {
      return { ok: false, reason: "storage-unavailable" };
    }
  }
  return {
    ok: true,
    mutation: toPublicMutation(stored),
    reused: false,
  };
}

export async function clearCampaignTemplateDesignPendingMutation(
  identityScope: string | null,
  expected: Pick<CampaignTemplateDesignPendingMutation, "fingerprint" | "key">,
  storage?: RecoveryStorage,
): Promise<boolean> {
  if (!identityScope) return false;
  const key = storageKey(identityScope);
  if (!key) return false;
  const existing = await readStoredMutation(key, storage, Date.now());
  if (
    existing.state !== "ready" ||
    existing.mutation.fingerprint !== expected.fingerprint ||
    existing.mutation.key !== expected.key
  ) {
    return false;
  }
  if (storage) {
    try {
      storage.removeItem(key);
      return storage.getItem(key) === null;
    } catch {
      return false;
    }
  }
  try {
    vaultDelete(key);
    const deleted = (await vaultReadJSON(key)).status === "missing";
    if (deleted) window.localStorage.removeItem(invalidMarkerKey(key));
    return (
      deleted && window.localStorage.getItem(invalidMarkerKey(key)) === null
    );
  } catch {
    return false;
  }
}

function purgeCampaignTemplateDesignMutationRecords(): void {
  if (typeof window === "undefined") return;
  vaultDeletePrefix(`${STORAGE_PREFIX}.`);
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(`${STORAGE_PREFIX}.`)) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // Scope-keyed reads still prevent adoption after a workspace switch.
  }
}

registerPrivateSessionReset(
  "campaign-template-design-mutations",
  purgeCampaignTemplateDesignMutationRecords,
);
