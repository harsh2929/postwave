/**
 * api/flows.ts — transport for the FLOW BUILDER: the automation spine.
 *
 * Every route below was read off the chi mounts at
 * `apps/api/internal/flowbuilder/flowbuilder.go::MountRoutes` (:215) and
 * `apps/api/internal/flow_approvals/flow_approvals.go::MountRoutes` (:115),
 * and every role floor off the MIDDLEWARE those mounts wrap them in — not off
 * routeauth/manifest.json, whose auto-generated rows are a lead rather than
 * evidence:
 *
 *   GET  /api/v1/flow-builder/flows              read:campaigns  → {items,nextCursor?}
 *   GET  /api/v1/flow-builder/flows/{id}         read:campaigns  → a BARE Flow
 *   GET  /api/v1/flow-builder/flows/{id}/versions read:campaigns → {items,nextCursor?}
 *   GET  /api/v1/flow-builder/catalog            read:campaigns  → a bare CatalogResponse
 *   GET  /api/v1/flow-builder/approvals          read:campaigns  → {items}
 *   POST /api/v1/flow-builder/validate           write:campaigns → GraphValidateResponse
 *   POST /api/v1/flow-builder/approvals/{id}/approve  write:campaigns → a bare Approval
 *   POST /api/v1/flow-builder/approvals/{id}/reject   write:campaigns → a bare Approval
 *
 * VALIDATE IS A WRITE SCOPE EVEN THOUGH IT WRITES NOTHING. It is mounted
 * `r.With(write)` (flowbuilder.go:222) and routeauth/manifest.json independently
 * floors it at session role `editor` — the manifest and the mount agree here,
 * and the STRICTER of the two binds regardless. So the affordance is gated on
 * `editor` client-side rather than discovered through a 403.
 *
 * THE GATE IS A SCOPE, NOT A ROLE, AND THE TWO BEHAVE DIFFERENTLY.
 * All six are wrapped in `apikeys.RequireScope`, never `requireAdmin`. On the
 * session-cookie path (apikeys/middleware.go:183) that middleware resolves to a
 * role floor by looking the scope up in two tables: `read:campaigns` is in
 * `readOnlyScopes` (:332), so `requireAdminRoleForScopes` returns false and ANY
 * authenticated dashboard user may read — viewer included. `write:campaigns` is
 * not read-only, but it IS in `editorWriteScopes` (:291), so
 * `sessionRoleAllowsScopes` admits owner, admin and editor. Reading is viewer;
 * deciding is editor. The screen gates on that rather than discovering it
 * through a 403 after a confirm sheet.
 *
 * DELIBERATELY NOT HERE, each for a reason rather than for time:
 *   - POST /flows and PATCH /flows/{id}: authoring a graph is a canvas job.
 *     Note the update verb is PATCH, not PUT — a client written against the
 *     PUT that some docs imply would 405 on every save.
 *   - POST /flows/{id}/activate: the handler (flowbuilder.go:468) does nothing
 *     but `WriteUnavailable` — it is a 503 by construction, so a button for it
 *     could only ever fail. This is the same reason no status control appears
 *     anywhere on the screen.
 *   - POST /flows/{id}/versions and .../promote: publishing from a phone, with
 *     no diff view, is not a thing anyone should do.
 *   - GET /flow-builder/ab-tests: a separate subsystem with its own results
 *     surface; app/(tabs)/campaigns already owns A/B reporting on this device.
 *   - GET /flows/{id}/runs: the per-subscriber run inspector. The runtime is
 *     contained, so it is empty by construction for every tenant today; a tab
 *     that can only ever say "no runs" teaches people to stop looking.
 *
 * Parsing lives in lib/flowWire + lib/flowApprovals so it is unit-testable in
 * the node vitest environment; this module is only URLs and envelopes.
 */
import {
  parseFlow,
  parseFlowPage,
  parseFlowVersionList,
  type FlowPage,
  type MobileFlow,
  type MobileFlowVersion,
} from "@/lib/flowWire";
import {
  parseFlowApproval,
  parseFlowApprovalList,
  type FlowApprovalDecision,
  type MobileFlowApproval,
} from "@/lib/flowApprovals";
import {
  parseFlowCatalog,
  type MobileFlowCatalog,
} from "@/lib/flowCatalog";
import {
  parseFlowValidation,
  type FlowValidateBody,
  type MobileFlowValidation,
} from "@/lib/flowValidation";

import { checkedApiResult, rawRequest } from "./request";

export const FLOWS_PATH = "/api/v1/flow-builder/flows";
export const FLOW_APPROVALS_PATH = "/api/v1/flow-builder/approvals";
export const FLOW_CATALOG_PATH = "/api/v1/flow-builder/catalog";
export const FLOW_VALIDATE_PATH = "/api/v1/flow-builder/validate";

/**
 * `ListFlows` reads `limit` via `pagination.ReadParamsWithDefault(query, 200,
 * pagination.MaxLimit)`. 50 is plenty for a phone list and keeps the payload
 * small — each row carries the ENTIRE graph (repo.go:541 LEFT JOINs the latest
 * version and `scanFlow` prefers its graph), so these rows are far heavier
 * than a typical list row.
 */
export const FLOW_PAGE_SIZE = 50;

