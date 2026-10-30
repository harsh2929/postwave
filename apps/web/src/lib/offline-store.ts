// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browser offline state is deliberately memory-only. A browser origin has no
 * OS-backed secret suitable for durable customer-data encryption; storing an
 * encryption key beside ciphertext would not improve the threat boundary.
 * Queued writes therefore survive transient connectivity within this tab but
 * are discarded on reload/crash, logout, or account/workspace switch.
 */

// The replay-status union + the common mutation fields now live in the shared
// @postwave/offline-outbox core (so web + desktop can't drift on them);
// re-exported here so every existing `from "./offline-store"` import is
// unchanged. Web's surface-specific fields extend the core.
import type {
  OfflineMutationCore,
  OfflineReplayStatus,
} from "@postwave/offline-outbox";

import { readContextEpoch } from "./context-epoch";
import {
  getOfflineStorageIdentity,
  OFFLINE_QUEUE_CHANGED_EVENT,
  purgeLegacyOfflineStorage,
  registerOfflineStorageRuntimeReset,
} from "./offline-storage-identity";

export {
  clearOfflineStorage,
  hasOfflineStorageIdentity,
  OFFLINE_QUEUE_CHANGED_EVENT,
  resetOfflineStorageIdentity,
  setOfflineStorageIdentity,
} from "./offline-storage-identity";

export type { OfflineReplayStatus };

export interface OfflineMutation extends OfflineMutationCore {
  query?: Record<string, string | number | boolean | undefined>;
  conflictStatus?: 409 | 412;
  retryableAt?: number;
}

export interface OfflineCacheEntry<T = unknown> {
  path: string;
  identity: string;
  cachedAt: string;
  expiresAt: string;
  data: T;
}

const MAX_QUEUE_ITEMS = 200;
const MAX_QUEUE_BYTES = 256 * 1024;
const MAX_CACHE_BYTES = 512 * 1024;
const QUEUE_TTL_MS = 4 * 60 * 60 * 1000;
const CACHE_TTL_MS = 30 * 60 * 1000;

export { OUTBOX_MAX_ATTEMPTS } from "@postwave/offline-outbox";
export const OFFLINE_REPLAY_POLICY_CHANGED_MESSAGE =
  "This queued change is no longer replayable. Retry it while online.";
let memoryQueue: OfflineMutation[] = [];
const memoryCache = new Map<string, OfflineCacheEntry>();
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

registerOfflineStorageRuntimeReset(() => {
  memoryQueue = [];
  memoryCache.clear();
  cancelExpiryTimer();
});

const ONLINE_ONLY_PATTERNS: RegExp[] = [
  /^POST\s+\/api\/v1\/billing\b/,
  /^POST\s+\/api\/public\/billing\b/,
  /^POST\s+\/api\/v1\/auth\b/,
  /^DELETE\s+\/api\/v1\/auth\b/,
  /\s+\/api\/v1\/api-keys\b/,
  /\s+\/api\/v1\/privacy\b/,
  /\s+\/api\/v1\/settings\/privacy\b/,
  /\s+\/api\/v1\/settings\/email-compliance\b/,
  /\s+\/api\/v1\/migrations\b/,
  /\/oauth\//,
  /\/oauth\b/,
  /\s+\/api\/v1\/campaigns\/[^/]+\/(?:send|queue)\b/,
  /\s+\/api\/v1\/campaigns\/[^/]+\/test-send\b/,
  /^DELETE\s+/,
];

const SAFE_MUTATION_PATTERNS: RegExp[] = [
  /^PATCH\s+\/api\/v1\/forms\/[^/]+$/,
  /^POST\s+\/api\/v1\/forms$/,
  /^PATCH\s+\/api\/v1\/segments\/[^/]+$/,
  /^POST\s+\/api\/v1\/segments$/,
];

const SAFE_GET_PATTERNS: RegExp[] = [/^\/api\/v1\/dashboard\/stats$/];

export function isOnlineOnlyMutation(method: string, path: string): boolean {
  const key = `${method.toUpperCase()} ${stripOrigin(path)}`;
  return ONLINE_ONLY_PATTERNS.some((pattern) => pattern.test(key));
}

export function isQueueableMutation(
  method: string,
  path: string,
  body?: unknown,
): boolean {
  const verb = method.toUpperCase();
  if (!["POST", "PUT", "PATCH"].includes(verb)) return false;
  if (isOnlineOnlyMutation(verb, path)) return false;
  if (isSendLikeCampaignPatch(path, body)) return false;
  const key = `${verb} ${stripOrigin(path)}`;
  return SAFE_MUTATION_PATTERNS.some((pattern) => pattern.test(key));
}

export function isOfflineCacheableGet(path: string): boolean {
  return SAFE_GET_PATTERNS.some((pattern) => pattern.test(stripOrigin(path)));
}

