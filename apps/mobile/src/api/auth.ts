/**
 * api/auth.ts
 *
 * Email-based auth surface for the mobile app — additive to the legacy
 * API-key path backed by the shared SDK client factory. Two paths coexist:
 *
 *   - API-key auth (legacy): SDK reads `apiKey` + `tenantId` from the
 *     auth store and sends `Authorization: Bearer pw_…` on every call.
 *
 *   - Session-cookie auth (new): the user signs in with email +
 *     password (or magic link / OAuth), the backend sets a `pw_session`
 *     cookie, and we round-trip it on every subsequent call by passing
 *     `credentials: "include"` to fetch. React Native's stock fetch
 *     supports cookies natively; the iOS NSURLSession + Android
 *     OkHttp underlying clients persist them per origin.
 *
 * Both paths populate the same Zustand auth store so route guards,
 * settings, and sign-out are uniform.
 *
 * Backend source-of-truth:
 *   apps/api/internal/auth/handlers.go        signup/login/logout/me
 *   apps/api/internal/auth/magiclink.go        magic-link/start + consume
 *   apps/api/internal/auth/password_reset.go   password-reset/start + confirm
 *   apps/api/internal/auth/oauth_handlers.go   /oauth/{provider}/start (302)
 *   apps/api/internal/auth/totp_handlers.go    enroll/verify/challenge/disable
 *
 * Notes:
 *   * Login is uniform 200/401. Multi-tenant: response is
 *     `{needs_workspace, workspaces}`; client re-submits with workspace_id.
 *   * MFA is per-session, NOT pre-session. `/me` returns the authoritative
 *     policy/factor/session triple. Required users enroll when no factor is
 *     confirmed, or satisfy `/totp/challenge` when one already exists.
 *   * Google is the only OAuth provider enabled for this release. /start returns a 302
 *     to the IdP — we open the URL in the system browser via
 *     expo-linking and listen for the deep-link return.
 */

import { apiUrl, normalizeApiBaseUrl } from "./url";
import {
  authLinkConsumeBody,
  safeAuthLinkState,
  type AuthLinkProof,
  type MobileAuthLinkStart,
} from "../lib/authLinkContract";
import { parseRetryAfterSeconds } from "../lib/retryAfter";
import { totpChallengeBody, type TotpChallengeInput, type TotpChallengeResult } from "../lib/trustedDeviceContract";
import { utf8ByteLength } from "../lib/utf8";

const TIMEOUT_MS = 15_000;
const MAX_AUTH_RESPONSE_TEXT_BYTES = 512 * 1024;
const MAX_AUTH_ERROR_TEXT_BYTES = 64 * 1024;
const MAX_OAUTH_REDIRECT_TO_BYTES = 2 * 1024;

export interface AuthApiError {
  message: string;
  status?: number;
  /** Backend error code from the JSON envelope (e.g. "weak_password"). */
  code?: string;
  kind?: "http" | "network" | "timeout" | "parse";
  /** Parsed `Retry-After` seconds from a 429, so the UI can count down. */
  retryAfterSeconds?: number;
}

export type MfaRequiredObserver = (event: {
  baseUrl: string;
  status: number;
  code: "mfa_required";
}) => void | Promise<void>;

let mfaRequiredObserver: MfaRequiredObserver | null = null;

/**
 * Installs the single app-level MFA observer. The auth store owns the
 * observer; both this cookie-aware client and the shared SDK fetch wrapper
 * report `mfa_required` through it so every API surface closes the local gate
 * immediately.
 */
export function setMfaRequiredObserver(
  observer: MfaRequiredObserver | null,
): void {
  mfaRequiredObserver = observer;
}

export async function reportMfaRequired(
  baseUrl: string,
  status = 403,
): Promise<void> {
  await mfaRequiredObserver?.({
    baseUrl: normalizeApiBaseUrl(baseUrl),
    status,
    code: "mfa_required",
  });
}

/** Inspect a raw/global/expo fetch response without consuming its body. */
export async function interceptMfaRequiredResponse(
  response: Response,
  authBaseUrl: string,
): Promise<Response> {
  if (response.status !== 403) return response;
  try {
    const declaredBytes = Number(response.headers.get("content-length") || 0);
    if (
      Number.isFinite(declaredBytes) &&
      declaredBytes > MAX_AUTH_ERROR_TEXT_BYTES
    ) {
      return response;
    }
    const text = await response.clone().text();
    if (!text || utf8ByteLength(text) > MAX_AUTH_ERROR_TEXT_BYTES) {
      return response;
    }
    const payload = JSON.parse(text) as {
      error?: { code?: unknown };
      code?: unknown;
    };
    if ((payload.error?.code ?? payload.code) === "mfa_required") {
      await reportMfaRequired(authBaseUrl, response.status).catch(
        () => undefined,
      );
    }
  } catch {
    // Response parsing/clone support varies slightly across RN versions.
    // The caller still receives the untouched original response.
  }
  return response;
}

