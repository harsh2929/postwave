// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed client for the auth backend (Phase: auth). Cookies are session-bound
// and HttpOnly; the api helper sends `credentials: "include"` by default so
// every call here is automatically session-aware.
//
// All endpoints route through the same backend prefix `/api/v1/auth/...` —
// see the corresponding handlers under engine/handlers/auth.

import { api } from "@/lib/api";
import { WEB_AUTH_LINK_START, type AuthLinkProof } from "@/lib/auth-link";
import {
  clearAllTemplateEditorRecovery,
  clearAllCampaignTemplateDesignSessions,
  clearCampaignTemplateDiscoveryCreateRecovery,
} from "@/lib/campaign-template-session-cleanup";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type OAuthProvider = "google";

export type AuthRole = "owner" | "admin" | "editor" | "viewer";

export interface MeResponse {
  user_id: string;
  tenant_id: string;
  email: string;
  role: AuthRole;
  effective_role?: AuthRole;
  viewer_mode?: boolean;
  can_use_viewer_mode?: boolean;
  auth_provider: string;
  email_verified: boolean;
  workspace_name: string;
  workspace_slug: string;
  /** True when this account has a confirmed TOTP enrollment. */
  totp_enabled?: boolean;
  /** True when middleware/dashboard should require a TOTP challenge before /app. */
  mfa_required?: boolean;
  /** True when the current session has already passed the TOTP step. */
  mfa_satisfied?: boolean;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
}

// ---------------------------------------------------------------------------
// Signup / login / logout
// ---------------------------------------------------------------------------

export interface SignupInput {
  email: string;
  password: string;
  workspace_name: string;
  workspace_slug: string;
}

export interface SignupResponse {
  user_id: string;
  tenant_id: string;
}

export function signup(input: SignupInput): Promise<SignupResponse> {
  return api.post<SignupResponse>("/api/v1/auth/signup", input);
}

export interface GoogleSignupInfo {
  provider: "google";
  email: string;
  csrf_token: string;
}

export function googleSignupInfo(): Promise<GoogleSignupInfo> {
  return api.get<GoogleSignupInfo>("/api/v1/auth/oauth/google/signup", {
    cache: "no-store",
    maxAttempts: 1,
  });
}

export function completeGoogleSignup(input: {
  workspace_name: string;
  workspace_slug: string;
  csrf_token: string;
}): Promise<SignupResponse> {
  return api.post<SignupResponse>("/api/v1/auth/oauth/google/signup", input, {
    maxAttempts: 1,
    requireOnline: true,
    idempotencyKey: null,
    allowStepUpRetry: false,
  });
}

// SETC-010: accept a copy-link team invitation by setting a password. Creates
// the invited user in the invited workspace with the invited role and sets the
// session cookie (201). Public route; caller maps 404/409 to friendly copy.
export interface AcceptInviteResponse {
  user_id: string;
  tenant_id: string;
  email: string;
  email_verified: boolean;
}

export function acceptInvite(
  token: string,
  password: string,
): Promise<AcceptInviteResponse> {
  return api.post<AcceptInviteResponse>("/api/v1/auth/accept-invite", {
    token,
    password,
  });
}

// AUTH-015: advisory workspace-slug availability probe. The signup 409 remains
// authoritative; this is only for inline feedback while typing.
export function checkWorkspaceSlug(
  slug: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ available: boolean }> {
  return api.get<{ available: boolean }>(
    `/api/v1/auth/slug-available?slug=${encodeURIComponent(slug)}`,
    opts,
  );
}

export interface LoginInput {
  email: string;
  password: string;
  /** Optional: forces login into a specific workspace when the user has many. */
  workspace_id?: string;
  /** AUTH-024: opt into a persistent 30-day session vs a browser-session login. */
  remember?: boolean;
}

export interface LoginNeedsWorkspaceResponse {
  needs_workspace: true;
  workspaces: WorkspaceSummary[];
}

export interface LoginOkResponse {
  needs_workspace?: false;
  user_id: string;
  tenant_id: string;
}

export type LoginResponse = LoginOkResponse | LoginNeedsWorkspaceResponse;

export function login(input: LoginInput): Promise<LoginResponse> {
  return api.post<LoginResponse>("/api/v1/auth/login", input);
}

export async function logout(): Promise<void> {
  try {
    await api.post<void>("/api/v1/auth/logout");
  } finally {
    // Personal create-recovery keys are scoped to the authenticated browser
    // session and must never cross a logout/shared-device handoff.
    clearAllCampaignTemplateDesignSessions();
    clearCampaignTemplateDiscoveryCreateRecovery();
    clearAllTemplateEditorRecovery();
  }
}

