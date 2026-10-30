import {
  vaultDelete,
  vaultDeletePrefix,
  vaultGetJSON,
  vaultReadJSON,
  vaultSetJSON,
} from "./secure-vault";
import type { QueueReceipt } from "./api/result";
import { readContextEpoch } from "./context-epoch";
import {
  deriveOfflineIdentity,
  isOpaqueOfflineIdentity,
} from "./offline-identity";

// The replay-status union + common mutation fields now live in the shared
// @postwave/offline-outbox core (so web + desktop can't drift on them);
// re-exported so every existing `from "./offline-store"` import is unchanged.
// Desktop's surface-specific fields extend the core.
import type {
  OfflineMutationCore,
  OfflineReplayStatus,
} from "@postwave/offline-outbox";

export type { OfflineReplayStatus };

export interface OfflineMutation extends OfflineMutationCore {
  retryAfterMs?: number;
  identity?: string;
  /** Human-facing journal labels; raw method/path stay diagnostic-only. */
  actionLabel?: string;
  recordLabel?: string;
}

export interface OfflineJournalEntry {
  id: string;
  queuedAt: string;
  resolvedAt: string;
  status: "synced" | "discarded";
  resource: string;
  actionLabel: string;
  recordLabel: string;
}

interface QueueEnvelope {
  version: 3;
  identity: string;
  writtenAt: string;
  items: OfflineMutation[];
  history?: OfflineJournalEntry[];
}

interface LegacyQueueEnvelope {
  version: 2;
  identity: string;
  writtenAt: string;
  items: OfflineMutation[];
}

interface CacheEntry<T = unknown> {
  path: string;
  identity: string;
  cachedAt: string;
  expiresAt: string;
  data: T;
}

interface CacheEnvelope {
  version: 2;
  identity: string;
  writtenAt: string;
  entries: CacheEntry[];
}

const LEGACY_QUEUE_KEY = "postwave.desktop.offline-mutations.v1";
const LEGACY_CACHE_PREFIX = "postwave.desktop.offline-cache.v1:";
const LEGACY_IDENTITY_KEY = "postwave.desktop.offline-identity.v1";
const IDENTITY_KEY = "postwave.desktop.offline-identity.v2";
const VAULT_QUEUE_PREFIX = "offline-outbox.v3:";
const LEGACY_VAULT_QUEUE_PREFIX = "offline-outbox.v2:";
const VAULT_CACHE_PREFIX = "offline-cache.v2:";
const MAX_IDENTITY_CHARS = 120;
const MAX_QUEUE_ITEMS = 200;
const MAX_JOURNAL_HISTORY_ITEMS = 100;
// Leave room under the vault's 512 KiB plaintext ceiling for the envelope and
// the bounded, payload-free recent outcome journal.
const MAX_QUEUE_STORAGE_BYTES = 400 * 1024;
// Leave headroom under the native vault's 512 KiB plaintext ceiling for the
// authenticated cache envelope (identity, timestamps, paths and JSON framing).
const MAX_CACHE_STORAGE_BYTES = 480 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;
const ENVELOPE_VERSION = 3 as const;
const CACHE_ENVELOPE_VERSION = 2 as const;
const EXACT_SUBSCRIBER_BASE_VERSION =
  /^"subscriber:([A-Za-z0-9._~-]+):v[0-9]+"$/u;

export { OUTBOX_MAX_ATTEMPTS } from "@postwave/offline-outbox";
export const OFFLINE_REPLAY_POLICY_CHANGED_MESSAGE =
  "This queued change is no longer replayable. Retry it while online.";
export const OFFLINE_SUBSCRIBER_RECONCILIATION_REQUIRED_MESSAGE =
  "The prior offline edit synced, but the server did not return a verified revision for this subscriber. Refresh the subscriber before retrying this queued edit.";

let currentIdentity: string | null = null;
let currentIdentitySource: string | null = null;
let identityLoaded = false;
let currentQueue: OfflineMutation[] = [];
let currentHistory: OfflineJournalEntry[] = [];
let currentCache = new Map<string, CacheEntry>();
let persistenceChain: Promise<void> = Promise.resolve();
let storageGeneration = 0;
let persistenceError: string | null = null;
let hydrationBlockedIdentity: string | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let identityRequestGeneration = 0;
let identityTransition: Promise<void> = Promise.resolve();

interface OfflineIdentityMetadata {
  version: 2;
  identity: string;
}

export interface OfflineIdentityOptions {
  /**
   * Exact legacy identities independently proven by the current auth signal.
   * A collision-prone credential fingerprint must never be supplied here.
   */
  legacyIdentities?: string[];
}

const offlineQueueListeners = new Set<() => void>();

export type OfflineEnqueueFailureCode =
  | "identity-unavailable"
  | "policy-refused"
  | "capacity"
  | "persistence-unavailable";

export type OfflineEnqueueResult =
  | { ok: true; item: OfflineMutation; receipt: QueueReceipt }
  | {
      ok: false;
      code: OfflineEnqueueFailureCode;
      message: string;
      preservedDraft?: unknown;
    };

function loadIdentityOnce(): void {
  if (identityLoaded) return;
  identityLoaded = true;
  purgeLegacyPlaintext();
  currentIdentity = readStoredOpaqueIdentity();
}

export function getOfflineIdentity(): string | null {
  loadIdentityOnce();
  return currentIdentity;
}

/**
 * Scope encrypted offline data to one authenticated user/tenant identity.
 * Switching accounts parks the previous identity's encrypted journal. It is
 * never rendered under another identity and is restored when that identity
 * returns; a workspace switch must not silently erase unsynced work.
 */
export function setOfflineIdentity(
  identitySource: string | null,
  options: OfflineIdentityOptions = {},
): Promise<void> {
  loadIdentityOnce();
  const source = normalizeIdentitySource(identitySource);
  const requestGeneration = ++identityRequestGeneration;
  const legacyMarker = readLegacyIdentityMetadata();
  if (
    source &&
    source === currentIdentitySource &&
    currentIdentity &&
    legacyMarker === null
  ) {
    return identityTransition;
  }

  detachOfflineIdentity(true);
  if (!source) {
    currentIdentitySource = null;
    identityTransition = Promise.resolve();
    return identityTransition;
  }

  const independentlyProven = new Set(
    [source, ...(options.legacyIdentities ?? [])]
      .map((value) => normalizeIdentity(value))
      .filter((value): value is string => value !== null),
  );
  identityTransition = deriveOfflineIdentity(source)
    .then(async (opaqueIdentity) => {
      if (
        requestGeneration !== identityRequestGeneration ||
        !opaqueIdentity ||
        !isOpaqueOfflineIdentity(opaqueIdentity)
      ) {
        return;
      }
      currentIdentitySource = source;
      currentIdentity = opaqueIdentity;
      storageGeneration += 1;
      const generation = storageGeneration;
      const legacyIdentity =
        legacyMarker && independentlyProven.has(legacyMarker)
          ? legacyMarker
          : null;
      const migration = legacyIdentity
        ? await migrateLegacyOfflineIdentity(
            legacyIdentity,
            opaqueIdentity,
            generation,
          )
        : null;
      if (
        requestGeneration !== identityRequestGeneration ||
        generation !== storageGeneration ||
        currentIdentity !== opaqueIdentity
      ) {
        return;
      }
      const identityPersisted = persistOpaqueIdentity(opaqueIdentity);
      if (identityPersisted && migration?.complete) {
        migration.deleteLegacyCopies();
      }
      await queueOfflineHydration(opaqueIdentity, generation);
    })
    .catch(() => {
      if (requestGeneration !== identityRequestGeneration) return;
      persistenceError =
        "Moosewave could not establish a private offline workspace identity. Offline data was left untouched and new edits will not be queued.";
      notifyOfflineQueueChanged();
    });
  return identityTransition;
}

