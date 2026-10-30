/**
 * Auth helpers — small surface around `apiAuth` for the boot pipeline,
 * sign-out, and "is the user signed in" detection. Never logs
 * credentials. Default to redacting in error paths.
 *
 * Two parallel auth modes coexist in this app:
 *
 *   1. API-key auth — local `pw_…` token sent as Bearer. Used by power
 *      users + automation. No /me round-trip needed; presence of the
 *      key in localStorage IS the signal.
 *
 *   2. Session-cookie auth — `pw_session` HttpOnly cookie set by the
 *      backend. Detected by hitting /api/v1/auth/me with credentials
 *      included; 200 means we're logged in, 401 means we aren't.
 *
 * Boot pipeline preference: session FIRST (best UX), API-key second
 * (developer fallback), Welcome/SignIn last.
 */

import {
  apiAuth,
  clearApiConfig,
  hasApiCredential,
  getRememberedSession,
  rememberSession,
  type AuthMeResponse,
} from "./api-client";
import { parseDesktopAuthLink } from "./auth-link-contract";
import {
  requestLifecycleTransition,
  type LifecycleTransitionResult,
} from "./lifecycle-coordinator";
import {
  createInternalNoteSignOutAction,
  type InternalNoteSignOutAction,
  registerInternalNoteRecoverySignOutGuard,
} from "./helpdesk-internal-note-lifecycle";
import { clearOfflineStores } from "./offline-store";
import { clearPersistedQueryCache } from "./query-client";
import { purgePrivateSessionState } from "./private-session-state";
import { vaultPurgeAll } from "./secure-vault";
import { reset as resetTelemetry } from "./telemetry";
import { isTauri, tauriApi } from "./tauri";
import {
  createWebhookPlaygroundFireSignOutAction,
  registerWebhookPlaygroundFireRecoverySignOutGuard,
  type WebhookPlaygroundFireSignOutAction,
} from "./webhook-playground-fire-lifecycle";
import { inspectWebhookPlaygroundFireRecoveryInventory } from "./webhook-playground-fire-recovery";
import { clearAllWorkspaces } from "./workspaces";

export type { DesktopAuthLinkProof } from "./auth-link-contract";

export type SessionStatus =
  | { kind: "session"; me: AuthMeResponse }
  | { kind: "api-key" }
  /** Transport-level failure (timeout / DNS / connection refused) — we
   *  genuinely don't know whether the session is alive. The remembered
   *  hint is preserved so the caller can boot the offline-capable shell. */
  | { kind: "offline" }
  | { kind: "none" };

/**
 * Resolve the current auth state. Tries cookie-session first, falls
 * back to API-key. Caches the /me hint so subsequent boots feel
 * instant; the cache is overwritten on every successful /me.
 *
 * Only a REAL server answer (an HTTP status, e.g. 401) clears the
 * remembered hint — a network/timeout error returns "offline" and
 * keeps the hint, so an offline launch doesn't dump a signed-in user
 * onto SignIn.
 */
export async function detectSession(): Promise<SessionStatus> {
  // Hit /me with credentials. Short timeout — boot can't hang.
  try {
    const res = await apiAuth.getAuthMe();
    if (res.data) {
      rememberSession(res.data);
      return { kind: "session", me: res.data };
    }
    const status = res.error?.status;
    if (typeof status !== "number" || status >= 500) {
      // No HTTP status (network/timeout/DNS) OR a 5xx server/gateway error —
      // NEITHER is an authoritative "no session". Keep the hint so a flaky
      // backend doesn't dump a signed-in user onto SignIn (D02#5); the API
      // key (if any) still works for the offline-capable shell.
      if (hasApiCredential()) return { kind: "api-key" };
      return { kind: "offline" };
    }
    // A real 4xx (401 etc.): the server affirmatively says there is no
    // valid session. Fall through to clear the stale hint.
  } catch {
    // Defensive: authRequest shouldn't throw, but treat a throw as
    // transport-level too — don't destroy the hint.
    if (hasApiCredential()) return { kind: "api-key" };
    return { kind: "offline" };
  }
  // The server affirmatively told us there's no session: clear the
  // stale hint.
  rememberSession(null);

  // API-key fallback: presence of pw_ token is enough — the legacy
  // path validates lazily on first use.
  if (hasApiCredential()) return { kind: "api-key" };

  return { kind: "none" };
}

/**
 * Sign out of EVERYTHING this app knows about: server session (if any)
 * + local API key. Idempotent. Calls the backend logout endpoint
 * best-effort; failures are swallowed because the user expects "sign
 * out" to always succeed locally.
 *
 * Internal cleanup callback only. User-initiated paths must call
 * {@link requestFullSignOut}, which performs the non-discardable lifecycle
 * review before this function can destroy encrypted recovery authority.
 */
