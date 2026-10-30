/**
 * TanStack Query v5 client + IDB-backed persister.
 *
 * Design choices:
 *   - Persister uses an idb-keyval store (`postwave:cache` DB, `query`
 *     object store) so cache survives Tauri WebView restarts without
 *     blowing the localStorage 5MB cap.
 *   - networkMode:'offlineFirst' on queries — cached payloads render
 *     immediately, refetches still happen when online.
 *   - onlineManager is wired to the Moosewave unified online signal
 *     (online-manager.ts) so paused queries resume on the SAME criterion
 *     the rest of the app uses (navigator + heartbeat + real-request).
 *   - The cache buster is `APP_VERSION:userId:tenantId`. Changing user
 *     OR tenant nukes the persisted cache, eliminating cross-tenant
 *     leak risk if a user switches identities in the same WebView.
 *   - Encryption: the persisted blob is encrypted with the AES-GCM key
 *     already used by secure-vault.ts (D02#3). Cleartext is kept in memory
 *     for query operations; ciphertext exists only in IndexedDB. Because
 *     the persister's serialize/deserialize hooks are synchronous, the
 *     crypto lives in the async idbAsyncStorage adapter's get/setItem —
 *     query callers don't pay the AES tax on in-memory reads, only on the
 *     throttled persist and the one-shot boot rehydrate.
 */

import {
  QueryClient,
  onlineManager as tanstackOnlineManager,
} from "@tanstack/react-query";

import { subscribeContextEpochCacheReset } from "./context-epoch";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type {
  AsyncStorage,
  PersistedClient,
} from "@tanstack/query-persist-client-core";
import { createStore, del, get, set } from "idb-keyval";

import { getRememberedSession } from "./api-client";
import { getOfflineIdentity } from "./offline-store";
import { getOnlineStatus } from "./online-manager";
import { installOutboxMutationDefaults } from "./outbox";
import { installReplayedQueryInvalidator } from "./replay-query-invalidator";
import { vaultCommitEncryptedString, vaultDecryptString } from "./secure-vault";

const APP_VERSION =
  (typeof window !== "undefined" &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((import.meta as any).env?.VITE_APP_VERSION as string | undefined)) ||
  "dev";

const IDB_DB = "postwave:cache";
const IDB_STORE = "query";
const CACHE_KEY = "tanstack-query-cache";

const idbStore = createStore(IDB_DB, IDB_STORE);

/**
 * idb-keyval shaped to TanStack's AsyncStorage<string> interface.
 * The persister writes a JSON string; we encrypt it (AES-GCM, vault key)
 * BEFORE it touches IDB and decrypt on read, so the on-disk blob is
 * ciphertext (D02#3). A decrypt miss (legacy plaintext, foreign key, or
 * corruption) reads as an empty cache and simply refetches — never as
 * trusted plaintext. If encryption is unavailable (no WebCrypto), we skip
 * persisting rather than fall back to writing cleartext.
 */
const idbAsyncStorage: AsyncStorage<string> = {
  getItem: async (key: string): Promise<string | null> => {
    try {
      const v = await get<string | undefined>(key, idbStore);
      if (v == null) return null;
      // Pre-D02#3 releases wrote the PersistedClient JSON directly. Delete
      // that plaintext before returning a safe cache miss. A structurally
      // valid AES-GCM envelope is retained when decryption returns null so a
      // temporary OS-keychain outage cannot destroy recoverable ciphertext.
      if (!isVaultCiphertextEnvelope(v)) {
        await del(key, idbStore);
        return null;
      }
      return await vaultDecryptString(v);
    } catch {
      return null;
    }
  },
  setItem: async (key: string, value: string): Promise<void> => {
    try {
      await vaultCommitEncryptedString(value, (envelope) =>
        set(key, envelope, idbStore),
      );
    } catch {
      /* quota / private mode / no WebCrypto — best-effort, never plaintext */
    }
  },
  removeItem: async (key: string): Promise<void> => {
    try {
      await del(key, idbStore);
    } catch {
      /* ignore */
    }
  },
};

