import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PersistedClient } from "@tanstack/react-query-persist-client";
import * as SecureStore from "expo-secure-store";

import {
  type StoredEnvelope,
  secureQueryPersistenceLimits,
  checksum,
  fitClientToBudget,
  secureGet,
  secureSet,
  slotChunkKey,
  slotMetaKey,
  splitUtf8,
  validChunkCount,
  validPersistedClient,
} from "./secureQueryEnvelope";
import { utf8ByteLength } from "./utf8";

const PREFIX = "postwave.mobile.query-cache.v2";
const MANIFEST_KEY = `${PREFIX}.manifest`;
const CLEANUP_KEY = `${PREFIX}.cleanup-pending`;
const LEGACY_ASYNC_STORAGE_KEY = "postwave.mobile.query-cache.v1";
const SLOT_NAMES = ["a", "b"] as const;
const CHUNK_MAX_BYTES = 1_800;
const MAX_CHUNKS = 40;
const MAX_PERSISTED_BYTES = CHUNK_MAX_BYTES * MAX_CHUNKS;
const PERSISTED_TTL_MS = 2 * 60 * 60 * 1_000;
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

type Slot = (typeof SLOT_NAMES)[number];

type PersistenceIdentity = {
  baseUrl: string;
  tenantId: string;
  principalId: string;
  role: string;
};


type StoredManifest = {
  version: 2;
  scope: string;
  slot: Slot;
  chunks: number;
  bytes: number;
  checksum: string;
};

type SlotMeta = { version: 2; chunks: number };

type Persister = {
  persistClient(client: PersistedClient): Promise<void>;
  restoreClient(): Promise<PersistedClient | undefined>;
  removeClient(): Promise<void>;
};

let activeScope: string | null = null;
let operationQueue: Promise<void> = Promise.resolve();

/**
 * WRITE-STORM GUARD (identity of the last payload actually written).
 *
 * TanStack v5's `persistQueryClientSubscribe` calls `persistQueryClientSave`
 * on EVERY query-cache and mutation-cache event and does NOT throttle -- v4
 * threw a throttle around it, v5 dropped it. Each call arrives here as a full
 * encrypted persist: chunk the payload, delete the old slot, and write up to
 * MAX_CHUNKS Keychain items.
 *
 * The payload almost never changes. `shouldPersistQuery` is false
 * unconditionally, so this store holds ONLY paused mutations, and a cold start
 * fires hundreds of query-cache events while that list stays byte-identical.
 * The result was hundreds of redundant Keychain write cycles per launch, on
 * the JS thread that also drives scrolling.
 *
 * The key is built from `clientState` ALONE. The envelope carries `expiresAt`
 * and the PersistedClient carries `timestamp`, both of which move on every
 * call, so hashing either would never match and this guard would be dead code
 * that still read as correct.
 */
let lastPersistedContent: string | null = null;
let lastPersistedAt = 0;

/**
 * Rewrite unchanged content this often anyway, to keep the on-disk TTL fresh.
 *
 * Skipping forever would be a DURABILITY bug, not just an optimisation: the
 * envelope expires after PERSISTED_TTL_MS and `restoreSecureClient` discards
 * an expired one. A mutation queued in a session that stays open longer than
 * the TTL would then be silently unrecoverable after a restart. A quarter of
 * the TTL bounds unchanged-content writes to one per interval while leaving
 * the stored entry comfortably inside its lifetime.
 */
const UNCHANGED_REPERSIST_INTERVAL_MS = PERSISTED_TTL_MS / 4;

function persistedContentKey(scope: string, client: PersistedClient): string {
  return `${scope}\u0000${client.buster}\u0000${JSON.stringify(client.clientState)}`;
}

/** Forget the guard so the next persist definitely writes. */
function invalidatePersistedContentKey(): void {
  lastPersistedContent = null;
  lastPersistedAt = 0;
}

/**
 * Select the identity allowed to restore future offline work. Session users
 * are scoped by origin + tenant + user + effective role. API-key mode may use
 * a non-secret stable fingerprint as principalId; callers must never pass a
 * bearer credential itself.
 */
export function configureQueryPersistenceScope(
  identity: PersistenceIdentity | null,
): string | null {
  const next = identity ? serializeScope(identity) : null;
  // A different identity writes to a different logical payload; carrying the
  // previous key over could skip the first write under the new scope.
  if (next !== activeScope) invalidatePersistedContentKey();
  activeScope = next;
  return activeScope;
}

export function queryPersistenceScope(identity: PersistenceIdentity): string {
  return serializeScope(identity);
}

