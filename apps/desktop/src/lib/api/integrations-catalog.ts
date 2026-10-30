import type { ApiResult } from "./result";

interface IntegrationsCatalogRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

type IntegrationsCatalogRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: IntegrationsCatalogRequestOptions,
) => Promise<ApiResult<T>>;

/* ---------- Integrations catalog facade -------------------------------- */

export type IntegrationBadge =
  | "native"
  | "partner"
  | "zapier"
  | "webhook"
  | "api_sdk"
  | "migration_only"
  | "planned";

export type IntegrationRuntimeStatus =
  | "available"
  | "partial"
  | "delegated"
  | "planned";

export type IntegrationLifecycleAction =
  | "connect/start"
  | "connect/callback"
  | "oauth/availability"
  | "oauth/start"
  | "oauth/callback"
  | "sync"
  | "backfill"
  | "pause"
  | "disconnect"
  | "provider-cleanup/acknowledge"
  | "roadmap";

export type IntegrationActionStatus = "delegated" | "planned" | "unavailable";

export type IntegrationRecipePreparationStatus = "delegated" | "planned";

export type IntegrationHealthState =
  | "planned"
  | "action_required"
  | "needs_attention"
  | "healthy"
  | "ready_to_configure"
  | "not_configured";

export type IntegrationStackStatus =
  | "empty"
  | "ready"
  | "covered"
  | "partial"
  | "gap";

export type IntegrationCoverageMaturity =
  | "verified_hybrid_ready"
  | "verified_native_ready"
  | "foundation_hybrid_ready"
  | "foundation_cataloged"
  | "bridge_ready"
  | "planned_only"
  | "catalog_only"
  | "empty";

export interface IntegrationCategory {
  key: string;
  label: string;
}

export interface IntegrationCatalogItem {
  slug: string;
  name: string;
  category: string;
  badge: IntegrationBadge;
  runtime_status: IntegrationRuntimeStatus;
  summary: string;
  capabilities: string[];
  docs_url?: string;
  setup_path?: string;
  native: boolean;
  featured?: boolean;
  phase?: string;
  sources?: string[];
}

export interface IntegrationsCatalogResponse {
  schema_version: string;
  target_public_entries: number;
  target_native_managed: number;
  honest_badges: IntegrationBadge[];
  categories: IntegrationCategory[];
  capabilities: string[];
  items: IntegrationCatalogItem[];
  counts: Record<string, number>;
}

export interface IntegrationConnection {
  slug: string;
  name: string;
  category: string;
  badge: IntegrationBadge;
  runtime_status: IntegrationRuntimeStatus;
  connected: boolean;
  status: string;
  count: number;
  primary_connection_id?: string;
  connection_ids?: string[];
  last_sync_at?: string | null;
  last_error?: string;
  manage_path?: string;
  source?: string;
  health_state?: IntegrationHealthState;
  health_message?: string;
}

export interface IntegrationsConnectionsResponse {
  items: IntegrationConnection[];
  summary: Record<string, number>;
  returned: number;
}

export interface IntegrationsConnectionsQuery {
  footprint?: boolean;
  connected?: boolean;
  q?: string;
  category?: string;
  health?: string | readonly string[];
  status?: string | readonly string[];
}

export interface IntegrationCategoryCoverage {
  key: string;
  label: string;
  total: number;
  native_managed: number;
  native_verified: number;
  native_partial: number;
  native_delegated: number;
  bridge_ready: number;
  planned: number;
  available_recipes: number;
  maturity: IntegrationCoverageMaturity;
}

export interface IntegrationPriorityGap {
  slug: string;
  name: string;
  category: string;
  phase?: string;
  current_badge: IntegrationBadge;
  runtime_status: IntegrationRuntimeStatus;
  bridge_available: boolean;
  reason: string;
}