/**
 * Load the encrypted outbox/cache before the authenticated shell starts.
 * Legacy plaintext is never migrated into memory: it is purged on first use.
 */
export function hydrateOfflineStores(): Promise<void> {
  loadIdentityOnce();
  return identityTransition
    .catch(() => undefined)
    .then(() => {
      const identity = currentIdentity;
      if (!identity) return persistenceChain;
      return queueOfflineHydration(identity, storageGeneration);
    });
}

function queueOfflineHydration(
  identity: string,
  generation: number,
): Promise<void> {
  persistenceChain = persistenceChain
    .catch(() => undefined)
    .then(async () => {
      if (generation !== storageGeneration || currentIdentity !== identity) {
        return;
      }
      const queueCiphertextPresent =
        vaultCiphertextExists(queueVaultKey(identity)) ||
        vaultCiphertextExists(legacyQueueVaultKey(identity));
      const cacheCiphertextPresent = vaultCiphertextExists(
        cacheVaultKey(identity),
      );
      const [queueEnvelope, legacyQueueEnvelope, cacheEnvelope] =
        await Promise.all([
          vaultGetJSON<QueueEnvelope>(queueVaultKey(identity)),
          vaultGetJSON<LegacyQueueEnvelope>(legacyQueueVaultKey(identity)),
          vaultGetJSON<CacheEnvelope>(cacheVaultKey(identity)),
        ]);
      if (generation !== storageGeneration || currentIdentity !== identity) {
        return;
      }

      if (
        (queueCiphertextPresent && !queueEnvelope && !legacyQueueEnvelope) ||
        (cacheCiphertextPresent && !cacheEnvelope)
      ) {
        hydrationBlockedIdentity = identity;
        persistenceError =
          "Moosewave could not unlock encrypted offline data. Nothing was overwritten; keep the app open and retry after the operating-system credential vault is available.";
      } else {
        hydrationBlockedIdentity = null;
      }

      const sourceQueue = validQueueEnvelope(queueEnvelope, identity)
        ? queueEnvelope.items
        : validLegacyQueueEnvelope(legacyQueueEnvelope, identity)
          ? legacyQueueEnvelope.items
          : [];
      const hydratedQueue = sanitizeOfflineQueueItems(sourceQueue);
      const hydratedHistory = validQueueEnvelope(queueEnvelope, identity)
        ? sanitizeJournalEntries(queueEnvelope.history)
        : [];
      const hydratedCache = validCacheEnvelope(cacheEnvelope, identity)
        ? sanitizeCacheEntries(cacheEnvelope.entries, identity)
        : new Map<string, CacheEntry>();
      // An identity change can be followed immediately by a user edit while
      // keychain I/O is still pending. Preserve those in-memory writes and
      // let them win by id/path over the crash-recovered snapshot.
      const liveIDs = new Set(currentQueue.map((item) => item.id));
      currentQueue = [
        ...hydratedQueue.filter((item) => !liveIDs.has(item.id)),
        ...currentQueue,
      ];
      currentHistory = mergeJournalHistory(hydratedHistory, currentHistory);
      currentCache = new Map([...hydratedCache, ...currentCache]);
      scheduleExpiryCleanup();
      notifyOfflineQueueChanged();

      // Rewrite only valid, current material so expired entries disappear
      // from disk as well as memory. Invalid envelopes are deleted.
      if (queueEnvelope && !validQueueEnvelope(queueEnvelope, identity)) {
        vaultDelete(queueVaultKey(identity));
      } else if (queueEnvelope || legacyQueueEnvelope) {
        await writeQueueEnvelope(identity, currentQueue);
        // Delete v2 only after v3 is durably written. An interrupted upgrade
        // therefore replays the same idempotent journal rather than losing it.
        vaultDelete(legacyQueueVaultKey(identity));
      }
      if (cacheEnvelope && !validCacheEnvelope(cacheEnvelope, identity)) {
        vaultDelete(cacheVaultKey(identity));
      } else if (cacheEnvelope) {
        await writeCacheEnvelope(identity, currentCache);
      }
    });
  return persistenceChain;
}

/** Wipe identity metadata, encrypted outbox/cache and in-memory plaintext. */
export async function clearOfflineStores(): Promise<void> {
  loadIdentityOnce();
  const previous = currentIdentity;
  const legacyIdentity = readLegacyIdentityMetadata();
  identityRequestGeneration += 1;
  storageGeneration += 1;
  cancelExpiryTimer();
  currentIdentity = null;
  currentIdentitySource = null;
  currentQueue = [];
  currentHistory = [];
  currentCache = new Map();
  try {
    window.localStorage.removeItem(IDENTITY_KEY);
    window.localStorage.removeItem(LEGACY_IDENTITY_KEY);
  } catch {
    /* storage unavailable */
  }
  purgeLegacyPlaintext();
  if (previous) scheduleVaultDelete(previous);
  if (legacyIdentity) scheduleVaultDelete(legacyIdentity);
  await identityTransition.catch(() => undefined);
  await persistenceChain.catch(() => undefined);
  persistenceError = null;
  hydrationBlockedIdentity = null;
  notifyOfflineQueueChanged();
}

/**
 * Detach the active identity for a workspace switch without deleting its
 * encrypted journal. The old workspace's data is neither readable nor
 * replayable under the new credential; returning to that identity restores
 * the retained entries.
 */
export async function parkOfflineStores(): Promise<void> {
  loadIdentityOnce();
  await persistenceChain.catch(() => undefined);
  identityRequestGeneration += 1;
  storageGeneration += 1;
  cancelExpiryTimer();
  currentIdentity = null;
  currentIdentitySource = null;
  currentQueue = [];
  currentHistory = [];
  currentCache = new Map();
  try {
    window.localStorage.removeItem(IDENTITY_KEY);
  } catch {
    /* local metadata storage unavailable */
  }
  persistenceError = null;
  hydrationBlockedIdentity = null;
  notifyOfflineQueueChanged();
}

export function getOfflinePersistenceError(): string | null {
  return persistenceError;
}

const SAFE_MUTATION_PATTERNS: RegExp[] = [
  /^PATCH\s+\/api\/v1\/forms\/[^/]+$/,
  /^POST\s+\/api\/v1\/forms$/,
  /^PATCH\s+\/api\/v1\/segments\/[^/]+$/,
  /^POST\s+\/api\/v1\/segments$/,
  /^PATCH\s+\/api\/v1\/templates\/[^/]+$/,
  /^POST\s+\/api\/v1\/templates$/,
  /^PATCH\s+\/api\/v1\/campaign-templates\/[^/]+$/,
  /^POST\s+\/api\/v1\/campaign-templates$/,
  /^POST\s+\/api\/v1\/lists$/,
  /^PATCH\s+\/api\/v1\/tags\/[^/]+$/,
  /^POST\s+\/api\/v1\/tags$/,
  /^PATCH\s+\/api\/v1\/subscribers\/[^/]+$/,
  /^PATCH\s+\/api\/v1\/campaigns\/[^/]+$/,
];

