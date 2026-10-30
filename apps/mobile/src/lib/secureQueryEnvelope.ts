/**
 * lib/secureQueryEnvelope — how the persisted query blob is shaped, sized and
 * addressed in the Keychain.
 *
 * Split out of secureQueryPersister, which was 527 lines at HEAD against a
 * 450-line ceiling and had grown further. The seam is a real one: everything
 * here is pure or a thin SecureStore shim, with no knowledge of when a persist
 * happens or what the caller intends. The persister keeps the lifecycle — when
 * to write, when to refuse, the tombstone ordering — and imports the shaping.
 *
 * Two properties recorded here because they are measured, not assumed:
 *   - `CHUNK_MAX_BYTES` is 1800. The installed expo-secure-store carries no
 *     documented size limit, so this is a conservative chunk size rather than a
 *     platform constraint; chunk count drives op count, not round-trip depth,
 *     because reads and writes are each issued as a single concurrent batch.
 *   - `splitUtf8` costs ~0.7ms at the 72KB cap and `checksum` ~0.07ms. A
 *     symmetric "faster" rewrite of the byte-length helper measured 7.4x
 *     SLOWER, because a whitespace-free `replace` is a C++ scan that returns
 *     the receiver without copying. Do not re-attempt it.
 */
import type { PersistedClient } from "@tanstack/react-query-persist-client";
import * as SecureStore from "expo-secure-store";

import {
  reportOfflinePersistenceEviction,
  reportOfflinePersistenceOverflow,
  trimPersistedMutations,
} from "./offlinePersistenceHealth";
import { utf8ByteLength } from "./utf8";

export type StoredEnvelope = {
  /**
   * SCHEMA BUSTER. Bump this whenever the SHAPE of anything a query stores
   * changes -- not just when this envelope's own fields change.
   *
   * restoreSecureClient discards a cache whose version does not match, so this
   * number is the only thing standing between a NEW build and a cache written
   * by an OLD one. A restored payload is handed straight to components, which
   * write `query.data ?? []` -- a NULLISH guard that passes a stale `{}` or
   * `{items: []}` through to a spread or a .map.
   *
   * That is not hypothetical: app/(tabs)/api-keys.tsx shipped
   * "Invalid attempt to spread non-iterable instance" by exactly this route, and
   * 25 further render sites bind `q.data ?? []` and then iterate it. The
   * queryFns all normalise to arrays, so a LIVE response is safe; only a
   * restored one from a previous shape is not.
   *
   * Bumping costs offline users their cached data on that one update, which is
   * the correct trade against rendering a shape the code no longer understands.
   */
  version: 2;
  scope: string;
  expiresAt: number;
  client: PersistedClient;
};

const PERSISTED_TTL_MS = 2 * 60 * 60 * 1_000;
const PREFIX = "postwave.mobile.query-cache.v2";
const CHUNK_MAX_BYTES = 1_800;
const MAX_CHUNKS = 40;
const MAX_PERSISTED_BYTES = CHUNK_MAX_BYTES * MAX_CHUNKS;
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
/** Two slots, alternated so a write never overwrites the copy being read. */
type Slot = "a" | "b";

/**
 * Make the envelope fit the encrypted budget (NATIVE#45).
 *
 * This used to be a bare `throw` BEFORE the manifest was touched, so an
 * over-budget dehydrate left the previously committed slot in place and every
 * later queued edit stopped reaching disk — silently, because
 * `PersistQueryClientProvider` swallows the rejection. The on-disk queue froze
 * at whatever it happened to hold and the user was never told.
 *
 * `shouldPersistQuery` returns false for everything (lib/queryClient.ts), so
 * the only variable-size content here is the paused mutation list. Evicting
 * the OLDEST queued writes until the payload fits keeps the newest edits
 * durable, and the eviction is REPORTED (lib/offlinePersistenceHealth.ts)
 * rather than silent. Only a payload that cannot fit even with an empty queue
 * still fails closed.
 */
