/**
 * api/authSessions.ts — the `/api/v1/auth/*` routes that are NOT part of the
 * login handshake: active-session management, email verification and the CLI
 * device grant.
 *
 * These used to be split across two transports. `deviceApprove.ts` reached an
 * `/api/v1/auth/*` endpoint through the SDK, which carries different error
 * semantics (status + requestId, no error `code`), a different `mfa_required`
 * interception path and a different timeout — and consequently threw away the
 * server's error code, collapsing four distinct failures into one string. The
 * session endpoints had no client at all.
 *
 * Everything here goes through `authRequest`, so it inherits the cookie
 * round-trip, the `X-Postwave-Client` CSRF header, the AuthApiError envelope,
 * the `mfa_required` observer and the response-size guards — one transport per
 * concern.
 */
import { authRequest, type AuthResult } from "./auth";

/** Mirrors `SessionInfo` in apps/api/internal/auth/sessions_handler.go. */
export interface AuthSessionInfo {
  id: string;
  issued_at: string;
  last_seen_at: string;
  expires_at: string;
  ip?: string;
  user_agent?: string;
  device_label?: string;
  device_type?: string;
  device_os?: string;
  device_client?: string;
  auth_method: string;
  current: boolean;
}

/** ListSessions is keyset-paginated (default limit 200). */
export interface AuthSessionsPage {
  sessions: AuthSessionInfo[];
  nextCursor?: string;
}

export type AuthDeviceGrantKind = "api_key" | "session";
export type AuthDeviceGrantAction = "inspect" | "approve" | "deny";

/** Server-normalised identity for the device holding the private device code. */
export interface AuthDeviceIdentity {
  device_label: string;
  device_type: "desktop" | "mobile" | "tablet" | "cli" | "bot" | "unknown";
  device_os?: string;
  device_client?: string;
}

/** Authenticated approver identity echoed only on the consent endpoint. */
export interface AuthDeviceGrantAccount {
  email: string;
  workspace_name?: string;
  workspace_slug?: string;
}

/** `POST /api/v1/auth/cli/device/approve` 200 body. */
export interface AuthDeviceApproveResponse {
  /** Present and true only for approve/deny mutations; inspect is read-only. */
  ok?: boolean;
  action?: AuthDeviceGrantAction;
  grant_kind: AuthDeviceGrantKind;
  device?: AuthDeviceIdentity;
  account?: AuthDeviceGrantAccount;
  /** Remaining lifetime of the approval request, in seconds. */
  expires_in?: number;
  /** Whether the requesting device asked for a persistent browser session. */
  remember?: boolean;
  /** The scopes the grant ACTUALLY received — role-derived server-side. */
  scopes?: string[];
  /** True when this approving session needs a TOTP step-up before approval. */
  requires_mfa?: boolean;
  /** Opaque, short-lived binding from inspect; memory-only and session-bound. */
  consent_token?: string;
}

export async function listSessions(
  baseUrl: string,
  cursor?: string,
): Promise<AuthResult<AuthSessionsPage>> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const res = await authRequest<{ sessions?: unknown; nextCursor?: unknown }>(
    baseUrl,
    `/api/v1/auth/sessions${qs}`,
  );
  if (res.error) return res;
  const rows = Array.isArray(res.data?.sessions)
    ? (res.data.sessions as unknown[]).filter(isAuthSessionInfo)
    : [];
  const next =
    typeof res.data?.nextCursor === "string" && res.data.nextCursor
      ? res.data.nextCursor
      : undefined;
  return { data: { sessions: rows, ...(next ? { nextCursor: next } : {}) } };
}

export function revokeSession(
  baseUrl: string,
  id: string,
): Promise<AuthResult<{ revoked: boolean }>> {
  return authRequest<{ revoked: boolean }>(
    baseUrl,
    `/api/v1/auth/sessions/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export function logoutAllOtherSessions(
  baseUrl: string,
): Promise<AuthResult<{ revoked_count: number }>> {
  return authRequest<{ revoked_count: number }>(
    baseUrl,
    "/api/v1/auth/sessions/logout-all",
    { method: "POST" },
  );
}

/** Re-send the address-verification email (`identity_api.go`, authed group). */
export function sendVerificationEmail(
  baseUrl: string,
): Promise<AuthResult<void>> {
  return authRequest<void>(baseUrl, "/api/v1/auth/send-verification", {
    method: "POST",
  });
}

/**
 * Consume an address-verification token.
 *
 * PUBLIC (`MountPublicAuthRoutes`, brute-force limited) and deliberately so:
 * the link lands from a mail client that may not be on the signed-in device,
 * and the token itself is the authority. The response is `{verified:true}`;
 * every failure arrives as `invalid_token` / `wrong_purpose` / `missing_token`
 * (apps/api/internal/auth/handlers.go VerifyEmail).
 */
export function verifyEmailToken(
  baseUrl: string,
  token: string,
): Promise<AuthResult<{ verified?: boolean }>> {
  return authRequest<{ verified?: boolean }>(
    baseUrl,
    "/api/v1/auth/verify-email",
    { method: "POST", body: JSON.stringify({ token }) },
  );
}

export function approveDeviceGrant(
  baseUrl: string,
  userCode: string,
  action: AuthDeviceGrantAction = "approve",
  consentToken?: string,
): Promise<AuthResult<AuthDeviceApproveResponse>> {
  return authRequest<AuthDeviceApproveResponse>(
    baseUrl,
    "/api/v1/auth/cli/device/approve",
    {
      method: "POST",
      body: JSON.stringify({
        user_code: userCode,
        // Omit the historical default so old servers and API-key grants retain
        // their byte-for-byte approval request shape.
        ...(action === "approve" && !consentToken ? {} : { action }),
        ...(consentToken ? { consent_token: consentToken } : {}),
      }),
    },
  );
}

/**
 * A malformed row must be dropped rather than rendered as a blank,
 * un-revocable device on a security screen.
 */
function isAuthSessionInfo(value: unknown): value is AuthSessionInfo {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    typeof row.auth_method === "string" &&
    typeof row.current === "boolean" &&
    typeof row.issued_at === "string" &&
    typeof row.last_seen_at === "string" &&
    typeof row.expires_at === "string" &&
    (row.ip === undefined || typeof row.ip === "string") &&
    (row.user_agent === undefined || typeof row.user_agent === "string") &&
    (row.device_label === undefined || typeof row.device_label === "string") &&
    (row.device_type === undefined || typeof row.device_type === "string") &&
    (row.device_os === undefined || typeof row.device_os === "string") &&
    (row.device_client === undefined || typeof row.device_client === "string")
  );
}