export async function fullSignOut(
  signOutAction: InternalNoteSignOutAction = createInternalNoteSignOutAction(),
  webhookFireSignOutAction: WebhookPlaygroundFireSignOutAction = createWebhookPlaygroundFireSignOutAction(),
): Promise<void> {
  const leaseWasAlreadyOwned = signOutAction.ownsLease();
  const webhookLeaseWasAlreadyOwned = webhookFireSignOutAction.ownsLease();
  if (!leaseWasAlreadyOwned) signOutAction.acquire();
  try {
    if (!webhookLeaseWasAlreadyOwned) webhookFireSignOutAction.acquire();
  } catch (error) {
    if (!leaseWasAlreadyOwned) signOutAction.release();
    throw error;
  }
  try {
    const webhookCheckpointInventory =
      inspectWebhookPlaygroundFireRecoveryInventory();
    if (webhookCheckpointInventory !== "clear") {
      throw new Error(
        webhookCheckpointInventory === "held"
          ? "Destructive sign-out is blocked while webhook Simulator checkpoint recovery evidence is unresolved."
          : "Destructive sign-out is blocked because the webhook Simulator checkpoint inventory could not be verified.",
      );
    }
    // Best-effort server logout. We don't await any UI on failure.
    try {
      await apiAuth.logoutSession();
    } catch {
      /* swallow — local cleanup still proceeds */
    }
    if (isTauri()) {
      try {
        await tauriApi.clearAllSessionBrokers();
      } catch {
        /* active-session clear already ran; continue local shared-device wipe */
      }
    }
    // Erase customer-bearing process memory first and sweep ownership-ambiguous
    // plaintext written by older builds (routes, recents, searches, filters).
    // Safe durable UI preferences use separate keys and are unaffected.
    purgePrivateSessionState();
    rememberSession(null);
    // Clear the local API config (keychain key + stored URL) so API-key
    // users are actually signed out — otherwise the next boot falls back
    // to the keychain key and boots straight back in authenticated.
    try {
      await clearApiConfig();
    } catch {
      /* swallow — keychain unavailable; in-memory key is already cleared */
    }
    // Also purge every per-workspace saved API key + workspace profile, so
    // the next user on this device can't restore the previous owner's key via
    // the workspace switcher (D02#9). clearApiConfig only clears the active
    // `api_key` slot, not the `api_key:<id>` copies.
    try {
      await clearAllWorkspaces();
    } catch {
      /* swallow — keychain/storage unavailable */
    }
    // Drop the offline queue/cache outright. Identity filtering alone is
    // not enough: items persisted by older builds carry no identity tag
    // and would otherwise survive into the next account's session.
    try {
      await clearOfflineStores();
    } catch {
      /* swallow — storage unavailable */
    }
    // Purge the encrypted sensitive-offline vault (subscriber detail, audit
    // log, suppressions) + drop its encryption key. Identity-scoped keys stop
    // cross-account READS while signed in; this wipes the ciphertext outright
    // so nothing survives sign-out on a shared device (D02#4).
    try {
      await vaultPurgeAll();
    } catch {
      /* swallow — storage/keychain unavailable */
    }
    // Wipe the persisted TanStack query cache (IndexedDB) too — it survived
    // sign-out and hydrated the previous tenant's lists/detail for the next
    // user on this device (D02#3).
    try {
      await clearPersistedQueryCache();
    } catch {
      /* swallow — storage unavailable */
    }
    // Drop the telemetry identity so the next user on this device isn't
    // conflated with the previous session.
    resetTelemetry();
  } finally {
    if (!webhookLeaseWasAlreadyOwned) webhookFireSignOutAction.release();
    if (!leaseWasAlreadyOwned) signOutAction.release();
  }
}

/** Route every user-initiated sign-out through the global lifecycle review. */
export function requestFullSignOut(): Promise<LifecycleTransitionResult> {
  // Register synchronously at the action boundary so even a lazy root service
  // or an unmounted Helpdesk route cannot race the privacy wipe. Keep the
  // owner alive for the entire review/recheck sequence, then release it.
  const signOutAction = createInternalNoteSignOutAction();
  const webhookFireSignOutAction = createWebhookPlaygroundFireSignOutAction();
  const unregisterNoteGuard =
    registerInternalNoteRecoverySignOutGuard(signOutAction);
  const unregisterWebhookFireGuard =
    registerWebhookPlaygroundFireRecoverySignOutGuard(webhookFireSignOutAction);
  const transition = requestLifecycleTransition(
    {
      kind: "sign-out",
      disposition: "identity-change",
      title: "Sign out of Moosewave?",
      description:
        "Moosewave will check drafts, active operations, and local changes before clearing this device's session and workspace credentials.",
      confirmLabel: "Sign out",
      danger: true,
    },
    () => fullSignOut(signOutAction, webhookFireSignOutAction),
  );
  void transition.finally(() => {
    unregisterWebhookFireGuard();
    unregisterNoteGuard();
  });
  return transition;
}

/** Synchronous "we MIGHT have a session" check — uses the cached hint. */
export function hasRememberedSession(): boolean {
  return getRememberedSession() !== null;
}

/**
 * Heuristic password strength for live UI feedback. Mirrors the
 * server's "≥ 12 chars" rule plus a couple of nudges so the meter is
 * informative. NEVER send the password anywhere.
 */
export function scorePassword(pw: string): {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
} {
  if (!pw) return { score: 0, label: "" };
  let s = 0;
  if (pw.length >= 12) s++;
  if (pw.length >= 16) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  // Length gate: the server rejects anything under 12 chars, so the
  // meter must never read better than "Weak" below that — character-
  // class bonuses alone can't promote a server-rejected password.
  if (pw.length < 12) s = Math.min(s, 1);
  const score = Math.max(0, Math.min(4, s)) as 0 | 1 | 2 | 3 | 4;
  const label =
    score < 1
      ? "Too short"
      : score === 1
        ? "Weak"
        : score === 2
          ? "OK"
          : score === 3
            ? "Strong"
            : "Excellent";
  return { score, label };
}

/**
 * Backward-compatible export name for callers; the accepted data is no longer
 * a bare token. Only a complete signed v1 native proof is returned.
 */
export const extractAuthToken = parseDesktopAuthLink;

/**
 * Best-effort, side-effect-free "redact a message before logging" helper.
 * Strips long alphanumeric runs (likely tokens) and bare words containing
 * `password=…` query bits.
 */
export function redact(message: string): string {
  if (!message) return message;
  let out = message;
  out = out.replace(/(token|password|code)=[^\s&]+/gi, "$1=***");
  // Replace 24+ char alphanum runs (likely a session token).
  out = out.replace(/[A-Za-z0-9_-]{24,}/g, "***");
  return out;
}
