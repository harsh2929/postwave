import type { ApiErr, ApiResult } from "./result";
import { parseStepUpChallenge, requestStepUpProof } from "../step-up";
import {
  parseSubscriberImportCancelResponse,
  parseSubscriberImportConfirmResponse,
  parseSubscriberImportPatchResponse,
  parseSubscriberImportPreview,
  parseSubscriberImportRemapOptions,
  parseSubscriberImportResource,
  subscriberImportContractError,
  type SubscriberImportCancelResponse,
  type SubscriberImportMappingContract,
  type SubscriberImportPatchResponse,
  type SubscriberImportPreview,
  type SubscriberImportRemapOptions,
  type SubscriberImportStrategy,
} from "./subscriber-import-contract";
export type * from "./subscriber-import-contract";
import {
  responseContractFailure,
  responseIdentityMatches,
  responseIdentityMismatch,
} from "./subscriber-response-integrity";
import {
  isExactSubscriberVersion,
  type DSARRequestInput,
  type DSARRequestResult,
  type DSARStoreResponse,
  type JurisdictionReconfirmInput,
  type SubscriberDetail,
} from "./subscriber-profiles";
import {
  isSubscriberEngagementResult,
  type SubscriberEngagementResult,
} from "./subscriber-engagement-contract";
export type * from "./subscriber-engagement-contract";

export interface SubscriberDataOperationsRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

export type SubscriberDataOperationsRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: SubscriberDataOperationsRequestOptions,
) => Promise<ApiResult<T>>;

export interface SubscriberDataDownloadController {
  signal: AbortSignal;
  dispose: () => void;
}

export interface SubscriberDataExportApi {
  downloadSubscriberDataExport: (
    id: string | number,
    opts?: { signal?: AbortSignal },
  ) => Promise<ApiResult<{ blob: Blob; filename: string }>>;
}

export interface SubscriberDataOperationsDependencies {
  request: SubscriberDataOperationsRequester;
  createDownloadController: (
    callerSignal?: AbortSignal | null,
  ) => SubscriberDataDownloadController;
  normalizeApiKey: (key: string | null | undefined) => string | null;
  getApiKey: () => string | null;
  nativeAwareFetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  apiUrl: (path: string) => string;
  errorFromResponse: (response: Response) => Promise<ApiErr["error"]>;
  transportError: (error: unknown) => ApiErr["error"];
  buildStreamUrl: (path: string) => Promise<string>;
  nativeClientHeaders: Readonly<Record<string, string>>;
}

/* ---------- Subscribers: engagement / dedupe / merge / import ----- */

export interface SubscriberDuplicatePair {
  kind: "case_diff" | "plus_alias" | "dot_alias" | string;
  primary_id: string;
  primary_email: string;
  duplicate_id: string;
  duplicate_email: string;
  confidence: number;
  primary_updated_at: string;
  duplicate_updated_at: string;
  evidence: SubscriberDuplicateEvidence[];
  stale: boolean;
}

export interface SubscriberDuplicatesResponse {
  pairs: SubscriberDuplicatePair[];
  count: number;
  scan: SubscriberDuplicateScan;
  next_cursor?: string;
  complete: boolean;
}

export interface SubscriberDuplicateEvidence {
  kind: string;
  confidence: number;
  reason: string;
}

export interface SubscriberDuplicateScan {
  scan_id: string;
  status: "running" | "complete" | "failed" | string;
  subscriber_count: number;
  candidate_count: number;
  created_at: string;
  completed_at?: string;
  expires_at: string;
  complete: boolean;
}

/**
 * SUB-023 — one cross-tenant master-identity link. Mirrors
 * `subscribers.FederationLink` JSON tags
 * (apps/api/internal/subscribers/federation.go). Links a child-workspace
 * subscriber (`child_subscriber_id`) to a master subscriber
 * (`master_subscriber_id`) in the agency parent workspace
 * (`parent_tenant_id`). `match_type` is the provenance of the link
 * (email / external_id / manual).
 */
export interface SubscriberFederationLink {
  id: string;
  child_subscriber_id: string;
  parent_tenant_id: string;
  master_subscriber_id: string;
  match_type: "email" | "external_id" | "manual" | string;
  match_key?: string;
  created_at: string;
  updated_at: string;
  subscriber_version?: string;
}

/** GET /api/v1/subscribers/{id}/federated-links response. */
export interface SubscriberFederationLinksResponse {
  items: SubscriberFederationLink[];
  subscriber_version: string;
}

/** Mirrors `subscribers.CreateFederationLinkInput` — POST body.
 * `parent_tenant_id` + `master_subscriber_id` are required; `match_type`
 * defaults server-side to "manual" when omitted. */
export interface SubscriberFederationLinkInput {
  parent_tenant_id: string;
  master_subscriber_id: string;
  match_type?: "email" | "external_id" | "manual";
  match_key?: string;
}

export interface SubscriberMergeResult {
  primary_id: string;
  duplicate_id: string;
  events_moved: number;
  suppressions_moved: number;
  tags_merged: number;
  custom_fields_merged: number;
  primary_version: string;
}

export interface SubscriberBulkMergeItem {
  primary_id: string;
  duplicate_id: string;
  status: "merged" | "failed";
  error?: string;
  result?: SubscriberMergeResult;
}

export interface SubscriberBulkMergeResult {
  merged: number;
  failed: number;
  items: SubscriberBulkMergeItem[];
}

/** Mirrors `subscribers.IdentifyResult` JSON tags
 * (apps/api/internal/subscribers/identify.go). action is one of
 * "created" | "updated" | "merged". */
export interface SubscriberIdentifyResult {
  subscriber: SubscriberDetail;
  action: "created" | "updated" | "merged";
}

/**
 * Mirrors `subscribers.BulkResult` JSON tags
 * (apps/api/internal/subscribers/bulk_operations.go).
 *
 * affected_ids is populated by reversible ops (tag/untag/unsubscribe)
 * so the client can compose a precise undo without re-querying.
 * recovery_token is set only on bulk-delete responses and is
 * redeemable via /api/v1/subscribers/bulk/recover within
 * recovery_until (24h after the original delete).
 */
export interface SubscriberBulkResult {
  affected: number;
  skipped?: number;
  source: "explicit_ids" | "segment" | "recovery";
  affected_ids?: string[];
  recovery_token?: string;
  recovery_until?: string;
  recovery_expired?: boolean;
  /** Server-side eligibility exclusions keyed by stable reason. */
  exclusions?: Record<string, number>;
}

export interface BulkConsentProvenanceInput {
  source: string;
  channel: string;
  legal_basis: string;
  occurred_at: string;
  jurisdiction: string;
  evidence: string;
  reason: string;
  policy_version: string;
}

/** SUB-109 — a saved, reusable CSV-import column-mapping template. The
 *  `mapping` object is byte-identical in shape to the import preview's
 *  mapping (it carries the `columns` array), so it can be dropped onto a
 *  fresh preview to override the auto-detected mapping. */
export interface SubscriberImportTemplate {
  id: string;
  name: string;
  mapping: unknown;
  source_hint: string;
  created_at: string;
  updated_at: string;
}

