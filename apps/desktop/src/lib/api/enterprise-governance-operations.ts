import type { ApiResult } from "./result";

export interface EnterpriseGovernanceRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

export type EnterpriseGovernanceRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: EnterpriseGovernanceRequestOptions,
) => Promise<ApiResult<T>>;

export interface EnterpriseGovernanceOperationsDependencies {
  request: EnterpriseGovernanceRequester;
}

/* ---------- Inbound routes types ---------- */

export interface InboundRouteAction {
  kind: "tag" | "automation_trigger" | "webhook" | "forward" | "store_only";
  tag?: string;
  event_type?: string;
  url?: string;
  to?: string;
  extra?: Record<string, unknown>;
  /** Response-only marker; the stored value is never returned. */
  has_stored_hmac_secret?: boolean;
  /** PATCH control for preserving an existing source action's HMAC value. */
  preserve_hmac_from_index?: number;
  /** PATCH control for explicitly removing a stored HMAC value. */
  remove_stored_hmac?: boolean;
}

export interface InboundRoute {
  id: string;
  name: string;
  priority: number;
  stop_on_match: boolean;
  enabled: boolean;
  match_recipient: string;
  match_subject_prefix?: string;
  match_from_domain?: string;
  actions: InboundRouteAction[];
  last_matched_at?: string | null;
  match_count: number;
  /** Configuration revision; runtime match counters do not advance it. */
  updated_at: string;
  /**
   * v2 retry policy (migration 0194). 0..5 additional attempts per
   * retryable action with exponential backoff on the base seconds.
   * Defaults preserve v1 behaviour (no retry).
   */
  action_retry_max?: number;
  action_retry_backoff_seconds?: number;
}

export interface InboundRouteInput {
  name: string;
  priority?: number;
  stop_on_match?: boolean;
  enabled?: boolean;
  match_recipient: string;
  match_subject_prefix?: string;
  match_from_domain?: string;
  actions: InboundRouteAction[];
  action_retry_max?: number;
  action_retry_backoff_seconds?: number;
  /**
   * v2 sentinel: send `clear_actions=true` alongside an empty
   * `actions` array to intentionally clear every action on the
   * route. v1 silently preserved existing actions when `actions=[]`
   * was sent (data-loss-hiding bug); v2 splits the two intents.
   */
  clear_actions?: boolean;
  /** Required for action replacement/clear so stale source indexes fail closed. */
  expected_updated_at?: string;
}

/**
 * v2 action-run row (migration 0194). One per (action, fire),
 * surfaces the "did my webhook actually fire?" loop the v1 page
 * couldn't answer.
 */
export interface InboundRouteActionRun {
  id: number;
  route_id: string;
  match_id?: number;
  action_index: number;
  action_kind: string;
  status: "succeeded" | "failed" | "skipped";
  attempts: number;
  http_status?: number;
  response_snippet?: string;
  error_message?: string;
  duration_ms: number;
  executed_at: string;
}

/** A single hit returned by `inboundRoutePreview`. */
export interface InboundRoutePreviewHit {
  route: InboundRoute;
  /** Plain-English description of which matchers fired. */
  reason: string;
}

/** Response shape for `inboundRoutePreview`. */
export interface InboundRoutePreviewResponse {
  matches: InboundRoutePreviewHit[];
  /** Total routes walked, including non-matchers. */
  evaluated: number;
  /** Route id that triggered stop_on_match, if any. */
  stopped_at_route_id?: string | null;
  no_matches?: boolean;
}

/**
 * One past match for a single rule (from inbound_route_matches).
 * Used by the per-rule history timeline in the edit modal.
 */
export interface InboundRouteMatch {
  id: number;
  route_id: string;
  inbound_email_id?: number | null;
  recipient: string;
  subject: string;
  from_email: string;
  matched_at: string;
}

/**
 * Metadata-only per-tenant inbound endpoint. GET never returns signing
 * material; rotationRequired tells the operator to create/replace it.
 */
export interface InboundEmailEndpoint {
  id: string;
  tenantId: string;
  slug: string;
  secretConfigured: boolean;
  rotationRequired: boolean;
  secretRotatedAt?: string | null;
  /** Present only in the immediate create/rotation response. */
  secret?: string;
  createdAt: string;
}

/** One-shot create/rotation response. The plaintext is never read back. */
export interface InboundEmailEndpointSecret extends InboundEmailEndpoint {
  secret: string;
}

/* ---------- SCIM admin types ---------- */

export interface ScimTokenInfo {
  id: string;
  prefix: string;
  description: string;
  created_at: string;
  revoked_at?: string | null;
  last_used_at?: string | null;
}

export interface ScimTokenMinted {
  id: string;
  token: string;
  prefix: string;
}