export function readOfflineQueue(): OfflineMutation[] {
  if (!getOfflineStorageIdentity()) return [];
  cleanupOfflineStorage();
  return memoryQueue;
}

export function writeOfflineQueue(items: OfflineMutation[]): void {
  if (!getOfflineStorageIdentity()) return;
  memoryQueue = boundQueue(sanitizeOfflineQueueItems(items));
  scheduleExpiryCleanup();
  notifyQueueChanged();
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
  const maximumExpiry = (queuedMs ?? now) + QUEUE_TTL_MS;
  const requestedExpiry = parseTimestamp(record.expiresAt);
  const expiryMs = Math.min(requestedExpiry ?? maximumExpiry, maximumExpiry);
  if (expiryMs <= now) return null;
  const expiresAt = new Date(expiryMs).toISOString();

  if (!method || !path || !isQueueableMutation(method, path, record.body)) {
    return {
      id: validID(record.id) ? record.id : newID("mut"),
      method,
      path,
      idempotencyKey: validID(record.idempotencyKey)
        ? record.idempotencyKey
        : newID("idem"),
      queuedAt,
      expiresAt,
      attempts,
      status: "failed",
      lastError: OFFLINE_REPLAY_POLICY_CHANGED_MESSAGE,
    };
  }

  return {
    id: validID(record.id) ? record.id : newID("mut"),
    method,
    path,
    ...storedQuery(record.query),
    ...(record.body !== undefined ? { body: record.body } : {}),
    ...storedHeaders(record.headers),
    idempotencyKey: validID(record.idempotencyKey)
      ? record.idempotencyKey
      : newID("idem"),
    ...(validID(record.baseVersion) ? { baseVersion: record.baseVersion } : {}),
    ...(record.conflictStatus === 409 || record.conflictStatus === 412
      ? { conflictStatus: record.conflictStatus }
      : {}),
    queuedAt,
    expiresAt,
    attempts,
    status: normalizeReplayStatus(record.status),
    ...(typeof record.lastError === "string" && record.lastError
      ? { lastError: record.lastError.slice(0, 2_000) }
      : {}),
    ...(typeof record.retryableAt === "number" &&
    Number.isFinite(record.retryableAt)
      ? { retryableAt: record.retryableAt }
      : {}),
    ...(typeof record.resource === "string" && record.resource
      ? { resource: record.resource }
      : { resource: resourceOfPath(path) }),
    // Preserved explicitly. A field the sanitizer does not name is DROPPED on
    // the way to storage, which is how the tombstone rule spent its whole life
    // returning false for every web mutation.
    ...(typeof record.contextEpoch === "string" && record.contextEpoch
      ? { contextEpoch: record.contextEpoch }
      : {}),
  };
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

export function resourceOfPath(path: string): string {
  const match = stripOrigin(path).match(/^\/api\/v1\/([a-z][a-z0-9-]*)/i);
  return match?.[1]?.toLowerCase() ?? "other";
}

function storedHeaders(value: unknown): { headers?: Record<string, string> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const ifMatch = record["if-match"] ?? record["If-Match"];
  return typeof ifMatch === "string" && ifMatch
    ? { headers: { "if-match": ifMatch } }
    : {};
}

function storedQuery(value: unknown): {
  query?: Record<string, string | number | boolean | undefined>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const query: Record<string, string | number | boolean | undefined> = {};
  for (const [key, val] of Object.entries(value)) {
    if (
      typeof val === "string" ||
      typeof val === "number" ||
      typeof val === "boolean" ||
      val === undefined
    ) {
      query[key] = val;
    }
  }
  return Object.keys(query).length > 0 ? { query } : {};
}

export function enqueueOfflineMutation(input: {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: HeadersInit;
  idempotencyKey?: string;
}): OfflineMutation {
  const now = Date.now();
  const headers = normalizeHeaders(input.headers);
  const cleanPath = stripOrigin(input.path);
  const item: OfflineMutation = {
    id: newID("mut"),
    method: input.method.toUpperCase(),
    path: cleanPath,
    ...(input.query ? { query: input.query } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    idempotencyKey: validID(input.idempotencyKey)
      ? input.idempotencyKey
      : newID("idem"),
    ...(headers["if-match"] ? { baseVersion: headers["if-match"] } : {}),
    queuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + QUEUE_TTL_MS).toISOString(),
    attempts: 0,
    status: "pending",
    resource: resourceOfPath(cleanPath),
    // The context this write was MADE in. Compared at replay, because the
    // replay authenticates as whoever is signed in then — usually the same
    // person, occasionally someone whose role or workspace has moved.
    ...(readContextEpoch() ? { contextEpoch: readContextEpoch() } : {}),
  };
  writeOfflineQueue([...readOfflineQueue(), item]);
  return item;
}

export function updateOfflineMutation(
  id: string,
  patch: Partial<OfflineMutation>,
): void {
  writeOfflineQueue(
    readOfflineQueue().map((item) =>
      item.id === id ? { ...item, ...patch } : item,
    ),
  );
}

export function removeOfflineMutation(id: string): void {
  writeOfflineQueue(readOfflineQueue().filter((item) => item.id !== id));
}

export function queuedMutationAck(item: OfflineMutation): {
  offline_queued: true;
  id: string;
  queued_at: string;
  replay_status: OfflineReplayStatus;
} {
  return {
    offline_queued: true,
    id: item.id,
    queued_at: item.queuedAt,
    replay_status: item.status,
  };
}

export function readCachedResponse<T>(path: string): T | null {
  const identity = getOfflineStorageIdentity();
  const cleanPath = stripOrigin(path);
  if (!identity || !isOfflineCacheableGet(cleanPath)) return null;
  cleanupOfflineStorage();
  const entry = memoryCache.get(cleanPath);
  return entry?.identity === identity ? (entry.data as T) : null;
}

export function writeCachedResponse(path: string, data: unknown): void {
  const identity = getOfflineStorageIdentity();
  const cleanPath = stripOrigin(path);
  if (!identity || !isOfflineCacheableGet(cleanPath)) return;
  const now = Date.now();
  const entry: OfflineCacheEntry = {
    path: cleanPath,
    identity,
    cachedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CACHE_TTL_MS).toISOString(),
    data,
  };
  if (storageByteLength(JSON.stringify(entry)) > MAX_CACHE_BYTES) return;
  memoryCache.set(cleanPath, entry);
  scheduleExpiryCleanup();
}

