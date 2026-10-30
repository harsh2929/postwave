/**
 * api/auditAlerts.ts — transport for the audit-alert rules surface.
 *
 * Every route was read off the chi mount at
 * `apps/api/internal/audit_alerts/audit_alerts.go::MountRoutes` (mounted from
 * `internal/server/operator_reference_routes.go:40`, itself called at
 * `apps/api/main.go:3657`), not from the OpenAPI document:
 *
 *   GET    /api/v1/audit-alerts                 audit:read            → {rules:[…]}
 *   GET    /api/v1/audit-alerts/{id}/fires      audit:read            → {fires:[…]}
 *   GET    /api/v1/audit-alerts/{id}/incidents  audit:read            → {incidents:[…], nextCursor?}
 *   POST   /api/v1/audit-alerts                 audit:configure_sinks → {id}
 *   PATCH  /api/v1/audit-alerts/{id}            audit:configure_sinks → {updated:true}
 *   DELETE /api/v1/audit-alerts/{id}            audit:configure_sinks → {deleted:true}
 *
 * THE MUTATION VERB IS PATCH. There is no PUT handler on this resource; a PUT
 * would 405. The body the handler decodes is
 * `{enabled?, name?, channel_config?, notify_slack?}` and each field is applied
 * independently, so sending only `{enabled}` touches only `enabled`.
 *
 * THE GATE IS A SCOPE, AND THEN A SECOND, GENERATED GATE ON TOP. Two layers run
 * before these handlers, and both were read rather than assumed:
 *
 *   1. `routeauth.Middleware` (main.go:2265, applied router-wide by
 *      authenticated_route_stack.go:38) enforces the generated manifest row.
 *      For the three GETs that row is `session_minimum_role: "viewer"`,
 *      `api_key_scopes: ["read:reports"]`; for PATCH/DELETE/POST it is
 *      `"admin"` / `["admin"]`. Those rows are `safe-default` + fail_closed —
 *      unreviewed, so they may be WRONG in the permissive direction, but they
 *      are genuinely ENFORCED in the restrictive one.
 *   2. The mount's own gates (audit_alerts.go:111-118):
 *      `RequireScope(ScopeAuditRead)` on the reads and
 *      `RequireScope(ScopeAuditConfigureSinks)` on the writes. For a session
 *      the scope set those check is injected by `auditRBACSessionScopes`
 *      (audit_rbac_middleware.go) — the SAME set `GET /api/v1/audit/my-scopes`
 *      reports, which is why the screen can gate on my-scopes honestly. A role
 *      with no `roles` row gets `audit:read` and nothing else; owner/admin get
 *      the full audit set. `audit:read` is inside `readOnlyScopes`, so
 *      `RequireScope` skips its role check on the reads and a viewer really can
 *      read this list.
 *
 * DELETE IS NOW WRAPPED. The original objection — "there is no create form to
 * rebuild the rule with" — dissolved when the create sheet shipped
 * (lib/auditAlertCreate). It remains a destructive verb: the server redacts
 * `channel_config` on every read, so a deleted rule's credential set cannot be
 * read back from this app and the confirm says so in those terms.
 *
 * Parsing lives in lib/auditAlert{Rules,Incidents} so it is unit-testable in the
 * node vitest environment; this module is only URLs and envelopes. The create
 * body is BUILT in lib/auditAlertCreate (node-tested against the Go
 * validators); this module transports it verbatim.
 */
import type { AuditAlertCreateBody } from "@/lib/auditAlertCreate";
import {
  parseAuditAlertIncidentPage,
  type AuditAlertIncidentPage,
} from "@/lib/auditAlertIncidents";
import {
  parseAuditAlertFireList,
  parseAuditAlertRuleList,
  type AuditAlertFire,
  type AuditAlertRule,
} from "@/lib/auditAlertRules";

import { checkedApiResult, rawRequest } from "./request";

/** `Deps.Fires` hard-codes `ORDER BY fired_at DESC LIMIT 100`. */
export const AUDIT_ALERT_FIRES_CAP = 100;

export const AUDIT_ALERTS_PATH = "/api/v1/audit-alerts";

export function auditAlertPath(id: string): string {
  return `${AUDIT_ALERTS_PATH}/${encodeURIComponent(id)}`;
}

export function auditAlertFiresPath(id: string): string {
  return `${auditAlertPath(id)}/fires`;
}

/**
 * How many linked incidents one phone-sized read asks for.
 *
 * `Deps.Incidents` keyset-paginates on `(updated_at, id)` and defaults to 200
 * when `?limit=` is omitted. 200 ticket rows is not a phone screen, and this
 * surface exists to answer "is anything still open", so the request is bounded
 * and the sheet SAYS it is bounded whenever the server returns a `nextCursor`.
 */
export const AUDIT_ALERT_INCIDENTS_PAGE = 25;

export function auditAlertIncidentsPath(
  id: string,
  limit: number = AUDIT_ALERT_INCIDENTS_PAGE,
): string {
  return `${auditAlertPath(id)}/incidents?limit=${encodeURIComponent(String(limit))}`;
}

export async function fetchAuditAlertRules(): Promise<AuditAlertRule[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", AUDIT_ALERTS_PATH),
  );
  return parseAuditAlertRuleList(res.data);
}

export async function fetchAuditAlertFires(
  id: string,
): Promise<AuditAlertFire[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", auditAlertFiresPath(id)),
  );
  return parseAuditAlertFireList(res.data);
}

/**
 * The external tickets this rule has opened, most recently updated first.
 *
 * Returns the page AND its `nextCursor`, because "these are all of them" is a
 * claim the caller must not make on this app's behalf: the handler withholds
 * older rows and only says so through that field.
 */
export async function fetchAuditAlertIncidents(
  id: string,
): Promise<AuditAlertIncidentPage> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", auditAlertIncidentsPath(id)),
  );
  return parseAuditAlertIncidentPage(res.data);
}

/**
 * Pause / resume. Only `enabled` is sent: the handler applies each field
 * independently, and including `channel_config` would round-trip a credential
 * set this app deliberately never reads.
 */
export async function setAuditAlertEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>("PATCH", auditAlertPath(id), { enabled }),
  );
}

/**
 * Flip the managed-Slack fan-out. Only `notify_slack` is sent, for the same
 * independent-fields reason as the pause toggle — the primary channel and its
 * credentials are untouched by this write.
 */
export async function setAuditAlertNotifySlack(
  id: string,
  notifySlack: boolean,
): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>("PATCH", auditAlertPath(id), {
      notify_slack: notifySlack,
    }),
  );
}

/**
 * Create a rule. The body is built and validated by lib/auditAlertCreate so a
 * request the server would 400 is caught before it leaves the phone; this
 * function sends it verbatim. Returns the new rule's id.
 */
export async function createAuditAlertRule(
  body: AuditAlertCreateBody,
): Promise<string> {
  const res = await checkedApiResult(
    rawRequest<unknown>("POST", AUDIT_ALERTS_PATH, body),
  );
  const id = (res.data as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : "";
}

/**
 * Delete a rule. Destructive and unrecoverable in one specific sense the
 * confirm must say: the server never returns `channel_config`, so the
 * credential set the rule carried cannot be read back and re-entered from
 * here without the original secret.
 */
export async function deleteAuditAlertRule(id: string): Promise<void> {
  await checkedApiResult(rawRequest<unknown>("DELETE", auditAlertPath(id)));
}