export interface IntegrationsCoverageResponse {
  schema_version: string;
  target_public_entries: number;
  target_native_managed: number;
  target_native_verified: number;
  public_entries: number;
  native_managed: number;
  native_verified: number;
  native_partial: number;
  native_delegated: number;
  public_gap: number;
  native_gap: number;
  native_verification_gap: number;
  public_parity: boolean;
  native_parity: boolean;
  native_verification_parity: boolean;
  bridge_ready: number;
  planned: number;
  available_recipes: number;
  generated_recipes: number;
  badge_counts: Record<string, number>;
  phase_counts: Record<string, number>;
  maturity_counts: Record<string, number>;
  categories: IntegrationCategoryCoverage[];
  priority_gaps: IntegrationPriorityGap[];
}

export interface IntegrationReadinessCheck {
  key: string;
  label: string;
  state: string;
  severity: string;
  count: number;
  message: string;
}

export interface IntegrationReadinessIssue {
  key: string;
  severity: string;
  slug?: string;
  name?: string;
  category?: string;
  message: string;
  remediation?: string;
}

export interface IntegrationsReadinessResponse {
  schema_version: string;
  ready: boolean;
  marketable_public_claim: boolean;
  public_claim: string;
  public_entries: number;
  target_public_entries: number;
  native_managed: number;
  target_native_managed: number;
  native_verified: number;
  target_native_verified: number;
  native_partial: number;
  native_delegated: number;
  bridge_ready: number;
  available_recipes: number;
  public_parity: boolean;
  native_parity: boolean;
  native_verification_parity: boolean;
  checks: IntegrationReadinessCheck[];
  issues: IntegrationReadinessIssue[];
  issue_counts: Record<string, number>;
  recommendations: string[];
}

export interface IntegrationStackComponent {
  slug: string;
  name: string;
  role: string;
  required: boolean;
  category: string;
  badge: IntegrationBadge;
  runtime_status: string;
  available: boolean;
  native_managed: boolean;
  bridge_available: boolean;
  setup_path?: string;
  reason: string;
}

export interface IntegrationCustomerStackCoverage {
  key: string;
  name: string;
  segment: string;
  summary: string;
  status: IntegrationStackStatus;
  coverage_pct: number;
  required_covered: number;
  required_total: number;
  optional_covered: number;
  optional_total: number;
  native_managed: number;
  bridge_ready: number;
  planned_gaps?: string[];
  components: IntegrationStackComponent[];
  next_actions: string[];
}

export interface IntegrationStackGap {
  slug: string;
  name: string;
  stacks: number;
  required_count: number;
  reason: string;
}

export interface IntegrationsStackReport {
  schema_version: string;
  target_coverage_pct: number;
  covered_pct: number;
  covered_stacks: number;
  total_stacks: number;
  summary: Record<string, number>;
  stacks: IntegrationCustomerStackCoverage[];
  highest_impact_gaps: IntegrationStackGap[];
  newsletter_commerce_ok: boolean;
}

export interface IntegrationSetupStep {
  title: string;
  description: string;
  action?: string;
  path?: string;
  required_fields?: string[];
}

export interface IntegrationHealthCheck {
  key: string;
  label: string;
  state: string;
  message: string;
}

export interface IntegrationRetryPolicy {
  mode: string;
  max_attempts: number;
  backoff: string;
  dead_letter: string;
  idempotency: string;
}

export interface IntegrationSyncHistoryEntry {
  at?: string | null;
  action: string;
  status: string;
  attempts?: number;
  message: string;
  error?: string;
}

export interface IntegrationAuditTrailEntry {
  at?: string | null;
  action: string;
  actor: string;
  message: string;
}

export interface IntegrationDataDeleteAction {
  method: string;
  path: string;
  description: string;
}

export interface IntegrationHealthReport {
  state: string;
  severity: string;
  message: string;
  monitoring_surface: string;
  docs_url?: string;
  checks: IntegrationHealthCheck[];
  retry_policy: IntegrationRetryPolicy;
  sync_history: IntegrationSyncHistoryEntry[];
  audit_trail: IntegrationAuditTrailEntry[];
  data_delete: IntegrationDataDeleteAction[];
}

