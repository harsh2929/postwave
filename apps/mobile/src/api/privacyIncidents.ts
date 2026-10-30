/**
 * api/privacyIncidents.ts — the breach-response register.
 *
 * AUTHORIZATION, READ FROM THE ROUTER RATHER THAN FROM A HANDLER OR A DOC.
 * `privacy.MountIncidentRoutes` registers the incident routes bare
 * (incidents.go:1027-1039) — there is no `requireAdmin` anywhere in that file.
 * The gate is on the CALLER: `MountPrivacyComplianceRoutes` wraps the whole
 * group in `router.Use(admin)` where `admin = apikeys.RequireScope(
 * apikeys.ScopeAdmin)` (server/tenant_governance.go:110-116). `ScopeAdmin` is
 * not in `readOnlyScopes` (apikeys/middleware.go:332-337), so on the session
 * path `requireAdminRoleForScopes` triggers and `isAdminOrOwner` admits only
 * owner|admin. The generated manifest derives all ten reviewed rows from the
 * canonical OpenAPI `x-required-scopes: [admin]` declaration.
 *
 * THE FIVE ROUTES THIS FILE USES, AND THE THREE IT REFUSES TO:
 *
 *   GET  /api/v1/privacy/incidents                       list
 *   GET  /api/v1/privacy/incidents/{id}                  detail + rule hold
 *   GET  /api/v1/privacy/incidents/{id}/events           merged ledger
 *   POST /api/v1/privacy/incidents            — declare a preliminary record.
 *     Requires an Idempotency-Key (incidents.go:277), which is what makes a
 *     retry after an ambiguous failure safe instead of a second breach record.
 *     The phone form is deliberately MINIMAL (severity + summary): the server
 *     accepts a bare record and the scope fields can be completed at a desk,
 *     while the record — and its operational clock — exist from the moment
 *     someone learned of the breach.
 *   POST /{id}/transition                     — non-closure state moves, with
 *     the operator-supplied reason and `expected_from` conflict handling the
 *     endpoint requires. `to: "closed"` is refused server-wide with a 503
 *     release hold (incidents.go:567) and is never sent from here.
 *   POST /{id}/signoff                        — release-held until approval is
 *     bound to a distinct authenticated principal and durable receipt.
 *   POST /{id}/notifications                  — release-held until delivery is
 *     bound to durable provider or regulator evidence.
 *   GET  /{id}/packet/{audience}              — release-held; no packet bytes
 *     are generated or returned.
 *
 * BOTH WRITES ARE ONLINE-ONLY. Neither enters the offline outbox: a breach
 * declaration or state move replayed later, out of context, would manufacture
 * audit evidence. They fail loudly at the moment of the attempt instead.
 */
import {
  normalizeIncident,
  normalizeIncidentEvents,
  normalizePrivacyIncidentDetail,
  normalizePrivacyIncidentPage,
  type IncidentEvent,
  type IncidentSeverity,
  type IncidentState,
  type PrivacyIncident,
  type PrivacyIncidentDetail,
  type PrivacyIncidentPage,
} from "@/lib/privacyIncidents";

import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

const BASE = "/api/v1/privacy/incidents";

/**
 * How many incidents one phone screen reads.
 *
 * `ReadParamsWithDefault(q, 200, MaxLimit)` (incidents.go:308) would hand back
 * TWO HUNDRED rows unasked — the pre-pagination cap, preserved for desktop.
 * Fifty is a deliberate reduction: this is the on-call glance, the rows are
 * ordered by `detected_at DESC` so the newest breaches are the ones returned,
 * and asking for a bounded page is what makes `nextCursor` mean "there is more
 * history than this screen is showing" instead of nothing at all.
 */
export const PRIVACY_INCIDENT_PAGE_SIZE = 50;

/** Keeps the HTTP status and code so the UI can tell a 403 from a 409. */
export class PrivacyIncidentError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "PrivacyIncidentError";
  }
}

async function incidentRequest<T>(
  method: string,
  path: string,
  label: string,
  body?: unknown,
  options?: { idempotencyKey?: string },
): Promise<T | null> {
  const res = await rawRequest<T>(
    method,
    path,
    body,
    options?.idempotencyKey !== undefined
      ? { idempotencyKey: options.idempotencyKey }
      : undefined,
  );
  if (res.error) throw new PrivacyIncidentError(res.error, label);
  return res.data;
}

