/**
 * lib/biometric.ts — typed, no-throw wrapper around
 * expo-local-authentication plus a persisted "lock the workspace behind
 * Face ID / Touch ID" preference.
 *
 * Design notes:
 *
 *  - Availability = hardware present AND a biometric/credential enrolled.
 *    We check both because a device can have a Face ID sensor but no
 *    enrolled face (fresh device / passcode-only user) — in that case the
 *    prompt would silently fall back to passcode, which is not what the
 *    "Require Face ID" toggle promises.
 *
 *  - authenticate() maps to the iOS `LAPolicyDeviceOwnerAuthentication`
 *    policy (disableDeviceFallback: false) so a user who can't pass the
 *    biometric scan can still unlock with the device passcode. This avoids
 *    a hard lock-out if Face ID fails repeatedly (e.g. mask / gloves).
 *
 *  - The preference is stored via SecureStore directly (the same Keychain
 *    primitive lib/secureVault.ts is built on). We deliberately do NOT
 *    route it through secureVault's vaultSetJSON: those entries carry a
 *    12-hour TTL and a PII-typed `kind`, so a long-lived security setting
 *    would silently expire and disable the lock. A small, permanent
 *    boolean — like the theme preference in lib/theme.ts — is the right
 *    shape here. The key namespace mirrors the vault's so a future
 *    "wipe everything" sweep can find it.
 *
 *  - Availability checks are guarded because they run during render setup.
 *    Preference writes deliberately reject: Settings must never claim that a
 *    security control changed when SecureStore did not commit it.
 */
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";

import {
  DEFAULT_APP_LOCK_GRACE_SECONDS,
  normalizeGraceSeconds,
  type AppLockGraceSeconds,
} from "@/lib/appLockGrace";

/**
 * SecureStore key for the lock preference. Namespaced under the same
 * `postwave.mobile` root as the vault so it's discoverable, but kept out
 * of the vault's TTL manifest (this is a permanent setting, not cached
 * PII).
 */
const LOCK_PREF_KEY = "postwave.mobile.biometric.lock";

/**
 * Grace window, in seconds, before a foreground return re-prompts. Stored
 * beside the lock preference and under the same permanent-setting rules (no
 * TTL, not PII). The POLICY lives in lib/appLockGrace.ts so it can be tested
 * without this module's native imports.
 */
const LOCK_GRACE_KEY = "postwave.mobile.biometric.lock.grace";

const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

type LockPreferenceListener = (enabled: boolean) => void;
const lockPreferenceListeners = new Set<LockPreferenceListener>();

/**
 * True when the device has a biometric (or, on Android, strong credential)
 * sensor AND the user has enrolled at least one. No-throw: any native
 * failure resolves to `false` (treat as "biometrics unavailable").
 */
export async function isBiometricAvailable(): Promise<boolean> {
  try {
    const [hasHardware, isEnrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return Boolean(hasHardware) && Boolean(isEnrolled);
  } catch {
    return false;
  }
}

/**
 * True when the device can perform ANY device-owner authentication — a
 * biometric OR a device passcode/PIN/pattern. This is the right gate for
 * "should the lock be armed": if the user enabled the lock and later removes
 * their enrolled face but still has a passcode, we must keep locking (and
 * fall back to the passcode prompt) rather than failing open. Only when the
 * device has NO credential at all (getEnrolledLevelAsync === NONE) is a
 * pass-through correct — arming then would hard-lock the user out, since
 * LAPolicyDeviceOwnerAuthentication can't satisfy itself.
 *
 * No-throw: any native failure resolves to `false`.
 */
export async function canAuthenticate(): Promise<boolean> {
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    return level !== LocalAuthentication.SecurityLevel.NONE;
  } catch {
    return false;
  }
}

/**
 * Prompts the OS biometric sheet. Resolves `true` only on a confirmed
 * success. A user cancel, lock-out, or any native error resolves `false`
 * (the caller keeps the workspace locked). Device-passcode fallback is
 * left enabled so a failed scan isn't a dead end.
 *
 * @param reason Copy shown in the system prompt (iOS Face ID subtitle /
 *   Android prompt title).
 */