export interface IntegrationConnectorContract {
  slug: string;
  owner: string;
  badge: IntegrationBadge;
  runtime_status: IntegrationRuntimeStatus;
  native_managed: boolean;
  native_verified: boolean;
  implementation_depth: string;
  public_claim: string;
  auth_modes: string[];
  credential_storage: string;
  secret_policy: string;
  setup_surface: string;
  monitoring: string[];
  lifecycle_actions: IntegrationLifecycleAction[];
  bridge_channels?: string[];
  required_scopes?: string[];
  data_objects: string[];
  event_topics: string[];
  compliance_gates: string[];
  privacy_actions: string[];
  rate_limit_policy: string;
  partner_review: string;
}

export interface IntegrationFieldMapping {
  source: string;
  target: string;
  required: boolean;
  description?: string;
}

export interface IntegrationRecipeBlueprint {
  trigger: string;
  destination: string;
  postwave_surface: string;
  required_scopes?: string[];
  required_secrets?: string[];
  events?: string[];
  field_mappings?: IntegrationFieldMapping[];
  sample_payload?: Record<string, unknown>;
  data_handling?: string[];
}

export interface IntegrationRecipe {
  id: string;
  name: string;
  provider: string;
  source_slug: string;
  target_slug?: string;
  summary: string;
  badge: IntegrationBadge;
  available: boolean;
  estimated_minutes: number;
  setup_path?: string;
  docs_url?: string;
  capabilities: string[];
  steps: IntegrationSetupStep[];
  blueprint: IntegrationRecipeBlueprint;
}

export interface IntegrationDetailResponse {
  item: IntegrationCatalogItem;
  connection: IntegrationConnection;
  setup: IntegrationSetupStep[];
  recipes: IntegrationRecipe[];
  lifecycle_actions: IntegrationLifecycleAction[];
  health: IntegrationHealthReport;
  contract: IntegrationConnectorContract;
}

export interface IntegrationsRecipesResponse {
  items: IntegrationRecipe[];
  summary: Record<string, number>;
}

export interface IntegrationRecipeDetailResponse {
  recipe: IntegrationRecipe;
  source: IntegrationCatalogItem;
  target?: IntegrationCatalogItem;
}

export interface IntegrationActionResponse {
  slug: string;
  action: IntegrationLifecycleAction;
  status: IntegrationActionStatus;
  message: string;
  delegated_to?: string;
  primary_connection_id?: string;
  connection_ids?: string[];
  required_fields?: string[];
  docs_url?: string;
  manage_path?: string;
}

export interface IntegrationRecipeApplyResponse {
  recipe_id: string;
  status: IntegrationRecipePreparationStatus;
  message: string;
  delegated_to?: string;
  manage_path?: string;
  required_fields?: string[];
  next_steps?: IntegrationSetupStep[];
  blueprint: IntegrationRecipeBlueprint;
}

