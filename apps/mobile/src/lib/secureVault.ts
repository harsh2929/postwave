import * as SecureStore from "expo-secure-store";

import { utf8ByteLength } from "./utf8";

export type SensitiveVaultKind =
  | "subscriber"
  | "audit"
  | "campaign"
  | "suppression"
  | "inbound-webhook"
  | "offline-failure"
  // Cold-offline projections for the automation cluster. Both are minimised
  // by lib/sequenceSnapshot before they reach the vault — an un-minimised
  // sequence exceeds MAX_BYTES and would be silently dropped.
  | "sequence"
  | "voice"
  // Workspace headline counts for a cold offline launch. Deliberately NOT the
  // stats payload: lib/dashboardOfflineProjection.ts allowlists counts only
  // and drops recent_audit, which carries teammate identities.
  | "dashboard";

const PREFIX = "postwave.mobile.vault.v3";
const LEGACY_PREFIXES = [
  "postwave.mobile.vault.v2",
  "postwave.mobile.vault.v1",
] as const;
const MANIFEST_KEY = `${PREFIX}.__manifest`;
const CLEANUP_PENDING_KEY = `${PREFIX}.__cleanup_pending`;
const LEGACY_MANIFEST_KEYS = LEGACY_PREFIXES.map(
  (prefix) => `${prefix}.__manifest`,
);
const MAX_BYTES = 24_000;
const MAX_ID_CHARS = 160;
const MAX_MANIFEST_KEYS = 256;
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_SCOPE = "global";
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export type VaultOptions = {
  scope?: string;
  ttlMs?: number;
};

// SecureStore has no multi-key transaction or prefix enumeration. Serialize
// every manifest mutation, register a key before its payload is written, and
// retain failed cleanup keys in the manifest. This gives each failure mode a
// deterministic retry path instead of creating an unenumerable orphan.
let vaultMutationQueue: Promise<void> = Promise.resolve();

function runVaultMutation<T>(operation: () => Promise<T>): Promise<T> {
  const task = vaultMutationQueue.then(operation, operation);
  vaultMutationQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

/**
 * Build the only accepted cache identity: API origin + tenant + human user +
 * effective role. API-key mode deliberately does not use this vault because
 * it has no human user/role boundary for a shared-device projection.
 */
export function vaultScopeForClient(input: {
  baseUrl: string;
  tenantId: string;
  userId: string;
  role: string;
}): string {
  const fields = [
    input.baseUrl.trim().replace(/\/+$/, ""),
    input.tenantId.trim(),
    input.userId.trim(),
    input.role.trim().toLowerCase(),
  ];
  if (fields.some((field) => !field || field.length > 512)) {
    throw new Error("Invalid secure vault identity scope");
  }
  return JSON.stringify(fields);
}

export function vaultSetJSON(
  kind: SensitiveVaultKind,
  id: string,
  value: unknown,
  options: VaultOptions | number = {},
): Promise<void> {
  const opts = normalizeOptions(options);
  const now = Date.now();
  const safeTtlMs =
    Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
  const payload = JSON.stringify({
    schema_version: 3,
    kind,
    id,
    scope: opts.scope,
    written_at: new Date(now).toISOString(),
    expires_at: new Date(now + safeTtlMs).toISOString(),
    value,
  });
  if (utf8ByteLength(payload) > MAX_BYTES) {
    return Promise.resolve();
  }
  const key = vaultKey(kind, id, opts.scope);
  return runVaultMutation(async () => {
    // Manifest first: if the payload write fails, clear can still delete this
    // tombstone. Writing payload first could leave an unenumerable orphan.
    await registerVaultKey(key);
    await SecureStore.setItemAsync(key, payload, SECURE_OPTIONS);
  });
}

export async function vaultGetJSON<T>(
  kind: SensitiveVaultKind,
  id: string,
  options: VaultOptions = {},
): Promise<T | null> {
  const opts = normalizeOptions(options);
  const key = vaultKey(kind, id, opts.scope);
  const raw = await SecureStore.getItemAsync(key, SECURE_OPTIONS);
  if (!raw) return null;
  if (utf8ByteLength(raw) > MAX_BYTES) {
    await vaultDelete(kind, id, opts);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      schema_version?: number;
      expires_at?: string;
      scope?: string;
      value?: T;
    };
    if (parsed.schema_version !== 3 || parsed.scope !== opts.scope) {
      await vaultDelete(kind, id, opts);
      return null;
    }
    const expiresAt =
      typeof parsed.expires_at === "string"
        ? Date.parse(parsed.expires_at)
        : Number.NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      await vaultDelete(kind, id, opts);
      return null;
    }
    return parsed.value ?? null;
  } catch {
    await vaultDelete(kind, id, opts);
    return null;
  }
}