function serializeScope(identity: PersistenceIdentity): string {
  const fields = [
    identity.baseUrl.trim().replace(/\/+$/, ""),
    identity.tenantId.trim(),
    identity.principalId.trim(),
    identity.role.trim().toLowerCase(),
  ];
  if (fields.some((value) => !value || value.length > 512)) {
    throw new Error("Invalid offline persistence identity scope");
  }
  return JSON.stringify(fields);
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const task = operationQueue.then(operation, operation);
  operationQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export const queryPersister: Persister = {
  persistClient(client) {
    const scope = activeScope;
    if (!scope) return Promise.resolve();
    return serialized(() => persistSecureClient(scope, client));
  },

  restoreClient() {
    const scope = activeScope;
    if (!scope) return Promise.resolve(undefined);
    return serialized(() => restoreSecureClient(scope));
  },

  removeClient() {
    return serialized(removeSecureClient);
  },
};

async function persistSecureClient(
  scope: string,
  client: PersistedClient,
): Promise<void> {
  const contentKey = persistedContentKey(scope, client);
  const now = Date.now();
  if (
    lastPersistedContent === contentKey &&
    now - lastPersistedAt < UNCHANGED_REPERSIST_INTERVAL_MS
  ) {
    // Same bytes, still comfortably inside the stored entry's TTL. Writing
    // them again would cost a full delete+write Keychain cycle and change
    // nothing on disk.
    return;
  }

  // Remove the retired plaintext cache on every successful code path. This is
  // deliberately a deletion-only AsyncStorage use; new data is never written
  // there.
  await AsyncStorage.removeItem(LEGACY_ASYNC_STORAGE_KEY);

  const fitted = fitClientToBudget({
    version: 2,
    scope,
    expiresAt: Date.now() + PERSISTED_TTL_MS,
    client,
  });
  const raw = fitted.raw;
  const chunks = splitUtf8(raw, CHUNK_MAX_BYTES);
  if (chunks.length === 0 || chunks.length > MAX_CHUNKS) {
    throw new Error("Offline queue cannot be persisted safely");
  }

  const current = await readManifest();
  const nextSlot: Slot = current?.slot === "a" ? "b" : "a";
  await clearSlot(nextSlot);
  await secureSet(
    slotMetaKey(nextSlot),
    JSON.stringify({
      version: 2,
      chunks: chunks.length,
    } satisfies SlotMeta),
  );

  try {
    // Concurrent, not serial. Each chunk is an independent Keychain item and
    // the manifest below is still the commit point, so ordering between chunks
    // carries no meaning -- awaiting them one at a time just multiplied the
    // native round-trip latency by the chunk count. `clearSlot` already
    // deletes in parallel; this is the matching half.
    await Promise.all(
      chunks.map((chunk, index) =>
        secureSet(slotChunkKey(nextSlot, index), chunk ?? ""),
      ),
    );
    const manifest: StoredManifest = {
      version: 2,
      scope,
      slot: nextSlot,
      chunks: chunks.length,
      bytes: fitted.bytes,
      checksum: checksum(raw),
    };
    // The manifest is the commit point. A process death before this write
    // leaves the previous slot readable; after it, the complete new slot is
    // authoritative.
    await secureSet(MANIFEST_KEY, JSON.stringify(manifest));
  } catch (error) {
    await clearSlot(nextSlot).catch(() => undefined);
    throw error;
  }

  // Recorded only AFTER the manifest commit point, so a failed write leaves
  // the guard clear and the next attempt retries rather than skipping.
  lastPersistedContent = contentKey;
  lastPersistedAt = now;

  if (current && current.slot !== nextSlot) {
    // A stale encrypted slot is not readable through the committed manifest.
    // Keep its meta on cleanup failure so the next write/removal can retry.
    await clearSlot(current.slot).catch(() => undefined);
  }
}


async function restoreSecureClient(
  scope: string,
): Promise<PersistedClient | undefined> {
  // PREAMBLE, IN ONE ROUND TRIP. Three keys in two stores, none reading what
  // another writes — but three `await`s, so three JS->native->JS round trips
  // before the chunk read below could even be dispatched (measured 4 waves for
  // a populated cache, 3 for an absent one; see the wave probe in
  // secureQueryPersister.latency.test.ts, which also explains why the win is
  // round trips and not Keychain time). The cleanup journal still wins — a
  // manifest read that raced it is discarded, and reads mutate nothing — and
  // readManifest() returns null rather than throwing on a corrupt manifest, so
  // the only rejection Promise.all can surface is the AsyncStorage delete,
  // which already failed the whole restore before this change.
  const [, cleanupPending, manifest] = await Promise.all([
    AsyncStorage.removeItem(LEGACY_ASYNC_STORAGE_KEY),
    secureGet(CLEANUP_KEY),
    readManifest(),
  ]);
  if (cleanupPending) {
    await removeSecureClient();
    return undefined;
  }
  if (!manifest || manifest.scope !== scope) return undefined;

  // Read the chunks CONCURRENTLY. This is the boot critical path: the
  // provider that owns it gates the app shell, so every Keychain round trip
  // here is time before first paint. Awaiting them one at a time cost one
  // full round trip per chunk — at a realistic 2-3ms per SecureStore call
  // that is ~53-77ms for a typical 23-chunk cache and ~92-136ms at the
  // 40-chunk cap, for reads that have no ordering relationship whatsoever.
  //
  // The write path next door already learned this ("awaiting them one at a
  // time just multiplied the [cost]"); the read path did not.
  //
  // Correctness is unchanged: the keys are distinct, Promise.all preserves
  // input order so index i is still chunk i, a missing chunk still discards
  // the whole cache, and the checksum below still validates the join.
  const pieces = await Promise.all(
    Array.from({ length: manifest.chunks }, (_unused, index) =>
      secureGet(slotChunkKey(manifest.slot, index)),
    ),
  );
  if (pieces.some((chunk) => chunk == null)) {
    await removeSecureClient();
    return undefined;
  }
  const raw = pieces.join("");
  if (
    utf8ByteLength(raw) !== manifest.bytes ||
    checksum(raw) !== manifest.checksum
  ) {
    await removeSecureClient();
    return undefined;
  }
  try {
    const envelope = JSON.parse(raw) as Partial<StoredEnvelope>;
    if (
      envelope.version !== 2 ||
      envelope.scope !== scope ||
      typeof envelope.expiresAt !== "number" ||
      !Number.isFinite(envelope.expiresAt) ||
      envelope.expiresAt <= Date.now() ||
      !validPersistedClient(envelope.client)
    ) {
      await removeSecureClient();
      return undefined;
    }
    return envelope.client;
  } catch {
    await removeSecureClient();
    return undefined;
  }
}

async function removeSecureClient(): Promise<void> {
  // The bytes are going away, so the next identical payload MUST be written
  // again -- otherwise signing back in would leave the queue unrecoverable.
  invalidatePersistedContentKey();
  const failures: unknown[] = [];
  // Tombstone FIRST and alone -- a process death between it and the deletions
  // below is what it exists to recover from.
  await secureSet(CLEANUP_KEY, String(Date.now())).catch((error) => {
    failures.push(error);
  });
  // The deletions themselves are independent (distinct keys, distinct slots,
  // one AsyncStorage key that no longer takes writes), so they go out
  // together: serial awaits cost 8 native round trips where 4 suffice, on both
  // the sign-out and the cold-launch teardown path. `allSettled` keeps the
  // contract -- every branch attempted, any failure keeps the tombstone rather
  // than claiming a clean wipe (secureQueryPersisterRemove.latency.test.ts).
  const results = await Promise.allSettled([
    SecureStore.deleteItemAsync(MANIFEST_KEY, SECURE_OPTIONS),
    ...SLOT_NAMES.map((slot) => clearSlot(slot)),
    AsyncStorage.removeItem(LEGACY_ASYNC_STORAGE_KEY),
  ]);
  for (const result of results) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length === 0) {
    await SecureStore.deleteItemAsync(CLEANUP_KEY, SECURE_OPTIONS).catch(
      (error) => failures.push(error),
    );
  }
  if (failures.length > 0) {
    throw new Error("Encrypted offline data cleanup is incomplete");
  }
}

