/**
 * store/authSecureStorage.ts
 *
 * The SecureStore key namespace for authentication plus the retry wrappers
 * every auth write goes through. Extracted from store/auth.ts (AUTH#60).
 *
 * Two key sets, and the difference is load-bearing:
 *
 *   - LOCAL_AUTH_STORAGE_KEYS is what a sign-out wipes. Anything listed here
 *     is credential-or-identity shaped and must not survive into the next
 *     account on a shared device.
 *
 *   - SECURE_KEY_CLEANUP_PENDING and SECURE_KEY_SESSION_REVOKE_PENDING are
 *     JOURNALS about an incomplete sign-out. They are deliberately NOT in that
 *     list: wiping them as part of the wipe they are recording would erase the
 *     very evidence hydrate() needs to fail closed on the next launch.
 *
 *   - postwave.mobile.helpdesk.note-intents.v2 is another deliberate journal
 *     exception. It contains only hashes, timestamps, and non-expiring
 *     idempotency keys for unresolved internal-note commits. Deleting it at
 *     sign-out could duplicate a note after the same canonical session
 *     principal returns. The journal is principal-isolated and capped both per
 *     principal and per device; it never restores authentication authority.
 *
 * Every operation is retried exactly once. A first keychain call right after a
 * device unlock, or during a backgrounding transition, fails transiently far
 * more often than it fails permanently.
 */
import * as SecureStore from "expo-secure-store";

import { BUILD_PROFILE } from "@/lib/config";
import { demoModeEnabled } from "@/lib/demoMode";

export const SECURE_KEY_API = "postwave.api_key";
export const SECURE_KEY_BASE = "postwave.base_url";
export const SECURE_KEY_TENANT = "postwave.tenant_id";
export const SECURE_KEY_PUSH_TOKEN = "postwave.push_token";
export const SECURE_KEY_SESSION = "postwave.session_profile";
export const SECURE_KEY_SESSION_STAGE = "postwave.session_profile.pending";
export const SECURE_KEY_CLEANUP_PENDING = "postwave.auth_cleanup_pending";
export const SECURE_KEY_SESSION_REVOKE_PENDING =
  "postwave.session_revocation_pending";

const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const LOCAL_AUTH_STORAGE_KEYS = [
  SECURE_KEY_API,
  SECURE_KEY_BASE,
  SECURE_KEY_TENANT,
  SECURE_KEY_PUSH_TOKEN,
  SECURE_KEY_SESSION,
  SECURE_KEY_SESSION_STAGE,
] as const;

/**
 * DEMO MODE ONLY: an in-memory stand-in for the platform keychain.
 *
 * Not a weakening of the auth rules — every latch, teardown and fail-closed
 * path still runs against this map exactly as it runs against SecureStore.
 * What it removes is the DURABLE marker: `SECURE_KEY_CLEANUP_PENDING` survives
 * app launches and device erases, and once set it refuses every later sign-in
 * (`AuthSessionStateError: local_cleanup_pending`) via the same handler that
 * re-asserts it. Correct for a real user; an unopenable door for QA.
 *
 * See lib/demoMode — production can never reach this.
 */
const demoStore = new Map<string, string>();

// The literal member expression matters: Metro inlines `process.env.EXPO_PUBLIC_*`
// by textual substitution, so reading it off a spread `process.env` object
// yields undefined in a release bundle.
const useDemoStore = demoModeEnabled(
  { EXPO_PUBLIC_DEV_DEMO: process.env.EXPO_PUBLIC_DEV_DEMO },
  BUILD_PROFILE,
);

export function secureGet(key: string): Promise<string | null> {
  if (useDemoStore) return Promise.resolve(demoStore.get(key) ?? null);
  return SecureStore.getItemAsync(key, SECURE_OPTIONS);
}

export function secureSet(key: string, value: string): Promise<void> {
  if (useDemoStore) {
    demoStore.set(key, value);
    return Promise.resolve();
  }
  return SecureStore.setItemAsync(key, value, SECURE_OPTIONS);
}

export function secureDelete(key: string): Promise<void> {
  if (useDemoStore) {
    demoStore.delete(key);
    return Promise.resolve();
  }
  return SecureStore.deleteItemAsync(key, SECURE_OPTIONS);
}

export async function retryStorageOperation(
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch {
    await operation();
  }
}

export async function retryStorageRead(
  operation: () => Promise<string | null>,
): Promise<string | null> {
  try {
    return await operation();
  } catch {
    return operation();
  }
}

export async function setPushToken(token: string): Promise<void> {
  await secureSet(SECURE_KEY_PUSH_TOKEN, token);
}

export async function clearPushToken(): Promise<void> {
  await secureDelete(SECURE_KEY_PUSH_TOKEN);
}

export async function getPushToken(): Promise<string | null> {
  return secureGet(SECURE_KEY_PUSH_TOKEN);
}