export function vaultDelete(
  kind: SensitiveVaultKind,
  id: string,
  options: VaultOptions = {},
): Promise<void> {
  const opts = normalizeOptions(options);
  const key = vaultKey(kind, id, opts.scope);
  return runVaultMutation(async () => {
    // If deletion fails, deregistration is never attempted; the key remains
    // discoverable for retry. A stale manifest after a deregistration failure
    // is safe and is compacted by the next clear.
    await SecureStore.deleteItemAsync(key, SECURE_OPTIONS);
    await deregisterVaultKey(key);
  });
}

/**
 * Purge every current and legacy vault entry. Any failed deletion remains in
 * its manifest, and the cleanup marker survives so a later startup/logout can
 * retry. Callers must not report a verified purge when this rejects.
 */
export function vaultClear(): Promise<void> {
  return runVaultMutation(async () => {
    await SecureStore.setItemAsync(
      CLEANUP_PENDING_KEY,
      String(Date.now()),
      SECURE_OPTIONS,
    );
    // The three manifests address disjoint key namespaces (v3 / v2 / v1) and
    // no purge reads what another wrote, so they run together rather than one
    // after the next. `allSettled` keeps the original semantics exactly: every
    // manifest is attempted even when an earlier one fails, each retains its
    // own failed keys, and any failure still rejects the whole purge so no
    // caller can report a verified wipe.
    const results = await Promise.allSettled(
      [MANIFEST_KEY, ...LEGACY_MANIFEST_KEYS].map((manifestKey) =>
        clearManifestEntries(manifestKey),
      ),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new Error("Secure offline data cleanup is incomplete");
    }
    await SecureStore.deleteItemAsync(CLEANUP_PENDING_KEY, SECURE_OPTIONS);
  });
}

/** Retry a previously interrupted/failed purge before an identity reuses it. */
export async function vaultRecoverPendingCleanup(): Promise<boolean> {
  const pending = await SecureStore.getItemAsync(
    CLEANUP_PENDING_KEY,
    SECURE_OPTIONS,
  );
  if (!pending) return false;
  await vaultClear();
  return true;
}

async function readManifest(key = MANIFEST_KEY): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(key, SECURE_OPTIONS);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Secure vault manifest is corrupt");
  }
  const keys = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        (parsed as { version?: unknown }).version === 3
      ? (parsed as { keys?: unknown }).keys
      : null;
  if (!Array.isArray(keys) || keys.length > MAX_MANIFEST_KEYS) {
    throw new Error("Secure vault manifest is invalid");
  }
  const expectedPrefix = `${manifestPrefix(key)}.`;
  const normalized = keys.filter(
    (candidate): candidate is string =>
      typeof candidate === "string" &&
      candidate.startsWith(expectedPrefix) &&
      candidate !== key &&
      candidate.length <= 900,
  );
  if (normalized.length !== keys.length) {
    throw new Error("Secure vault manifest contains an invalid key");
  }
  return [...new Set(normalized)];
}

async function writeManifest(
  keys: string[],
  key = MANIFEST_KEY,
): Promise<void> {
  if (keys.length === 0) {
    await SecureStore.deleteItemAsync(key, SECURE_OPTIONS);
    return;
  }
  if (keys.length > MAX_MANIFEST_KEYS) {
    throw new Error("Secure vault entry limit reached");
  }
  const value =
    key === MANIFEST_KEY
      ? JSON.stringify({ version: 3, keys })
      : JSON.stringify(keys);
  await SecureStore.setItemAsync(key, value, SECURE_OPTIONS);
}

async function registerVaultKey(key: string): Promise<void> {
  const keys = await readManifest(MANIFEST_KEY);
  if (!keys.includes(key)) {
    await writeManifest([...keys, key], MANIFEST_KEY);
  }
}