export async function listPrivacyIncidents(
  limit: number = PRIVACY_INCIDENT_PAGE_SIZE,
): Promise<PrivacyIncidentPage> {
  const params = new URLSearchParams({ limit: String(limit) });
  const raw = await incidentRequest<unknown>(
    "GET",
    `${BASE}?${params.toString()}`,
    "Loading breach incidents",
  );
  return normalizePrivacyIncidentPage(raw);
}

/**
 * One incident with an explicit jurisdiction-rules release hold. The detail
 * response contains recognition metadata only, never legal obligations.
 */
export async function fetchPrivacyIncident(
  incidentId: string,
): Promise<PrivacyIncidentDetail> {
  const id = (incidentId ?? "").trim();
  if (!id) throw new Error("An incident id is required.");
  const raw = await incidentRequest<unknown>(
    "GET",
    `${BASE}/${encodeURIComponent(id)}`,
    "Loading the incident",
  );
  return normalizePrivacyIncidentDetail(raw, id);
}

export interface DeclareIncidentInput {
  severity: IncidentSeverity;
  summary: string;
}

/**
 * Declare (create) a preliminary breach record.
 *
 * `idempotencyKey` is REQUIRED by the server (`Idempotency-Key` header,
 * incidents.go:277). The caller owns the key's lifecycle: mint one per draft,
 * keep it across ambiguous failures so a retry cannot open a duplicate
 * record, rotate it after a definite rejection or a success — the policy in
 * lib/privacyIncidentWrite (`declareKeyAfterFailure`).
 */
export async function createPrivacyIncident(
  input: DeclareIncidentInput,
  idempotencyKey: string,
): Promise<PrivacyIncident> {
  const key = (idempotencyKey ?? "").trim();
  if (!key) throw new Error("An idempotency key is required.");
  const raw = await incidentRequest<unknown>(
    "POST",
    BASE,
    "Declaring the incident",
    { severity: input.severity, summary: input.summary },
    { idempotencyKey: key },
  );
  return normalizeIncident(raw);
}

export interface IncidentTransitionInput {
  to: IncidentState;
  reason: string;
  /** The state this client last verified — the server 409s on a mismatch. */
  expectedFrom: IncidentState;
}

export interface IncidentTransitionResult {
  incidentId: string;
  from: string;
  to: string;
  at: string;
}

/**
 * Move an incident through the state machine. Non-closure only: `to:"closed"`
 * is refused locally because the server answers it with a blanket 503 release
 * hold (incidents.go:567) — never wire a 503.
 */
export async function transitionPrivacyIncident(
  incidentId: string,
  input: IncidentTransitionInput,
): Promise<IncidentTransitionResult> {
  const id = (incidentId ?? "").trim();
  if (!id) throw new Error("An incident id is required.");
  if (input.to === "closed") {
    throw new Error(
      "Incident closure is release-held on the server; this client does not request it.",
    );
  }
  const raw = await incidentRequest<{
    incident_id?: unknown;
    from?: unknown;
    to?: unknown;
    at?: unknown;
  }>(
    "POST",
    `${BASE}/${encodeURIComponent(id)}/transition`,
    "Recording the state change",
    { to: input.to, reason: input.reason, expected_from: input.expectedFrom },
  );
  return {
    incidentId: typeof raw?.incident_id === "string" ? raw.incident_id : id,
    from: typeof raw?.from === "string" ? raw.from : "",
    to: typeof raw?.to === "string" ? raw.to : input.to,
    at: typeof raw?.at === "string" ? raw.at : "",
  };
}

/** The merged transition + notification ledger for one incident. */
export async function listPrivacyIncidentEvents(
  incidentId: string,
): Promise<IncidentEvent[]> {
  const id = (incidentId ?? "").trim();
  if (!id) throw new Error("An incident id is required.");
  const raw = await incidentRequest<unknown>(
    "GET",
    `${BASE}/${encodeURIComponent(id)}/events`,
    "Loading the incident ledger",
  );
  return normalizeIncidentEvents(raw, id);
}