export function flowPath(id: string): string {
  return `${FLOWS_PATH}/${encodeURIComponent(id)}`;
}

export function flowVersionsPath(id: string): string {
  return `${flowPath(id)}/versions`;
}

export function flowApprovalDecisionPath(
  id: string,
  decision: FlowApprovalDecision,
): string {
  return `${FLOW_APPROVALS_PATH}/${encodeURIComponent(id)}/${decision}`;
}

/**
 * One page of flows. `status` maps onto the handler's `?status=` filter, which
 * runs through `normalizeFlowStatus` server-side — so "active" and the legacy
 * "live" select the same rows. An empty string means "every status".
 */
export async function fetchFlows(options?: {
  status?: string;
  cursor?: string | null;
}): Promise<FlowPage> {
  const params = new URLSearchParams({ limit: String(FLOW_PAGE_SIZE) });
  const status = options?.status?.trim();
  if (status) params.set("status", status);
  const cursor = options?.cursor?.trim();
  if (cursor) params.set("cursor", cursor);
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", `${FLOWS_PATH}?${params.toString()}`),
  );
  return parseFlowPage(res.data);
}

/**
 * One flow. Returns a BARE Flow object rather than an envelope — `GetFlow`
 * (flowbuilder.go:313) writes the struct directly, unlike its own list route.
 * A missing flow answers 404 via `writeFlowRepoError`, which `checkedApiResult`
 * turns into a thrown tagged Error, so this never resolves to a hollow row.
 */
export async function fetchFlow(id: string): Promise<MobileFlow | null> {
  const res = await checkedApiResult(rawRequest<unknown>("GET", flowPath(id)));
  return parseFlow(res.data);
}

/** Version history, newest first, `pagination.Envelope[FlowVersion]`. */
export async function fetchFlowVersions(
  id: string,
): Promise<readonly MobileFlowVersion[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", flowVersionsPath(id)),
  );
  return parseFlowVersionList(res.data);
}

/**
 * The server's node/trigger catalogue. A BARE `CatalogResponse`, not an
 * envelope — `Catalog` (flowbuilder.go:238) writes the struct directly.
 *
 * Returns null rather than throwing when the body is not a catalogue, because
 * the caller's fallback (lib/flowCatalog's static mirror) is a perfectly good
 * outcome and an error state for it would put a red banner over a screen that
 * is rendering correctly.
 */
export async function fetchFlowCatalog(): Promise<MobileFlowCatalog | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", FLOW_CATALOG_PATH),
  );
  return parseFlowCatalog(res.data);
}

/**
 * Run a stored graph through the server's structural validator.
 *
 * TWO STATUSES ARE BOTH THE ANSWER. 200 means no structural errors; 422 means
 * there ARE some — and the 422 body is the same full `GraphValidateResponse`,
 * carrying the very list the caller asked for (`ValidateGraph`,
 * flowbuilder.go). Treating 422 as a failure would report "couldn't check this
 * flow" in exactly the case where the check succeeded and found something. The
 * body reaches us through `AIApiError.payload`, which is why that field exists.
 *
 * Anything else — 400 from an older API, 403 without editor, a 5xx — is a real
 * failure and is thrown for `flowValidationErrorMessage` to put into words.
 */
export async function validateFlowGraph(
  body: FlowValidateBody,
): Promise<MobileFlowValidation> {
  const res = await rawRequest<unknown>("POST", FLOW_VALIDATE_PATH, body);
  if (res.error) {
    const reported =
      res.error.status === 422 ? parseFlowValidation(res.error.payload) : null;
    if (reported) return reported;
    const error = new Error(res.error.message) as Error & {
      status?: number;
      code?: string;
    };
    error.status = res.error.status;
    if (res.error.code) error.code = res.error.code;
    throw error;
  }
  const parsed = parseFlowValidation(res.data);
  if (!parsed) {
    // A 200 whose body is not a verdict is not "the flow is fine".
    throw new Error("The validator answered with something this app can't read.");
  }
  return parsed;
}

/**
 * The manual-review queue. `status` goes straight into
 * `WHERE ($2 = '' OR transactional_status = $2)`, and the SELECT has NO LIMIT
 * (flow_approvals.go:52) — so the screen always asks for a status rather than
 * pulling a tenant's entire decision history onto a phone.
 */
export async function fetchFlowApprovals(
  status: string,
): Promise<MobileFlowApproval[]> {
  const params = new URLSearchParams();
  const trimmed = status.trim();
  if (trimmed) params.set("status", trimmed);
  const query = params.toString();
  const res = await checkedApiResult(
    rawRequest<unknown>(
      "GET",
      query ? `${FLOW_APPROVALS_PATH}?${query}` : FLOW_APPROVALS_PATH,
    ),
  );
  return parseFlowApprovalList(res.data);
}

/**
 * Approve or reject one parked review. Answers the UPDATED row (a bare
 * Approval, not an envelope), or 409 `not_pending` when it was already decided
 * — which `lib/flowApprovals.decisionErrorMessage` turns into copy that tells
 * the operator to refresh rather than to retry forever.
 */
export async function decideFlowApproval(
  id: string,
  decision: FlowApprovalDecision,
): Promise<MobileFlowApproval | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("POST", flowApprovalDecisionPath(id, decision)),
  );
  return parseFlowApproval(res.data);
}
