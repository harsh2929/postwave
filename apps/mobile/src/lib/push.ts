/**
 * lib/push.ts — Expo push notification registration.
 *
 * Flow:
 *
 *   1. Ask the OS for notification permission. iOS prompts once; later
 *      'denied' answers stick until the user toggles in Settings.
 *
 *   2. Get the Expo push token. Format:
 *      "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]". This is the
 *      identifier the server sends to the Expo Push Service, which
 *      then translates to APNs (iOS) / FCM (Android) device tokens.
 *
 *   3. Register the current user's physical installation through the
 *      dedicated mobile-device API. The Expo token is sent only in the
 *      authenticated JSON body and stored envelope-encrypted server-side.
 *
 *   4. Save the token in SecureStore so subsequent launches can detect
 *      that registration already happened (idempotent toggle).
 *
 * Failure modes:
 *
 *   - Permission denied → return null, caller surfaces a nudge.
 *   - Not a real device (simulator) → expo-notifications returns null
 *     for the token; we treat that as "no push, no error".
 *   - Server registration fails → reject and leave the toggle OFF; callers
 *     surface a retry instead of reporting a false local-only success.
 */
import { PostwaveClient } from "@postwave/sdk";
import { EVENTS } from "@postwave/telemetry";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";

import { getClient } from "@/api/sdkClient";
import { refreshAppBadge } from "@/lib/appBadge";
import { BUILD_PROFILE } from "@/lib/config";
import { trackPermissionOutcome } from "@/lib/permissionTelemetry";
import {
  registerAndroidNotificationChannels,
  registerNotificationCategories,
} from "@/lib/pushPresentation";
import { startPushLifecycle, teardownPushPresence } from "@/lib/pushLifecycle";
import {
  normalizePushPermissionState,
  type PushPermissionState,
} from "@/lib/pushPriming";
import {
  getOrCreatePushDeviceKey,
  readPushDeviceKey,
} from "@/lib/pushDeviceStore";
import {
  boundedHealthDuration,
  pushErrorCode,
} from "@/lib/pushObservation";
import { resolveEnabledPushEvents } from "@/lib/pushTopics";
import { track } from "@/lib/telemetry";
import { clearPushToken, setPushToken, useAuthStore } from "@/store/auth";
import {
  normalizePushServerBaseUrl,
  queuePendingPushRevocation,
  readPendingPushRevocations,
  removePendingPushRevocation,
  replacePendingPushRevocations,
  type PendingPushRevocation,
} from "@/lib/pushRevocationJournal";

/**
 * NATIVE#54 — this module used to own eight concerns. What is left is ONE: the
 * device registration lifecycle (permission -> token -> server row -> revoke).
 * The rest moved to siblings that can each be tested on their own terms, and
 * are re-exported here because `@/lib/push` is the import path every screen,
 * hook and route test already uses; the split is an implementation detail and
 * must not become a migration.
 *
 *   OS presentation (channels, categories) . . lib/pushPresentation.ts
 *   possession-key format + entropy  . . . . . lib/pushDeviceKey.ts
 *   possession-key Keychain storage  . . . . . lib/pushDeviceStore.ts
 *   health telemetry buckets/clamps  . . . . . lib/pushObservation.ts
 *   notification-response parsing  . . . . . . lib/pushNotificationAction.ts
 *   cold-start approval decisions  . . . . . . lib/pushApprovalDecision.ts
 */
export {
  PUSH_ACTION_APPROVE,
  PUSH_ACTION_REJECT,
  PUSH_ACTION_VIEW,
  PUSH_CATEGORY_APPROVAL,
  PUSH_CATEGORY_ENTITY,
  PUSH_CATEGORY_SECURITY,
  registerAndroidNotificationChannels,
  registerNotificationCategories,
} from "@/lib/pushPresentation";
export {
  NEW_DEVICE_SIGN_IN_EVENT,
  PUSH_ACTION_REVOKE_SESSION,
} from "@/lib/pushSecuritySession";
export { readPushDeviceKey } from "@/lib/pushDeviceStore";
export {
  MAX_PUSH_ENTITY_ID_CHARS,
  parseNotificationAction,
  type ParsedNotificationAction,
} from "@/lib/pushNotificationAction";
export {
  decideApprovalFromNotification,
  lastNotificationResponse,
} from "@/lib/pushApprovalDecision";