export type AuthResult<T> =
  | { data: T; error?: undefined }
  | { data?: undefined; error: AuthApiError };

/** /api/v1/auth/me success body. */
export interface AuthMeResponse {
  user_id: string;
  tenant_id: string;
  email: string;
  role: string;
  effective_role?: string;
  viewer_mode?: boolean;
  auth_provider: string;
  email_verified: boolean;
  can_use_viewer_mode?: boolean;
  workspace_name?: string;
  workspace_slug?: string;
  /** Whether this user has a confirmed TOTP factor. */
  totp_enabled: boolean;
  /** Canonical tenant-policy decision for this durable user role. */
  mfa_required: boolean;
  /** Canonical state of the current cookie session, not a user preference. */
  mfa_satisfied: boolean;
}

/** /signup body. */
export interface AuthSignupInput {
  email: string;
  password: string;
  workspace_name: string;
  workspace_slug: string;
}

/** /signup 201 body. */
export interface AuthSignupResponse {
  user_id: string;
  tenant_id: string;
  workspace_slug: string;
  email_verified: boolean;
}

/** /login body. */
export interface AuthLoginInput {
  email: string;
  password: string;
  workspace_id?: string;
}

export interface AuthLoginOk {
  ok: true;
  user_id: string;
  tenant_id: string;
}

export interface AuthLoginNeedsWorkspace {
  needs_workspace: true;
  workspaces: { tenant_id: string; email: string }[];
}

export type AuthLoginResult = AuthLoginOk | AuthLoginNeedsWorkspace;

export interface AuthTotpEnrollResponse {
  otpauth_uri: string;
  recovery_codes: string[];
}

export type AuthOAuthProvider = "google";

/**
 * Cookie-aware fetch. `credentials: "include"` causes RN's underlying
 * platform client (NSURLSession on iOS / OkHttp on Android) to attach
 * cookies for the API origin and persist Set-Cookie headers from the
 * response, so the pw_session cookie round-trips across calls.
 */