export function createIntegrationsCatalogApi(
  request: IntegrationsCatalogRequester,
) {
  function integrationAction(
    slug: string,
    suffix: string,
    init: RequestInit,
  ): Promise<ApiResult<IntegrationActionResponse>> {
    const path = suffix
      ? `/api/v1/integrations/${encodeURIComponent(slug)}/${suffix}`
      : `/api/v1/integrations/${encodeURIComponent(slug)}`;
    return request<IntegrationActionResponse>(path, init);
  }

  return {
    catalog(): Promise<ApiResult<IntegrationsCatalogResponse>> {
      return request<IntegrationsCatalogResponse>(
        "/api/v1/integrations/catalog",
      );
    },
    connections(
      params: IntegrationsConnectionsQuery = {},
    ): Promise<ApiResult<IntegrationsConnectionsResponse>> {
      const qs = new URLSearchParams();
      if (params.footprint != null)
        qs.set("footprint", String(params.footprint));
      if (params.connected != null)
        qs.set("connected", String(params.connected));
      if (params.q) qs.set("q", params.q);
      if (params.category) qs.set("category", params.category);
      const health =
        typeof params.health === "string"
          ? params.health
          : params.health?.join(",");
      if (health) qs.set("health", health);
      const status =
        typeof params.status === "string"
          ? params.status
          : params.status?.join(",");
      if (status) qs.set("status", status);
      const query = qs.toString();
      return request<IntegrationsConnectionsResponse>(
        `/api/v1/integrations/connections${query ? `?${query}` : ""}`,
      );
    },
    coverage(): Promise<ApiResult<IntegrationsCoverageResponse>> {
      return request<IntegrationsCoverageResponse>(
        "/api/v1/integrations/coverage",
      );
    },
    stacks(): Promise<ApiResult<IntegrationsStackReport>> {
      return request<IntegrationsStackReport>("/api/v1/integrations/stacks");
    },
    readiness(): Promise<ApiResult<IntegrationsReadinessResponse>> {
      return request<IntegrationsReadinessResponse>(
        "/api/v1/integrations/readiness",
      );
    },
    detail(slug: string): Promise<ApiResult<IntegrationDetailResponse>> {
      return request<IntegrationDetailResponse>(
        `/api/v1/integrations/${encodeURIComponent(slug)}`,
      );
    },
    health(slug: string): Promise<ApiResult<IntegrationHealthReport>> {
      return request<IntegrationHealthReport>(
        `/api/v1/integrations/${encodeURIComponent(slug)}/health`,
      );
    },
    contract(slug: string): Promise<ApiResult<IntegrationConnectorContract>> {
      return request<IntegrationConnectorContract>(
        `/api/v1/integrations/${encodeURIComponent(slug)}/contract`,
      );
    },
    recipes(params?: {
      q?: string;
      source?: string;
      target?: string;
      provider?: string;
      badge?: string;
      capability?: string;
      available?: boolean;
    }): Promise<ApiResult<IntegrationsRecipesResponse>> {
      const qs = new URLSearchParams();
      if (params?.q) qs.set("q", params.q);
      if (params?.source) qs.set("source", params.source);
      if (params?.target) qs.set("target", params.target);
      if (params?.provider) qs.set("provider", params.provider);
      if (params?.badge) qs.set("badge", params.badge);
      if (params?.capability) qs.set("capability", params.capability);
      if (params?.available != null)
        qs.set("available", String(params.available));
      const query = qs.toString();
      return request<IntegrationsRecipesResponse>(
        `/api/v1/integrations/recipes${query ? `?${query}` : ""}`,
      );
    },
    recipeDetail(
      id: string,
    ): Promise<ApiResult<IntegrationRecipeDetailResponse>> {
      return request<IntegrationRecipeDetailResponse>(
        `/api/v1/integrations/recipes/${encodeURIComponent(id)}`,
      );
    },
    applyRecipe(
      id: string,
    ): Promise<ApiResult<IntegrationRecipeApplyResponse>> {
      return request<IntegrationRecipeApplyResponse>(
        `/api/v1/integrations/recipes/${encodeURIComponent(id)}/apply`,
        { method: "POST", body: "{}" },
      );
    },
    startConnect(slug: string): Promise<ApiResult<IntegrationActionResponse>> {
      return integrationAction(slug, "connect/start", {
        method: "POST",
        body: "{}",
      });
    },
    callback(slug: string): Promise<ApiResult<IntegrationActionResponse>> {
      return integrationAction(slug, "connect/callback", {
        method: "POST",
        body: "{}",
      });
    },
    sync(slug: string): Promise<ApiResult<IntegrationActionResponse>> {
      return integrationAction(slug, "sync", { method: "POST", body: "{}" });
    },
    backfill(slug: string): Promise<ApiResult<IntegrationActionResponse>> {
      return integrationAction(slug, "backfill", {
        method: "POST",
        body: "{}",
      });
    },
    pause(slug: string): Promise<ApiResult<IntegrationActionResponse>> {
      return integrationAction(slug, "pause", { method: "POST", body: "{}" });
    },
    disconnect(slug: string): Promise<ApiResult<IntegrationActionResponse>> {
      return integrationAction(slug, "", { method: "DELETE" });
    },
  };
}
