/**
 * store/authState.ts
 *
 * The shape of the auth store: its snapshot fields, its action signatures, and
 * the two state constructors every seam shares. Extracted from store/auth.ts
 * (AUTH#60) so the action modules can be typed against the store without
 * importing the store itself.
 *
 * `AuthSet` / `AuthGet` are the narrow contract the action modules receive.
 * They are intentionally narrower than zustand's own setState (no replace
 * overload, no updater function): an auth action must only ever MERGE a partial
 * state, because a full replace would silently drop the action methods.
 */
import type { LocalAuthCleanupResult } from "./authCleanup";
import type { SessionMfaGate } from "./authMfaGate";
import type { SessionProfile } from "./authSessionProfile";

export type AuthMode = "api_key" | "session";
export type SessionValidation =
  | "none"
  | "checking"
  | "validated_online"
  | "offline_cached";

export type SessionCancellationResult = {
  cleanup: LocalAuthCleanupResult;
  serverRevocationPending: boolean;
};

export type AuthSnapshot = {
  apiKey: string | null;
  baseUrl: string | null;
  tenantId: string | null;
  /** Active mode. null when both are absent (logged out). */
  mode: AuthMode | null;
  /** Populated when `mode === "session"`. */
  session: SessionProfile | null;
};

export type AuthState = AuthSnapshot & {
  hydrated: boolean;
  signingIn: boolean;
  sessionValidation: SessionValidation;
  authWarning: string | null;
  localCleanupPending: boolean;
  /** API-key sign-in (legacy). */
  signIn: (input: {
    apiKey: string;
    baseUrl: string;
    tenantId: string;
  }) => Promise<AuthSnapshot>;
  /**
   * Session sign-in: caller has already authenticated against the
   * backend (cookie is set in the platform jar) and resolved the user
   * profile via /api/v1/auth/me. We just persist the `baseUrl` + the
   * profile so subsequent launches land authenticated.
   */
  signInSession: (input: {
    baseUrl: string;
    profile: Partial<SessionProfile>;
  }) => Promise<AuthSnapshot>;
  signOut: () => Promise<void>;
  cancelSession: (
    sessionBaseUrl?: string,
  ) => Promise<SessionCancellationResult>;
  retryLocalCleanup: () => Promise<LocalAuthCleanupResult>;
  prepareForSessionAuthentication: () => Promise<void>;
  clearAuthWarning: () => void;
  hydrate: () => Promise<void>;
  revalidateSession: () => Promise<void>;
  refreshSessionFromServer: () => Promise<SessionProfile>;
  isAuthenticated: () => boolean;
  canEnterApp: () => boolean;
  canUseOnlineServices: () => boolean;
  mfaGate: () => SessionMfaGate;
  handleMfaRequired: (baseUrl: string) => Promise<void>;
};

export type AuthSet = (state: Partial<AuthState>) => void;
export type AuthGet = () => AuthState;

/** Field defaults for a store that has not hydrated yet. */
export function initialAuthFields(): Omit<
  AuthState,
  | "signIn"
  | "signInSession"
  | "signOut"
  | "cancelSession"
  | "retryLocalCleanup"
  | "prepareForSessionAuthentication"
  | "clearAuthWarning"
  | "hydrate"
  | "revalidateSession"
  | "refreshSessionFromServer"
  | "isAuthenticated"
  | "canEnterApp"
  | "canUseOnlineServices"
  | "mfaGate"
  | "handleMfaRequired"
> {
  return {
    apiKey: null,
    baseUrl: null,
    tenantId: null,
    mode: null,
    session: null,
    hydrated: false,
    signingIn: false,
    sessionValidation: "none",
    authWarning: null,
    localCleanupPending: false,
  };
}

/**
 * The single definition of "signed out". Every teardown path commits exactly
 * this so no partial identity (a lingering tenantId, a stale `checking`
 * validation) can survive a sign-out and be read as authorization.
 */
export function loggedOutState(
  warning: string | null,
  cleanupPending: boolean,
): Partial<AuthState> {
  return {
    apiKey: null,
    baseUrl: null,
    tenantId: null,
    session: null,
    mode: null,
    sessionValidation: "none",
    signingIn: false,
    authWarning: warning,
    localCleanupPending: cleanupPending,
  };
}