async function deregisterVaultKey(key: string): Promise<void> {
  const keys = await readManifest(MANIFEST_KEY);
  const next = keys.filter((candidate) => candidate !== key);
  if (next.length !== keys.length) {
    await writeManifest(next, MANIFEST_KEY);
  }
}

async function clearManifestEntries(manifestKey: string): Promise<void> {
  const keys = await readManifest(manifestKey);
  // Concurrent, not serial. Every key in a manifest is an independent Keychain
  // item: deleting them in a fixed order carries no meaning, and nothing here
  // reads a key it has just deleted. Awaiting one at a time multiplied the
  // native round trip by the entry count -- a 40-entry manifest cost 40
  // sequential trips (~80-120ms at 2-3ms each) on the sign-out path, and on
  // the COLD BOOT path when vaultRecoverPendingCleanup retries an interrupted
  // purge before `hydrated` can flip.
  //
  // `allSettled`, not `all`: the per-key failure list is the retry contract.
  // A rejected delete must leave that key in the manifest so a later purge can
  // find it, and one failure must not cancel the other deletions the way
  // `Promise.all` short-circuits a caller.
  // A key SecureStore will not accept cannot name a stored item, so there is
  // nothing to delete and retrying it forever is what kept the marker set.
  // Drop those from the manifest instead of treating them as failures — this
  // is the repair path for installs that already recorded colon-bearing keys
  // under the old sanitiser.
  const deletable = keys.filter((key) => isStorableSecureKey(key));
  const results = await Promise.allSettled(
    deletable.map((key) => SecureStore.deleteItemAsync(key, SECURE_OPTIONS)),
  );
  const failures = deletable.filter(
    (_key, index) => results[index]?.status === "rejected",
  );
  if (failures.length > 0) {
    await writeManifest(failures, manifestKey);
    throw new Error("Secure vault entries remain after cleanup");
  }
  await SecureStore.deleteItemAsync(manifestKey, SECURE_OPTIONS);
}

function normalizeOptions(
  options: VaultOptions | number,
): Required<VaultOptions> {
  if (typeof options === "number") {
    return { scope: DEFAULT_SCOPE, ttlMs: options };
  }
  return {
    scope: safeScope(options.scope),
    ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
  };
}

function safeScope(scope: string | undefined): string {
  const value =
    typeof scope === "string" && scope.trim() ? scope.trim() : DEFAULT_SCOPE;
  return safeVaultId(value);
}

function vaultKey(kind: SensitiveVaultKind, id: string, scope: string): string {
  return `${PREFIX}.${scope}.${kind}.${safeVaultId(id)}`;
}

/**
 * The character set expo-secure-store actually accepts.
 *
 * Its own validator is `/^[\w.-]+$/` (SecureStore.ts isValidKey), i.e.
 * alphanumerics, underscore, dot and hyphen — and NOTHING else. This regex is
 * kept here as the single place that knowledge lives so the sanitiser and the
 * manifest repair below cannot drift apart.
 */
const SECURE_STORE_KEY_RE = /^[\w.-]+$/u;

/** Whether SecureStore will accept this key at all. */
export function isStorableSecureKey(key: string): boolean {
  return SECURE_STORE_KEY_RE.test(key);
}

function safeVaultId(id: string): string {
  // ":" WAS IN THIS CLASS AND MUST NOT BE.
  //
  // Every scope is built from the API origin (vaultScopeForClient), and every
  // origin contains "://". Permitting the colon meant every scoped key looked
  // like `postwave.mobile.vault.v3.__https:__api.example.com__...`, which
  // SecureStore rejects outright — so the offline vault silently stored
  // nothing, and worse, `vaultClear` could never delete the keys the manifest
  // had recorded. That failure set the cleanup-pending marker, and that marker
  // disables sign-in. A one-character character-class bug latched the whole app
  // shut after any sign-out.
  const sanitized = id.replace(/[^a-zA-Z0-9_.-]/g, "_") || "_";
  if (sanitized.length <= MAX_ID_CHARS) return sanitized;
  return `${sanitized.slice(0, 96)}_${hashString(sanitized)}`;
}

function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function manifestPrefix(manifestKey: string): string {
  return manifestKey.endsWith(".__manifest")
    ? manifestKey.slice(0, -".__manifest".length)
    : PREFIX;
}
