import { opaqueVaultKey } from "./opaque-vault-key";
import { registerPrivateSessionReset } from "./private-session-state";

export type CampaignTemplateDiscoveryCreateKind = "collection" | "saved-search";

export interface CampaignTemplateDiscoveryCreateAttempt {
  fingerprint: string;
  key: string;
  /** Kept only in memory so input changes can retire the durable marker. */
  signature: string;
}

export type CampaignTemplateDiscoveryCreatePreparation =
  | {
      ok: true;
      attempt: CampaignTemplateDiscoveryCreateAttempt;
      reused: boolean;
    }
  | {
      ok: false;
      reason:
        | "identity-unavailable"
        | "fingerprint-unavailable"
        | "recovery-record-invalid"
        | "storage-unavailable";
    };

interface StoredCreateAttempt {
  version: 1;
  fingerprint: string;
  key: string;
}

const STORAGE_PREFIX = "postwave.template-discovery-create.v1";
const IDENTITY_SCOPE_RE = /^[a-f0-9]{16}$/u;
const FINGERPRINT_RE = /^template-create:sha256:[a-f0-9]{64}$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_RECORD_BYTES = 1_024;
const MAX_KEY_BYTES = 255;

function purgeCampaignTemplateDiscoveryCreateRecords(): void {
  if (typeof window === "undefined") return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(`${STORAGE_PREFIX}.`)) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // A hardened webview can deny enumeration; scope-keyed reads still prevent
    // a marker from crossing into a different authenticated workspace.
  }
}

registerPrivateSessionReset(
  "campaign-template-discovery-create",
  purgeCampaignTemplateDiscoveryCreateRecords,
);

function storageKey(
  identityScope: string,
  kind: CampaignTemplateDiscoveryCreateKind,
): string | null {
  return IDENTITY_SCOPE_RE.test(identityScope)
    ? `${STORAGE_PREFIX}.${identityScope}.${kind}`
    : null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function validIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !CONTROL_RE.test(value) &&
    new TextEncoder().encode(value.trim()).byteLength <= MAX_KEY_BYTES
  );
}

function decodeStoredAttempt(raw: string): StoredCreateAttempt | null {
  if (new TextEncoder().encode(raw).byteLength > MAX_RECORD_BYTES) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      !hasOnlyKeys(record, ["version", "fingerprint", "key"]) ||
      record.version !== 1 ||
      typeof record.fingerprint !== "string" ||
      !FINGERPRINT_RE.test(record.fingerprint) ||
      !validIdempotencyKey(record.key)
    ) {
      return null;
    }
    return {
      version: 1,
      fingerprint: record.fingerprint,
      key: record.key,
    };
  } catch {
    return null;
  }
}

function readStoredAttempt(key: string):
  | { state: "empty" }
  | { state: "invalid" }
  | {
      state: "ready";
      value: StoredCreateAttempt;
    } {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return { state: "empty" };
    const value = decodeStoredAttempt(raw);
    return value ? { state: "ready", value } : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

function removeStoredAttempt(key: string): boolean {
  try {
    window.localStorage.removeItem(key);
    return window.localStorage.getItem(key) === null;
  } catch {
    return false;
  }
}

function writeStoredAttempt(key: string, value: StoredCreateAttempt): boolean {
  const raw = JSON.stringify(value);
  if (new TextEncoder().encode(raw).byteLength > MAX_RECORD_BYTES) return false;
  try {
    window.localStorage.setItem(key, raw);
    return window.localStorage.getItem(key) === raw;
  } catch {
    return false;
  }
}

export async function campaignTemplateDiscoveryCreateFingerprint(
  kind: CampaignTemplateDiscoveryCreateKind,
  signature: string,
): Promise<string | null> {
  return opaqueVaultKey("template-create", JSON.stringify([kind, signature]));
}

/**
 * Checkpoint a create identity before dispatch. The record deliberately stores
 * only an opaque payload fingerprint and the retry key, never the draft.
 */
export async function prepareCampaignTemplateDiscoveryCreate(
  identityScope: string | null,
  kind: CampaignTemplateDiscoveryCreateKind,
  signature: string,
  createKey: () => string,
): Promise<CampaignTemplateDiscoveryCreatePreparation> {
  if (!identityScope) return { ok: false, reason: "identity-unavailable" };
  const key = storageKey(identityScope, kind);
  if (!key) return { ok: false, reason: "identity-unavailable" };
  const fingerprint = await campaignTemplateDiscoveryCreateFingerprint(
    kind,
    signature,
  );
  if (!fingerprint || !FINGERPRINT_RE.test(fingerprint)) {
    return { ok: false, reason: "fingerprint-unavailable" };
  }

  const stored = readStoredAttempt(key);
  if (stored.state === "invalid") {
    // An unknown create may already have reached the server. Never overwrite a
    // malformed recovery marker and risk minting a duplicate identity.
    return { ok: false, reason: "recovery-record-invalid" };
  }
  if (stored.state === "ready" && stored.value.fingerprint === fingerprint) {
    return {
      ok: true,
      attempt: {
        fingerprint,
        key: stored.value.key,
        signature,
      },
      reused: true,
    };
  }
  if (stored.state === "ready" && !removeStoredAttempt(key)) {
    return { ok: false, reason: "storage-unavailable" };
  }

  const idempotencyKey = createKey();
  if (!validIdempotencyKey(idempotencyKey)) {
    return { ok: false, reason: "storage-unavailable" };
  }
  if (
    !writeStoredAttempt(key, {
      version: 1,
      fingerprint,
      key: idempotencyKey,
    })
  ) {
    return { ok: false, reason: "storage-unavailable" };
  }
  return {
    ok: true,
    attempt: { fingerprint, key: idempotencyKey, signature },
    reused: false,
  };
}

export function clearCampaignTemplateDiscoveryCreate(
  identityScope: string | null,
  kind: CampaignTemplateDiscoveryCreateKind,
): boolean {
  if (!identityScope) return true;
  const key = storageKey(identityScope, kind);
  return key ? removeStoredAttempt(key) : false;
}
