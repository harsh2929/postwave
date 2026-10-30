// SPDX-License-Identifier: AGPL-3.0-only
/**
 * TanStack Query v5 client + memory-only persister for the Next.js dashboard.
 *
 * Notes:
 *   - Browser-only data is not durably persisted. A web origin cannot keep
 *     an encryption key outside the same attacker/storage boundary as its
 *     ciphertext, so customer query payloads remain in tab memory.
 *   - Per-deploy buster: APP_VERSION comes from package.json so that
 *     deploys atomically invalidate persisted caches (closes the SW
 *     update race called out in the strategy doc).
 *   - onlineManager is wired to the Moosewave unified online signal
 *     so paused queries resume on the same criterion as the rest of
 *     the app (navigator + heartbeat + real-request).
 *   - Focus refetching is age-gated, not unconditional. See
 *     FOCUS_REFETCH_MIN_AGE_MS below.
 */

import { QueryClient } from "@tanstack/react-query";
import type { PersistedClient } from "@tanstack/react-query-persist-client";

import pkg from "../../package.json";

const APP_VERSION = (pkg as { version?: string }).version || "dev";

const IDB_DB = "postwave-web:cache";
const IDB_STORE = "query";
const CACHE_KEY = "tanstack-query-cache";
const liveQueryClients = new Set<QueryClient>();
const OUTBOX_RESOURCES = ["segments", "forms"] as const;

let ephemeralClient: PersistedClient | undefined;

export function buildCacheBuster(
  userId: string | null | undefined,
  tenantId: string | null | undefined,
): string {
  return `${APP_VERSION}:${userId || "anon"}:${tenantId || "anon"}`;
}

/**
 * Default freshness floor for queries that don't declare their own staleTime.
 * v5's default is 0, which means "refetch on every mount and every focus" —
 * around twenty live queries in the dashboard omit staleTime and were paying
 * that. Anything genuinely real-time is already covered by RealtimeInvalidator,
 * which invalidates the matching qk keys off the server event bus.
 */
const DEFAULT_STALE_TIME_MS = 30_000;

/**
 * Minimum data age before a window-focus event is allowed to refetch.
 *
 * WEB-FETCH-008: `refetchOnWindowFocus: true` combined with the shared
 * STALE.detail of 10s meant a single alt-tab away and back refired a page's
 * entire query set (11 XHRs on the segment detail route, every loaded page of
 * each infinite query in the SMS log). Returning to a tab after a few seconds
 * is not a signal that anything changed — the event bus is. Coming back after
 * a minute or more is, so focus refetching stays on for that case rather than
 * being switched off wholesale.
 */
const FOCUS_REFETCH_MIN_AGE_MS = 60_000;

/**
 * API answers that describe the environment rather than a failure: the service
 * behind the feature is not deployed here (service-availability.ts), or
 * Campaign Assurance is off (campaign-assurance-api.ts). Asking again cannot
 * change either, and the transport already does not re-send them (they carry
 * retryable: false), so a query does not retry them either: two more requests
 * and about three seconds before the page could say "not available here".
 * Matched by code so this module stays free of the API client.
 */
const ENVIRONMENT_STATE_CODES: ReadonlySet<string> = new Set([
  "service_not_deployed",
  "campaign_assurance_not_enabled",
]);

/** Two retries, as before, except for an answer about the environment. */
export function retryQuery(failureCount: number, error: unknown): boolean {
  const code =
    error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  if (typeof code === "string" && ENVIRONMENT_STATE_CODES.has(code)) return false;
  return failureCount < 2;
}

export function makeQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: "offlineFirst",
        retry: retryQuery,
        staleTime: DEFAULT_STALE_TIME_MS,
        refetchOnWindowFocus: (query) =>
          Date.now() - query.state.dataUpdatedAt >= FOCUS_REFETCH_MIN_AGE_MS,
        refetchOnReconnect: true,
        gcTime: 30 * 60 * 1000,
      },
      mutations: {
        networkMode: "offlineFirst",
        // api.request already owns bounded retries and preserves one
        // Idempotency-Key across every transport attempt. Retrying the
        // mutation here would invoke api.request again, mint a fresh key, and
        // risk duplicating a write after an ambiguous network/5xx outcome.
        // Offline replay likewise owns its retry budget with the stored key.
        retry: false,
      },
    },
  });
  // Feature 10 — per-resource mutation defaults carry the outbox lifecycle,
  // network and garbage-collection policy. Query retries remain disabled;
  // offline replay owns its retry budget and preserves the stored key.
  // This three-line policy used to be imported from the replay runtime's
  // shared module, which made every dashboard route download the rest of that
  // async chunk. Keep the exact mutation defaults at the client boundary.
  for (const resource of OUTBOX_RESOURCES) {
    client.setMutationDefaults([resource], {
      retry: false,
      networkMode: "offlineFirst",
      gcTime: 24 * 60 * 60 * 1000,
    });
  }
  liveQueryClients.add(client);
  return client;
}

// The cache is intentionally tab-memory only. A generic persistence adapter
// pulled two persistence packages plus their serialization machinery into
// every dashboard route merely to store one module variable. Keep the tiny
// Persister contract directly: tests and teardown retain the same API, while
// customer data never crosses into browser storage.
export const idbPersister = {
  async persistClient(client: PersistedClient): Promise<void> {
    ephemeralClient = client;
  },
  async restoreClient(): Promise<PersistedClient | undefined> {
    return ephemeralClient;
  },
  async removeClient(): Promise<void> {
    ephemeralClient = undefined;
  },
};

/**
 * Delete the plaintext IndexedDB record written by pre-H-01 releases. This is
 * invoked at authenticated-provider startup and at every logout boundary;
 * new builds never read this record and never write another disk copy.
 */
export async function purgeLegacyQueryCache(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    // Legacy IndexedDB support is deletion-only and runs after mount. Loading
    // idb-keyval on demand keeps an obsolete storage backend out of the
    // authenticated shell's critical path.
    const { createStore, del } = await import("idb-keyval");
    const legacyIDBStore = createStore(IDB_DB, IDB_STORE);
    await del(CACHE_KEY, legacyIDBStore);
  } catch {
    /* IndexedDB unavailable or already gone */
  }
}

/**
 * Remove all in-memory TanStack data and any legacy disk snapshot at the
 * authentication boundary.
 */
export async function clearQueryState(): Promise<void> {
  for (const client of liveQueryClients) {
    client.clear();
  }
  await idbPersister.removeClient();
  await purgeLegacyQueryCache();
}