export async function authRequest<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<AuthResult<T>> {
  const url = authUrl(baseUrl, path);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const callerSignal = init.signal;
  const onCallerAbort = (): void => ctrl.abort();
  if (callerSignal) {
    if (callerSignal.aborted) {
      ctrl.abort();
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }
  // X-Postwave-Client marks this as a native client so post-login,
  // cookie-authenticated POSTs (TOTP enroll/verify, logout) pass the
  // backend Origin/CSRF gate — RN's fetch cannot send an Origin header.
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Postwave-Client": "mobile",
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.headers) {
    for (const [k, v] of Object.entries(
      init.headers as Record<string, string>,
    )) {
      headers[k] = v;
    }
  }
  try {
    // RN's RequestInit type doesn't include `cache`, so we omit it here.
    // Per-request caching is moot anyway — these endpoints all have
    // Cache-Control: no-store on the server.
    const res = await fetch(url, {
      ...init,
      headers,
      credentials: "include",
      signal: ctrl.signal,
    });
    if (res.status === 204) {
      return { data: undefined as unknown as T };
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      let code: string | undefined;
      try {
        const text = await readTextLimited(res, MAX_AUTH_ERROR_TEXT_BYTES);
        if (text) {
          try {
            const j = JSON.parse(text) as {
              error?: { code?: string; message?: string };
              message?: string;
            };
            if (j && typeof j === "object") {
              message = j.error?.message || j.message || message;
              code = j.error?.code;
            }
          } catch {
            message = text.slice(0, 200);
          }
        }
      } catch {
        /* ignore */
      }
      if (code === "mfa_required") {
        await reportMfaRequired(baseUrl, res.status).catch(() => undefined);
      }
      const retryAfterSeconds = parseRetryAfterSeconds(
        res.headers.get("retry-after"),
      );
      return {
        error: {
          message,
          status: res.status,
          kind: "http",
          ...(code ? { code } : {}),
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        },
      };
    }
    const text = await readTextLimited(res, MAX_AUTH_RESPONSE_TEXT_BYTES);
    if (!text) return { data: undefined as unknown as T };
    try {
      return { data: JSON.parse(text) as T };
    } catch {
      return {
        error: {
          code: "invalid_json",
          kind: "parse",
          message: "API returned invalid JSON. Please refresh and try again.",
        },
      };
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        error: {
          code: "request_timeout",
          kind: "timeout",
          message: "Request timed out",
        },
      };
    }
    if (err instanceof AuthBodyTooLargeError) {
      return {
        error: {
          code: "response_too_large",
          kind: "parse",
          message: "API response was too large. Please refresh and try again.",
        },
      };
    }
    return {
      error: {
        kind: "network",
        message: err instanceof Error ? err.message : "Network error",
      },
    };
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

function authUrl(baseUrl: string, path: string): string {
  return apiUrl(baseUrl, path);
}

async function readTextLimited(
  res: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = Number(res.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AuthBodyTooLargeError();
  }
  // React Native's auth fetch buffers responses and does not expose a usable
  // streaming reader. Enforce Content-Length before buffering when present,
  // then retain the UTF-8 post-read guard for chunked/missing-length replies.
  const text = await res.text();
  if (utf8ByteLength(text) > maxBytes) throw new AuthBodyTooLargeError();
  return text;
}

class AuthBodyTooLargeError extends Error {
  constructor() {
    super("auth response body exceeded safety limit");
    this.name = "AuthBodyTooLargeError";
  }
}

/**
 * Bound auth client — the API base URL is captured at construction so
 * call-sites don't have to thread it through every hook. Instances are
 * cheap; the auth screens build one per submit.
 */
export interface AuthClient {
  baseUrl: string;
  getMe(): Promise<AuthResult<AuthMeResponse>>;
  signup(input: AuthSignupInput): Promise<AuthResult<AuthSignupResponse>>;
  login(input: AuthLoginInput): Promise<AuthResult<AuthLoginResult>>;
  logoutSession(): Promise<AuthResult<void>>;
  magicLinkStart(email: string, contract: MobileAuthLinkStart): Promise<AuthResult<{ sent: boolean }>>;
  magicLinkConsume(proof: AuthLinkProof): Promise<AuthResult<{ user_id: string; tenant_id: string }>>;
  passwordResetStart(email: string, contract: MobileAuthLinkStart): Promise<AuthResult<{ sent: boolean }>>;
  passwordResetConfirm(proof: AuthLinkProof, newPassword: string): Promise<AuthResult<{ reset: boolean }>>;
  oauthStartUrl(provider: AuthOAuthProvider, redirectTo?: string): string;
  totpEnroll(): Promise<AuthResult<AuthTotpEnrollResponse>>;
  totpVerify(
    code: string,
  ): Promise<AuthResult<{ verified: boolean; mfa_satisfied: boolean }>>;
  /** AUTH#48: `trust_device` + `trust_days` are the opt-in remember-me pair. */
  totpChallenge(
    input: TotpChallengeInput,
  ): Promise<AuthResult<TotpChallengeResult>>;
  totpDisable(): Promise<AuthResult<void>>;
}

export function createAuthClient(baseUrl: string): AuthClient {
  const base = normalizeApiBaseUrl(baseUrl);
  return {
    baseUrl: base,
    async getMe(): Promise<AuthResult<AuthMeResponse>> {
      const result = await authRequest<unknown>(base, "/api/v1/auth/me");
      if (result.error) return result;
      if (!isAuthMeResponse(result.data)) {
        return {
          error: {
            code: "invalid_me_response",
            kind: "parse",
            message:
              "The server returned an incomplete session profile. Please refresh and try again.",
          },
        };
      }
      return { data: result.data };
    },
    signup(input): Promise<AuthResult<AuthSignupResponse>> {
      return authRequest<AuthSignupResponse>(base, "/api/v1/auth/signup", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    async login(input): Promise<AuthResult<AuthLoginResult>> {
      const res = await authRequest<{
        user_id?: string;
        tenant_id?: string;
        needs_workspace?: boolean;
        workspaces?: { tenant_id: string; email: string }[];
      }>(base, "/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (res.error) return res;
      const j = res.data;
      if (j && j.needs_workspace && Array.isArray(j.workspaces)) {
        return {
          data: {
            needs_workspace: true,
            workspaces: j.workspaces,
          } as AuthLoginNeedsWorkspace,
        };
      }
      if (
        j &&
        typeof j.user_id === "string" &&
        typeof j.tenant_id === "string"
      ) {
        return {
          data: {
            ok: true,
            user_id: j.user_id,
            tenant_id: j.tenant_id,
          } as AuthLoginOk,
        };
      }
      return { error: { message: "unexpected login response" } };
    },
    logoutSession(): Promise<AuthResult<void>> {
      return authRequest<void>(base, "/api/v1/auth/logout", { method: "POST" });
    },
    magicLinkStart(email, contract): Promise<AuthResult<{ sent: boolean }>> {
      return authRequest<{ sent: boolean }>(
        base,
        "/api/v1/auth/magic-link/start",
        {
          method: "POST",
          body: JSON.stringify({ email, ...contract }),
        },
      );
    },
    magicLinkConsume(proof) {
      return authRequest<{ user_id: string; tenant_id: string }>(
        base,
        "/api/v1/auth/magic-link/consume",
        { method: "POST", body: JSON.stringify(authLinkConsumeBody(proof)) },
      );
    },
    passwordResetStart(email, contract) {
      return authRequest<{ sent: boolean }>(
        base,
        "/api/v1/auth/password-reset/start",
        { method: "POST", body: JSON.stringify({ email, ...contract }) },
      );
    },
    passwordResetConfirm(proof, newPassword) {
      return authRequest<{ reset: boolean }>(
        base,
        "/api/v1/auth/password-reset/confirm",
        {
          method: "POST",
          body: JSON.stringify({
            ...authLinkConsumeBody(proof), new_password: newPassword,
          }),
        },
      );
    },
    oauthStartUrl(provider, redirectTo) {
      const params = new URLSearchParams();
      const safeRedirectTo = safeOAuthRedirectTo(redirectTo);
      if (safeRedirectTo) params.set("redirect_to", safeRedirectTo);
      const qs = params.toString();
      return authUrl(
        base,
        `/api/v1/auth/oauth/${encodeURIComponent(provider)}/start${
          qs ? `?${qs}` : ""
        }`,
      );
    },
    totpEnroll() {
      return authRequest<AuthTotpEnrollResponse>(
        base,
        "/api/v1/auth/totp/enroll",
        { method: "POST", body: JSON.stringify({}) },
      );
    },
    totpVerify(code) {
      return authRequest<{ verified: boolean; mfa_satisfied: boolean }>(
        base,
        "/api/v1/auth/totp/verify",
        { method: "POST", body: JSON.stringify({ code }) },
      );
    },
    totpChallenge(input) {
      // The body is built by the pure contract module, which refuses to put an
      // unapproved trust duration on the wire — see trustedDeviceContract.ts.
      return authRequest<TotpChallengeResult>(
        base,
        "/api/v1/auth/totp/challenge",
        { method: "POST", body: JSON.stringify(totpChallengeBody(input)) },
      );
    },
    totpDisable() {
      return authRequest<void>(base, "/api/v1/auth/totp", { method: "DELETE" });
    },
  };
}

function isAuthMeResponse(value: unknown): value is AuthMeResponse {
  if (!value || typeof value !== "object") return false;
  const me = value as Record<string, unknown>;
  return (
    typeof me.user_id === "string" &&
    typeof me.tenant_id === "string" &&
    typeof me.email === "string" &&
    typeof me.role === "string" &&
    typeof me.auth_provider === "string" &&
    typeof me.email_verified === "boolean" &&
    typeof me.totp_enabled === "boolean" &&
    typeof me.mfa_required === "boolean" &&
    typeof me.mfa_satisfied === "boolean" &&
    (me.effective_role === undefined ||
      typeof me.effective_role === "string") &&
    (me.viewer_mode === undefined || typeof me.viewer_mode === "boolean") &&
    (me.can_use_viewer_mode === undefined ||
      typeof me.can_use_viewer_mode === "boolean") &&
    (me.workspace_name === undefined ||
      typeof me.workspace_name === "string") &&
    (me.workspace_slug === undefined || typeof me.workspace_slug === "string")
  );
}

/**
 * Native OAuth return guard — must match the SERVER's `sanitizeOAuthRedirect`
 * (apps/api/internal/auth/oauth_handlers.go), which accepts exactly
 * `moosewave://auth/magic` with a single sanitized `state` and falls back to
 * the web origin otherwise. This previously also accepted
 * `moosewave://auth/oauth-return`, which the server rejects — a client built on
 * it would strand the user in a browser. The `state` is mandatory: bounceBack
 * mints a magic-link token bound to that nonce, and magic-return.tsx refuses a
 * link whose state does not match the one this device stored.
 */
export function safeOAuthRedirectTo(value?: string): string | undefined {
  if (!value) return undefined;
  if (utf8ByteLength(value) > MAX_OAUTH_REDIRECT_TO_BYTES) return undefined;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "postwave:" || url.username || url.password) {
      return undefined;
    }
    if (url.hostname.toLowerCase() !== "auth") return undefined;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 1) return undefined;
    if (segments[0]?.toLowerCase() !== "magic") return undefined;
    const states = url.searchParams.getAll("state");
    if (states.length !== 1) return undefined;
    if (!safeAuthLinkState(states[0])) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Lower-noise error message: redact backend internals like "pq:
 * duplicate key value …" so users don't see Postgres prose. Same
 * approach as the desktop's redact() helper.
 */
export function redactAuthError(message: string): string {
  if (!message) return "Something went wrong";
  if (/pq:|sql:|database is locked/i.test(message)) {
    return "Server error. Please try again.";
  }
  return message;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function isValidWorkspaceSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

export function suggestWorkspaceSlug(
  email: string,
  workspaceName: string,
): string {
  const base = workspaceName.trim() || email.split("@")[0] || "";
  return base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