/**
 * GET /api/v1/subscribers/{id}/data-export.zip — SUB-045 per-subscriber
 * DSAR (GDPR Art. 15 / CCPA §1798.100). Admin-scope.
 *
 * Returns a ZIP Blob + the server-suggested filename pulled from
 * Content-Disposition. Caller triggers the actual save (anchor click
 * via createObjectURL) so the UI can also surface a busy/progress
 * state during the synchronous bundle build.
 */
export function createDownloadSubscriberDataExport({
  createDownloadController,
  normalizeApiKey,
  getApiKey,
  nativeAwareFetch,
  apiUrl,
  errorFromResponse,
  transportError,
}: SubscriberDataOperationsDependencies) {
  return async function downloadSubscriberDataExport(
    id: string | number,
    opts?: { signal?: AbortSignal },
  ): Promise<ApiResult<{ blob: Blob; filename: string }>> {
    const dl = createDownloadController(opts?.signal);
    try {
      const headers: Record<string, string> = {
        Accept: "application/zip",
      };
      const key = normalizeApiKey(getApiKey());
      if (key) headers.Authorization = `Bearer ${key}`;
      const res = await nativeAwareFetch(
        apiUrl(
          `/api/v1/subscribers/${encodeURIComponent(String(id))}/data-export.zip`,
        ),
        {
          method: "GET",
          headers,
          mode: "cors",
          credentials: "include",
          cache: "no-store",
          signal: dl.signal,
        },
      );
      if (!res.ok) {
        return { error: await errorFromResponse(res) };
      }
      const cd = res.headers.get("Content-Disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(cd);
      const filename =
        m?.[1] ??
        `subscriber-${id}-data-export-${new Date()
          .toISOString()
          .slice(0, 10)}.zip`;
      const blob = await res.blob();
      return { data: { blob, filename } };
    } catch (err) {
      return { error: transportError(err) };
    } finally {
      dl.dispose();
    }
  };
}

/**
 * Compatibility transport for the release-held portable-receipt route.
 * The server currently returns a stable 503 until completeness and evidence
 * qualification are approved. Product surfaces must not expose this method as
 * an export action or make standards/full-history claims from it.
 */
export function createDownloadSubscriberConsentReceipt({
  createDownloadController,
  normalizeApiKey,
  getApiKey,
  nativeAwareFetch,
  apiUrl,
  errorFromResponse,
  transportError,
}: SubscriberDataOperationsDependencies) {
  return async function downloadSubscriberConsentReceipt(
    id: string | number,
    opts?: { signal?: AbortSignal },
  ): Promise<
    ApiResult<{ blob: Blob; filename: string; consentReceiptId: string }>
  > {
    const dl = createDownloadController(opts?.signal);
    try {
      const headers: Record<string, string> = {
        Accept: "application/zip",
      };
      const key = normalizeApiKey(getApiKey());
      if (key) headers.Authorization = `Bearer ${key}`;
      const res = await nativeAwareFetch(
        apiUrl(
          `/api/v1/subscribers/${encodeURIComponent(String(id))}/consent-receipt.zip`,
        ),
        {
          method: "GET",
          headers,
          mode: "cors",
          credentials: "include",
          cache: "no-store",
          signal: dl.signal,
        },
      );
      if (!res.ok) {
        return { error: await errorFromResponse(res) };
      }
      const cd = res.headers.get("Content-Disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(cd);
      const filename =
        m?.[1] ??
        `subscriber-${id}-consent-receipt-${new Date()
          .toISOString()
          .slice(0, 10)}.zip`;
      const consentReceiptId =
        res.headers.get("X-Postwave-Consent-Receipt-ID") ?? "";
      const blob = await res.blob();
      return { data: { blob, filename, consentReceiptId } };
    } catch (err) {
      return { error: transportError(err) };
    } finally {
      dl.dispose();
    }
  };
}

/**
 * POST /api/v1/sar/requests — explicit subject access or Moosewave erasure.
 *
 * `kind` and `fanout_enabled` are required so access and erasure can never be
 * confused by a default. Connected-store fan-out is read-only and supported
 * only for access requests. Erasure is currently limited to Moosewave-managed
 * data and must send `fanout_enabled=false`.
 * Admin-scope. `requireOnline` so the call is never silently queued.
 */
export function createCreateSarRequest({
  request,
}: SubscriberDataOperationsDependencies) {
  return function createSarRequest(
    body: DSARRequestInput,
  ): Promise<ApiResult<DSARRequestResult>> {
    return request<DSARRequestResult>(
      "/api/v1/sar/requests",
      { method: "POST", body: JSON.stringify(body) },
      { requireOnline: true },
    );
  };
}

/**
 * GET /api/v1/sar/requests/{id}/store-responses — SUB-053 admin view of
 * the persisted per-store DSAR fan-out outcomes for a SAR request. Used
 * by the DSAR progress modal to (re)load the latest receipts after the
 * synchronous Create returns. Admin-scope; 404 when the SAR id is unknown.
 */
export function createListDsarStoreResponses({
  request,
}: SubscriberDataOperationsDependencies) {
  return function listDsarStoreResponses(requestId: string | number): Promise<
    ApiResult<{
      request_id: string;
      count: number;
      store_responses: DSARStoreResponse[];
    }>
  > {
    return request(
      `/api/v1/sar/requests/${encodeURIComponent(String(requestId))}/store-responses`,
    );
  };
}

/**
 * GET /api/v1/subscribers/{id}/data-export.zip — SUB-053 thin wrapper used
 * by the Privacy tab "Export this subscriber's data" button. Aliases
 * `downloadSubscriberDataExport` so the DSAR surface reads against a
 * DSAR-named method while reusing the verified blob/Content-Disposition
 * download path.
 */
export function createGetDsarExport(api: SubscriberDataExportApi) {
  return function getDsarExport(
    id: string | number,
    opts?: { signal?: AbortSignal },
  ): Promise<ApiResult<{ blob: Blob; filename: string }>> {
    return api.downloadSubscriberDataExport(id, opts);
  };
}

/**
 * PATCH /api/v1/subscribers/{id}/jurisdiction-reconfirm — SUB-055 records
 * the subject's fresh consent decision (granted on "accepted", denied on
 * "declined") as a consent receipt, clears jurisdiction_reconfirm_required,
 * and returns the updated subscriber. The complete evidence envelope and
 * one-time jurisdiction timestamp are required. `requireOnline` prevents a
 * compliance decision from being queued or replayed against later state.
 */
export function createReconfirmSubscriberJurisdiction({
  request,
}: SubscriberDataOperationsDependencies) {
  return async function reconfirmSubscriberJurisdiction(
    id: string | number,
    body: JurisdictionReconfirmInput,
  ): Promise<ApiResult<SubscriberDetail>> {
    if (!isExactSubscriberVersion(body?.expected_subscriber_version)) {
      return {
        error: {
          kind: "http",
          status: 428,
          code: "precondition_required",
          message:
            "Reload this subscriber before recording evidence so the exact reviewed profile revision can be verified.",
        },
        retryability: "not-retryable",
      };
    }
    const response = await request<SubscriberDetail>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/jurisdiction-reconfirm`,
      { method: "PATCH", body: JSON.stringify(body) },
      { maxAttempts: 1, requireOnline: true },
    );
    if (response.error) return response;
    if (
      response.data.id === undefined ||
      !responseIdentityMatches(id, response.data.id)
    ) {
      return responseIdentityMismatch("subscriber");
    }
    if (
      !isExactSubscriberVersion(response.data.version) ||
      !isExactSubscriberVersion(response.serverVersion) ||
      response.data.version !== response.serverVersion ||
      response.data.version === body.expected_subscriber_version ||
      response.data.jurisdiction_reconfirm_required !== false
    ) {
      return responseContractFailure(
        "The server did not return the completed jurisdiction review with one matching fresh subscriber revision. The previous verified profile was kept; refresh before trying again.",
      );
    }
    return response;
  };
}

/**
 * GET /api/v1/subscribers/export.csv — SUB-106-107-108 streaming
 * tabular export. Returns the raw CSV blob, truncation flag, and trusted
 * exported-row receipt lifted from response headers so the UI can distinguish
 * complete, partial, and malformed responses.
 *
 * Unlike the legacy client-side rowsToCsv path, this hits the server
 * so the export reflects all rows in the frozen applied
 * status/query/archive/sort scope — never a page-only fallback.
 */
/** Cap on the error body read while looking for a step-up challenge. */
const MAX_STEP_UP_BODY_BYTES = 64 * 1024;

/**
 * Read a step-up challenge off a response without consuming it.
 *
 * A bounded clone, so the caller can still hand the ORIGINAL to
 * `errorFromResponse` when the challenge turns out not to be one (or goes
 * unanswered). Only 401s are inspected — the server puts the marker nowhere
 * else, and cloning every failed download to look for it would buffer a body
 * for nothing.
 */
async function readStepUpChallenge(
  res: Response,
): Promise<ReturnType<typeof parseStepUpChallenge>> {
  if (res.status !== 401) return null;
  let parsed: unknown;
  try {
    const text = (await res.clone().text()).slice(0, MAX_STEP_UP_BODY_BYTES);
    parsed = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    // An unreadable or non-JSON body leaves header-only detection, which is
    // the right degradation: a challenge is still a challenge without its
    // reason, and a non-challenge 401 still parses to null.
    parsed = undefined;
  }
  return parseStepUpChallenge(res.status, res.headers, parsed);
}

export function createExportSubscribersCSV({
  createDownloadController,
  normalizeApiKey,
  getApiKey,
  nativeAwareFetch,
  apiUrl,
  errorFromResponse,
  transportError,
}: SubscriberDataOperationsDependencies) {
  return async function exportSubscribersCSV(opts?: {
    limit?: number;
    status?: string;
    q?: string;
    includeArchived?: boolean;
    sort?: string;
    order?: "asc" | "desc";
    signal?: AbortSignal;
  }): Promise<
    ApiResult<{
      blob: Blob;
      filename: string;
      truncated: boolean;
      exportedRows: number | null;
    }>
  > {
    const dl = createDownloadController(opts?.signal);
    try {
      const qs = new URLSearchParams();
      if (opts?.limit != null && opts.limit > 0) {
        qs.set("limit", String(Math.floor(opts.limit)));
      }
      if (opts?.status) qs.set("status", opts.status);
      if (opts?.q) qs.set("q", opts.q);
      if (opts?.includeArchived) qs.set("include_archived", "true");
      if (opts?.sort) qs.set("sort", opts.sort);
      if (opts?.order) qs.set("order", opts.order);
      const path = `/api/v1/subscribers/export.csv${qs.toString() ? `?${qs}` : ""}`;
      const headers: Record<string, string> = { Accept: "text/csv" };
      const key = normalizeApiKey(getApiKey());
      if (key) headers.Authorization = `Bearer ${key}`;
      const send = (): Promise<Response> =>
        nativeAwareFetch(apiUrl(path), {
          method: "GET",
          headers,
          mode: "cors",
          credentials: "include",
          cache: "no-store",
          signal: dl.signal,
        });
      // THE SECOND TRANSPORT. This export does not go through the api-client
      // `request` core at all — it calls the native-aware fetch directly so it
      // can stream a blob — and `GET /api/v1/subscribers/export.csv` is both
      // the route it serves and the highest-stakes entry in the server's
      // step-up policy (`subscribers.export`, Immediate freshness: every
      // subscriber's address leaving the building). Detection wired only into
      // the JSON core would have left exactly that action unable to answer the
      // challenge, failing the download with a bare "HTTP 401".
      let res = await send();
      if (!res.ok) {
        const challenge = await readStepUpChallenge(res);
        // A GET with no body is trivially replayable, so a single one-shot
        // guard is the only thing needed to keep a repeated challenge from
        // looping.
        if (challenge && (await requestStepUpProof(challenge))) {
          res = await send();
        }
      }
      if (!res.ok) {
        return { error: await errorFromResponse(res) };
      }
      const cd = res.headers.get("Content-Disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(cd);
      const filename =
        m?.[1] ?? `subscribers-${new Date().toISOString().slice(0, 10)}.csv`;
      const truncated = res.headers.get("X-Postwave-Truncated") === "true";
      const exportedRowsHeader = res.headers.get("X-Postwave-Exported-Rows");
      const parsedExportedRows =
        exportedRowsHeader == null ? Number.NaN : Number(exportedRowsHeader);
      const exportedRows =
        Number.isSafeInteger(parsedExportedRows) && parsedExportedRows >= 0
          ? parsedExportedRows
          : null;
      const blob = await res.blob();
      return { data: { blob, filename, truncated, exportedRows } };
    } catch (err) {
      return { error: transportError(err) };
    } finally {
      dl.dispose();
    }
  };
}

/* ---------- subscribers: bulk ops, import, dedupe, engagement ---- */
export function createSuppressSubscriber({
  request,
}: SubscriberDataOperationsDependencies) {
  return function suppressSubscriber(
    id: string | number,
    reason?: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/suppress`,
      {
        method: "POST",
        body: JSON.stringify({ reason: reason ?? "manual" }),
      },
    );
  };
}

export function createGetSubscriberEngagement({
  request,
}: SubscriberDataOperationsDependencies) {
  return async function getSubscriberEngagement(
    id: string | number,
    opts?: { signal?: AbortSignal },
  ): Promise<ApiResult<SubscriberEngagementResult>> {
    const response = await request<SubscriberEngagementResult>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/engagement`,
      undefined,
      opts,
    );
    if (!response.error && !isSubscriberEngagementResult(response.data)) {
      return responseContractFailure(
        "The contact-performance service returned an invalid response. The previous verified report was kept; retry the request.",
      );
    }
    if (
      !response.error &&
      !responseIdentityMatches(id, response.data.subscriber_id)
    ) {
      return responseIdentityMismatch("subscriber");
    }
    return response;
  };
}

export function createGetSubscriberEngagementBatch({
  request,
}: SubscriberDataOperationsDependencies) {
  return async function getSubscriberEngagementBatch(
    ids: (string | number)[],
  ): Promise<ApiResult<{ results: SubscriberEngagementResult[] }>> {
    const qs = new URLSearchParams({ ids: ids.map(String).join(",") });
    const response = await request<{ results: SubscriberEngagementResult[] }>(
      `/api/v1/subscribers/engagement?${qs.toString()}`,
    );
    if (response.error) return response;
    if (
      !Array.isArray(response.data.results) ||
      response.data.results.some((item) => !isSubscriberEngagementResult(item))
    ) {
      return responseContractFailure(
        "The engagement service returned an incomplete response. The previous verified scores were kept; retry the request.",
      );
    }
    const expected = new Set(ids.map((id) => String(id).trim().toLowerCase()));
    const returned = response.data.results.map((item) =>
      item.subscriber_id.trim().toLowerCase(),
    );
    if (
      returned.some((id) => !expected.has(id)) ||
      new Set(returned).size !== returned.length
    ) {
      return responseIdentityMismatch("subscriber import");
    }
    return response;
  };
}

export function createListSubscriberDuplicates({
  request,
}: SubscriberDataOperationsDependencies) {
  return function listSubscriberDuplicates(
    opts: {
      kind?: "case_diff" | "plus_alias" | "dot_alias";
      limit?: number;
    } = {},
  ): Promise<ApiResult<SubscriberDuplicatesResponse>> {
    const params = new URLSearchParams();
    if (opts.kind) params.set("kind", opts.kind);
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return request<SubscriberDuplicatesResponse>(
      `/api/v1/subscribers/duplicates${qs ? `?${qs}` : ""}`,
    );
  };
}

function duplicateScanContractFailure(): ApiResult<never> {
  return responseContractFailure(
    "The duplicate scanner returned an incomplete manifest. No merge controls were enabled; start a new scan.",
  );
}

function validDuplicateScan(scan: SubscriberDuplicateScan): boolean {
  const createdAt = Date.parse(scan?.created_at);
  const completedAt = Date.parse(scan?.completed_at ?? "");
  const expiresAt = Date.parse(scan?.expires_at);
  return (
    typeof scan?.scan_id === "string" &&
    scan.scan_id.trim() !== "" &&
    scan.status === "complete" &&
    scan.complete === true &&
    Number.isSafeInteger(scan.subscriber_count) &&
    scan.subscriber_count >= 0 &&
    Number.isSafeInteger(scan.candidate_count) &&
    scan.candidate_count >= 0 &&
    Number.isFinite(createdAt) &&
    Number.isFinite(completedAt) &&
    Number.isFinite(expiresAt) &&
    completedAt >= createdAt &&
    expiresAt > completedAt
  );
}

function validDuplicatePair(pair: SubscriberDuplicatePair): boolean {
  const evidence = Array.isArray(pair?.evidence) ? pair.evidence : [];
  return (
    typeof pair?.primary_id === "string" &&
    pair.primary_id.trim() !== "" &&
    typeof pair.duplicate_id === "string" &&
    pair.duplicate_id.trim() !== "" &&
    pair.primary_id !== pair.duplicate_id &&
    typeof pair.primary_email === "string" &&
    typeof pair.duplicate_email === "string" &&
    Number.isFinite(pair.confidence) &&
    pair.confidence >= 0 &&
    pair.confidence <= 1 &&
    Number.isFinite(Date.parse(pair.primary_updated_at)) &&
    Number.isFinite(Date.parse(pair.duplicate_updated_at)) &&
    typeof pair.stale === "boolean" &&
    evidence.length > 0 &&
    evidence.every(
      (evidence) =>
        typeof evidence?.kind === "string" &&
        evidence.kind.trim() !== "" &&
        typeof evidence.reason === "string" &&
        evidence.reason.trim() !== "" &&
        Number.isFinite(evidence.confidence) &&
        evidence.confidence >= 0 &&
        evidence.confidence <= 1,
    ) &&
    pair.kind === evidence[0]?.kind &&
    new Set(evidence.map((item) => item.kind)).size === evidence.length &&
    Math.abs(pair.confidence - (evidence[0]?.confidence ?? -1)) < 0.0005 &&
    evidence.every((item, index) => {
      if (index === 0) return true;
      const previous = evidence[index - 1]!;
      return (
        previous.confidence > item.confidence ||
        (previous.confidence === item.confidence && previous.kind < item.kind)
      );
    })
  );
}

function validDuplicatePageWindow(
  nextCursor: string | undefined,
  requestedCursor: string | undefined,
  returnedCount: number,
  totalCount: number,
): boolean {
  if (
    !Number.isSafeInteger(returnedCount) ||
    returnedCount < 0 ||
    !Number.isSafeInteger(totalCount) ||
    totalCount < 0 ||
    (requestedCursor !== undefined &&
      !/^(?:0|[1-9][0-9]*)$/u.test(requestedCursor))
  )
    return false;
  const previous = Number(requestedCursor ?? 0);
  if (!Number.isSafeInteger(previous) || previous > totalCount) return false;
  const expectedNext = previous + returnedCount;
  if (!Number.isSafeInteger(expectedNext) || expectedNext > totalCount)
    return false;
  if (nextCursor === undefined) return expectedNext === totalCount;
  if (!/^[1-9][0-9]*$/u.test(nextCursor)) return false;
  return Number(nextCursor) === expectedNext && expectedNext < totalCount;
}

export function createStartSubscriberDuplicateScan({
  request,
}: SubscriberDataOperationsDependencies) {
  return async function startSubscriberDuplicateScan(opts?: {
    signal?: AbortSignal;
  }): Promise<ApiResult<SubscriberDuplicateScan>> {
    const response = await request<SubscriberDuplicateScan>(
      "/api/v1/subscribers/duplicate-scans",
      { method: "POST" },
      { requireOnline: true, timeoutMs: 120_000, signal: opts?.signal },
    );
    if (response.error) return response;
    return validDuplicateScan(response.data)
      ? response
      : duplicateScanContractFailure();
  };
}

export function createListSubscriberDuplicateScanPairs({
  request,
}: SubscriberDataOperationsDependencies) {
  return async function listSubscriberDuplicateScanPairs(
    scanID: string,
    opts: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ApiResult<SubscriberDuplicatesResponse>> {
    const params = new URLSearchParams();
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.limit) params.set("limit", String(opts.limit));
    const query = params.toString();
    const response = await request<SubscriberDuplicatesResponse>(
      `/api/v1/subscribers/duplicate-scans/${encodeURIComponent(scanID)}/pairs${query ? `?${query}` : ""}`,
      undefined,
      { signal: opts.signal },
    );
    if (response.error) return response;
    if (
      !validDuplicateScan(response.data.scan) ||
      !responseIdentityMatches(scanID, response.data.scan.scan_id) ||
      response.data.complete !== true ||
      response.data.count !== response.data.scan.candidate_count ||
      !Array.isArray(response.data.pairs) ||
      response.data.pairs.length > Math.min(opts.limit ?? 50, 200) ||
      response.data.scan.candidate_count < response.data.pairs.length ||
      !validDuplicatePageWindow(
        response.data.next_cursor,
        opts.cursor,
        response.data.pairs.length,
        response.data.count,
      ) ||
      response.data.pairs.some((pair) => !validDuplicatePair(pair)) ||
      new Set(
        response.data.pairs.map(
          (pair) => `${pair.primary_id}:${pair.duplicate_id}`,
        ),
      ).size !== response.data.pairs.length
    ) {
      return duplicateScanContractFailure();
    }
    return response;
  };
}

export function createMergeSubscribers({
  request,
}: SubscriberDataOperationsDependencies) {
  return async function mergeSubscribers(input: {
    primary_id: string;
    duplicate_id: string;
    primary_version: string;
    duplicate_version: string;
  }): Promise<ApiResult<SubscriberMergeResult>> {
    const response = await request<SubscriberMergeResult>(
      "/api/v1/subscribers/merge",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      { requireOnline: true, maxAttempts: 1 },
    );
    if (
      !response.error &&
      (!responseIdentityMatches(input.primary_id, response.data.primary_id) ||
        !responseIdentityMatches(
          input.duplicate_id,
          response.data.duplicate_id,
        ) ||
        typeof response.data.primary_version !== "string" ||
        response.data.primary_version.trim() === "" ||
        response.data.primary_version !== response.serverVersion)
    ) {
      return responseIdentityMismatch("subscriber");
    }
    return response;
  };
}

export function createBulkMergeSubscribers({
  request,
}: SubscriberDataOperationsDependencies) {
  return function bulkMergeSubscribers(input: {
    pairs: {
      primary_id: string;
      duplicate_id: string;
      primary_version: string;
      duplicate_version: string;
    }[];
  }): Promise<ApiResult<SubscriberBulkMergeResult>> {
    return request<SubscriberBulkMergeResult>(
      "/api/v1/subscribers/merge/bulk",
      { method: "POST", body: JSON.stringify(input) },
      { requireOnline: true, maxAttempts: 1 },
    ).then((response) => {
      if (response.error) return response;
      const { data } = response;
      if (
        !Array.isArray(data.items) ||
        data.items.length !== input.pairs.length ||
        !Number.isSafeInteger(data.merged) ||
        !Number.isSafeInteger(data.failed) ||
        data.merged < 0 ||
        data.failed < 0 ||
        data.merged + data.failed !== data.items.length ||
        data.items.some((item, index) => {
          const requested = input.pairs[index];
          if (
            !requested ||
            !responseIdentityMatches(requested.primary_id, item.primary_id) ||
            !responseIdentityMatches(requested.duplicate_id, item.duplicate_id)
          ) {
            return true;
          }
          if (item.status === "failed") {
            return typeof item.error !== "string" || item.error.trim() === "";
          }
          return (
            item.status !== "merged" ||
            !item.result ||
            !responseIdentityMatches(
              requested.primary_id,
              item.result.primary_id,
            ) ||
            !responseIdentityMatches(
              requested.duplicate_id,
              item.result.duplicate_id,
            ) ||
            typeof item.result.primary_version !== "string" ||
            item.result.primary_version.trim() === "" ||
            item.result.primary_version.trim() === "*"
          );
        })
      ) {
        return responseContractFailure(
          "The bulk merge response did not match the requested subscriber revisions. Refresh duplicates before retrying.",
        );
      }
      return response;
    });
  };
}

/**
 * SUB-023 — GET /api/v1/subscribers/{id}/federated-links. Returns every
 * cross-tenant master-identity link for the child subscriber,
 * newest-first. Subscriber-read scoped. 404 on a deployment without the
 * federation routes — callers hide the section in that case.
 */
export function createListSubscriberFederatedLinks({
  request,
}: SubscriberDataOperationsDependencies) {
  return async function listSubscriberFederatedLinks(
    id: string | number,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<SubscriberFederationLinksResponse>> {
    const response = await request<SubscriberFederationLinksResponse>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/federated-links`,
      undefined,
      opts.signal ? { signal: opts.signal } : undefined,
    );
    if (response.error) return response;
    if (
      !Array.isArray(response.data.items) ||
      !isExactSubscriberVersion(response.data.subscriber_version) ||
      response.data.subscriber_version !== response.serverVersion ||
      response.data.items.some(
        (link) => typeof link?.id !== "string" || link.id.trim() === "",
      )
    ) {
      return responseContractFailure(
        "The federation service returned an incomplete response. The previous verified links were kept; retry the request.",
      );
    }
    if (
      response.data.items.some(
        (link) => !responseIdentityMatches(id, link.child_subscriber_id),
      ) ||
      new Set(response.data.items.map((link) => link.id)).size !==
        response.data.items.length
    ) {
      return responseIdentityMismatch("subscriber");
    }
    return response;
  };
}