/**
 * A persisted mutation minus its rollback snapshot.
 *
 * `onMutate` in lib/optimisticQueries returns the OptimisticSnapshot — full
 * cached rows for every projection the write touched — and TanStack keeps it
 * as `state.context` so `onError` can roll back. Dehydrating a paused
 * mutation carries that state verbatim, which put cached rows into the
 * Keychain under the offline queue's key. A snapshot is only meaningful to
 * the process that took it: after a restart the queries are gone and the
 * rows would be re-fetched, so nothing is lost by dropping it, and the
 * "only allowlisted paused mutations are persisted" invariant becomes true
 * of the DATA and not merely of the entries.
 */
export function withoutRollbackContext(mutation: unknown): unknown {
  if (!mutation || typeof mutation !== "object") return mutation;
  const state = (mutation as { state?: unknown }).state;
  if (!state || typeof state !== "object" || !("context" in state)) return mutation;
  const { context: _dropped, ...rest } = state as { context?: unknown };
  return { ...(mutation as object), state: rest };
}

export function fitClientToBudget(envelope: StoredEnvelope): {
  raw: string;
  bytes: number;
} {
  const stored = envelope.client.clientState?.mutations ?? [];
  const stripped = stored.map(withoutRollbackContext);
  envelope = withMutations(envelope, stripped);
  const raw = JSON.stringify(envelope);
  const bytes = utf8ByteLength(raw);
  if (bytes <= MAX_PERSISTED_BYTES) return { raw, bytes };

  const mutations = envelope.client.clientState?.mutations ?? [];
  const measure = (kept: readonly unknown[]): number =>
    utf8ByteLength(JSON.stringify(withMutations(envelope, kept)));
  const { kept, dropped } = trimPersistedMutations(
    mutations,
    measure,
    MAX_PERSISTED_BYTES,
  );
  const trimmedRaw = JSON.stringify(withMutations(envelope, kept));
  const trimmedBytes = utf8ByteLength(trimmedRaw);
  if (trimmedBytes > MAX_PERSISTED_BYTES) {
    reportOfflinePersistenceOverflow({
      bytes,
      limitBytes: MAX_PERSISTED_BYTES,
    });
    throw new Error("Offline queue exceeds the encrypted persistence budget");
  }
  reportOfflinePersistenceEviction({
    dropped,
    bytes,
    limitBytes: MAX_PERSISTED_BYTES,
  });
  return { raw: trimmedRaw, bytes: trimmedBytes };
}

function withMutations(
  envelope: StoredEnvelope,
  mutations: readonly unknown[],
): StoredEnvelope {
  return {
    ...envelope,
    client: {
      ...envelope.client,
      clientState: {
        ...envelope.client.clientState,
        mutations: mutations as PersistedClient["clientState"]["mutations"],
      },
    },
  };
}
export function validChunkCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_CHUNKS
  );
}

export function validPersistedClient(value: unknown): value is PersistedClient {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedClient>;
  return (
    typeof candidate.timestamp === "number" &&
    Number.isFinite(candidate.timestamp) &&
    typeof candidate.buster === "string" &&
    Boolean(candidate.clientState) &&
    typeof candidate.clientState === "object" &&
    Array.isArray(candidate.clientState.queries) &&
    Array.isArray(candidate.clientState.mutations)
  );
}

export function splitUtf8(value: string, limit: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (chunk && chunkBytes + characterBytes > limit) {
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function checksum(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function slotMetaKey(slot: Slot): string {
  return `${PREFIX}.slot.${slot}.meta`;
}

export function slotChunkKey(slot: Slot, index: number): string {
  return `${PREFIX}.slot.${slot}.${index}`;
}

export function secureGet(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key, SECURE_OPTIONS);
}

export function secureSet(key: string, value: string): Promise<void> {
  return SecureStore.setItemAsync(key, value, SECURE_OPTIONS);
}

export const secureQueryPersistenceLimits = {
  maxBytes: MAX_PERSISTED_BYTES,
  ttlMs: PERSISTED_TTL_MS,
  schemaVersion: 2,
} as const;