const ONLINE_ONLY_PATTERNS: RegExp[] = [
  /\s+\/api\/v1\/billing\b/,
  /\s+\/api\/v1\/auth\b/,
  /\s+\/api\/v1\/api-keys\b/,
  /\s+\/api\/v1\/privacy\b/,
  /\s+\/api\/v1\/settings\/privacy\b/,
  /\s+\/api\/v1\/settings\/email-compliance\b/,
  /\s+\/api\/v1\/migrations\b/,
  /\/oauth\b/,
  /^DELETE\s+/,
  /\s+\/api\/v1\/campaigns\/[^/]+\/(send|send-now|test-send|test|schedule|unschedule|resume|duplicate-send|ab-test)\b/,
  /\s+\/api\/v1\/campaigns\/ab-test\b/,
  /\s+\/api\/v1\/subscribers\/bulk\b/,
  /\s+\/api\/v1\/subscribers\/merge\b/,
  /\s+\/api\/v1\/subscribers\/identify\b/,
  /\s+\/api\/v1\/subscribers\/[^/]+\/.+/,
  /\s+\/api\/v1\/subscriber-imports\b/,
  // ECO-03 draft checkpoints. A checkpoint PUT is an OPTIMISTICALLY VERSIONED
  // write: the body carries the version the draft was built on, and the server
  // refuses anything else. Replayed from the journal minutes or hours later it
  // necessarily carries a version the server has moved past — a guaranteed 409
  // arriving with no editor open to resolve it, and (worse) a stale draft
  // landing on top of newer work if that refusal ever softened. The checkpoint
  // client already calls the non-queueable `apiRequest`; this keeps the write
  // unqueueable even if the safe-mutation allowlist grows to cover the path.
  /\s+\/api\/v1\/editor\/checkpoints\//,
];

const SAFE_GET_PATTERNS: RegExp[] = [/^\/api\/v1\/dashboard\/stats$/];

export function isQueueableMutation(
  method: string,
  path: string,
  body?: unknown,
): boolean {
  const verb = method.toUpperCase();
  if (!["POST", "PATCH", "PUT"].includes(verb)) return false;
  const key = `${verb} ${stripOrigin(path)}`;
  if (ONLINE_ONLY_PATTERNS.some((pattern) => pattern.test(key))) return false;
  if (!SAFE_MUTATION_PATTERNS.some((pattern) => pattern.test(key)))
    return false;
  return isSafeQueueBody(verb, stripOrigin(path), body);
}

function isSafeQueueBody(method: string, path: string, body: unknown): boolean {
  if (method !== "PATCH" || !body || typeof body !== "object") return true;
  const record = body as Record<string, unknown>;
  if (/^\/api\/v1\/campaigns\/[^/]+$/.test(path)) {
    return !isSendLikeCampaignPatch(path, record);
  }
  if (/^\/api\/v1\/forms\/[^/]+$/.test(path)) {
    // Publishing/unpublishing changes a public surface and requires an online
    // confirmation. Draft content/settings edits remain queueable.
    return record.status === undefined;
  }
  if (/^\/api\/v1\/subscribers\/[^/]+$/.test(path)) {
    // Consent/delivery state changes are not low-risk profile edits.
    const onlineOnlyKeys = [
      "status",
      "unsubscribe_reason",
      "frequency_preference",
      "paused_until",
      "clear_paused_until",
      "pause_days",
    ];
    return !onlineOnlyKeys.some((key) => record[key] !== undefined);
  }
  return true;
}

export function isOfflineCacheableGet(path: string): boolean {
  return SAFE_GET_PATTERNS.some((pattern) => pattern.test(stripOrigin(path)));
}

export function offlineQueueProbablyEmpty(): boolean {
  return readOfflineQueue().length === 0;
}

export function offlineQueueIdle(): Promise<void> {
  return identityTransition.catch(() => undefined).then(() => persistenceChain);
}

export function readOfflineQueue(): OfflineMutation[] {
  loadIdentityOnce();
  if (!currentIdentity) return [];
  const sanitized = sanitizeOfflineQueueItems(currentQueue);
  if (JSON.stringify(sanitized) !== JSON.stringify(currentQueue)) {
    currentQueue = sanitized;
    scheduleQueuePersist();
  }
  return currentQueue;
}

export function readOfflineJournal(): OfflineJournalEntry[] {
  loadIdentityOnce();
  if (!currentIdentity) return [];
  return currentHistory;
}

export function writeOfflineQueue(items: OfflineMutation[]): void {
  mutateOfflineQueue(() => items);
}

export function subscribeOfflineQueue(cb: () => void): () => void {
  offlineQueueListeners.add(cb);
  return () => offlineQueueListeners.delete(cb);
}

function notifyOfflineQueueChanged(): void {
  for (const listener of offlineQueueListeners) {
    try {
      listener();
    } catch {
      /* listener failures are isolated */
    }
  }
}

function mutateOfflineQueue(
  mutator: (items: OfflineMutation[]) => OfflineMutation[],
): void {
  loadIdentityOnce();
  if (!currentIdentity) return;
  currentQueue = sanitizeOfflineQueueItems(mutator(currentQueue));
  scheduleExpiryCleanup();
  scheduleQueuePersist();
  notifyOfflineQueueChanged();
}

function queueFits(items: OfflineMutation[]): boolean {
  return (
    items.length <= MAX_QUEUE_ITEMS &&
    storageByteLength(JSON.stringify(items)) <= MAX_QUEUE_STORAGE_BYTES
  );
}

export function sanitizeOfflineQueueItems(items: unknown[]): OfflineMutation[] {
  const now = Date.now();
  return items
    .map((item) => sanitizeOfflineQueueItem(item, now))
    .filter((item): item is OfflineMutation => item !== null);
}