/**
 * SUB-023 — POST /api/v1/subscribers/{id}/federated-links. Links the
 * child subscriber to a master subscriber in the agency parent
 * workspace. Idempotent on (child, master). write:subscribers scoped.
 */
export function createCreateSubscriberFederatedLink({
  request,
}: SubscriberDataOperationsDependencies) {
  return async function createSubscriberFederatedLink(
    id: string | number,
    input: SubscriberFederationLinkInput,
    subscriberVersion: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<SubscriberFederationLink>> {
    if (!isExactSubscriberVersion(subscriberVersion)) {
      return responseContractFailure(
        "Reload this subscriber before linking a federated identity so the latest exact profile revision can be verified.",
      );
    }
    const response = await request<SubscriberFederationLink>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/federated-links`,
      {
        method: "POST",
        headers: { "If-Match": subscriberVersion },
        body: JSON.stringify(input),
      },
      { ...opts, maxAttempts: 1, requireOnline: true },
    );
    if (
      !response.error &&
      (typeof response.data.id !== "string" ||
        response.data.id.trim() === "" ||
        !responseIdentityMatches(id, response.data.child_subscriber_id) ||
        !responseIdentityMatches(
          input.master_subscriber_id,
          response.data.master_subscriber_id,
        ) ||
        !responseIdentityMatches(
          input.parent_tenant_id,
          response.data.parent_tenant_id,
        ) ||
        !isExactSubscriberVersion(response.data.subscriber_version) ||
        response.data.subscriber_version !== response.serverVersion)
    ) {
      return responseIdentityMismatch("subscriber");
    }
    return response;
  };
}

/**
 * SUB-023 — DELETE
 * /api/v1/subscribers/{id}/federated-links/{master_subscriber_id}.
 * Removes the link to the given master subscriber. write:subscribers
 * scoped. (The path param is named parent_subscriber_id server-side; it
 * is the master subscriber id in the parent workspace.)
 */
export function createDeleteSubscriberFederatedLink({
  request,
}: SubscriberDataOperationsDependencies) {
  return function deleteSubscriberFederatedLink(
    id: string | number,
    masterSubscriberId: string,
    subscriberVersion: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<{ deleted: boolean; subscriber_version: string }>> {
    if (!isExactSubscriberVersion(subscriberVersion)) {
      return Promise.resolve(
        responseContractFailure(
          "Reload this subscriber before unlinking a federated identity so the latest exact profile revision can be verified.",
        ),
      );
    }
    return request<{ deleted: boolean; subscriber_version: string }>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/federated-links/${encodeURIComponent(masterSubscriberId)}`,
      { method: "DELETE", headers: { "If-Match": subscriberVersion } },
      { ...opts, maxAttempts: 1, requireOnline: true },
    ).then((response) => {
      if (
        !response.error &&
        (response.data.deleted !== true ||
          !isExactSubscriberVersion(response.data.subscriber_version) ||
          response.data.subscriber_version !== response.serverVersion)
      ) {
        return responseContractFailure(
          "The federation service did not confirm one fresh subscriber revision after unlinking. Refresh before retrying.",
        );
      }
      return response;
    });
  };
}

