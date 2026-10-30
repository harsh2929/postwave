/**
 * api/ops.ts — the enterprise/operator endpoint family (migrations, SCIM,
 * audit sinks, agency).
 *
 * GOVERNANCE#57. This module used to re-declare the wire shape of every one of
 * those resources by hand and reach the server through `rawRequest(method,
 * "/api/v1/…")` string literals, even though `@postwave/sdk` — already a
 * workspace dependency, already the transport underneath `rawRequest` — ships
 * typed resources for all four. Two things went wrong with that:
 *
 *   1. A backend field rename needed a mobile-local type edit that nothing
 *      enforced, so mobile silently drifted. It HAD drifted: the local
 *      `MobileMigrationJob` carried `updated_at` and the local
 *      `MobileMigrationProgress` carried `percent` / `completed` / `total`,
 *      none of which `canonical.MigrationJob`
 *      (packages/migrate/canonical/types.go:330) has ever sent. Real code
 *      branched on all four. Deriving from the SDK turned every one of those
 *      into a compile error, which is how they were found.
 *   2. Nine hand-written URL strings had to stay in step with nine resource
 *      methods by eye.
 *
 * So: EVERY type below is DERIVED from the SDK — never re-typed — and every
 * call goes through the typed resource method. `Mobile*` aliases are kept
 * because ~15 screens and libs import them by that name, and renaming them
 * would be churn with no reader benefit.
 *
 * WHERE MOBILE DELIBERATELY WIDENS, AND WHY IT IS NOT OPTIONAL. The SDK narrows
 * three server enums that the server has since outgrown. `AuditSinkKind` is
 * `s3|datadog|splunk|http`, but apps/api/internal/auditsink/admin.go:220 accepts
 * `s3|datadog|splunk|http|archive|snowflake_shareback|otlp_logs` — seven. A
 * phone build also outlives the server it talks to. So the enum-valued fields
 * are read as `<SDK union> | (string & {})`: the SDK still supplies the field
 * NAMES and every non-enum field type, autocomplete still offers the known
 * values, and a value this build has never heard of renders as itself instead
 * of being a type lie. Field-level drift is caught; value-level drift is
 * tolerated on purpose.
 *
 * The envelope stays `AIApiResult`: callers branch on `res.error.status` /
 * `.code` (the agency screen's three distinct 403s depend on it) rather than
 * importing the SDK error hierarchy.
 */
import type {
  AdapterCapabilities,
  AgentMandateSummary,
  AuditSink,
  MigrationJob,
  MigrationProgress,
  MigrationStatus,
  PostwaveClient,
  ScimRoleMapping,
  ScimTokenInfo,
} from "@postwave/sdk";

import { type AIApiResult, rawRequest, sdkResult } from "./request";
import { getClient } from "./sdkClient";

/**
 * A server enum this build must tolerate not recognising. `(string & {})`
 * keeps the SDK's known values in autocomplete while accepting any string,
 * so a newer server value is rendered rather than mistyped.
 */
type Open<T extends string> = T | (string & Record<never, never>);

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * `canonical.MigrationProgress` (types.go:347) is a flat bag of
 * `<resource>_done` / `<resource>_total` integers. Partial because the
 * optional counters (templates, source_archive) are `omitempty` server-side
 * and because a job that has not started reports none of them — and because
 * ABSENCE IS NOT ZERO: `mobileMigrationResourceProgress` drops a counter it
 * cannot see rather than rendering it as 0/0.
 */
export type MobileMigrationProgress = Partial<MigrationProgress>;

export type MobileMigrationStatus = MigrationStatus;

/**
 * Partial for one reason worth stating: this is a LIST payload rendered by a
 * screen that also seeds itself from cache and from push, so every consumer
 * already handles a half-populated row. `id` is the one field nothing can work
 * without.
 */
export type MobileMigrationJob = Partial<
  Omit<MigrationJob, "id" | "source" | "status" | "progress">
> & {
  id: string;
  source?: Open<MigrationJob["source"]>;
  status?: Open<MigrationStatus>;
  progress?: MobileMigrationProgress;
};

/**
 * `GET /api/v1/migrations/sources` returns `canonical.AdapterCapabilities`.
 * `supports` is deep-partial because the adapter matrix grows a key per
 * capability and older gateways omit the newer ones.
 */