// ---------------------------------------------------------------------------
// Whoami
// ---------------------------------------------------------------------------

export function whoami(): Promise<MeResponse> {
  return api.get<MeResponse>("/api/v1/auth/me");
}

/**
 * Bypasses offline read-through before a sensitive mutation. Callers must also
 * compare the returned workspace/user/effective role with the representation
 * that opened the action; this is a freshness check, not a new authority tier.
 */
export function whoamiFresh(signal?: AbortSignal): Promise<MeResponse> {
  return api.get<MeResponse>("/api/v1/auth/me", {
    cache: "no-store",
    requireOnline: true,
    maxAttempts: 1,
    signal,
  });
}

// SHELL-018: the authenticated user's workspaces, for the shell switcher.
export interface UserWorkspace extends WorkspaceSummary {
  role: string;
  current: boolean;
}

export function listWorkspaces(): Promise<UserWorkspace[]> {
  return api
    .get<{ workspaces: UserWorkspace[] }>("/api/v1/auth/workspaces")
    .then((r) => r.workspaces ?? []);
}

export function effectiveAuthRole(me: MeResponse): AuthRole {
  return me.effective_role ?? me.role;
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

export function verifyEmail(token: string): Promise<{ ok: true }> {
  return api.post<{ ok: true }>("/api/v1/auth/verify-email", { token });
}

export function sendVerificationEmail(): Promise<{ ok: true }> {
  return api.post<{ ok: true }>("/api/v1/auth/send-verification");
}

// ---------------------------------------------------------------------------
// Magic link
// ---------------------------------------------------------------------------

export function magicLinkStart(email: string): Promise<{ ok: true }> {
  return api.post<{ ok: true }>("/api/v1/auth/magic-link/start", {
    email,
    ...WEB_AUTH_LINK_START,
  });
}

export function magicLinkConsume(proof: AuthLinkProof): Promise<{ ok: true }> {
  return api.post<{ ok: true }>("/api/v1/auth/magic-link/consume", proof, {
    maxAttempts: 1,
    requireOnline: true,
  });
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

export function passwordResetStart(email: string): Promise<{ ok: true }> {
  return api.post<{ ok: true }>("/api/v1/auth/password-reset/start", {
    email,
    ...WEB_AUTH_LINK_START,
  });
}

export function passwordResetConfirm(
  proof: AuthLinkProof,
  newPassword: string,
): Promise<{ ok: true }> {
  return api.post<{ ok: true }>("/api/v1/auth/password-reset/confirm", {
    ...proof,
    new_password: newPassword,
  });
}

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

export interface TotpEnrollResponse {
  /** otpauth:// URI; render to a QR code or display literally. */
  otpauth_uri: string;
  recovery_codes: string[];
}

export interface AccountSecurityRequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

function accountSecurityMutationOptions(
  options: AccountSecurityRequestOptions,
) {
  return {
    cache: "no-store" as const,
    requireOnline: true,
    maxAttempts: 1,
    signal: options.signal,
    idempotencyKey: options.idempotencyKey,
  };
}

export async function totpEnroll(
  options: AccountSecurityRequestOptions = {},
): Promise<TotpEnrollResponse> {
  const value = await api.post<unknown>(
    "/api/v1/auth/totp/enroll",
    undefined,
    accountSecurityMutationOptions(options),
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Authenticator enrollment returned an invalid response.");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.otpauth_uri !== "string" ||
    !row.otpauth_uri.startsWith("otpauth://") ||
    row.otpauth_uri.length > 16 * 1024 ||
    !validRecoveryCodes(row.recovery_codes)
  ) {
    throw new Error("Authenticator enrollment returned an invalid response.");
  }
  return {
    otpauth_uri: row.otpauth_uri,
    recovery_codes: row.recovery_codes,
  };
}

export async function totpVerify(
  code: string,
  options: AccountSecurityRequestOptions = {},
): Promise<{ verified: true; mfa_satisfied: true }> {
  const value = await api.post<unknown>(
    "/api/v1/auth/totp/verify",
    { code },
    accountSecurityMutationOptions(options),
  );
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).verified !== true ||
    (value as Record<string, unknown>).mfa_satisfied !== true
  ) {
    throw new Error("Authenticator verification returned an invalid receipt.");
  }
  return { verified: true, mfa_satisfied: true };
}

