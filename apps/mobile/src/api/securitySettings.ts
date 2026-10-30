/**
 * api/securitySettings.ts — the workspace security policy, read-only on mobile.
 *
 * WHY THIS EXISTS. Mobile already tells users what the policy DOES to them:
 * TotpSecuritySection refuses to remove two-factor with "your workspace policy
 * requires it", and the session dies at `session_max_minutes` with no warning.
 * Neither sentence was checkable from the phone — `security/settings` had zero
 * callers in apps/mobile — so the enforcement read as an unexplained wall.
 *
 * READ-ONLY, DELIBERATELY. The PUT half of this endpoint changes who can sign
 * in to the whole workspace. Mis-tapping "Require two-factor for everyone" from
 * a phone can lock out every colleague who has not enrolled, with no undo, so
 * the write stays on the web admin and mobile links to it.
 *
 * FAIL CLOSED ON 403. The route is mounted behind
 * `apikeys.RequireScope(ScopeAdmin)` (apps/api/internal/server/
 * tenant_governance.go), so the SERVER is the authority on who may read it —
 * not a client-side role check that a stale cached profile could get wrong.
 * A 403 (or a 404 from a deployment where the governance routes are not
 * mounted) hides the card entirely rather than showing an error for something
 * the user was never entitled to see.
 *
 * Endpoint: GET /api/v1/security/settings →
 *   {require_2fa_for_admins, require_2fa_for_all, sso_provider?,
 *    sso_metadata_url?, session_max_minutes?}
 * (apps/api/internal/handlers/security.go — a flat object, and an unvisited
 * tenant gets the zero value rather than a 404.)
 */
import { rawRequest } from "./request";

export interface TenantSecurityPolicy {
  require2faForAdmins: boolean;
  require2faForAll: boolean;
  /**
   * The provider string stored in `tenant_security_settings.sso_provider`.
   *
   * NOT a statement about how anyone signs in. Nothing in this deployment
   * consumes the column: there is no ACS route, no SAML handler anywhere in
   * apps/api, and `scim.SAMLJITProvision` has zero callers. The API now refuses
   * to store a NEW value (503 `sso_not_available`, apps/api/internal/handlers/
   * security.go), but rows saved before that gate existed are still returned
   * here — so a non-null value means "somebody once typed this", never
   * "sign-in is federated".
   */
  ssoProvider: string | null;
  /** Null means "server default" — the column is nullable, not zero. */
  sessionMaxMinutes: number | null;
}

export class SecurityPolicyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message || "Couldn't load the workspace security policy.");
    this.name = "SecurityPolicyError";
    this.status = status;
  }
}

/**
 * True when the policy is none of this user's business (403) or the surface is
 * not deployed (404). Both mean "render nothing", never "something is broken".
 */
export function isPolicyHidden(error: unknown): boolean {
  return (
    error instanceof SecurityPolicyError &&
    (error.status === 403 || error.status === 404)
  );
}

function bool(value: unknown): boolean {
  return value === true;
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function positiveIntOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : null;
}

export function normalizeSecurityPolicy(payload: unknown): TenantSecurityPolicy {
  const raw = (payload ?? {}) as Record<string, unknown>;
  return {
    require2faForAdmins: bool(raw.require_2fa_for_admins),
    require2faForAll: bool(raw.require_2fa_for_all),
    ssoProvider: trimmedOrNull(raw.sso_provider),
    sessionMaxMinutes: positiveIntOrNull(raw.session_max_minutes),
  };
}

/**
 * One sentence for the two booleans, in the order the server enforces them:
 * `require_2fa_for_all` subsumes `require_2fa_for_admins`, so a workspace with
 * both set must not read as "admins only" (middleware/mfa_gate.go applies the
 * all-users rule first).
 */
export function twoFactorPolicyLabel(policy: TenantSecurityPolicy): string {
  if (policy.require2faForAll) return "Required for everyone";
  if (policy.require2faForAdmins) return "Required for admins and owners";
  return "Optional — not enforced by this workspace";
}

function unit(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * `session_max_minutes` as a duration a human can act on. Null is the honest
 * "we do not set one" rather than an invented number: auth/session.go caps
 * against the server default when the column is unset.
 */
export function formatSessionTtl(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) {
    return "Server default";
  }
  const whole = Math.trunc(minutes);
  const days = Math.floor(whole / 1440);
  const hours = Math.floor((whole % 1440) / 60);
  const mins = whole % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(unit(days, "day"));
  if (hours > 0) parts.push(unit(hours, "hour"));
  if (mins > 0) parts.push(unit(mins, "minute"));
  return parts.join(" ");
}

/**
 * The stored provider, always qualified — or the plain truth that there is none.
 *
 * Rendering a bare "okta" here told an admin their workspace was federated. It
 * is not: no surface in this repo consumes the column (see `ssoProvider`), so
 * the value is an inert preference and the label has to say so. Showing it
 * qualified beats hiding it, because clearing the field is the only way out and
 * an operator cannot clear a value they cannot see.
 */
export function ssoProviderLabel(policy: TenantSecurityPolicy): string {
  if (policy.ssoProvider === null) return "Not configured";
  return `${policy.ssoProvider} — not enforced`;
}

/**
 * The sentence under the SSO row, or null when there is nothing to add.
 *
 * Lives here rather than inline in the card so the claim is unit-testable: this
 * is the one row on the screen whose neighbours (two-factor, session length)
 * ARE enforced server-side — mfa_gate.go and the session TTL both read this
 * same table — which is exactly what made an unenforced row read as enforced.
 */
export function ssoProviderHint(policy: TenantSecurityPolicy): string | null {
  if (policy.ssoProvider === null) return null;
  return (
    "This value is saved but does nothing — sign-in is not delegated to it. " +
    "Everyone still signs in with their Moosewave credentials."
  );
}

export async function getSecuritySettings(): Promise<TenantSecurityPolicy> {
  const res = await rawRequest<unknown>("GET", "/api/v1/security/settings");
  if (res.error) {
    throw new SecurityPolicyError(res.error.status, res.error.message);
  }
  return normalizeSecurityPolicy(res.data);
}