/**
 * registerForPushNotifications. Idempotent — safe to call on every
 * launch. Returns the Expo push token, or null if registration
 * couldn't complete (permission denied, simulator, etc.).
 */
export async function registerForPushNotifications(): Promise<string | null> {
  return observePushRegistration("settings", async () => {
    if (!Device.isDevice) {
      trackPermissionOutcome("notifications", "unsupported");
      return null;
    }
    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (granted) {
      trackPermissionOutcome("notifications", "already_granted");
    } else {
      const requested = await Notifications.requestPermissionsAsync();
      granted = requested.granted;
      // NATIVE#56: registration_completed reports `unavailable` for a denied
      // prompt, a simulator and a token failure alike, so a permission-refusal
      // rate was not derivable. This separates the OS decision from the rest.
      trackPermissionOutcome("notifications", granted ? "granted" : "denied");
    }
    if (!granted) return null;
    return completePushRegistration();
  });
}

/**
 * getNotificationPermissionGranted — reads the LIVE OS notification
 * permission. Use this (not just "is a token stored") to drive the
 * Settings toggle, so it flips OFF when the user revokes permission in
 * the iOS/Android system settings.
 */
export async function getNotificationPermissionGranted(): Promise<boolean> {
  if (!Device.isDevice) return false;
  const { granted } = await Notifications.getPermissionsAsync();
  return granted;
}

/**
 * getNotificationPermissionState — the THREE-way permission read.
 *
 * `getNotificationPermissionGranted` collapses "not yet asked" and "the user
 * said no and iOS will never ask again" into a single `false`, which is enough
 * to drive a switch but not enough to decide what to SAY before requesting.
 * See src/lib/pushPriming.ts.
 *
 * A simulator (`!Device.isDevice`) can never be granted and can never be
 * prompted; reporting `denied` there would send the user to a Settings pane
 * that has no Moosewave entry, so it reports `undetermined`.
 */
export async function getNotificationPermissionState(): Promise<PushPermissionState> {
  if (!Device.isDevice) return "undetermined";
  const { status, granted } = await Notifications.getPermissionsAsync();
  return normalizePushPermissionState(status, granted);
}

/**
 * registerForPushNotificationsIfGranted — launch-safe variant that NEVER
 * shows the OS permission dialog. It completes registration only when
 * permission has ALREADY been granted. Call this on app launch so we don't
 * burn iOS's one-shot permission prompt before the user has primed it by
 * opting in from Settings (which calls registerForPushNotifications).
 */
export async function registerForPushNotificationsIfGranted(): Promise<
  string | null
> {
  return observePushRegistration("launch", async () => {
    if (!Device.isDevice) return null;
    const existing = await Notifications.getPermissionsAsync();
    if (!existing.granted) return null;
    return completePushRegistration();
  });
}

/**
 * Shared tail of both registration paths: assumes permission is granted,
 * sets up the Android channel, mints the Expo push token, and registers the
 * acting session user's device. Returns the token only after the server
 * confirms durable registration.
 */