export function cleanupOfflineStorage(): void {
  purgeLegacyOfflineStorage();
  const identity = getOfflineStorageIdentity();
  if (!identity) {
    memoryQueue = [];
    memoryCache.clear();
    return;
  }
  memoryQueue = boundQueue(sanitizeOfflineQueueItems(memoryQueue));
  const now = Date.now();
  for (const [path, entry] of memoryCache) {
    const cachedAt = Date.parse(entry.cachedAt);
    const expiresAt = Date.parse(entry.expiresAt);
    if (
      entry.identity !== identity ||
      !isOfflineCacheableGet(path) ||
      !Number.isFinite(cachedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now ||
      expiresAt > cachedAt + CACHE_TTL_MS ||
      storageByteLength(JSON.stringify(entry)) > MAX_CACHE_BYTES
    ) {
      memoryCache.delete(path);
    }
  }
  scheduleExpiryCleanup();
}

function scheduleExpiryCleanup(): void {
  cancelExpiryTimer();
  if (!getOfflineStorageIdentity()) return;
  const expiries = [
    ...memoryQueue.map((item) => parseTimestamp(item.expiresAt)),
    ...[...memoryCache.values()].map((entry) =>
      parseTimestamp(entry.expiresAt),
    ),
  ].filter((value): value is number => value !== null);
  if (expiries.length === 0) return;
  const delay = Math.max(0, Math.min(...expiries) - Date.now());
  expiryTimer = globalThis.setTimeout(
    () => {
      expiryTimer = null;
      const queueCount = memoryQueue.length;
      cleanupOfflineStorage();
      if (memoryQueue.length !== queueCount) notifyQueueChanged();
    },
    Math.min(delay + 1, 2_147_483_647),
  );
}

function cancelExpiryTimer(): void {
  if (expiryTimer !== null) globalThis.clearTimeout(expiryTimer);
  expiryTimer = null;
}

function boundQueue(items: OfflineMutation[]): OfflineMutation[] {
  let candidate = items.slice(-MAX_QUEUE_ITEMS);
  while (
    candidate.length > 0 &&
    storageByteLength(JSON.stringify(candidate)) > MAX_QUEUE_BYTES
  ) {
    candidate = candidate.slice(Math.max(1, Math.floor(candidate.length / 2)));
  }
  return candidate;
}

function notifyQueueChanged(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent(OFFLINE_QUEUE_CHANGED_EVENT, {
        detail: { count: memoryQueue.length },
      }),
    );
  } catch {
    /* event APIs unavailable */
  }
}

function isSendLikeCampaignPatch(path: string, body: unknown): boolean {
  if (!/^\/api\/v1\/campaigns\/[^/]+$/.test(stripOrigin(path))) return false;
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  return (
    record.status === "scheduled" ||
    record.status === "sending" ||
    record.status === "sent" ||
    typeof record.scheduled_at === "string" ||
    typeof record.send_at === "string"
  );
}

function normalizeHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    if (key.toLowerCase() === "if-match") result["if-match"] = value;
  });
  return result;
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

function storageByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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
