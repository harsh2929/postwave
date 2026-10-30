/**
 * Crash-safe, possession-only cleanup journal for native push registrations.
 * It intentionally stores no Expo token, user/session id, or cookie. A single
 * installation can have cleanup pending against multiple API origins after
 * account/server switches, so the journal is a small bounded array rather
 * than a last-write-wins marker.
 *
 * This module is now a thin SecureStore adapter: every rule it used to hold
 * inline — origin canonicalisation, possession-key validation, the record
 * filter and the bounded insert — lives in lib/pushRevocationRecords.ts, which
 * has no native imports and is therefore unit-testable in the node environment
 * (NATIVE#51). The re-exports keep every existing import path working.
 */
import * as SecureStore from "expo-secure-store";

import {
  MAX_JOURNAL_BYTES,
  MAX_PENDING_REVOKES,
  normalizePushServerBaseUrl,
  parseRevocationJournal,
  withQueuedRevocation,
  type PendingPushRevocation,
} from "@/lib/pushRevocationRecords";

const SECURE_KEY_PENDING_REVOKE = "postwave.push_pending_revoke.v1";
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export { normalizePushServerBaseUrl };
export type { PendingPushRevocation };

export async function queuePendingPushRevocation(
  baseUrl: string,
  deviceKey: string,
): Promise<void> {
  const pending: PendingPushRevocation = {
    baseUrl: normalizePushServerBaseUrl(baseUrl),
    deviceKey,
    createdAt: Date.now(),
  };
  const current = await readPendingPushRevocations();
  await replacePendingPushRevocations(withQueuedRevocation(current, pending));
}

export async function readPendingPushRevocations(): Promise<
  PendingPushRevocation[]
> {
  const raw = await SecureStore.getItemAsync(
    SECURE_KEY_PENDING_REVOKE,
    SECURE_OPTIONS,
  );
  if (!raw) return [];
  if (raw.length > MAX_JOURNAL_BYTES) {
    await clearPendingPushRevocations();
    return [];
  }
  try {
    // Accept the original single-record format and rewrite it on the next
    // mutation so already-installed builds upgrade without losing cleanup.
    const { records, changed } = parseRevocationJournal(
      JSON.parse(raw) as unknown,
    );
    if (changed) await replacePendingPushRevocations(records);
    return records;
  } catch {
    await clearPendingPushRevocations();
    return [];
  }
}

export async function removePendingPushRevocation(
  baseUrl: string,
  deviceKey: string,
): Promise<void> {
  const normalized = normalizePushServerBaseUrl(baseUrl);
  const pending = await readPendingPushRevocations();
  await replacePendingPushRevocations(
    pending.filter(
      (entry) => entry.baseUrl !== normalized || entry.deviceKey !== deviceKey,
    ),
  );
}

export async function replacePendingPushRevocations(
  pending: PendingPushRevocation[],
): Promise<void> {
  if (pending.length === 0) {
    await clearPendingPushRevocations();
    return;
  }
  if (pending.length > MAX_PENDING_REVOKES) {
    throw new Error("Too many pending push revocations.");
  }
  const encoded = JSON.stringify(pending);
  if (encoded.length > MAX_JOURNAL_BYTES) {
    throw new Error("Pending push revocation journal is too large.");
  }
  await SecureStore.setItemAsync(
    SECURE_KEY_PENDING_REVOKE,
    encoded,
    SECURE_OPTIONS,
  );
}

async function clearPendingPushRevocations(): Promise<void> {
  await SecureStore.deleteItemAsync(SECURE_KEY_PENDING_REVOKE, SECURE_OPTIONS);
}