export interface ScimRoleMapping {
  id: string;
  group_name: string;
  role: "owner" | "admin" | "editor" | "viewer";
  precedence: number;
  created_at: string;
}

/* ---------- Compliance types ---------- */

export type ComplianceFramework =
  | "hipaa"
  | "soc2"
  | "gdpr"
  | "ccpa"
  | "pci_dss"
  | "iso27001"
  | "can_spam"
  | "casl"
  | string;

export type ComplianceStatus =
  | "attested"
  | "in_progress"
  | "revoked"
  | "unsupported";

export interface ComplianceProgram {
  framework: ComplianceFramework;
  status: ComplianceStatus;
  signedByEmail?: string;
  signerName?: string;
  documentPath?: string;
  documentSha256?: string;
  notes?: string;
  attestedAt?: string;
  renewalAt?: string;
  updatedAt?: string;
}

export interface ComplianceEvent {
  id: number;
  framework: ComplianceFramework;
  eventType: "attested" | "revoked" | "renewed" | "amended";
  signedByEmail?: string;
  counterSignedBy?: string;
  documentPath?: string;
  documentSha256?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
  at: string;
}

/* ---------- BYOK key types ---------- */

/**
 * Mirrors apps/api/internal/byok.Key. The Go struct has no `json:` tags,
 * so the wire format is PascalCase. We accept both casings defensively.
 */
export interface ByokKey {
  id?: string;
  tenant_id?: string;
  provider?: string;
  key_ref?: string;
  status?: string;
  description?: string;
  created_at?: string;
  activated_at?: string | null;
  rotated_at?: string | null;
  deleted_at?: string | null;
  last_health_check_at?: string | null;
  last_health_check_ok?: boolean | null;
  last_health_check_err?: string;
  ID?: string;
  Provider?: string;
  KeyRef?: string;
  Status?: string;
  Description?: string;
  CreatedAt?: string;
  ActivatedAt?: string | null;
  RotatedAt?: string | null;
  LastHealthCheckAt?: string | null;
  LastHealthCheckOK?: boolean | null;
  LastHealthCheckErr?: string;
  [extra: string]: unknown;
}

export interface ByokKeysResponse {
  keys: ByokKey[];
}

export interface ByokProvidersResponse {
  providers: string[];
  supported?: string[];
}

export interface ByokHealthResponse {
  key_id: string;
  provider: string;
  ok: boolean;
  code: "ok" | "health_failed";
  error?: string;
}