export async function totpChallenge(
  input: {
    code?: string;
    recovery_code?: string;
  },
  options: AccountSecurityRequestOptions = {},
): Promise<{
  mfa_satisfied: true;
  already?: true;
}> {
  const value = await api.post<unknown>(
    "/api/v1/auth/totp/challenge",
    input,
    accountSecurityMutationOptions(options),
  );
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).mfa_satisfied !== true ||
    !(
      (value as Record<string, unknown>).already === undefined ||
      (value as Record<string, unknown>).already === true
    )
  ) {
    throw new Error("Authenticator challenge returned an invalid receipt.");
  }
  return (value as Record<string, unknown>).already === true
    ? { mfa_satisfied: true, already: true }
    : { mfa_satisfied: true };
}

export function totpDisable(
  options: AccountSecurityRequestOptions = {},
): Promise<void> {
  return api.delete<void>(
    "/api/v1/auth/totp",
    accountSecurityMutationOptions(options),
  );
}

// SETC-035: recovery-code status + regeneration for an already-enrolled user.
export interface RecoveryCodesStatus {
  /** False when there is no confirmed TOTP factor. */
  enrolled: boolean;
  remaining: number;
  total: number;
  /** Server's opinion that the user should regenerate soon. */
  low: boolean;
}

export async function getRecoveryCodesStatus(
  options: Pick<AccountSecurityRequestOptions, "signal"> = {},
): Promise<RecoveryCodesStatus> {
  const value = await api.get<unknown>("/api/v1/auth/totp/recovery-codes", {
    cache: "no-store",
    requireOnline: true,
    maxAttempts: 1,
    signal: options.signal,
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Recovery-code status response was malformed.");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.enrolled !== "boolean" ||
    !Number.isSafeInteger(row.remaining) ||
    Number(row.remaining) < 0 ||
    !Number.isSafeInteger(row.total) ||
    Number(row.total) < Number(row.remaining) ||
    Number(row.total) > 1_000 ||
    typeof row.low !== "boolean"
  ) {
    throw new Error("Recovery-code status response was malformed.");
  }
  return {
    enrolled: row.enrolled,
    remaining: Number(row.remaining),
    total: Number(row.total),
    low: row.low,
  };
}

export interface RecoveryCodesRegenerated {
  /** Shown exactly once; the previous bundle stops working immediately. */
  recovery_codes: string[];
  remaining: number;
  total: number;
}

/**
 * Replace the entire recovery-code bundle and return the new plaintext once.
 * Requires a FRESH authenticator code (verified server-side), not just an
 * MFA-satisfied session — minting durable codes needs live possession proof.
 * A wrong code returns 401 invalid_code.
 */
export function regenerateRecoveryCodes(
  code: string,
  options: AccountSecurityRequestOptions = {},
): Promise<RecoveryCodesRegenerated> {
  return api
    .post<unknown>(
      "/api/v1/auth/totp/recovery-codes",
      { code },
      accountSecurityMutationOptions(options),
    )
    .then((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(
          "Recovery-code regeneration returned an invalid receipt.",
        );
      }
      const row = value as Record<string, unknown>;
      if (
        !validRecoveryCodes(row.recovery_codes) ||
        !Number.isSafeInteger(row.remaining) ||
        Number(row.remaining) < 0 ||
        !Number.isSafeInteger(row.total) ||
        Number(row.total) !== row.recovery_codes.length ||
        Number(row.remaining) > Number(row.total)
      ) {
        throw new Error(
          "Recovery-code regeneration returned an invalid receipt.",
        );
      }
      return {
        recovery_codes: row.recovery_codes,
        remaining: Number(row.remaining),
        total: Number(row.total),
      };
    });
}

function validRecoveryCodes(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 100 &&
    value.every(
      (code) =>
        typeof code === "string" &&
        code.length > 0 &&
        code.length <= 256 &&
        !/[\u0000-\u001f\u007f]/.test(code),
    )
  );
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

const MAX_OAUTH_REDIRECT_TO_BYTES = 2 * 1024;

export function oauthStartUrl(
  provider: OAuthProvider,
  redirectTo: string = "/app",
): string {
  const qs = new URLSearchParams({
    redirect_to: safeOAuthRedirectTo(redirectTo),
  });
  return `/api/v1/auth/oauth/${encodeURIComponent(provider)}/start?${qs.toString()}`;
}

/**
 * Starts an explicit account-link flow. The API requires the current HttpOnly
 * session cookie, binds that exact session/user/tenant into single-use OAuth
 * state, and revalidates it at callback before creating an IdP link.
 */