async function completePushRegistration(): Promise<string | null> {
  if (Platform.OS === "android") {
    // Channels must exist before we can post — iOS doesn't need this.
    await registerAndroidNotificationChannels();
  }

  // Expo Push Service token — agnostic to APNs/FCM. Production builds should
  // always have an EAS project id from Constants.easConfig or env; dev clients
  // can still omit it.
  const projectId = expoProjectId();
  if (!projectId && BUILD_PROFILE === "production") {
    console.warn("[postwave-mobile] missing EAS project id; push disabled");
    return null;
  }
  // Register the interactive categories (Approve/Reject, View) alongside the
  // token so a delivered push can show its action buttons. Best-effort and
  // idempotent — see registerNotificationCategories.
  await registerNotificationCategories();

  const tokenResp = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : {},
  );
  const token = tokenResp.data;
  if (!token) return null;

  const auth = useAuthStore.getState();
  if (!auth.isAuthenticated() || auth.mode !== "session") return null;
  const deviceKey = await getOrCreatePushDeviceKey();
  const pending = await readPendingPushRevocations();
  if (pending.length > 0) {
    // Best effort before the new claim. When the old origin is temporarily
    // down, registration on the current origin may still proceed; a different
    // old origin remains queued, while a same-origin claim safely supersedes
    // the stale row.
    await retryPendingPushRevocation().catch(() => false);
  }
  const { baseUrl, client } = getClient();
  const registered = await client.mobilePush.register({
    device_key: deviceKey,
    expo_push_token: token,
    platform: Platform.OS === "android" ? "android" : "ios",
    // The user's per-topic choice (src/lib/pushTopics.ts), falling back to the
    // manifest defaults when they've never expressed one. Previously this was a
    // module constant computed once at load, so the 16-value allowlist the API
    // accepts had no UI at all.
    enabled_events: await resolveEnabledPushEvents(),
  });
  if (!registered.registered || !registered.delivery_enabled) {
    throw new Error("Push delivery is not enabled on this server.");
  }
  const remaining = await readPendingPushRevocations();
  if (
    remaining.some(
      (entry) =>
        normalizePushServerBaseUrl(entry.baseUrl) ===
          normalizePushServerBaseUrl(baseUrl) &&
        entry.deviceKey === deviceKey,
    )
  ) {
    // A successful same-origin claim atomically moves/reactivates the row for
    // this possession key, so a stale revoke for that exact origin/key has
    // been superseded. Cross-origin cleanup records remain independently
    // queued; one development/staging outage must not erase another origin.
    await removePendingPushRevocation(baseUrl, deviceKey);
  }
  await setPushToken(token);
  // A registered device is exactly the point at which the two long-lived
  // listeners become meaningful: token rotation (the row would otherwise go
  // stale until the next cold launch) and foreground delivery (which had no
  // cache-invalidation path of its own). Idempotent — this runs every launch.
  startPushLifecycle({ onTokenRotated: rotatePushToken });
  // Bring the icon badge in step with the inbox on every launch that has push.
  void refreshAppBadge();
  return token;
}

/**
 * Re-register after APNs/FCM rotates the Expo token while the app is resident
 * (NATIVE#48). The device key is unchanged, so the server's possession-key
 * upsert moves the registration atomically rather than orphaning a row.
 */
async function rotatePushToken(token: string): Promise<void> {
  const auth = useAuthStore.getState();
  if (!auth.isAuthenticated() || auth.mode !== "session") return;
  const deviceKey = await getOrCreatePushDeviceKey();
  const { client } = getClient();
  const registered = await client.mobilePush.register({
    device_key: deviceKey,
    expo_push_token: token,
    platform: Platform.OS === "android" ? "android" : "ios",
    enabled_events: await resolveEnabledPushEvents(),
  });
  if (!registered.registered || !registered.delivery_enabled) return;
  await setPushToken(token);
}

/**
 * unregisterPushNotifications durably revokes this installation before
 * clearing local state. A failed remote call is queued in SecureStore so it
 * can be retried without a session after logout.
 */
export async function unregisterPushNotifications(): Promise<void> {
  const startedAt = Date.now();
  try {
    await performPushUnregistration();
    track(EVENTS.MOBILE_PUSH_REVOCATION_COMPLETED, {
      source: "explicit",
      outcome: "success",
      duration_ms: boundedHealthDuration(startedAt),
    });
  } catch (error) {
    track(EVENTS.MOBILE_PUSH_REVOCATION_COMPLETED, {
      source: "explicit",
      outcome: "failure",
      error_code: pushErrorCode(error),
      duration_ms: boundedHealthDuration(startedAt),
    });
    throw error;
  }
}