function isVaultCiphertextEnvelope(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as {
      alg?: unknown;
      iv?: unknown;
      data?: unknown;
    };
    return (
      parsed.alg === "AES-GCM" &&
      typeof parsed.iv === "string" &&
      parsed.iv.length > 0 &&
      typeof parsed.data === "string" &&
      parsed.data.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Build the buster string per the spec: APP_VERSION:userId:tenantId.
 *
 * While `me` is unresolved (the boot window), we read the last-known
 * user/tenant from the remembered-session hint SYNCHRONOUSLY. Without
 * this, the initial buster is `…:anon:anon`, mismatches the persisted
 * one, and PersistQueryClientProvider's removeClient() destroys the IDB
 * cache on every boot — exactly the cache that offline cold-boot needs
 * (audit §3.4). When `me` resolves to the same identity the buster is
 * unchanged; a genuinely different identity still busts the cache.
 *
 * Empty user/tenant (no hint either) fall back to "anon" so the cache
 * is partitioned separately for the true pre-auth state.
 */
export function buildCacheBuster(
  userId: string | null | undefined,
  tenantId: string | null | undefined,
): string {
  let user = userId;
  let tenant = tenantId;
  if (!user || !tenant) {
    const hint = getRememberedSession();
    user = user || hint?.user_id;
    tenant = tenant || hint?.tenant_id;
  }
  if (user && tenant) return `${APP_VERSION}:${user}:${tenant}`;
  // API-key workspaces have no remembered session during cold boot. The
  // broker-derived offline identity includes the configured API origin, so it
  // prevents one workspace's encrypted cache from hydrating under another.
  const offlineIdentity = getOfflineIdentity();
  return `${APP_VERSION}:offline:${offlineIdentity || "anon"}`;
}

/**
 * Singleton QueryClient configured for offline-first reads. We
 * intentionally set NO global staleTime — per-query staleTime values
 * come from the STALE table in query-keys.ts.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: "offlineFirst",
      retry: 2,
      // Refetch on focus is good for fresh data but skip when we know
      // we're offline — the unified onlineManager handles resume.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      // Keep encrypted disk snapshots short-lived. Eight hours supports a
      // workday/offline restart without retaining customer data overnight.
      gcTime: 8 * 60 * 60 * 1000,
    },
    mutations: {
      networkMode: "offlineFirst",
      // retry: 0 — TanStack-level mutation retries re-invoke the
      // api-client call, which re-mints the Idempotency-Key (defeating
      // server dedupe) and stacks with httpFetch's internal retries.
      retry: 0,
    },
  },
});

// Feature 10 — install per-resource mutation defaults (retry budget,
// decorrelated jitter) so mutations keyed under [resource] inherit the
// outbox policy without each call site restating it.
installOutboxMutationDefaults(queryClient);
installReplayedQueryInvalidator((prefix) => {
  void queryClient.invalidateQueries({ queryKey: [prefix] });
});

/**
 * IDB-backed persister. Throttle 1s — same as the persister default,
 * documented here so it's visible at the call site.
 *
 * DECISION (audit §3.5): mutations are NOT persisted. A restored paused
 * mutation can never resume — there is no default `mutationFn` to
 * rehydrate it with and `resumePausedMutations()` is never called — so
 * persisting them only buries user edits silently on disk. Durability
 * for offline writes lives in the offline-store/outbox queue instead.
 * `serialize` strips mutations because the persistOptions live in
 * App.tsx (owned elsewhere); the effect is identical to dehydrateOptions
 * `shouldDehydrateMutation: () => false`.
 */
export const idbPersister = createAsyncStoragePersister({
  storage: idbAsyncStorage,
  key: CACHE_KEY,
  throttleTime: 1_000,
  serialize: (client: PersistedClient): string =>
    JSON.stringify({
      ...client,
      clientState: { ...client.clientState, mutations: [] },
    }),
});

/**
 * D02#3: wipe the persisted TanStack cache (IndexedDB) AND the in-memory
 * query cache on sign-out. Otherwise the previous tenant's cached lists /
 * detail records survive on disk and are restored for the next user who
 * signs in on the same device. Called from auth.fullSignOut.
 */
export async function clearPersistedQueryCache(): Promise<void> {
  try {
    await idbPersister.removeClient();
  } catch {
    /* IndexedDB unavailable — nothing persisted to wipe */
  }
  try {
    queryClient.clear();
  } catch {
    /* no-op */
  }
}

/**
 * Wire TanStack's onlineManager to the Moosewave unified online signal.
 * This must run exactly once at module-init time; calling it from a
 * useEffect would race the very first query mount.
 *
 * The setup function receives a `setOnline` callback that TanStack
 * uses to flip its own internal state. We bridge the Moosewave
 * onlineStatus ('online' | 'connecting' | 'offline') to a boolean —
 * 'connecting' counts as online so queries don't pause mid-flight.
 */
let onlineWired = false;
export function wireTanstackOnlineManager(
  subscribe: (cb: () => void) => () => void,
): void {
  if (onlineWired) return;
  onlineWired = true;
  tanstackOnlineManager.setEventListener((setOnline) => {
    const push = (): void => {
      setOnline(getOnlineStatus() !== "offline");
    };
    push();
    return subscribe(push);
  });
}

/**
 * Drop every cached answer when the server says the context moved.
 *
 * Desktop rebuilds nothing on a role change: the QueryClient is a module
 * singleton created once at launch, so a demotion, a plan downgrade or a
 * View-as-Viewer preview ending leaves a cache full of answers computed under
 * permissions the person no longer has — behind buttons the UI still offers,
 * in a window they never closed.
 *
 * `clear()` rather than `invalidateQueries()`: invalidation marks entries stale
 * but keeps serving them while it refetches, so the old answer stays on screen
 * during exactly the window that matters.
 *
 * Idempotent, because the app shell may mount more than once in development
 * and a second subscription would clear the cache twice for one change.
 */
let contextEpochWired = false;
export function wireContextEpochCacheReset(): void {
  if (contextEpochWired) return;
  contextEpochWired = true;
  subscribeContextEpochCacheReset({
    clear: () => {
      // The PERSISTED blob, not only the in-memory client.
      //
      // `queryClient.clear()` alone empties memory and leaves the encrypted
      // IndexedDB snapshot intact — and desktop keeps that for eight hours.
      // The next launch rehydrates the very cache this was meant to drop,
      // while provenance now says it is current, so nothing ever clears it
      // again. `clearPersistedQueryCache` was already in this file for exactly
      // this and was simply not called from here.
      void clearPersistedQueryCache();
    },
  });
}
