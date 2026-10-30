/**
 * api/auditGovernance.ts — transport for the workspace-level audit governance
 * endpoints (retention policy, auditor portal sessions, access requests).
 *
 * Shapes and gates are documented in lib/auditGovernance; this module is only
 * URLs and envelopes, with `./request` as its single impure import so the
 * transport seam stays node-testable.
 */
import {
  parseAccessRequests,
  parseAuditRetention,
  parsePortalSessions,
  type AuditAccessRequest,
  type AuditPortalSession,
  type AuditRetentionPolicy,
} from "@/lib/auditGovernance";

import { checkedApiResult, rawRequest } from "./request";

export const AUDIT_RETENTION_PATH = "/api/v1/audit/retention";
export const AUDIT_PORTAL_SESSIONS_PATH = "/api/v1/audit/portal/sessions";
export const AUDIT_ACCESS_REQUESTS_PATH = "/api/v1/audit/access-requests";

export async function fetchAuditRetention(): Promise<AuditRetentionPolicy> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", AUDIT_RETENTION_PATH),
  );
  return parseAuditRetention(res.data);
}

/** PUT { retentionDays } — 1..3650, or null for the deployment default. */
export async function setAuditRetention(days: number | null): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>("PUT", AUDIT_RETENTION_PATH, { retentionDays: days }),
  );
}

export async function fetchAuditPortalSessions(): Promise<
  AuditPortalSession[]
> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", AUDIT_PORTAL_SESSIONS_PATH),
  );
  return parsePortalSessions(res.data);
}

/**
 * The STOPPING half of the portal capability (lib/stoppingHalfPolicy): the
 * mint (POST, which returns a bearer portal URL) is deliberately not wrapped
 * here — see lib/auditGovernance's header.
 */
export async function revokeAuditPortalSession(id: string): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>(
      "DELETE",
      `${AUDIT_PORTAL_SESSIONS_PATH}/${encodeURIComponent(id)}`,
    ),
  );
}

/** Pending only — the server's own default for this endpoint. */
export async function fetchAuditAccessRequests(): Promise<
  AuditAccessRequest[]
> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", AUDIT_ACCESS_REQUESTS_PATH),
  );
  return parseAccessRequests(res.data);
}
