/**
 * lib/auditGovernance.ts — parsing + policy for the workspace-level audit
 * governance endpoints: the retention policy, auditor portal sessions and
 * pending audit-access requests.
 *
 * Wire shapes (read off the Go handlers, not OpenAPI):
 *
 *   GET /api/v1/audit/retention          → { retentionDays: number|null, defaultDays }
 *   PUT /api/v1/audit/retention          body { retentionDays: 1..3650 | null }
 *   GET /api/v1/audit/portal/sessions    → { sessions: [{id, scope, expiresAt,
 *                                            createdAt, accessedAt?, revokedAt?}] }
 *   DELETE /audit/portal/sessions/{id}   → { ok: true }
 *   GET /api/v1/audit/access-requests    → { items: [AccessRequest] } (pending)
 *
 * ── THE STOPPING-HALF DECISION, applied to portal sessions ────────────────
 * Mobile ships LIST + REVOKE and deliberately not MINT. Minting hands back a
 * portal URL that is a bearer credential (lib/stoppingHalfPolicy: the
 * starting half that returns a credential stays off the phone), and desktop's
 * own release note holds the mint behind "non-consuming portal review".
 * Revoking a session someone should not have is the archetypal away-from-desk
 * act and can only remove authority.
 *
 * Import-free of react-native; asserted under node vitest.
 */
import type { AuditAuthMode, AuditScopeSet, AuditWriteAccess } from "./auditForensics";

// ── retention policy ───────────────────────────────────────────────────────

export interface AuditRetentionPolicy {
  /** Tenant override, or null when the deployment default applies. */
  retentionDays: number | null;
  defaultDays: number;
}

export function parseAuditRetention(body: unknown): AuditRetentionPolicy {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    retentionDays:
      typeof b.retentionDays === "number" && Number.isFinite(b.retentionDays)
        ? b.retentionDays
        : null,
    defaultDays:
      typeof b.defaultDays === "number" && Number.isFinite(b.defaultDays)
        ? b.defaultDays
        : 90,
  };
}

/** Server bound for PUT: integer 1..3650 (SetRetention). */
export function validAuditRetentionDays(days: number): boolean {
  return Number.isInteger(days) && days >= 1 && days <= 3650;
}

/** The effective window, override or default. */
export function effectiveRetentionDays(policy: AuditRetentionPolicy): number {
  return policy.retentionDays ?? policy.defaultDays;
}

/**
 * Does this change SHORTEN the window? A reduction makes older rows eligible
 * for the next purge — that is the data-destroying direction, and it is the
 * one that gets the typed confirm.
 */
export function isRetentionReduction(
  policy: AuditRetentionPolicy,
  nextDays: number,
): boolean {
  return nextDays < effectiveRetentionDays(policy);
}

/** The presets auditors actually pick (90 standard, 365 SOC 2, 2555 HIPAA). */
export const AUDIT_RETENTION_PRESETS: readonly {
  days: number;
  label: string;
}[] = [
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
  { days: 2555, label: "7 years" },
];

/**
 * Who may CHANGE the policy. Session floor is admin (manifest, reviewed); an
 * API key needs audit:read + audit:configure_retention (mount) or admin.
 */
export function retentionPolicyWriteAccess(input: {
  scopes: AuditScopeSet | null | undefined;
  mode: AuditAuthMode;
  online: boolean;
}): AuditWriteAccess {
  const scopes = input.scopes;
  if (!scopes) return { allowed: false, known: false, notice: null };
  const scopeOk =
    scopes.isAdmin ||
    (input.mode === "api_key" &&
      scopes.auditScopes.includes("audit:read") &&
      scopes.auditScopes.includes("audit:configure_retention"));
  if (!scopeOk) {
    return {
      allowed: false,
      known: true,
      notice:
        input.mode === "api_key"
          ? "Changing the retention window needs an API key with audit:read and audit:configure_retention (or admin). The current policy is shown read-only."
          : "Changing the retention window is limited to workspace owners and admins. The current policy is shown read-only.",
    };
  }
  if (!input.online) {
    return {
      allowed: false,
      known: true,
      notice:
        "You're offline. A retention change decides what the purge job deletes, so it is never queued for later.",
    };
  }
  return { allowed: true, known: true, notice: null };
}

// ── portal sessions ────────────────────────────────────────────────────────