async function readManifest(): Promise<StoredManifest | null> {
  const raw = await secureGet(MANIFEST_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredManifest>;
    if (
      parsed.version !== 2 ||
      (parsed.slot !== "a" && parsed.slot !== "b") ||
      typeof parsed.scope !== "string" ||
      !validChunkCount(parsed.chunks) ||
      typeof parsed.bytes !== "number" ||
      !Number.isSafeInteger(parsed.bytes) ||
      parsed.bytes <= 0 ||
      parsed.bytes > MAX_PERSISTED_BYTES ||
      typeof parsed.checksum !== "string"
    ) {
      return null;
    }
    return parsed as StoredManifest;
  } catch {
    return null;
  }
}

async function clearSlot(slot: Slot): Promise<void> {
  const rawMeta = await secureGet(slotMetaKey(slot));
  let count = 0;
  if (rawMeta) {
    try {
      const meta = JSON.parse(rawMeta) as Partial<SlotMeta>;
      count = validChunkCount(meta.chunks) ? meta.chunks : MAX_CHUNKS;
    } catch {
      count = MAX_CHUNKS;
    }
  }
  const results = await Promise.allSettled(
    Array.from({ length: count }, (_, index) =>
      SecureStore.deleteItemAsync(slotChunkKey(slot, index), SECURE_OPTIONS),
    ),
  );
  const failed = results.some((result) => result.status === "rejected");
  if (!failed) {
    await SecureStore.deleteItemAsync(slotMetaKey(slot), SECURE_OPTIONS);
  }
  if (failed) throw new Error("Encrypted offline slot cleanup is incomplete");
}

export { secureQueryPersistenceLimits };