export function oauthLinkStartUrl(
  provider: OAuthProvider,
  redirectTo: string = "/app/settings/security",
): string {
  const qs = new URLSearchParams({
    redirect_to: safeOAuthRedirectTo(redirectTo),
    link: "true",
  });
  return `/api/v1/auth/oauth/${encodeURIComponent(provider)}/start?${qs.toString()}`;
}

// SETC-021: view + disconnect linked social identities.
export interface OAuthIdentity {
  provider: string;
  email: string;
  linked_at: string;
}

export interface OAuthIdentitiesResponse {
  identities: OAuthIdentity[];
  /** True when the user can still sign in with a password after unlinking. */
  has_password: boolean;
  /** True when the user has an enrolled passkey — also a standing method. */
  has_passkey: boolean;
}

export async function listOAuthIdentities(
  options: { signal?: AbortSignal } = {},
): Promise<OAuthIdentitiesResponse> {
  const payload = await api.get<unknown>("/api/v1/auth/oauth/identities", {
    cache: "no-store",
    requireOnline: true,
    maxAttempts: 1,
    signal: options.signal,
  });
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Linked-identity response was malformed.");
  }
  const body = payload as Record<string, unknown>;
  if (
    !Array.isArray(body.identities) ||
    body.identities.length > 16 ||
    typeof body.has_password !== "boolean" ||
    typeof body.has_passkey !== "boolean"
  ) {
    throw new Error("Linked-identity response was malformed.");
  }
  const providers = new Set<string>();
  const identities = body.identities.map((value): OAuthIdentity => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Linked-identity response contained an invalid record.");
    }
    const row = value as Record<string, unknown>;
    if (
      typeof row.provider !== "string" ||
      row.provider.length === 0 ||
      row.provider.length > 64 ||
      providers.has(row.provider) ||
      typeof row.email !== "string" ||
      row.email.length === 0 ||
      row.email.length > 320 ||
      typeof row.linked_at !== "string" ||
      row.linked_at.length > 128 ||
      !Number.isFinite(Date.parse(row.linked_at))
    ) {
      throw new Error("Linked-identity response contained an invalid record.");
    }
    providers.add(row.provider);
    return {
      provider: row.provider,
      email: row.email,
      linked_at: row.linked_at,
    };
  });
  return {
    identities,
    has_password: body.has_password,
    has_passkey: body.has_passkey,
  };
}

/**
 * Disconnect a linked identity provider. The server refuses (409
 * last_login_method) if this is the account's only sign-in method.
 */
export function unlinkOAuthIdentity(
  provider: string,
  options: { signal?: AbortSignal; idempotencyKey?: string } = {},
): Promise<void> {
  return api.delete<void>(
    `/api/v1/auth/oauth/${encodeURIComponent(provider)}/link`,
    {
      cache: "no-store",
      requireOnline: true,
      maxAttempts: 1,
      signal: options.signal,
      idempotencyKey: options.idempotencyKey,
    },
  );
}

function safeOAuthRedirectTo(value: string): string {
  if (
    new TextEncoder().encode(value).byteLength > MAX_OAUTH_REDIRECT_TO_BYTES
  ) {
    return "/app";
  }
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  return "/app";
}

export interface ViewerModeState {
  viewer_mode: boolean;
  /** The role you actually hold. */
  role: string;
  /** The role the app is treating you as right now. */
  effective_role: string;
}

/**
 * Toggles viewer mode for the current session.
 *
 * PATCH, not POST — the route rejects POST outright.
 *
 * THE RESPONSE CARRIES TWO ROLES AND THEY ARE DIFFERENT QUESTIONS. `role` is
 * what you hold; `effective_role` is what the app is enforcing this second.
 * While viewer mode is on an owner is refused writes exactly as a viewer
 * would be, so a UI that shows only `role` explains nothing when a button
 * stops working — the operator sees "owner" and a permission error at the
 * same time.
 */
export async function setViewerMode(
  enabled: boolean,
): Promise<ViewerModeState> {
  const r = await api.patch<Record<string, unknown>>(
    "/api/v1/auth/me/viewer-mode",
    { enabled },
  );
  const t = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    viewer_mode: r?.viewer_mode === true,
    role: t(r?.role),
    effective_role: t(r?.effective_role),
  };
}

/** True when the session is acting with fewer rights than the user holds. */
export function actingBelowRole(v: ViewerModeState): boolean {
  return (
    v.role !== "" && v.effective_role !== "" && v.role !== v.effective_role
  );
}
