// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Synchronous identity boundary for the browser's memory-only offline state.
 *
 * This module intentionally contains no replay, request, or query runtime. The
 * dashboard provider must establish and tear down the active identity before
 * descendants can use cached data, while routes that never queue a mutation
 * should not have to download the full offline store.
 */

const LEGACY_QUEUE_KEY = "postwave.web.offline-mutations.v1";
const LEGACY_CACHE_PREFIX = "postwave.web.offline-cache.v1:";
const DISK_QUEUE_PREFIX = "postwave.web.offline-mutations.v2:";
const DISK_CACHE_PREFIX = "postwave.web.offline-cache.v2:";

export const OFFLINE_QUEUE_CHANGED_EVENT = "postwave:offline-queue-changed";

let storageIdentity: string | null = null;
let resetLoadedRuntime: (() => void) | null = null;

/** @internal Registered by offline-store when its memory runtime is loaded. */
export function registerOfflineStorageRuntimeReset(reset: () => void): void {
  resetLoadedRuntime = reset;
}

/** @internal Read by offline-store without duplicating identity state. */
export function getOfflineStorageIdentity(): string | null {
  return storageIdentity;
}

export function setOfflineStorageIdentity(
  userId: string,
  tenantId: string,
): void {
  const next = identityKey(userId, tenantId);
  if (!next) {
    resetOfflineStorageIdentity();
    return;
  }
  if (storageIdentity !== next) {
    // Purge the loaded queue/cache before publishing the next identity. The
    // call is synchronous so descendants can never observe another account's
    // in-memory data during a provider transition.
    resetLoadedRuntime?.();
    storageIdentity = next;
    notifyQueueCleared();
  }
  purgeLegacyOfflineStorage();
}

export function resetOfflineStorageIdentity(): void {
  storageIdentity = null;
  resetLoadedRuntime?.();
  purgeLegacyOfflineStorage();
}

export function hasOfflineStorageIdentity(): boolean {
  return storageIdentity !== null;
}

export function clearOfflineStorage(): void {
  resetOfflineStorageIdentity();
  notifyQueueCleared();
}

/** @internal Legacy plaintext records are deleted, never read or restored. */
export function purgeLegacyOfflineStorage(): void {
  if (typeof window === "undefined") return;
  try {
    const storage = window.localStorage;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        key === LEGACY_QUEUE_KEY ||
        key?.startsWith(LEGACY_CACHE_PREFIX) ||
        key?.startsWith(DISK_QUEUE_PREFIX) ||
        key?.startsWith(DISK_CACHE_PREFIX)
      ) {
        keys.push(key);
      }
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* storage may be unavailable */
  }
}

function notifyQueueCleared(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent(OFFLINE_QUEUE_CHANGED_EVENT, {
        detail: { count: 0 },
      }),
    );
  } catch {
    /* event APIs unavailable */
  }
}

function identityKey(userId: string, tenantId: string): string | null {
  const user = userId.trim();
  const tenant = tenantId.trim();
  if (!user || !tenant || user.length > 128 || tenant.length > 128) return null;
  return `${user}:${tenant}`;
}
