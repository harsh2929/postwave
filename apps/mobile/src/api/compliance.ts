/**
 * api/compliance.ts — the compliance posture monitor's two reads.
 *
 * AUTHORIZATION, READ OFF THE MOUNT SITE AND OFF THE MIDDLEWARE, NOT OFF THE
 * MANIFEST. `compliance.Deps.MountRoutes`
 * (apps/api/internal/compliance/compliance.go:111-117) registers the five
 * routes with NO guard of its own — its own comment says "the caller is
 * expected to wrap them with the admin scope". The caller is
 * `MountPrivacyComplianceRoutes` (apps/api/internal/server/tenant_governance.go
 * :125-128), which wraps the whole group in
 * `apikeys.RequireScope(apikeys.ScopeAdmin)` (:98).
 *
 * That is a SCOPE gate that degenerates into a ROLE gate on the session path.
 * `RequireScope` (apps/api/internal/apikeys/middleware.go:183-225): an API key
 * needs the literal `admin` scope; a session-cookie request is checked with
 * `requireAdminRoleForScopes` (:342-349), which returns true for any scope not
 * in the `readOnlyScopes` allow-list (:332-337) — and `ScopeAdmin` is not in
 * it — so `sessionRoleAllowsScopes` (:300-318) admits only `owner` or `admin`
 * (`isAdminOrOwner`, :353-356). Everyone else gets 403 `insufficient_role`.
 *
 * The generated `routeauth` manifest agrees for once: all five
 * `/api/v1/compliance/programs*` rows carry `"session_minimum_role": "admin"`,
 * `"policy_source": "family:admin"`, `"review_status": "reviewed"`. Both layers
 * say admin, so the screen gates on `admin` BEFORE issuing a request.
 *
 * THE TWO WRITES ARE DELIBERATELY ABSENT FROM THIS FILE. See the header of
 * `components/compliance/CompliancePostureScreen.tsx` for the reasoning; the
 * short version is that `POST /{framework}/attest` requires a signer identity
 * and a document hash the phone cannot produce, and `POST /{framework}/revoke`
 * is the same legal weight in the other direction with none of the urgency
 * that would justify it. A monitor that cannot mis-sign is the point.
 *
 * THE PER-FRAMEWORK READ IS ALSO ABSENT, AND THAT IS AN OPTIMISATION, NOT A
 * GAP. `GetProgram` (compliance.go:201-209) selects the identical column list
 * as `ListPrograms` (:138-142) and marshals the identical `Program` struct, so
 * fetching it for the selected row would spend a cellular round trip on bytes
 * already in hand.
 */
import {
  normalizeComplianceEvents,
  normalizeCompliancePrograms,
  type ComplianceEvent,
  type ComplianceProgram,
} from "@/lib/compliancePrograms";

import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

/** Keeps the HTTP status so the UI can tell a 403 from a 404 from a 500. */
export class ComplianceRequestError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "ComplianceRequestError";
  }
}

async function complianceRequest<T>(
  path: string,
  label: string,
): Promise<T | null> {
  const res = await rawRequest<T>("GET", path, undefined);
  if (res.error) throw new ComplianceRequestError(res.error, label);
  return res.data;
}

/**
 * True for "your role cannot see this".
 *
 * `RequireScope` writes `insufficient_role` on the session path and
 * `insufficient_scope` on the API-key path (middleware.go:191, :202, :217);
 * `routeauth` writes its own. All of them arrive as a 403 and all of them are
 * the same fact to a reader, so branching on the status alone is enough and
 * does not depend on which guard fired first.
 */
export function isComplianceRoleDenied(error: unknown): boolean {
  return error instanceof ComplianceRequestError
    ? error.status === 403
    : typeof error === "object" &&
        error !== null &&
        (error as { status?: unknown }).status === 403;
}

/**
 * Every framework the server tracks, one row each.
 *
 * `ListPrograms` (compliance.go:159-170) guarantees one entry per catalogue
 * slug even when nothing is stored, so an empty array here means the response
 * was empty — which the server never does — rather than "nothing attested".
 * The screen treats an empty array as an anomaly, not as a clean bill.
 */
export async function listCompliancePrograms(): Promise<ComplianceProgram[]> {
  const raw = await complianceRequest<unknown>(
    "/api/v1/compliance/programs",
    "Loading compliance programs",
  );
  return normalizeCompliancePrograms(raw);
}

/**
 * One framework's attestation history, newest first, capped at 500 rows by the
 * server (compliance.go:467).
 *
 * NEVER CALLED FOR HIPAA. `ListEvents` short-circuits it to a fixed empty
 * response (compliance.go:447-455), so the request can only ever confirm what
 * the catalogue already states — and an empty ledger rendered under a
 * framework nobody can attest to reads as "nothing has happened yet", which is
 * the wrong sentence. The hook refuses the call; this function still guards it
 * so the rule holds wherever it is called from.
 */
export async function listComplianceEvents(
  framework: string,
): Promise<ComplianceEvent[]> {
  const slug = (framework ?? "").trim();
  if (!slug) throw new Error("A framework slug is required to read its ledger.");
  if (slug === "hipaa") {
    throw new Error("HIPAA has no attestation ledger to read.");
  }
  const raw = await complianceRequest<unknown>(
    `/api/v1/compliance/programs/${encodeURIComponent(slug)}/events`,
    "Loading the attestation ledger",
  );
  return normalizeComplianceEvents(raw, slug);
}