async function performPushUnregistration(): Promise<void> {
  await teardownPushPresence();
  const deviceKey = await readPushDeviceKey();
  const auth = useAuthStore.getState();
  if (!deviceKey) {
    await clearPushToken();
    return;
  }
  const baseUrl = auth.baseUrl;
  try {
    if (auth.isAuthenticated() && auth.mode === "session") {
      const { client } = getClient();
      await client.mobilePush.revoke({ device_key: deviceKey });
    } else if (baseUrl) {
      await revokePushDeviceByPossession(baseUrl, deviceKey);
    }
  } catch (error) {
    let journalError: unknown;
    if (baseUrl) {
      try {
        await queuePendingPushRevocation(baseUrl, deviceKey);
      } catch (failedJournalWrite) {
        journalError = failedJournalWrite;
      }
    }
    // Local logout must never leave the Settings surface reporting an active
    // registration. The possession-bound journal above is sufficient for the
    // server retry and contains no Expo token/session credential.
    await clearPushToken();
    if (journalError) throw journalError;
    throw error;
  }
  if (baseUrl) {
    await removePendingPushRevocation(baseUrl, deviceKey);
  }
  await clearPushToken();
}

/**
 * Remove this device's server push registration while credentials are still
 * available, then clear auth. Sign-out must still complete if unregistering
 * the local token fails, hence the `finally` ordering.
 */
export async function unregisterPushThenSignOut(
  signOut: () => Promise<void>,
): Promise<void> {
  try {
    await unregisterPushNotifications();
  } finally {
    await signOut();
  }
}

/**
 * Retry every queued possession-bound revocation.
 *
 * Runs without a session: each entry carries only an origin and this
 * installation's possession key, so a device that failed to revoke before
 * logout can still finish the job on the next launch or reconnect. Failures
 * are re-queued, never dropped, and a per-origin failure must not discard
 * another origin's pending cleanup.
 */
export async function retryPendingPushRevocation(): Promise<boolean> {
  const pending = await readPendingPushRevocations();
  if (pending.length === 0) return true;
  const startedAt = Date.now();
  const remaining: PendingPushRevocation[] = [];
  const failures: unknown[] = [];
  for (const entry of pending) {
    try {
      await revokePushDeviceByPossession(entry.baseUrl, entry.deviceKey);
    } catch (error) {
      remaining.push(entry);
      failures.push(error);
    }
  }
  await replacePendingPushRevocations(remaining);
  if (failures.length === 0) {
    track(EVENTS.MOBILE_PUSH_REVOCATION_COMPLETED, {
      source: "retry",
      outcome: "success",
      duration_ms: boundedHealthDuration(startedAt),
    });
    return true;
  }
  const error = failures[0];
  track(EVENTS.MOBILE_PUSH_REVOCATION_COMPLETED, {
    source: "retry",
    outcome: "failure",
    error_code: pushErrorCode(error),
    duration_ms: boundedHealthDuration(startedAt),
  });
  throw error;
}

async function observePushRegistration(
  source: "launch" | "settings",
  operation: () => Promise<string | null>,
): Promise<string | null> {
  const startedAt = Date.now();
  try {
    const token = await operation();
    track(EVENTS.MOBILE_PUSH_REGISTRATION_COMPLETED, {
      source,
      outcome: token ? "success" : "unavailable",
      duration_ms: boundedHealthDuration(startedAt),
    });
    return token;
  } catch (error) {
    track(EVENTS.MOBILE_PUSH_REGISTRATION_COMPLETED, {
      source,
      outcome: "failure",
      error_code: pushErrorCode(error),
      duration_ms: boundedHealthDuration(startedAt),
    });
    throw error;
  }
}

async function revokePushDeviceByPossession(
  baseUrl: string,
  deviceKey: string,
): Promise<void> {
  const client = new PostwaveClient({ authMode: "none", baseUrl, retries: 2 });
  await client.mobilePush.revokePossession({ device_key: deviceKey });
}

function expoProjectId(): string | undefined {
  const fromEnv = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim();
  if (fromEnv) return fromEnv;
  const easConfig = Constants.easConfig as { projectId?: string } | undefined;
  if (easConfig?.projectId) return easConfig.projectId;
  const extra = Constants.expoConfig?.extra as
    | { eas?: { projectId?: string } }
    | undefined;
  return extra?.eas?.projectId;
}