function sanitizeOfflineQueueItem(
  item: unknown,
  now: number,
): OfflineMutation | null {
  const record =
    item && typeof item === "object"
      ? (item as Partial<OfflineMutation>)
      : ({} as Partial<OfflineMutation>);
  const method =
    typeof record.method === "string" ? record.method.toUpperCase() : "";
  const path = typeof record.path === "string" ? stripOrigin(record.path) : "";
  const attempts =
    typeof record.attempts === "number" && Number.isFinite(record.attempts)
      ? Math.max(0, Math.floor(record.attempts))
      : 0;
  const queuedMs = parseTimestamp(record.queuedAt);
  const queuedAt = new Date(queuedMs ?? now).toISOString();
  const storedIdentity = normalizeIdentity(record.identity);
  if (currentIdentity && storedIdentity && storedIdentity !== currentIdentity) {
    return null;
  }
  const identity = currentIdentity ?? storedIdentity;

  if (!method || !path || !isQueueableMutation(method, path, record.body)) {
    return {
      id: validID(record.id) ? record.id : newID("mut"),
      method,
      path,
      idempotencyKey: validID(record.idempotencyKey)
        ? record.idempotencyKey
        : newID("idem"),
      queuedAt,
      attempts,
      status: "failed",
      lastError: OFFLINE_REPLAY_POLICY_CHANGED_MESSAGE,
      actionLabel: "Review queued change",
      recordLabel: "Unavailable record",
      ...(identity ? { identity } : {}),
    };
  }

  return {
    id: validID(record.id) ? record.id : newID("mut"),
    method,
    path,
    ...(record.body !== undefined ? { body: record.body } : {}),
    ...storedHeaders(record.headers),
    idempotencyKey: validID(record.idempotencyKey)
      ? record.idempotencyKey
      : newID("idem"),
    ...(validID(record.baseVersion) ? { baseVersion: record.baseVersion } : {}),
    queuedAt,
    attempts,
    status: normalizeReplayStatus(record.status),
    ...(typeof record.retryAfterMs === "number" && record.retryAfterMs >= 0
      ? { retryAfterMs: record.retryAfterMs }
      : {}),
    ...(typeof record.lastError === "string" && record.lastError
      ? { lastError: record.lastError.slice(0, 2_000) }
      : {}),
    ...(typeof record.resource === "string" && record.resource
      ? { resource: record.resource }
      : { resource: resourceOfPath(path) }),
    // Preserved explicitly. A field the sanitizer does not name is DROPPED on
    // the way to the vault — the same way the tombstone rule's `resource` was.
    ...(typeof record.contextEpoch === "string" && record.contextEpoch
      ? { contextEpoch: record.contextEpoch }
      : {}),
    actionLabel:
      typeof record.actionLabel === "string" && record.actionLabel.trim()
        ? record.actionLabel.slice(0, 160)
        : mutationActionLabel(method, path),
    recordLabel:
      typeof record.recordLabel === "string" && record.recordLabel.trim()
        ? record.recordLabel.slice(0, 160)
        : mutationRecordLabel(path, record.body),
    ...(identity ? { identity } : {}),
  };
}

export function resourceOfPath(path: string): string {
  const match = stripOrigin(path).match(/^\/api\/v1\/([a-z][a-z0-9-]*)/i);
  return match?.[1]?.toLowerCase() ?? "other";
}

/**
 * FIFO ordering key for one queued mutation.
 *
 * Most resources retain their historic resource-wide ordering. Subscriber
 * profile PATCHes are independent compare-and-swap streams, however, so a
 * conflict for profile A must not park profile B. Malformed/non-record paths
 * deliberately fall back to the broad resource bucket.
 */
export function offlineMutationOrderingKey(
  mutation: Pick<OfflineMutation, "method" | "path" | "resource">,
): string {
  const resource = mutation.resource || resourceOfPath(mutation.path);
  if (resource !== "subscribers" || mutation.method.toUpperCase() !== "PATCH") {
    return resource;
  }
  const cleanPath = stripOrigin(mutation.path);
  const match = /^\/api\/v1\/subscribers\/([^/?#]+)$/u.exec(cleanPath);
  if (!match?.[1]) return resource;
  try {
    const recordID = decodeURIComponent(match[1]).trim().toLowerCase();
    return recordID ? `subscribers:${recordID}` : resource;
  } catch {
    return resource;
  }
}

const RESOURCE_NAMES: Record<string, string> = {
  forms: "form",
  segments: "segment",
  templates: "template",
  "campaign-templates": "template",
  lists: "list",
  tags: "tag",
  subscribers: "subscriber profile",
  campaigns: "campaign draft",
};

export function mutationActionLabel(method: string, path: string): string {
  const resource = RESOURCE_NAMES[resourceOfPath(path)] ?? "record";
  const verb = method.toUpperCase() === "POST" ? "Create" : "Update";
  return `${verb} ${resource}`;
}

export function mutationRecordLabel(path: string, body: unknown): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    for (const key of ["name", "title", "subject", "slug"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim().replace(/\s+/g, " ").slice(0, 120);
      }
    }
  }
  const clean = stripOrigin(path).split("?", 1)[0] ?? path;
  const encodedID = clean.split("/").filter(Boolean).at(-1);
  const resource = RESOURCE_NAMES[resourceOfPath(path)] ?? "record";
  if (!encodedID || encodedID === resourceOfPath(path))
    return `New ${resource}`;
  try {
    return `${resource[0]?.toUpperCase() ?? "R"}${resource.slice(1)} ${decodeURIComponent(encodedID).slice(0, 80)}`;
  } catch {
    return `${resource[0]?.toUpperCase() ?? "R"}${resource.slice(1)}`;
  }
}