/** GET /api/v1/inbound-routes. */
export function createInboundRoutesList({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function inboundRoutesList(): Promise<
    ApiResult<{ routes: InboundRoute[] }>
  > {
    return request<{ routes: InboundRoute[] }>("/api/v1/inbound-routes");
  };
}

/** POST /api/v1/inbound-routes. */
export function createInboundRouteCreate({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function inboundRouteCreate(
    input: InboundRouteInput,
  ): Promise<ApiResult<InboundRoute>> {
    return request<InboundRoute>("/api/v1/inbound-routes", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
}

/** PATCH /api/v1/inbound-routes/{id}. */
export function createInboundRoutePatch({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function inboundRoutePatch(
    id: string,
    patch: Partial<InboundRouteInput>,
  ): Promise<ApiResult<InboundRoute>> {
    return request<InboundRoute>(
      `/api/v1/inbound-routes/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  };
}

/** DELETE /api/v1/inbound-routes/{id}. */
export function createInboundRouteDelete({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function inboundRouteDelete(
    id: string,
  ): Promise<ApiResult<{ deleted: boolean }>> {
    return request<{ deleted: boolean }>(
      `/api/v1/inbound-routes/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  };
}

/** POST /api/v1/inbound-routes/reorder. */
export function createInboundRoutesReorder({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function inboundRoutesReorder(
    routeIds: string[],
  ): Promise<ApiResult<{ ok: boolean; count: number }>> {
    return request<{ ok: boolean; count: number }>(
      "/api/v1/inbound-routes/reorder",
      {
        method: "POST",
        body: JSON.stringify({ route_ids: routeIds }),
      },
    );
  };
}

/** POST /api/v1/inbound-routes/preview. */
export function createInboundRoutePreview({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function inboundRoutePreview(input: {
    recipient: string;
    subject?: string;
    from?: string;
  }): Promise<ApiResult<InboundRoutePreviewResponse>> {
    return request<InboundRoutePreviewResponse>(
      "/api/v1/inbound-routes/preview",
      { method: "POST", body: JSON.stringify(input) },
    );
  };
}

/** GET /api/v1/inbound-routes/{id}/matches. */
export function createInboundRouteMatchesList({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function inboundRouteMatchesList(
    id: string,
    opts?: { limit?: number },
  ): Promise<ApiResult<{ matches: InboundRouteMatch[]; count: number }>> {
    const qs =
      opts?.limit != null
        ? `?limit=${encodeURIComponent(String(opts.limit))}`
        : "";
    return request<{ matches: InboundRouteMatch[]; count: number }>(
      `/api/v1/inbound-routes/${encodeURIComponent(id)}/matches${qs}`,
    );
  };
}

/** GET /api/v1/inbound-routes/matches/{match_id}/runs. */
export function createInboundRouteActionRunsList({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function inboundRouteActionRunsList(
    matchID: number | string,
  ): Promise<ApiResult<{ runs: InboundRouteActionRun[]; count: number }>> {
    return request<{ runs: InboundRouteActionRun[]; count: number }>(
      `/api/v1/inbound-routes/matches/${encodeURIComponent(String(matchID))}/runs`,
    );
  };
}

/** GET /api/v1/inbound-emails/endpoint. */
export function createInboundEndpointGet({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function inboundEndpointGet(): Promise<
    ApiResult<InboundEmailEndpoint>
  > {
    return request<InboundEmailEndpoint>("/api/v1/inbound-emails/endpoint");
  };
}

/** POST /api/v1/inbound-emails/endpoint/rotate. */
export function createInboundEndpointRotate({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function inboundEndpointRotate(): Promise<
    ApiResult<InboundEmailEndpointSecret>
  > {
    return request<InboundEmailEndpointSecret>(
      "/api/v1/inbound-emails/endpoint/rotate",
      { method: "POST" },
    );
  };
}

/** GET /api/v1/scim/tokens. */
export function createScimTokensList({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function scimTokensList(): Promise<
    ApiResult<{ tokens: ScimTokenInfo[] }>
  > {
    return request<{ tokens: ScimTokenInfo[] }>("/api/v1/scim/tokens");
  };
}

/** POST /api/v1/scim/tokens. */
export function createScimTokenCreate({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function scimTokenCreate(input: {
    description?: string;
  }): Promise<ApiResult<ScimTokenMinted>> {
    return request<ScimTokenMinted>("/api/v1/scim/tokens", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
}

/** DELETE /api/v1/scim/tokens/{id}. */
export function createScimTokenRevoke({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function scimTokenRevoke(
    id: string,
  ): Promise<ApiResult<{ revoked: boolean }>> {
    return request<{ revoked: boolean }>(
      `/api/v1/scim/tokens/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  };
}

/** GET /api/v1/scim/role-mappings. */
export function createScimRoleMappingsList({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function scimRoleMappingsList(): Promise<
    ApiResult<{ mappings: ScimRoleMapping[] }>
  > {
    return request<{ mappings: ScimRoleMapping[] }>(
      "/api/v1/scim/role-mappings",
    );
  };
}

/** POST /api/v1/scim/role-mappings. */
export function createScimRoleMappingUpsert({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function scimRoleMappingUpsert(input: {
    group_name: string;
    role: "owner" | "admin" | "editor" | "viewer";
    precedence?: number;
  }): Promise<ApiResult<ScimRoleMapping>> {
    return request<ScimRoleMapping>("/api/v1/scim/role-mappings", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
}

/** DELETE /api/v1/scim/role-mappings/{id}. */
export function createScimRoleMappingDelete({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function scimRoleMappingDelete(
    id: string,
  ): Promise<ApiResult<{ deleted: boolean }>> {
    return request<{ deleted: boolean }>(
      `/api/v1/scim/role-mappings/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  };
}

/** GET /api/v1/compliance/programs. */
export function createListCompliancePrograms({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function listCompliancePrograms(): Promise<
    ApiResult<{ programs: ComplianceProgram[] }>
  > {
    return request(`/api/v1/compliance/programs`);
  };
}

/** GET /api/v1/compliance/programs/{framework}. */
export function createGetComplianceProgram({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function getComplianceProgram(
    framework: string,
  ): Promise<ApiResult<ComplianceProgram>> {
    return request(
      `/api/v1/compliance/programs/${encodeURIComponent(framework)}`,
    );
  };
}

/** POST /api/v1/compliance/programs/{framework}/attest. */
export function createAttestComplianceProgram({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function attestComplianceProgram(
    framework: string,
    input: {
      signedByEmail: string;
      signerName?: string;
      documentPath?: string;
      documentSha256?: string;
      notes?: string;
      renewalAt?: string;
      /** Exact revision returned by GET when a stored row already exists. */
      expectedUpdatedAt?: string;
    },
  ): Promise<ApiResult<{ ok: boolean; framework: string }>> {
    return request(
      `/api/v1/compliance/programs/${encodeURIComponent(framework)}/attest`,
      { method: "POST", body: JSON.stringify(input) },
    );
  };
}

/** POST /api/v1/compliance/programs/{framework}/revoke. */
export function createRevokeComplianceProgram({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function revokeComplianceProgram(
    framework: string,
    reason: string,
    expectedUpdatedAt: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request(
      `/api/v1/compliance/programs/${encodeURIComponent(framework)}/revoke`,
      {
        method: "POST",
        body: JSON.stringify({ reason, expectedUpdatedAt }),
      },
    );
  };
}

/** GET /api/v1/compliance/programs/{framework}/events. */
export function createListComplianceEvents({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function listComplianceEvents(
    framework: string,
  ): Promise<ApiResult<{ events: ComplianceEvent[] }>> {
    return request(
      `/api/v1/compliance/programs/${encodeURIComponent(framework)}/events`,
    );
  };
}

/** GET /api/v1/byok/keys. */
export function createByokListKeys({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function byokListKeys(): Promise<ApiResult<ByokKeysResponse>> {
    return request<ByokKeysResponse>("/api/v1/byok/keys");
  };
}

/** GET /api/v1/byok/providers. */
export function createByokListProviders({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function byokListProviders(): Promise<
    ApiResult<ByokProvidersResponse>
  > {
    return request<ByokProvidersResponse>("/api/v1/byok/providers");
  };
}

/** POST /api/v1/byok/keys. */
export function createByokCreateKey({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function byokCreateKey(input: {
    provider: string;
    key_ref: string;
    description?: string;
  }): Promise<ApiResult<ByokKey>> {
    return request<ByokKey>("/api/v1/byok/keys", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
}

/** POST /api/v1/byok/keys/{id}/activate. */
export function createByokActivateKey({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function byokActivateKey(id: string): Promise<ApiResult<ByokKey>> {
    return request<ByokKey>(
      `/api/v1/byok/keys/${encodeURIComponent(id)}/activate`,
      { method: "POST", body: "{}" },
    );
  };
}

/** POST /api/v1/byok/keys/{id}/health. */
export function createByokHealthCheck({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function byokHealthCheck(
    id: string,
  ): Promise<ApiResult<ByokHealthResponse>> {
    return request<ByokHealthResponse>(
      `/api/v1/byok/keys/${encodeURIComponent(id)}/health`,
      { method: "POST", body: "{}" },
    );
  };
}

/** DELETE /api/v1/byok/keys/{id}. */
export function createByokDeleteKey({
  request,
}: EnterpriseGovernanceOperationsDependencies) {
  return function byokDeleteKey(
    id: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/byok/keys/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  };
}

export function createEnterpriseGovernanceOperationsMethods(
  dependencies: EnterpriseGovernanceOperationsDependencies,
) {
  return {
    inboundRoutesList: createInboundRoutesList(dependencies),
    inboundRouteCreate: createInboundRouteCreate(dependencies),
    inboundRoutePatch: createInboundRoutePatch(dependencies),
    inboundRouteDelete: createInboundRouteDelete(dependencies),
    inboundRoutesReorder: createInboundRoutesReorder(dependencies),
    inboundRoutePreview: createInboundRoutePreview(dependencies),
    inboundRouteMatchesList: createInboundRouteMatchesList(dependencies),
    inboundRouteActionRunsList: createInboundRouteActionRunsList(dependencies),
    inboundEndpointGet: createInboundEndpointGet(dependencies),
    inboundEndpointRotate: createInboundEndpointRotate(dependencies),
    scimTokensList: createScimTokensList(dependencies),
    scimTokenCreate: createScimTokenCreate(dependencies),
    scimTokenRevoke: createScimTokenRevoke(dependencies),
    scimRoleMappingsList: createScimRoleMappingsList(dependencies),
    scimRoleMappingUpsert: createScimRoleMappingUpsert(dependencies),
    scimRoleMappingDelete: createScimRoleMappingDelete(dependencies),
    listCompliancePrograms: createListCompliancePrograms(dependencies),
    getComplianceProgram: createGetComplianceProgram(dependencies),
    attestComplianceProgram: createAttestComplianceProgram(dependencies),
    revokeComplianceProgram: createRevokeComplianceProgram(dependencies),
    listComplianceEvents: createListComplianceEvents(dependencies),
    byokListKeys: createByokListKeys(dependencies),
    byokListProviders: createByokListProviders(dependencies),
    byokCreateKey: createByokCreateKey(dependencies),
    byokActivateKey: createByokActivateKey(dependencies),
    byokHealthCheck: createByokHealthCheck(dependencies),
    byokDeleteKey: createByokDeleteKey(dependencies),
  };
}