export type MobileMigrationSource = Partial<
  Omit<AdapterCapabilities, "source" | "auth_method" | "supports">
> & {
  source: Open<AdapterCapabilities["source"]>;
  auth_method?: Open<AdapterCapabilities["auth_method"]>;
  supports?: Partial<AdapterCapabilities["supports"]>;
};

export async function listMobileMigrations(): Promise<
  AIApiResult<MobileMigrationJob[]>
> {
  return sdkResult(() => getClient().client.migrations.list());
}

export async function listMobileMigrationSources(): Promise<
  AIApiResult<MobileMigrationSource[]>
> {
  return sdkResult(() => getClient().client.migrations.listSources());
}

/**
 * Cancel a running migration. Idempotent server-side, and deliberately the
 * only migration WRITE mobile exposes: stopping a runaway import is the one
 * thing that cannot wait until someone is back at a desk. Rollback stays on
 * desktop — it needs the verification report to be read first.
 *
 * THE ONE CALL IN THIS MODULE THAT STAYS HAND-ROLLED, and it is an SDK gap
 * rather than a preference: `services/migration/.../migration.go:281` mounts
 * `DELETE /v1/migrations/{job_id}` → `CancelJob`, but `MigrationsResource`
 * ships no `cancel()` — it has rollback and rollbackStatus and nothing that
 * stops a running job. Adding it belongs in packages/sdk-ts.
 */
export async function cancelMobileMigration(
  jobId: string,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>(
    "DELETE",
    `/api/v1/migrations/${encodeURIComponent(jobId)}`,
  );
}

// ---------------------------------------------------------------------------
// Migration cutover watch (GOVERNANCE#53)
// ---------------------------------------------------------------------------

type Sdk = PostwaveClient;

/** `GET /api/v1/migrations/{job_id}/shadow-monitor` — monitor + check history. */
export type MobileShadowMonitorResponse = Awaited<
  ReturnType<Sdk["migrations"]["shadowMonitor"]>
>;

/** `GET /api/v1/migrations/{job_id}/source-events` — monitor + event rows. */
export type MobileSourceEventResponse = Awaited<
  ReturnType<Sdk["migrations"]["sourceEvents"]>
>;

export type MobileSourceEventRecord =
  MobileSourceEventResponse["events"][number];

/**
 * Both GETs answer 404 when no monitor was ever started for the job
 * (services/migration/internal/handlers/shadow_monitor.go:131,
 * source_events.go:161) and 503 when the deployment's job store is not
 * monitor-capable. Neither is a fault; the caller renders both as states.
 */
export async function getMobileShadowMonitor(
  jobId: string,
): Promise<AIApiResult<MobileShadowMonitorResponse>> {
  return sdkResult(() => getClient().client.migrations.shadowMonitor(jobId));
}

export async function getMobileSourceEvents(
  jobId: string,
): Promise<AIApiResult<MobileSourceEventResponse>> {
  return sdkResult(() => getClient().client.migrations.sourceEvents(jobId));
}

/**
 * Reopen a source-event that was previously signed off. The `reviewed`
 * direction is deliberately NOT exposed here — see
 * lib/sourceEventReview.ts for why a phone must not sign off a
 * reconciliation.
 */
export async function reopenMobileSourceEventReview(
  jobId: string,
  eventId: string,
): Promise<AIApiResult<MobileSourceEventRecord>> {
  return sdkResult(() =>
    getClient().client.migrations.updateSourceEventReview(jobId, eventId, {
      status: "pending",
    }),
  );
}

// ---------------------------------------------------------------------------
// SCIM
// ---------------------------------------------------------------------------

export type MobileScimTokenInfo = ScimTokenInfo;
export type MobileScimRoleMapping = ScimRoleMapping;

export async function listMobileScimTokens(): Promise<
  AIApiResult<{ tokens: MobileScimTokenInfo[] }>
> {
  return sdkResult(() => getClient().client.scim.listTokens());
}

export async function listMobileScimRoleMappings(): Promise<
  AIApiResult<{ mappings: MobileScimRoleMapping[] }>
> {
  return sdkResult(() => getClient().client.scim.listRoleMappings());
}

/**
 * Revoke a SCIM provisioning token. A leaked SCIM bearer can create, modify
 * and deprovision workspace users, so "revoke it now" is the definition of
 * an action that must not wait for a laptop.
 */