export async function authenticate(reason: string): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      // Android defaults to accepting Class 2 (weak) biometrics. An app lock
      // protecting customer data must require Class 3; the documented device
      // credential fallback remains intentional for lockout recovery.
      biometricsSecurityLevel: "strong",
      // Keep the device-passcode fallback so a user who can't pass the
      // scan (failed Face ID, gloves on the sensor) is never locked out
      // of their own workspace.
      disableDeviceFallback: false,
      cancelLabel: "Cancel",
    });
    return result.success === true;
  } catch {
    return false;
  }
}

/**
 * Local possession step-up for a single high-value action.
 *
 * Distinct from the app lock: this proves the person holding the unlocked
 * phone right now is its owner, immediately before an action that hands
 * durable authority to something else — approving a CLI device grant mints a
 * role-scoped API key that outlives the session, and it was one tap on an
 * unattended, already-unlocked phone.
 *
 * Fails OPEN on a device with no enrolled credential at all. A phone with no
 * passcode cannot satisfy `authenticate()`, so hard-requiring it would make
 * the action permanently impossible rather than more secure.
 */
export async function requireDeviceAuth(reason: string): Promise<boolean> {
  if (!(await canAuthenticate())) return true;
  return authenticate(reason);
}

/**
 * Reads the persisted "require biometric unlock" preference. Defaults to
 * `false` (no lock) on a missing value or any read failure — a Keychain
 * error must never leave the user stuck behind a lock they didn't set.
 */
export async function getBiometricLockEnabled(): Promise<boolean> {
  // Read twice before believing a failure. A first Keychain call right after a
  // device unlock, or during a backgrounding transition, fails TRANSIENTLY far
  // more often than it fails permanently (see store/authSecureStorage) — and
  // this read runs once per gate mount, so a single transient error left the
  // lock disarmed for the whole app launch, taking the screen-capture and
  // app-switcher protection with it.
  //
  // The false default on a hard failure is deliberate and kept: a Keychain
  // that will not answer must not strand someone behind a lock they never set.
  // The retry removes the common cause without taking that risk.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const stored = await SecureStore.getItemAsync(
        LOCK_PREF_KEY,
        SECURE_OPTIONS,
      );
      return stored === "1";
    } catch {
      if (attempt === 1) return false;
    }
  }
  return false;
}

/**
 * Persist the lock preference transactionally and notify the mounted gate
 * only after SecureStore commits. Callers must surface a rejection and keep
 * their prior UI value; the persisted value is the source of truth.
 */
export async function setBiometricLockEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    await SecureStore.setItemAsync(LOCK_PREF_KEY, "1", SECURE_OPTIONS);
  } else {
    await SecureStore.deleteItemAsync(LOCK_PREF_KEY, SECURE_OPTIONS);
  }
  for (const listener of lockPreferenceListeners) listener(enabled);
}

/** React to a committed preference change without polling or remounting. */
export function subscribeBiometricLockPreference(
  listener: LockPreferenceListener,
): () => void {
  lockPreferenceListeners.add(listener);
  return () => lockPreferenceListeners.delete(listener);
}

/**
 * Reads the grace window. Any read failure, missing value or corrupted value
 * resolves to 0 — "authenticate every time" — because the failure mode of this
 * setting must be MORE locking, not less.
 */
export async function getAppLockGraceSeconds(): Promise<AppLockGraceSeconds> {
  try {
    const stored = await SecureStore.getItemAsync(LOCK_GRACE_KEY, SECURE_OPTIONS);
    return normalizeGraceSeconds(stored);
  } catch {
    return DEFAULT_APP_LOCK_GRACE_SECONDS;
  }
}

/**
 * Persists the grace window, then notifies the mounted gate. Rejects on a
 * storage failure for the same reason `setBiometricLockEnabled` does: Settings
 * must never claim a security control changed when the Keychain did not commit.
 */
export async function setAppLockGraceSeconds(seconds: number): Promise<void> {
  const value = normalizeGraceSeconds(seconds);
  if (value <= 0) {
    await SecureStore.deleteItemAsync(LOCK_GRACE_KEY, SECURE_OPTIONS);
  } else {
    await SecureStore.setItemAsync(LOCK_GRACE_KEY, String(value), SECURE_OPTIONS);
  }
  for (const listener of graceListeners) listener(value);
}

type GraceListener = (seconds: AppLockGraceSeconds) => void;
const graceListeners = new Set<GraceListener>();

/** Lets the mounted gate pick up a Settings change without a remount. */
export function subscribeAppLockGrace(listener: GraceListener): () => void {
  graceListeners.add(listener);
  return () => graceListeners.delete(listener);
}
