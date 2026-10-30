/**
 * store/auth.ts
 *
 * In-memory + secure-store-backed auth state.
 *
 * Two coexisting auth modes:
 *
 *   1. API-key mode (`mode: "api_key"`): apiKey + baseUrl + tenantId.
 *      The PostwaveClient sends `Authorization: Bearer pw_…` on every
 *      request. This is the original power-user / automation flow.
 *
 *   2. Session mode (`mode: "session"`): a backend-issued cookie
 *      (`pw_session`) is what authenticates the user. We additionally
 *      cache user identity (email, role, tenant, has-totp) so the UI
 *      can render "signed in as …" without re-hitting /me on every
 *      mount. The cookie itself lives in the platform's HTTP layer
 *      (NSURLSession on iOS, OkHttp on Android) — we don't store it
 *      ourselves; that storage is automatic and origin-scoped.
 *
 * On signOut we wipe BOTH paths so the user lands cleanly on the
 * sign-in screen regardless of which mode they were using. Session
 * mode also POSTs /api/v1/auth/logout to revoke the server-side
 * record before clearing local state.
 *
 * Storage:
 *   - API key, baseUrl, tenantId: SecureStore (Keychain on iOS,
 *     EncryptedSharedPreferences on Android).
 *
 *   - Session profile (email, role, tenant): SecureStore as a single
 *     JSON blob. Non-secret per se but co-located so logout wipes it.
 *
 *   - Cookies: platform HTTP layer (RN's stock fetch + cookie jar).
 *
 * THIS FILE IS A COMPOSITION ROOT (AUTH#60). It owns the zustand store, the
 * synchronous authorization predicates, and the public module surface — and
 * nothing else. The seven concerns it used to mix now live beside it:
 *
 *   authSecureStorage.ts     key namespace + retry wrappers + push token
 *   authErrors.ts            AuthSessionStateError / LocalAuthPersistenceError
 *   authSessionProfile.ts    the identity blob and its sanitiser (IO-free)
 *   authMfaGate.ts           gate + destination derivation (import-free)
 *   authPersistence.ts       the write-ahead session transaction
 *   authCleanup.ts           local wipe orchestration + server revocation
 *   authState.ts             store shape, AuthSet/AuthGet, loggedOutState
 *   authSignIn.ts            api-key / session sign-in, cancellation
 *   authHydrate.ts           launch restore + crash-recovery boundary
 *   authSessionLifecycle.ts  /me revalidation + 403 mfa_required handling
 *
 * The public surface below is unchanged, so no call site moved.
 */
import { create } from "zustand";

import { setMfaRequiredObserver } from "@/api/auth";

import { mfaGateForSession, sessionMfaAllowsEntry } from "./authMfaGate";
import {
  cancelAuthSession,
  retryLocalCleanupAction,
  signInWithApiKey,
  signInWithSession,
} from "./authSignIn";
import { hydrateAuthState } from "./authHydrate";
import {
  handleMfaRequiredAction,
  prepareForSessionAuthenticationAction,
  refreshSessionFromServerAction,
  revalidateSessionAction,
} from "./authSessionLifecycle";
import { initialAuthFields, type AuthState } from "./authState";

export {
  AuthSessionStateError,
  LocalAuthPersistenceError,
} from "./authErrors";
export type { LocalAuthCleanupResult } from "./authCleanup";
export {
  destinationForSession,
  mfaGateForSession,
  needsMfaSecurityStepUp,
} from "./authMfaGate";
export type { SessionDestination, SessionMfaGate } from "./authMfaGate";
export { parseStoredSession } from "./authPersistence";
export {
  clearPushToken,
  getPushToken,
  setPushToken,
} from "./authSecureStorage";
export { sanitizeSessionProfile, sessionProfileFromMe } from "./authSessionProfile";
export type { MfaStatus, SessionProfile } from "./authSessionProfile";
export type {
  AuthMode,
  AuthSnapshot,
  SessionCancellationResult,
  SessionValidation,
} from "./authState";

export const useAuthStore = create<AuthState>((set, get) => ({
  ...initialAuthFields(),

  /**
   * "Do we hold credentials?" — NOT "may this user see the app". MFA is
   * deliberately not consulted here: a session pending its TOTP challenge is
   * authenticated, which is exactly why the challenge screen can call /totp.
   */
  isAuthenticated() {
    const s = get();
    if (s.mode === "session") {
      return Boolean(s.baseUrl && s.session);
    }
    if (s.mode === "api_key") {
      return Boolean(s.apiKey && s.baseUrl && s.tenantId);
    }
    return false;
  },

  /**
   * "May this user see the tabs?" — credentials AND a cleared MFA gate. A
   * cached-but-unvalidated session still qualifies so the app opens offline;
   * `checking` qualifies so a launch does not flash the sign-in screen.
   */
  canEnterApp() {
    const s = get();
    if (s.mode === "api_key") {
      return Boolean(s.apiKey && s.baseUrl && s.tenantId);
    }
    if (s.mode === "session") {
      return (
        Boolean(s.baseUrl && s.session) &&
        sessionMfaAllowsEntry(s.session) &&
        (s.sessionValidation === "validated_online" ||
          s.sessionValidation === "offline_cached" ||
          s.sessionValidation === "checking")
      );
    }
    return false;
  },

  /**
   * "May we issue authorized network calls?" — strictly stronger than
   * canEnterApp: a session mode caller must have been validated ONLINE, so an
   * offline-restored profile cannot authorize a mutation against a session the
   * server may already have revoked.
   */
  canUseOnlineServices() {
    const s = get();
    if (s.mode === "api_key") {
      return Boolean(s.apiKey && s.baseUrl && s.tenantId);
    }
    if (s.mode === "session") {
      return (
        Boolean(s.baseUrl && s.session) &&
        sessionMfaAllowsEntry(s.session) &&
        s.sessionValidation === "validated_online"
      );
    }
    return false;
  },

  /**
   * The three-way MFA verdict: "enrollment" | "challenge" | "none".
   *
   * Deliberately NOT accompanied by `needsMfaEnrollment()` /
   * `needsMfaChallenge()` boolean wrappers. Both existed, both were pure
   * indirection over this call, and neither ever had a consumer — because
   * every real consumer (the (auth) layout's redirect policy, mfa-enroll and
   * totp's canonical-state routing) has to distinguish all three values, and a
   * boolean that answers one of three questions makes the other two invisible.
   */
  mfaGate() {
    const s = get();
    if (s.mode !== "session" || !s.baseUrl || !s.session) return "none";
    return mfaGateForSession(s.session);
  },

  hydrate() {
    return hydrateAuthState(set, get);
  },

  revalidateSession() {
    return revalidateSessionAction(set, get);
  },

  refreshSessionFromServer() {
    return refreshSessionFromServerAction(set, get);
  },

  signIn(input) {
    return signInWithApiKey(input, set, get);
  },

  signInSession(input) {
    return signInWithSession(input, set, get);
  },

  async signOut() {
    await get().cancelSession();
  },

  cancelSession(sessionBaseUrl) {
    return cancelAuthSession(sessionBaseUrl, set, get);
  },

  retryLocalCleanup() {
    return retryLocalCleanupAction(set);
  },

  prepareForSessionAuthentication() {
    return prepareForSessionAuthenticationAction(set);
  },

  clearAuthWarning() {
    set({ authWarning: null });
  },

  handleMfaRequired(baseUrl: string) {
    return handleMfaRequiredAction(baseUrl, set, get);
  },
}));

setMfaRequiredObserver(({ baseUrl }) =>
  useAuthStore.getState().handleMfaRequired(baseUrl),
);