export async function revokeMobileScimToken(
  id: string,
): Promise<AIApiResult<unknown>> {
  return sdkResult(() => getClient().client.scim.revokeToken(id));
}

// ---------------------------------------------------------------------------
// Agent mandates
//
// The bound a PERSON puts on an agent. Until this, no client existed on any
// surface — not web, not desktop, not the SDK — so the governance moat was
// reachable only by hand-rolled HTTP.
//
// SESSION-ONLY, which is exactly why mobile can host it: the server refuses an
// API key with 403 `session_required` (an agent that could mint its own mandate
// would not be bounded by it), and the phone authenticates with a session.
//
// CREATE IS DELIBERATELY ABSENT. Minting returns the bearer token exactly once,
// and mobile has no hardened capture-then-dismiss ceremony for a reveal-once
// secret — the same reasoning that keeps API-key rotate off this platform.
// Offering it would manufacture the dead end it is meant to solve: a token the
// operator can see, cannot reliably capture, and cannot get back.
// ---------------------------------------------------------------------------

export type MobileAgentMandate = AgentMandateSummary;

/** `GET /api/v1/agent-mandates` — includes revoked and expired, by design. */
export async function listMobileAgentMandates(): Promise<
  AIApiResult<{ data: MobileAgentMandate[] }>
> {
  return sdkResult(() => getClient().client.agentMandates.list());
}

/**
 * End an agent's authority. Idempotent server-side (200 even for an unknown or
 * already-revoked id), so a retry after a flaky response is safe.
 */
export async function revokeMobileAgentMandate(
  id: string,
): Promise<AIApiResult<unknown>> {
  return sdkResult(() => getClient().client.agentMandates.revoke(id));
}

// ---------------------------------------------------------------------------
// Audit sinks
// ---------------------------------------------------------------------------

/**
 * `kind` and `circuit_state` are opened up: see the module header — the
 * server's kind allow-list is three values longer than the SDK's union.
 */
export type MobileAuditSink = Omit<AuditSink, "kind" | "circuit_state"> & {
  kind: Open<AuditSink["kind"]>;
  circuit_state: Open<AuditSink["circuit_state"]>;
};

/**
 * `AuditSinkDLQEntry` is declared by the SDK but not re-exported from its
 * package root, so it is read off the typed list method instead — which binds
 * it even more tightly to the call it describes.
 */
export type MobileAuditSinkDlqEntry = Awaited<
  ReturnType<Sdk["auditSinks"]["dlqList"]>
>["entries"][number];

export async function listMobileAuditSinks(): Promise<
  AIApiResult<{ sinks: MobileAuditSink[] }>
> {
  return sdkResult(() => getClient().client.auditSinks.list());
}

export async function listMobileAuditSinkDlq(): Promise<
  AIApiResult<{ entries: MobileAuditSinkDlqEntry[]; count: number }>
> {
  return sdkResult(() => getClient().client.auditSinks.dlqList());
}

/**
 * Close an open circuit breaker so the sink starts delivering again. The
 * breaker trips automatically after consecutive failures; once the upstream
 * is fixed, nothing re-closes it but this call — until then every audit
 * event is silently accumulating in the DLQ.
 */
export async function resetMobileAuditSinkCircuit(
  id: string,
): Promise<AIApiResult<unknown>> {
  return sdkResult(() => getClient().client.auditSinks.circuitReset(id));
}

/**
 * Re-deliver one dead-lettered batch of audit events. DLQ ids are `bigint`
 * server-side and the SDK types the parameter as `number`; a caller that still
 * holds the id as a string is coerced here, and a value that is not a finite
 * integer is refused locally rather than being pasted into a URL as `NaN`.
 */
export async function replayMobileAuditSinkDlq(
  id: number | string,
): Promise<AIApiResult<unknown>> {
  const numeric = typeof id === "number" ? id : Number(String(id).trim());
  if (!Number.isSafeInteger(numeric)) {
    return {
      data: null,
      error: { status: 0, message: "Invalid dead-letter entry id." },
    };
  }
  return sdkResult(() => getClient().client.auditSinks.dlqReplay(numeric));
}

/** Send a probe event through an existing sink to prove it is reachable. */
export async function testMobileAuditSink(
  id: string,
): Promise<AIApiResult<unknown>> {
  return sdkResult(() => getClient().client.auditSinks.testExisting(id));
}