/** POST /api/v1/subscribers/identify — SUB-001 identify-by-external-id.
 * Returns {subscriber, action} where action is "created" | "updated"
 * | "merged". Used by Shopify / Stripe / CRM sync integrations. */
export function createIdentifySubscriber({
  request,
}: SubscriberDataOperationsDependencies) {
  return function identifySubscriber(input: {
    external_id?: string;
    email?: string;
    phone?: string;
    traits?: Record<string, unknown>;
    subscriber_versions?: Record<string, string>;
  }): Promise<ApiResult<SubscriberIdentifyResult>> {
    return request<SubscriberIdentifyResult>(
      "/api/v1/subscribers/identify",
      { method: "POST", body: JSON.stringify(input) },
      { requireOnline: true, maxAttempts: 1 },
    ).then((response) => {
      if (response.error) return response;
      if (
        !response.data.subscriber?.id ||
        !response.data.subscriber.version ||
        response.data.subscriber.version !== response.serverVersion ||
        !["created", "updated", "merged"].includes(response.data.action)
      ) {
        return responseContractFailure(
          "The identity service returned an incomplete or unversioned profile. Refresh subscribers before making another identity change.",
        );
      }
      return response;
    });
  };
}

export function createPreviewSubscriberImport({
  request,
}: SubscriberDataOperationsDependencies) {
  return async function previewSubscriberImport(
    file: File,
    options?: { signal?: AbortSignal; idempotencyKey?: string },
  ): Promise<ApiResult<SubscriberImportPreview>> {
    const form = new FormData();
    form.append("file", file);
    const result = await request<unknown>(
      "/api/v1/subscriber-imports/preview",
      {
        method: "POST",
        body: form,
        ...(options?.idempotencyKey
          ? { headers: { "Idempotency-Key": options.idempotencyKey } }
          : {}),
      },
      {
        requireOnline: true,
        signal: options?.signal,
        timeoutMs: 5 * 60_000,
        maxAttempts: 1,
      },
    );
    if (result.error) return result;
    const parsed = parseSubscriberImportPreview(result.data);
    return parsed ? { data: parsed } : subscriberImportContractError();
  };
}