export async function enqueueOfflineMutation(input: {
  method: string;
  path: string;
  body?: unknown;
  headers?: HeadersInit;
  idempotencyKey?: string;
}): Promise<OfflineEnqueueResult> {
  const now = Date.now();
  const headers = normalizeHeaders(input.headers);
  const cleanPath = stripOrigin(input.path);
  const identity = getOfflineIdentity();
  if (!identity) {
    return {
      ok: false,
      code: "identity-unavailable",
      message:
        "Moosewave could not identify the active workspace, so this edit was not queued. Keep this window open and reconnect before retrying.",
      preservedDraft: input.body,
    };
  }
  if (hydrationBlockedIdentity === identity) {
    return {
      ok: false,
      code: "persistence-unavailable",
      message:
        persistenceError ??
        "Encrypted offline data could not be unlocked. This edit was not queued to avoid overwriting retained work.",
      preservedDraft: input.body,
    };
  }
  if (!isQueueableMutation(input.method, cleanPath, input.body)) {
    return {
      ok: false,
      code: "policy-refused",
      message:
        "This action requires a live server connection and was not queued.",
      preservedDraft: input.body,
    };
  }
  const item: OfflineMutation = {
    id: newID("mut"),
    method: input.method.toUpperCase(),
    path: cleanPath,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    idempotencyKey: validID(input.idempotencyKey)
      ? input.idempotencyKey
      : newID("idem"),
    ...(headers["if-match"] ? { baseVersion: headers["if-match"] } : {}),
    queuedAt: new Date(now).toISOString(),
    attempts: 0,
    status: "pending",
    resource: resourceOfPath(cleanPath),
    // The context this write was MADE in. Compared at replay, because a
    // desktop queue can outlive a role change by days.
    ...(readContextEpoch() ? { contextEpoch: readContextEpoch() } : {}),
    identity,
    actionLabel: mutationActionLabel(input.method, cleanPath),
    recordLabel: mutationRecordLabel(cleanPath, input.body),
  };

  // Queue admission is a serialized, durable transaction. The API cannot
  // report `queued` until the encrypted envelope has been written. Existing
  // records are never evicted to make room for a newer edit.
  const operation = persistenceChain
    .catch(() => undefined)
    .then(async (): Promise<OfflineEnqueueResult> => {
      if (currentIdentity !== identity) {
        return {
          ok: false,
          code: "identity-unavailable",
          message:
            "The active workspace changed before this edit could be stored. The form is still populated; review it and retry.",
          preservedDraft: input.body,
        };
      }
      const candidate = sanitizeOfflineQueueItems([...currentQueue, item]);
      if (!queueFits(candidate)) {
        persistenceError =
          "Offline storage is full. Existing queued changes are safe, but new edits cannot be stored until you reconnect or discard an item.";
        notifyOfflineQueueChanged();
        return {
          ok: false,
          code: "capacity",
          message: persistenceError,
          preservedDraft: input.body,
        };
      }
      try {
        await writeQueueEnvelope(identity, candidate);
      } catch {
        persistenceError =
          "Encrypted offline storage is unavailable. Existing durable entries are retained, but this new edit was not queued; keep the form open and retry after reconnecting.";
        notifyOfflineQueueChanged();
        return {
          ok: false,
          code: "persistence-unavailable",
          message:
            persistenceError ??
            "Offline storage is unavailable. This edit remains in the open form but was not queued.",
          preservedDraft: input.body,
        };
      }
      currentQueue = candidate;
      persistenceError = null;
      scheduleExpiryCleanup();
      notifyOfflineQueueChanged();
      return { ok: true, item, receipt: queueReceiptForMutation(item) };
    });
  persistenceChain = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export function updateOfflineMutation(
  id: string,
  patch: Partial<OfflineMutation>,
): void {
  mutateOfflineQueue((items) =>
    items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  );
}

/**
 * Surface an active replay without committing its HTTP attempt to storage.
 * The durable envelope deliberately keeps the prior retry count until the
 * outcome is known: a crash can safely resend the stable idempotency key, and
 * a secure-storage failure cannot spend the mutation's HTTP retry budget.
 */
export function stageOfflineReplayAttempt(
  id: string,
  nextAttempts: number,
): void {
  loadIdentityOnce();
  if (!currentIdentity) return;
  currentQueue = sanitizeOfflineQueueItems(
    currentQueue.map((item) =>
      item.id === id
        ? { ...item, status: "replaying", attempts: nextAttempts }
        : item,
    ),
  );
  notifyOfflineQueueChanged();
}

/**
 * Persist an operator-authored edit before the UI reports it as saved. Replay
 * bookkeeping can remain eventually persisted because the original durable
 * item is idempotent; changing its payload cannot.
 */
export function updateOfflineMutationDurably(
  id: string,
  patch: Partial<OfflineMutation>,
): Promise<boolean> {
  loadIdentityOnce();
  const identity = currentIdentity;
  if (!identity) return Promise.resolve(false);
  const operation = persistenceChain
    .catch(() => undefined)
    .then(async (): Promise<boolean> => {
      if (currentIdentity !== identity) return false;
      const candidate = sanitizeOfflineQueueItems(
        currentQueue.map((item) =>
          item.id === id ? { ...item, ...patch } : item,
        ),
      );
      if (!candidate.some((item) => item.id === id) || !queueFits(candidate)) {
        persistenceError =
          "The edited queued change could not be stored. The original durable version remains in the sync journal.";
        notifyOfflineQueueChanged();
        return false;
      }
      try {
        await writeQueueEnvelope(identity, candidate);
      } catch {
        persistenceError =
          "The edited queued payload could not be stored securely. Its original durable version remains in the sync journal.";
        notifyOfflineQueueChanged();
        return false;
      }
      currentQueue = candidate;
      persistenceError = null;
      notifyOfflineQueueChanged();
      return true;
    });
  persistenceChain = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export function removeOfflineMutation(id: string): void {
  mutateOfflineQueue((items) => items.filter((item) => item.id !== id));
}

function resolvedOfflineMutationState(
  queue: OfflineMutation[],
  history: OfflineJournalEntry[],
  id: string,
  status: OfflineJournalEntry["status"],
  successorBaseVersion?: string,
): { queue: OfflineMutation[]; history: OfflineJournalEntry[] } | null {
  const itemIndex = queue.findIndex((candidate) => candidate.id === id);
  const item = queue[itemIndex];
  if (!item) return null;
  const orderingKey = offlineMutationOrderingKey(item);
  const successorVersionIdentity =
    typeof successorBaseVersion === "string"
      ? EXACT_SUBSCRIBER_BASE_VERSION.exec(
          successorBaseVersion,
        )?.[1]?.toLowerCase()
      : undefined;
  const isSubscriberSuccess =
    status === "synced" && orderingKey.startsWith("subscribers:");
  const verifiedSuccessorBaseVersion =
    isSubscriberSuccess &&
    typeof successorBaseVersion === "string" &&
    successorVersionIdentity !== undefined &&
    orderingKey === `subscribers:${successorVersionIdentity}`
      ? successorBaseVersion
      : null;
  const nextQueue = queue.flatMap((candidate, index) => {
    if (candidate.id === id) return [];
    const isDependentSuccessor =
      index > itemIndex &&
      offlineMutationOrderingKey(candidate) === orderingKey &&
      candidate.status !== "conflict" &&
      candidate.status !== "dead-letter" &&
      candidate.baseVersion !== "*";
    if (verifiedSuccessorBaseVersion !== null && isDependentSuccessor) {
      return [
        {
          ...candidate,
          headers: {
            ...(candidate.headers ?? {}),
            "if-match": verifiedSuccessorBaseVersion,
          },
          baseVersion: verifiedSuccessorBaseVersion,
        },
      ];
    }
    if (isSubscriberSuccess && isDependentSuccessor) {
      return [
        {
          ...candidate,
          status: "conflict" as const,
          lastError: OFFLINE_SUBSCRIBER_RECONCILIATION_REQUIRED_MESSAGE,
          retryAfterMs: undefined,
        },
      ];
    }
    return [candidate];
  });
  const nextHistory = mergeJournalHistory(
    [
      {
        id: item.id,
        queuedAt: item.queuedAt,
        resolvedAt: new Date().toISOString(),
        status,
        resource: item.resource ?? resourceOfPath(item.path),
        actionLabel:
          item.actionLabel ?? mutationActionLabel(item.method, item.path),
        recordLabel:
          item.recordLabel ?? mutationRecordLabel(item.path, item.body),
      },
    ],
    history,
  );
  return { queue: nextQueue, history: nextHistory };
}

export function resolveOfflineMutation(
  id: string,
  status: OfflineJournalEntry["status"],
  successorBaseVersion?: string,
): void {
  const resolved = resolvedOfflineMutationState(
    currentQueue,
    currentHistory,
    id,
    status,
    successorBaseVersion,
  );
  if (!resolved) return;
  currentQueue = resolved.queue;
  currentHistory = resolved.history;
  scheduleQueuePersist();
  notifyOfflineQueueChanged();
}

/**
 * Persist a replay resolution and its same-record ETag handoff as one
 * encrypted envelope before the drain advances. If persistence fails, the
 * canonical in-memory queue remains unresolved so the stable idempotency key
 * can safely retry the already-accepted server request on a later drain.
 */
export function resolveOfflineMutationDurably(
  id: string,
  status: OfflineJournalEntry["status"],
  successorBaseVersion?: string,
): Promise<boolean> {
  loadIdentityOnce();
  const identity = currentIdentity;
  const generation = storageGeneration;
  if (!identity) return Promise.resolve(false);
  const operation = persistenceChain
    .catch(() => undefined)
    .then(async (): Promise<boolean> => {
      if (generation !== storageGeneration || currentIdentity !== identity) {
        return false;
      }
      const resolved = resolvedOfflineMutationState(
        currentQueue,
        currentHistory,
        id,
        status,
        successorBaseVersion,
      );
      if (!resolved) return false;
      try {
        await writeQueueEnvelope(identity, resolved.queue, resolved.history);
      } catch {
        if (generation === storageGeneration && currentIdentity === identity) {
          persistenceError =
            "The server accepted a queued change, but Moosewave could not securely checkpoint its sync receipt. The same idempotent change will retry before later edits are sent.";
          notifyOfflineQueueChanged();
        }
        return false;
      }
      if (generation !== storageGeneration || currentIdentity !== identity) {
        return false;
      }
      currentQueue = resolved.queue;
      currentHistory = resolved.history;
      clearPersistenceFailure(generation, identity);
      scheduleExpiryCleanup();
      notifyOfflineQueueChanged();
      return true;
    });
  persistenceChain = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export function removeOfflineJournalEntry(id: string): void {
  const next = currentHistory.filter((entry) => entry.id !== id);
  if (next.length === currentHistory.length) return;
  currentHistory = next;
  scheduleQueuePersist();
  notifyOfflineQueueChanged();
}

export function queueReceiptForMutation(item: OfflineMutation): QueueReceipt {
  return {
    queueId: item.id,
    queuedAt: item.queuedAt,
    state: item.status,
    resource: item.resource ?? resourceOfPath(item.path),
    action: item.actionLabel ?? mutationActionLabel(item.method, item.path),
    record: item.recordLabel ?? mutationRecordLabel(item.path, item.body),
  };
}

export function readCachedResponse<T>(path: string): T | null {
  loadIdentityOnce();
  const identity = currentIdentity;
  const cleanPath = stripOrigin(path);
  if (!identity || !isOfflineCacheableGet(cleanPath)) return null;
  cleanupOfflineStorage();
  const entry = currentCache.get(cleanPath);
  if (!entry || entry.identity !== identity) return null;
  return entry.data as T;
}

export function writeCachedResponse(path: string, data: unknown): void {
  loadIdentityOnce();
  const identity = currentIdentity;
  const cleanPath = stripOrigin(path);
  if (!identity || !isOfflineCacheableGet(cleanPath)) return;
  const now = Date.now();
  const entry: CacheEntry = {
    path: cleanPath,
    identity,
    cachedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CACHE_TTL_MS).toISOString(),
    data,
  };
  if (storageByteLength(JSON.stringify(entry)) > MAX_CACHE_STORAGE_BYTES) {
    return;
  }
  currentCache.set(cleanPath, entry);
  scheduleExpiryCleanup();
  scheduleCachePersist();
}

export function cleanupOfflineStorage(): void {
  loadIdentityOnce();
  purgeLegacyPlaintext();
  const identity = currentIdentity;
  if (!identity) {
    currentQueue = [];
    currentHistory = [];
    currentCache.clear();
    cancelExpiryTimer();
    return;
  }
  const nextQueue = sanitizeOfflineQueueItems(currentQueue);
  const nextCache = sanitizeCacheEntries([...currentCache.values()], identity);
  if (JSON.stringify(nextQueue) !== JSON.stringify(currentQueue)) {
    currentQueue = nextQueue;
    scheduleQueuePersist();
    notifyOfflineQueueChanged();
  }
  if (JSON.stringify([...nextCache]) !== JSON.stringify([...currentCache])) {
    currentCache = nextCache;
    scheduleCachePersist();
  }
  scheduleExpiryCleanup();
}

/** Remove expired encrypted material even when no later read touches it. */
function scheduleExpiryCleanup(): void {
  cancelExpiryTimer();
  if (!currentIdentity) return;
  const expiries = [
    ...[...currentCache.values()].map((entry) =>
      parseTimestamp(entry.expiresAt),
    ),
  ].filter((value): value is number => value !== null);
  if (expiries.length === 0) return;
  const delay = Math.max(0, Math.min(...expiries) - Date.now());
  expiryTimer = globalThis.setTimeout(
    () => {
      expiryTimer = null;
      cleanupOfflineStorage();
    },
    Math.min(delay + 1, 2_147_483_647),
  );
}

function cancelExpiryTimer(): void {
  if (expiryTimer !== null) globalThis.clearTimeout(expiryTimer);
  expiryTimer = null;
}

function scheduleQueuePersist(): void {
  const identity = currentIdentity;
  if (!identity) return;
  const generation = storageGeneration;
  const items = currentQueue.map((item) => structuredCloneSafe(item));
  const history = currentHistory.map((entry) => structuredCloneSafe(entry));
  persistenceChain = persistenceChain
    .catch(() => undefined)
    .then(async () => {
      if (generation !== storageGeneration || currentIdentity !== identity) {
        return;
      }
      await writeQueueEnvelope(identity, items, history);
      clearPersistenceFailure(generation, identity);
    })
    .catch(() => recordPersistenceFailure(generation, identity));
}

function scheduleCachePersist(): void {
  const identity = currentIdentity;
  if (!identity) return;
  const generation = storageGeneration;
  const entries = new Map(
    [...currentCache.entries()].map(([key, value]) => [
      key,
      structuredCloneSafe(value),
    ]),
  );
  persistenceChain = persistenceChain
    .catch(() => undefined)
    .then(async () => {
      if (generation !== storageGeneration || currentIdentity !== identity) {
        return;
      }
      await writeCacheEnvelope(identity, entries);
      clearPersistenceFailure(generation, identity);
    })
    .catch(() => recordPersistenceFailure(generation, identity));
}

function recordPersistenceFailure(generation: number, identity: string): void {
  if (generation !== storageGeneration || currentIdentity !== identity) return;
  if (persistenceError?.includes("could not securely checkpoint")) {
    notifyOfflineQueueChanged();
    return;
  }
  persistenceError =
    "Moosewave could not update the encrypted offline journal. Keep the app open: the visible in-memory state may be newer than the durable copy.";
  notifyOfflineQueueChanged();
}

function clearPersistenceFailure(generation: number, identity: string): void {
  if (generation !== storageGeneration || currentIdentity !== identity) return;
  if (!persistenceError) return;
  persistenceError = null;
  notifyOfflineQueueChanged();
}

function scheduleVaultDelete(identity: string): void {
  persistenceChain = persistenceChain
    .catch(() => undefined)
    .then(() => {
      vaultDelete(queueVaultKey(identity));
      vaultDelete(legacyQueueVaultKey(identity));
      vaultDelete(cacheVaultKey(identity));
      vaultDeletePrefix(`sensitive:${identity}:`);
    });
}

interface LegacyIdentityMigration {
  complete: boolean;
  deleteLegacyCopies: () => void;
}

async function migrateLegacyOfflineIdentity(
  legacyIdentity: string,
  opaqueIdentity: string,
  generation: number,
): Promise<LegacyIdentityMigration> {
  const oldQueueKey = queueVaultKey(legacyIdentity);
  const oldV2QueueKey = legacyQueueVaultKey(legacyIdentity);
  const oldCacheKey = cacheVaultKey(legacyIdentity);
  const oldQueuePresent = vaultCiphertextExists(oldQueueKey);
  const oldV2QueuePresent = vaultCiphertextExists(oldV2QueueKey);
  const oldCachePresent = vaultCiphertextExists(oldCacheKey);
  const newQueueKey = queueVaultKey(opaqueIdentity);
  const newCacheKey = cacheVaultKey(opaqueIdentity);
  const [oldQueue, oldV2Queue, oldCache, newQueue, newCache] =
    await Promise.all([
      vaultReadJSON<QueueEnvelope>(oldQueueKey),
      vaultReadJSON<LegacyQueueEnvelope>(oldV2QueueKey),
      vaultReadJSON<CacheEnvelope>(oldCacheKey),
      vaultReadJSON<QueueEnvelope>(newQueueKey),
      vaultReadJSON<CacheEnvelope>(newCacheKey),
    ]);
  const deleteLegacyCopies = (): void => {
    for (const key of [oldQueueKey, oldV2QueueKey, oldCacheKey]) {
      try {
        vaultDelete(key);
      } catch {
        /* the rewritten opaque copy remains authoritative */
      }
    }
    vaultDeletePrefix(`sensitive:${legacyIdentity}:`);
    try {
      if (window.localStorage.getItem(LEGACY_IDENTITY_KEY) === legacyIdentity) {
        window.localStorage.removeItem(LEGACY_IDENTITY_KEY);
      }
    } catch {
      /* metadata storage unavailable */
    }
  };
  const incomplete = { complete: false, deleteLegacyCopies };
  if (
    generation !== storageGeneration ||
    currentIdentity !== opaqueIdentity ||
    (oldQueuePresent && oldQueue.status === "unavailable") ||
    (oldV2QueuePresent && oldV2Queue.status === "unavailable") ||
    (oldCachePresent && oldCache.status === "unavailable") ||
    newQueue.status === "unavailable" ||
    newCache.status === "unavailable"
  ) {
    noteLegacyMigrationUnavailable(generation, opaqueIdentity);
    return incomplete;
  }

  const legacyQueues: Array<QueueEnvelope | LegacyQueueEnvelope> = [];
  if (oldQueue.status === "ready") {
    if (!validQueueEnvelope(oldQueue.value, legacyIdentity)) return incomplete;
    legacyQueues.push(oldQueue.value);
  }
  if (oldV2Queue.status === "ready") {
    if (!validLegacyQueueEnvelope(oldV2Queue.value, legacyIdentity)) {
      return incomplete;
    }
    legacyQueues.push(oldV2Queue.value);
  }
  if (
    oldCache.status === "ready" &&
    !validCacheEnvelope(oldCache.value, legacyIdentity)
  ) {
    return incomplete;
  }
  if (
    newQueue.status === "ready" &&
    !validQueueEnvelope(newQueue.value, opaqueIdentity)
  ) {
    return incomplete;
  }
  if (
    newCache.status === "ready" &&
    !validCacheEnvelope(newCache.value, opaqueIdentity)
  ) {
    return incomplete;
  }

  const reboundItems = rebindLegacyQueueItems(
    legacyQueues.flatMap((envelope) => envelope.items),
    legacyIdentity,
    opaqueIdentity,
  );
  const reboundCache =
    oldCache.status === "ready"
      ? rebindLegacyCacheEntries(
          oldCache.value.entries,
          legacyIdentity,
          opaqueIdentity,
        )
      : [];
  if (!reboundItems || !reboundCache) return incomplete;
  const existingItems = newQueue.status === "ready" ? newQueue.value.items : [];
  const existingHistory =
    newQueue.status === "ready"
      ? sanitizeJournalEntries(newQueue.value.history)
      : [];
  const legacyHistory = legacyQueues.flatMap((envelope) =>
    "history" in envelope ? sanitizeJournalEntries(envelope.history) : [],
  );
  const mergedItems = mergeOfflineQueueItems(reboundItems, existingItems);
  const existingCache =
    newCache.status === "ready" ? newCache.value.entries : [];
  const mergedCache = sanitizeCacheEntries(
    [...reboundCache, ...existingCache],
    opaqueIdentity,
  );
  try {
    if (oldQueuePresent || oldV2QueuePresent) {
      await writeQueueEnvelope(
        opaqueIdentity,
        mergedItems,
        mergeJournalHistory(existingHistory, legacyHistory),
      );
    }
    if (oldCachePresent) {
      await writeCacheEnvelope(opaqueIdentity, mergedCache);
    }
  } catch {
    noteLegacyMigrationUnavailable(generation, opaqueIdentity);
    return incomplete;
  }
  return { complete: true, deleteLegacyCopies };
}

function rebindLegacyQueueItems(
  items: OfflineMutation[],
  legacyIdentity: string,
  opaqueIdentity: string,
): OfflineMutation[] | null {
  if (
    items.some(
      (item) => item.identity !== undefined && item.identity !== legacyIdentity,
    )
  ) {
    return null;
  }
  return sanitizeOfflineQueueItems(
    items.map((item) => ({ ...item, identity: opaqueIdentity })),
  );
}

function rebindLegacyCacheEntries(
  entries: CacheEntry[],
  legacyIdentity: string,
  opaqueIdentity: string,
): CacheEntry[] | null {
  if (entries.some((entry) => entry.identity !== legacyIdentity)) return null;
  return entries.map((entry) => ({ ...entry, identity: opaqueIdentity }));
}

function mergeOfflineQueueItems(
  legacyItems: OfflineMutation[],
  existingItems: OfflineMutation[],
): OfflineMutation[] {
  const byID = new Map<string, OfflineMutation>();
  for (const item of [...legacyItems, ...existingItems])
    byID.set(item.id, item);
  return sanitizeOfflineQueueItems([...byID.values()]);
}

function noteLegacyMigrationUnavailable(
  generation: number,
  identity: string,
): void {
  if (generation !== storageGeneration || currentIdentity !== identity) return;
  persistenceError =
    "Moosewave could not upgrade older encrypted offline data. The original ciphertext was preserved and was not opened under this workspace.";
  notifyOfflineQueueChanged();
}

async function writeQueueEnvelope(
  identity: string,
  items: OfflineMutation[],
  history: OfflineJournalEntry[] = currentHistory,
): Promise<void> {
  if (items.length === 0 && history.length === 0) {
    vaultDelete(queueVaultKey(identity));
    return;
  }
  await vaultSetJSON(queueVaultKey(identity), {
    version: ENVELOPE_VERSION,
    identity,
    writtenAt: new Date().toISOString(),
    items,
    history,
  } satisfies QueueEnvelope);
}

async function writeCacheEnvelope(
  identity: string,
  entries: Map<string, CacheEntry>,
): Promise<void> {
  if (entries.size === 0) {
    vaultDelete(cacheVaultKey(identity));
    return;
  }
  await vaultSetJSON(cacheVaultKey(identity), {
    version: CACHE_ENVELOPE_VERSION,
    identity,
    writtenAt: new Date().toISOString(),
    entries: [...entries.values()],
  } satisfies CacheEnvelope);
}

function validQueueEnvelope(
  envelope: QueueEnvelope | null,
  identity: string,
): envelope is QueueEnvelope {
  return (
    envelope?.version === ENVELOPE_VERSION &&
    envelope.identity === identity &&
    Array.isArray(envelope.items)
  );
}

function validLegacyQueueEnvelope(
  envelope: LegacyQueueEnvelope | null,
  identity: string,
): envelope is LegacyQueueEnvelope {
  return (
    envelope?.version === 2 &&
    envelope.identity === identity &&
    Array.isArray(envelope.items)
  );
}

function validCacheEnvelope(
  envelope: CacheEnvelope | null,
  identity: string,
): envelope is CacheEnvelope {
  return (
    envelope?.version === CACHE_ENVELOPE_VERSION &&
    envelope.identity === identity &&
    Array.isArray(envelope.entries)
  );
}

function sanitizeJournalEntries(value: unknown): OfflineJournalEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: OfflineJournalEntry[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as Partial<OfflineJournalEntry>;
    const queuedAt = parseTimestamp(entry.queuedAt);
    const resolvedAt = parseTimestamp(entry.resolvedAt);
    if (
      !validID(entry.id) ||
      queuedAt === null ||
      resolvedAt === null ||
      (entry.status !== "synced" && entry.status !== "discarded") ||
      typeof entry.resource !== "string" ||
      typeof entry.actionLabel !== "string" ||
      typeof entry.recordLabel !== "string"
    ) {
      continue;
    }
    entries.push({
      id: entry.id,
      queuedAt: new Date(queuedAt).toISOString(),
      resolvedAt: new Date(resolvedAt).toISOString(),
      status: entry.status,
      resource: entry.resource.slice(0, 80),
      actionLabel: entry.actionLabel.slice(0, 160),
      recordLabel: entry.recordLabel.slice(0, 160),
    });
  }
  return mergeJournalHistory(entries, []);
}

function mergeJournalHistory(
  preferred: OfflineJournalEntry[],
  existing: OfflineJournalEntry[],
): OfflineJournalEntry[] {
  const byID = new Map<string, OfflineJournalEntry>();
  for (const entry of [...preferred, ...existing]) {
    if (!byID.has(entry.id)) byID.set(entry.id, entry);
  }
  return [...byID.values()]
    .sort((a, b) => Date.parse(b.resolvedAt) - Date.parse(a.resolvedAt))
    .slice(0, MAX_JOURNAL_HISTORY_ITEMS);
}

function sanitizeCacheEntries(
  entries: unknown[],
  identity: string,
): Map<string, CacheEntry> {
  const now = Date.now();
  const result = new Map<string, CacheEntry>();
  for (const value of entries) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Partial<CacheEntry>;
    if (
      entry.identity !== identity ||
      typeof entry.path !== "string" ||
      !isOfflineCacheableGet(entry.path) ||
      typeof entry.cachedAt !== "string" ||
      typeof entry.expiresAt !== "string"
    ) {
      continue;
    }
    const cachedAt = Date.parse(entry.cachedAt);
    const expiresAt = Date.parse(entry.expiresAt);
    if (
      !Number.isFinite(cachedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now ||
      expiresAt > cachedAt + CACHE_TTL_MS
    ) {
      continue;
    }
    const cleanPath = stripOrigin(entry.path);
    const normalized: CacheEntry = {
      path: cleanPath,
      identity,
      cachedAt: new Date(cachedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      data: entry.data,
    };
    if (
      storageByteLength(JSON.stringify(normalized)) <= MAX_CACHE_STORAGE_BYTES
    ) {
      result.set(cleanPath, normalized);
    }
  }
  return result;
}

function purgeLegacyPlaintext(): void {
  try {
    const storage = window.localStorage;
    storage.removeItem(LEGACY_QUEUE_KEY);
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(LEGACY_CACHE_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

function readStoredOpaqueIdentity(): string | null {
  try {
    const raw = window.localStorage.getItem(IDENTITY_KEY);
    if (!raw || storageByteLength(raw) > 512) {
      if (raw) window.localStorage.removeItem(IDENTITY_KEY);
      return null;
    }
    const metadata = JSON.parse(raw) as Partial<OfflineIdentityMetadata>;
    if (metadata.version !== 2 || !isOpaqueOfflineIdentity(metadata.identity)) {
      window.localStorage.removeItem(IDENTITY_KEY);
      return null;
    }
    return metadata.identity;
  } catch {
    return null;
  }
}

function persistOpaqueIdentity(identity: string): boolean {
  if (!isOpaqueOfflineIdentity(identity)) return false;
  try {
    window.localStorage.setItem(
      IDENTITY_KEY,
      JSON.stringify({
        version: 2,
        identity,
      } satisfies OfflineIdentityMetadata),
    );
    return true;
  } catch {
    return false;
  }
}

function readLegacyIdentityMetadata(): string | null {
  try {
    return normalizeIdentity(window.localStorage.getItem(LEGACY_IDENTITY_KEY));
  } catch {
    return null;
  }
}

function normalizeIdentitySource(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const source = value.trim();
  if (
    !source ||
    source !== value ||
    storageByteLength(source) > 8 * 1024 ||
    /[\u0000-\u001f\u007f]/.test(source)
  ) {
    return null;
  }
  return source;
}

function detachOfflineIdentity(removeMetadata: boolean): void {
  storageGeneration += 1;
  cancelExpiryTimer();
  currentIdentity = null;
  currentIdentitySource = null;
  currentQueue = [];
  currentHistory = [];
  currentCache = new Map();
  hydrationBlockedIdentity = null;
  if (removeMetadata) {
    try {
      window.localStorage.removeItem(IDENTITY_KEY);
    } catch {
      /* metadata storage unavailable */
    }
  }
  notifyOfflineQueueChanged();
}

function queueVaultKey(identity: string): string {
  return `${VAULT_QUEUE_PREFIX}${identity}`;
}

function legacyQueueVaultKey(identity: string): string {
  return `${LEGACY_VAULT_QUEUE_PREFIX}${identity}`;
}

function vaultCiphertextExists(logicalKey: string): boolean {
  try {
    return (
      window.localStorage.getItem(`postwave.desktop.vault.v1:${logicalKey}`) !==
      null
    );
  } catch {
    return false;
  }
}

function cacheVaultKey(identity: string): string {
  return `${VAULT_CACHE_PREFIX}${identity}`;
}

function normalizeIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const identity = value.trim();
  if (
    !identity ||
    identity !== value ||
    identity.length > MAX_IDENTITY_CHARS ||
    /[\u0000-\u001f\u007f]/.test(identity)
  ) {
    return null;
  }
  return identity;
}

function normalizeReplayStatus(value: unknown): OfflineReplayStatus {
  switch (value) {
    case "pending":
    case "replaying":
    case "conflict":
    case "failed":
    case "dead-letter":
      return value;
    default:
      return "pending";
  }
}

function storedHeaders(value: unknown): { headers?: Record<string, string> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const ifMatch = record["if-match"] ?? record["If-Match"];
  return typeof ifMatch === "string" && ifMatch
    ? { headers: { "if-match": ifMatch } }
    : {};
}

function normalizeHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    if (key.toLowerCase() === "if-match") result["if-match"] = value;
  });
  return result;
}

function isSendLikeCampaignPatch(path: string, body: unknown): boolean {
  if (!/^\/api\/v1\/campaigns\/[^/]+$/.test(stripOrigin(path))) return false;
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  return (
    record.status === "scheduled" ||
    record.status === "sending" ||
    record.status === "sent" ||
    typeof record.scheduled_at === "string"
  );
}

function stripOrigin(path: string): string {
  const raw = path.trim();
  if (!/^(?:https?:)?\/\//i.test(raw)) return raw;
  try {
    const url = new URL(raw, "http://postwave.local");
    return `${url.pathname}${url.search}`;
  } catch {
    return raw;
  }
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validID(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function newID(prefix: string): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `${prefix}_${Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`;
  }
  return `${prefix}_${Date.now().toString(36)}`;
}

function storageByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