export interface AuditPortalSession {
  id: string;
  scope: string;
  expiresAt: string;
  createdAt: string;
  accessedAt: string | null;
  revokedAt: string | null;
}

export function parsePortalSessions(body: unknown): AuditPortalSession[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(b.sessions) ? b.sessions : [];
  const out: AuditPortalSession[] = [];
  for (const item of raw) {
    const s = (item ?? {}) as Record<string, unknown>;
    if (typeof s.id !== "string" || !s.id) continue;
    out.push({
      id: s.id,
      scope: typeof s.scope === "string" ? s.scope : "",
      expiresAt: typeof s.expiresAt === "string" ? s.expiresAt : "",
      createdAt: typeof s.createdAt === "string" ? s.createdAt : "",
      accessedAt: typeof s.accessedAt === "string" ? s.accessedAt : null,
      revokedAt: typeof s.revokedAt === "string" ? s.revokedAt : null,
    });
  }
  return out;
}

export type PortalSessionState = "active" | "expired" | "revoked";

/**
 * Revoked wins over expired: a session that was BOTH must read as revoked,
 * because "we cut this off" and "it lapsed" are different governance answers.
 */
export function portalSessionState(
  session: AuditPortalSession,
  now: number,
): PortalSessionState {
  if (session.revokedAt) return "revoked";
  const expires = Date.parse(session.expiresAt);
  if (Number.isFinite(expires) && expires <= now) return "expired";
  return "active";
}

/** Only an ACTIVE session is revocable — revoking a lapsed one is a no-op lie. */
export function isPortalSessionRevocable(
  session: AuditPortalSession,
  now: number,
): boolean {
  return portalSessionState(session, now) === "active";
}

/** Revoke is admin on every path (mount RequireScope(ScopeAdmin)). */
export function portalRevokeAccess(input: {
  scopes: AuditScopeSet | null | undefined;
  mode: AuditAuthMode;
  online: boolean;
}): AuditWriteAccess {
  const scopes = input.scopes;
  if (!scopes) return { allowed: false, known: false, notice: null };
  if (!scopes.isAdmin) {
    return {
      allowed: false,
      known: true,
      notice:
        input.mode === "api_key"
          ? "Revoking an auditor session needs an API key with the admin scope."
          : "Revoking an auditor session is limited to workspace owners and admins.",
    };
  }
  if (!input.online) {
    return {
      allowed: false,
      known: true,
      notice:
        "You're offline. A revoke only protects anything once the server has it, so it is never queued.",
    };
  }
  return { allowed: true, known: true, notice: null };
}

// ── access requests ────────────────────────────────────────────────────────

export interface AuditAccessRequest {
  id: string;
  userEmail: string;
  actorLabel: string;
  note: string;
  status: string;
  createdAt: string;
}

export function parseAccessRequests(body: unknown): AuditAccessRequest[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(b.items) ? b.items : [];
  const out: AuditAccessRequest[] = [];
  for (const item of raw) {
    const r = (item ?? {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id) continue;
    out.push({
      id: r.id,
      userEmail: typeof r.userEmail === "string" ? r.userEmail : "",
      actorLabel: typeof r.actorLabel === "string" ? r.actorLabel : "",
      note: typeof r.note === "string" ? r.note : "",
      status: typeof r.status === "string" ? r.status : "",
      createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    });
  }
  return out;
}

/** Who a pending request is FROM, for the banner line. */
export function accessRequesterLabel(request: AuditAccessRequest): string {
  return request.userEmail || request.actorLabel || "An account";
}

/**
 * The admin banner above the log. Null when there is nothing to say — a
 * governance banner that renders on zero would train everyone to skip it.
 */
export function accessRequestsBannerLine(
  requests: readonly AuditAccessRequest[] | null | undefined,
): string | null {
  if (!Array.isArray(requests) || requests.length === 0) return null;
  if (requests.length === 1) {
    return `${accessRequesterLabel(requests[0]!)} is waiting on audit access.`;
  }
  return `${requests.length} teammates are waiting on audit access.`;
}

/**
 * One sentence for the current retention state. Says WHICH policy is in force
 * (tenant override vs deployment default) — "90 days" alone hides who decided.
 */
export function retentionSummaryLine(policy: AuditRetentionPolicy): string {
  return policy.retentionDays === null
    ? `Audit events are kept ${policy.defaultDays} days (deployment default).`
    : `Audit events are kept ${policy.retentionDays} days (workspace override; default is ${policy.defaultDays}).`;
}