export interface SubscriberImportPatchInput {
  configuration_revision: number;
  mapping?: SubscriberImportMappingContract;
  on_existing?: SubscriberImportStrategy;
  consent_source?: string;
  consent_source_url?: string;
  consent_captured_at?: string;
  consent_legal_basis?: "consent";
  consent_jurisdiction?: string;
  consent_reason?: string;
  consent_policy_version?: string;
  consent_evidence_reference?: string;
  consent_scope?: "email_marketing";
  consent_scope_acknowledged?: boolean;
  tags?: string[];
  auto_create_properties?: boolean;
  schedule_type?: "immediate";
  schedule_cron?: "";
  scheduled_at?: "";
  drip_hours_interval?: 0;
  drip_hours_total?: 0;
}

export function createPatchSubscriberImport({
  request,
}: SubscriberDataOperationsDependencies) {
  return async function patchSubscriberImport(
    id: string,
    patch: SubscriberImportPatchInput,
    options?: { signal?: AbortSignal },
  ): Promise<ApiResult<SubscriberImportPatchResponse>> {
    const result = await request<unknown>(
      `/api/v1/subscriber-imports/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
      {
        requireOnline: true,
        signal: options?.signal,
        timeoutMs: 60_000,
        maxAttempts: 1,
      },
    );
    if (result.error) return result;
    const parsed = parseSubscriberImportPatchResponse(result.data);
    if (!parsed) return subscriberImportContractError();
    if (!responseIdentityMatches(id, parsed.id)) {
      return responseIdentityMismatch("subscriber import");
    }
    return { data: parsed };
  };
}

/**
 * Confirm an import. With no argument this flips the row to 'queued'
 * for the worker (the historical immediate / scheduled hand-off).
 *
 * SUB-105 — passing `{ dry_run: true }` instead runs a validation-only
 * pass: every row is checked (email format, in-file dedupe, custom-field
 * types) and the per-row would-be outcomes are returned in
 * `dry_run_results` WITHOUT writing any subscribers. The row stays in
 * 'preview' so a later real confirm still works.
 */
export function createConfirmSubscriberImport({
  request,
}: SubscriberDataOperationsDependencies) {
  return async function confirmSubscriberImport(
    id: string,
    opts?: { dry_run?: boolean; signal?: AbortSignal },
  ): Promise<ApiResult<SubscriberImportPreview>> {
    const result = await request<unknown>(
      `/api/v1/subscriber-imports/${encodeURIComponent(id)}/confirm`,
      {
        method: "POST",
        body: JSON.stringify({ dry_run: opts?.dry_run ?? false }),
      },
      {
        requireOnline: true,
        signal: opts?.signal,
        timeoutMs: opts?.dry_run ? 5 * 60_000 : 2 * 60_000,
        maxAttempts: 1,
      },
    );
    if (result.error) return result;
    const parsed = parseSubscriberImportConfirmResponse(result.data);
    if (!parsed) return subscriberImportContractError();
    if (!responseIdentityMatches(id, parsed.id)) {
      return responseIdentityMismatch("subscriber import");
    }
    return { data: parsed };
  };
}

export function createGetSubscriberImport({
  request,
}: SubscriberDataOperationsDependencies) {
  return async function getSubscriberImport(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<ApiResult<SubscriberImportPreview>> {
    const result = await request<unknown>(
      `/api/v1/subscriber-imports/${encodeURIComponent(id)}`,
      undefined,
      {
        requireOnline: true,
        signal: options?.signal,
        timeoutMs: 60_000,
        maxAttempts: 1,
      },
    );
    if (result.error) return result;
    const parsed = parseSubscriberImportResource(result.data);
    if (!parsed) return subscriberImportContractError();
    if (!responseIdentityMatches(id, parsed.id)) {
      return responseIdentityMismatch("subscriber import");
    }
    return { data: parsed };
  };
}

/** SUB-102-103: ask the worker to abort an in-progress import. */
export function createCancelSubscriberImport({
  request,
}: SubscriberDataOperationsDependencies) {
  return async function cancelSubscriberImport(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<ApiResult<SubscriberImportCancelResponse>> {
    const result = await request<unknown>(
      `/api/v1/subscriber-imports/${encodeURIComponent(id)}/cancel`,
      { method: "POST", body: "{}" },
      {
        requireOnline: true,
        signal: options?.signal,
        timeoutMs: 60_000,
        maxAttempts: 1,
      },
    );
    if (result.error) return result;
    const parsed = parseSubscriberImportCancelResponse(result.data);
    if (!parsed) return subscriberImportContractError();
    if (!responseIdentityMatches(id, parsed.id)) {
      return responseIdentityMismatch("subscriber import");
    }
    return { data: parsed };
  };
}

/** SUB-102 — list the canonical merge fields + the tenant's registered
 *  custom fields so the wizard's per-column remap dropdowns can offer
 *  every valid target. */
export function createGetImportRemapOptions({
  request,
}: SubscriberDataOperationsDependencies) {
  return async function getImportRemapOptions(options?: {
    signal?: AbortSignal;
  }): Promise<ApiResult<SubscriberImportRemapOptions>> {
    const result = await request<unknown>(
      "/api/v1/subscriber-imports/remap-options",
      undefined,
      {
        requireOnline: true,
        signal: options?.signal,
        timeoutMs: 60_000,
        maxAttempts: 1,
      },
    );
    if (result.error) return result;
    const parsed = parseSubscriberImportRemapOptions(result.data);
    return parsed ? { data: parsed } : subscriberImportContractError();
  };
}

/** SUB-103 — auth-token-safe SSE URL for an import's live progress
 *  stream (GET /api/v1/subscriber-imports/{id}/progress). Same
 *  buildStreamUrl pattern as auditStreamUrlAuthed: a bare relative URL
 *  resolves against tauri://localhost and carries no auth, so the
 *  EventSource never connects in the packaged app. */
export function createSubscriberImportProgressUrlAuthed({
  buildStreamUrl,
}: SubscriberDataOperationsDependencies) {
  return function subscriberImportProgressUrlAuthed(
    id: string,
  ): Promise<string> {
    return buildStreamUrl(
      `/api/v1/subscriber-imports/${encodeURIComponent(id)}/progress`,
    );
  };
}

/* ---------- subscribers: SUB-109 reusable import-mapping templates -- */

/** SUB-109 — list the tenant's saved import-mapping templates,
 *  newest-first. The import wizard offers these so an operator can
 *  re-apply a saved column mapping to a fresh preview. */
export function createListSubscriberImportTemplates({
  request,
}: SubscriberDataOperationsDependencies) {
  return function listSubscriberImportTemplates(): Promise<
    ApiResult<{ items: SubscriberImportTemplate[] }>
  > {
    return request<{ items: SubscriberImportTemplate[] }>(
      "/api/v1/subscriber-import-templates",
    );
  };
}

/** SUB-109 — persist the current column mapping as a named, reusable
 *  template. Upsert by (tenant, name): re-saving under an existing
 *  name overwrites that template's mapping + source_hint. */
export function createSaveSubscriberImportTemplate({
  request,
}: SubscriberDataOperationsDependencies) {
  return function saveSubscriberImportTemplate(input: {
    name: string;
    mapping?: unknown;
    source_hint?: string;
  }): Promise<ApiResult<SubscriberImportTemplate>> {
    return request<SubscriberImportTemplate>(
      "/api/v1/subscriber-import-templates",
      { method: "POST", body: JSON.stringify(input) },
    );
  };
}

/** SUB-109 — delete one saved import-mapping template. */
export function createDeleteSubscriberImportTemplate({
  request,
}: SubscriberDataOperationsDependencies) {
  return function deleteSubscriberImportTemplate(
    id: string,
  ): Promise<ApiResult<void>> {
    return request<void>(
      `/api/v1/subscriber-import-templates/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  };
}

/* ---------- subscribers: SUB-098 sequenced bulk ops --------------- */
export function createBulkTagSubscribers({
  request,
}: SubscriberDataOperationsDependencies) {
  return function bulkTagSubscribers(input: {
    subscriber_ids: string[];
    tag: string;
  }): Promise<ApiResult<SubscriberBulkResult>> {
    return request<SubscriberBulkResult>("/api/v1/subscribers/bulk/tag", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
}

export function createBulkUntagSubscribers({
  request,
}: SubscriberDataOperationsDependencies) {
  return function bulkUntagSubscribers(input: {
    subscriber_ids: string[];
    tag: string;
  }): Promise<ApiResult<SubscriberBulkResult>> {
    return request<SubscriberBulkResult>("/api/v1/subscribers/bulk/untag", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
}

export function createBulkUnsubscribeSubscribers({
  request,
}: SubscriberDataOperationsDependencies) {
  return function bulkUnsubscribeSubscribers(input: {
    subscriber_ids: string[];
  }): Promise<ApiResult<SubscriberBulkResult>> {
    return request<SubscriberBulkResult>(
      "/api/v1/subscribers/bulk/unsubscribe",
      { method: "POST", body: JSON.stringify(input) },
    );
  };
}

export function createBulkDeleteSubscribers({
  request,
}: SubscriberDataOperationsDependencies) {
  return function bulkDeleteSubscribers(input: {
    subscriber_ids: string[];
  }): Promise<ApiResult<SubscriberBulkResult>> {
    return request<SubscriberBulkResult>("/api/v1/subscribers/bulk/delete", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
}

export function createBulkRecoverSubscribers({
  request,
}: SubscriberDataOperationsDependencies) {
  return function bulkRecoverSubscribers(input: {
    recovery_token: string;
  }): Promise<ApiResult<SubscriberBulkResult>> {
    return request<SubscriberBulkResult>("/api/v1/subscribers/bulk/recover", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
}

/* ---------- subscribers: SUB-100 extended bulk verbs -------------- */

/**
 * SUB-100 — re-enable blocklisted subscribers (inverse of bulk/unsubscribe).
 * Only `blocklisted` rows flip to `enabled`; everything else is skipped.
 */
export function createBulkResubscribeSubscribers({
  request,
}: SubscriberDataOperationsDependencies) {
  return function bulkResubscribeSubscribers(
    input: {
      subscriber_ids: string[];
    } & BulkConsentProvenanceInput,
  ): Promise<ApiResult<SubscriberBulkResult>> {
    return request<SubscriberBulkResult>(
      "/api/v1/subscribers/bulk/resubscribe",
      { method: "POST", body: JSON.stringify(input) },
    );
  };
}

/** SUB-100 — add the audience to a list (alias of move-to-list). */
export function createBulkAddToListSubscribers({
  request,
}: SubscriberDataOperationsDependencies) {
  return function bulkAddToListSubscribers(input: {
    subscriber_ids: string[];
    list_id: string;
  }): Promise<ApiResult<SubscriberBulkResult>> {
    return request<SubscriberBulkResult>(
      "/api/v1/subscribers/bulk/add-to-list",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  };
}

/**
 * SUB-100 — set (or remove) a custom_fields key across the audience.
 * `remove: true` deletes the key; otherwise `value` overwrites it.
 */
export function createBulkSetCustomFieldSubscribers({
  request,
}: SubscriberDataOperationsDependencies) {
  return function bulkSetCustomFieldSubscribers(input: {
    subscriber_ids: string[];
    key: string;
    value?: unknown;
    remove?: boolean;
  }): Promise<ApiResult<SubscriberBulkResult>> {
    return request<SubscriberBulkResult>(
      "/api/v1/subscribers/bulk/set-custom-field",
      { method: "POST", body: JSON.stringify(input) },
    );
  };
}

/** SUB-100 — set (or remove) a merge_fields key (FNAME, LNAME, …). */
export function createBulkUpdateMergeFieldSubscribers({
  request,
}: SubscriberDataOperationsDependencies) {
  return function bulkUpdateMergeFieldSubscribers(input: {
    subscriber_ids: string[];
    key: string;
    value?: unknown;
    remove?: boolean;
  }): Promise<ApiResult<SubscriberBulkResult>> {
    return request<SubscriberBulkResult>(
      "/api/v1/subscribers/bulk/update-merge-field",
      { method: "POST", body: JSON.stringify(input) },
    );
  };
}

/** SUB-100 — append a 'granted' consent_events row per subscriber. */
export function createBulkGrantConsentSubscribers({
  request,
}: SubscriberDataOperationsDependencies) {
  return function bulkGrantConsentSubscribers(
    input: {
      subscriber_ids: string[];
      category: string;
    } & BulkConsentProvenanceInput,
  ): Promise<ApiResult<SubscriberBulkResult>> {
    return request<SubscriberBulkResult>(
      "/api/v1/subscribers/bulk/grant-consent",
      { method: "POST", body: JSON.stringify(input) },
    );
  };
}

/** SUB-100 — append a 'revoked' consent_events row per subscriber. */
export function createBulkRevokeConsentSubscribers({
  request,
}: SubscriberDataOperationsDependencies) {
  return function bulkRevokeConsentSubscribers(
    input: {
      subscriber_ids: string[];
      category: string;
    } & BulkConsentProvenanceInput,
  ): Promise<ApiResult<SubscriberBulkResult>> {
    return request<SubscriberBulkResult>(
      "/api/v1/subscribers/bulk/revoke-consent",
      { method: "POST", body: JSON.stringify(input) },
    );
  };
}

/**
 * SUB-100 — stream a CSV of the resolved audience (explicit ids OR a
 * segment). The server responds with text/csv (not JSON / not a signed
 * URL), so this mirrors exportSubscribersCSV: returns the raw blob plus
 * the server-suggested filename for a browser download.
 */
export function createBulkExportSubscribersBySegment({
  createDownloadController,
  normalizeApiKey,
  getApiKey,
  nativeAwareFetch,
  apiUrl,
  errorFromResponse,
  transportError,
  nativeClientHeaders: NATIVE_CLIENT_HEADERS,
}: SubscriberDataOperationsDependencies) {
  return async function bulkExportSubscribersBySegment(input: {
    subscriber_ids?: string[];
    segment_id?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<ApiResult<{ blob: Blob; filename: string }>> {
    const dl = createDownloadController(input?.signal);
    try {
      const headers: Record<string, string> = {
        Accept: "text/csv",
        "Content-Type": "application/json",
        ...NATIVE_CLIENT_HEADERS,
      };
      const key = normalizeApiKey(getApiKey());
      if (key) headers.Authorization = `Bearer ${key}`;
      const body = JSON.stringify({
        subscriber_ids: input.subscriber_ids,
        segment_id: input.segment_id,
        limit: input.limit,
      });
      const res = await nativeAwareFetch(
        apiUrl("/api/v1/subscribers/bulk/export-by-segment"),
        {
          method: "POST",
          headers,
          body,
          mode: "cors",
          credentials: "include",
          cache: "no-store",
          signal: dl.signal,
        },
      );
      if (!res.ok) {
        return { error: await errorFromResponse(res) };
      }
      const cd = res.headers.get("Content-Disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(cd);
      const filename =
        m?.[1] ?? `subscribers-${new Date().toISOString().slice(0, 10)}.csv`;
      const blob = await res.blob();
      return { data: { blob, filename } };
    } catch (err) {
      return { error: transportError(err) };
    } finally {
      dl.dispose();
    }
  };
}

export function createSubscriberDataOperationsMethods(
  dependencies: SubscriberDataOperationsDependencies,
) {
  const downloadSubscriberDataExport =
    createDownloadSubscriberDataExport(dependencies);
  const dataExportApi: SubscriberDataExportApi = {
    downloadSubscriberDataExport,
  };
  return {
    downloadSubscriberDataExport: downloadSubscriberDataExport,
    downloadSubscriberConsentReceipt:
      createDownloadSubscriberConsentReceipt(dependencies),
    createSarRequest: createCreateSarRequest(dependencies),
    listDsarStoreResponses: createListDsarStoreResponses(dependencies),
    getDsarExport: createGetDsarExport(dataExportApi),
    reconfirmSubscriberJurisdiction:
      createReconfirmSubscriberJurisdiction(dependencies),
    exportSubscribersCSV: createExportSubscribersCSV(dependencies),
    suppressSubscriber: createSuppressSubscriber(dependencies),
    getSubscriberEngagement: createGetSubscriberEngagement(dependencies),
    getSubscriberEngagementBatch:
      createGetSubscriberEngagementBatch(dependencies),
    listSubscriberDuplicates: createListSubscriberDuplicates(dependencies),
    startSubscriberDuplicateScan:
      createStartSubscriberDuplicateScan(dependencies),
    listSubscriberDuplicateScanPairs:
      createListSubscriberDuplicateScanPairs(dependencies),
    mergeSubscribers: createMergeSubscribers(dependencies),
    bulkMergeSubscribers: createBulkMergeSubscribers(dependencies),
    listSubscriberFederatedLinks:
      createListSubscriberFederatedLinks(dependencies),
    createSubscriberFederatedLink:
      createCreateSubscriberFederatedLink(dependencies),
    deleteSubscriberFederatedLink:
      createDeleteSubscriberFederatedLink(dependencies),
    identifySubscriber: createIdentifySubscriber(dependencies),
    previewSubscriberImport: createPreviewSubscriberImport(dependencies),
    patchSubscriberImport: createPatchSubscriberImport(dependencies),
    confirmSubscriberImport: createConfirmSubscriberImport(dependencies),
    getSubscriberImport: createGetSubscriberImport(dependencies),
    cancelSubscriberImport: createCancelSubscriberImport(dependencies),
    getImportRemapOptions: createGetImportRemapOptions(dependencies),
    subscriberImportProgressUrlAuthed:
      createSubscriberImportProgressUrlAuthed(dependencies),
    listSubscriberImportTemplates:
      createListSubscriberImportTemplates(dependencies),
    saveSubscriberImportTemplate:
      createSaveSubscriberImportTemplate(dependencies),
    deleteSubscriberImportTemplate:
      createDeleteSubscriberImportTemplate(dependencies),
    bulkTagSubscribers: createBulkTagSubscribers(dependencies),
    bulkUntagSubscribers: createBulkUntagSubscribers(dependencies),
    bulkUnsubscribeSubscribers: createBulkUnsubscribeSubscribers(dependencies),
    bulkDeleteSubscribers: createBulkDeleteSubscribers(dependencies),
    bulkRecoverSubscribers: createBulkRecoverSubscribers(dependencies),
    bulkResubscribeSubscribers: createBulkResubscribeSubscribers(dependencies),
    bulkAddToListSubscribers: createBulkAddToListSubscribers(dependencies),
    bulkSetCustomFieldSubscribers:
      createBulkSetCustomFieldSubscribers(dependencies),
    bulkUpdateMergeFieldSubscribers:
      createBulkUpdateMergeFieldSubscribers(dependencies),
    bulkGrantConsentSubscribers:
      createBulkGrantConsentSubscribers(dependencies),
    bulkRevokeConsentSubscribers:
      createBulkRevokeConsentSubscribers(dependencies),
    bulkExportSubscribersBySegment:
      createBulkExportSubscribersBySegment(dependencies),
  };
}
