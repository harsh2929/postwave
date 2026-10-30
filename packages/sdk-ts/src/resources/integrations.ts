// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

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

export type IntegrationCapability =
  | "profiles"
  | "events"
  | "lists"
  | "segments"
  | "commerce"
  | "orders"
  | "products"
  | "reviews"
  | "subscriptions"
  | "support"
  | "ads_audiences"
  | "warehouse_export"
  | "warehouse_import"
  | "automation_triggers";

export type IntegrationLifecycleAction =
  | "connect/start"
  | "connect/callback"
  | "sync"
  | "backfill"
  | "pause"
  | "disconnect"
  | "roadmap";

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
  capabilities: IntegrationCapability[];
  docs_url?: string;
  setup_path?: string;
  native: boolean;
  featured?: boolean;
  phase?: string;
  sources?: string[];
}

export interface IntegrationCatalogQuery {
  [key: string]: string | boolean | undefined;
  q?: string;
  category?: string;
  badge?: IntegrationBadge;
  capability?: IntegrationCapability;
}

export interface IntegrationCatalogResponse {
  schema_version: string;
  target_public_entries: number;
  target_native_managed: number;
  honest_badges: IntegrationBadge[];
  categories: IntegrationCategory[];
  capabilities: IntegrationCapability[];
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
  health_state: string;
  health_message: string;
}

export interface IntegrationConnectionsResponse {
  items: IntegrationConnection[];
  summary: Record<string, number>;
}

export interface IntegrationSetupStep {
  title: string;
  description: string;
  action?: string;
  path?: string;
  required_fields?: string[];
}

export interface IntegrationFieldMapping {
  source: string;
  target: string;
  required: boolean;
  description?: string;
}

export interface IntegrationBlueprint {
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
  capabilities: IntegrationCapability[];
  steps: IntegrationSetupStep[];
  blueprint: IntegrationBlueprint;
}

export interface IntegrationRecipesQuery {
  [key: string]: string | boolean | undefined;
  q?: string;
  source?: string;
  target?: string;
  provider?: string;
  badge?: IntegrationBadge;
  capability?: IntegrationCapability;
  available?: boolean;
}

export interface IntegrationRecipesResponse {
  items: IntegrationRecipe[];
  summary: Record<string, number>;
}

export interface IntegrationRecipeDetailResponse {
  recipe: IntegrationRecipe;
  source: IntegrationCatalogItem;
  target?: IntegrationCatalogItem;
}

export interface IntegrationRecipeApplyResponse {
  recipe_id: string;
  status: "delegated" | "planned";
  message: string;
  delegated_to?: string;
  manage_path?: string;
  required_fields?: string[];
  next_steps?: IntegrationSetupStep[];
  blueprint: IntegrationBlueprint;
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

export interface IntegrationDetailResponse {
  item: IntegrationCatalogItem;
  connection: IntegrationConnection;
  setup: IntegrationSetupStep[];
  recipes: IntegrationRecipe[];
  lifecycle_actions: IntegrationLifecycleAction[];
  health: IntegrationHealthReport;
  contract: IntegrationConnectorContract;
}

export interface IntegrationActionResponse {
  slug: string;
  action: IntegrationLifecycleAction | string;
  status: "delegated" | "planned";
  message: string;
  delegated_to?: string;
  primary_connection_id?: string;
  connection_ids?: string[];
  required_fields?: string[];
  docs_url?: string;
  manage_path?: string;
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
  maturity: string;
}

export interface IntegrationPriorityGap {
  slug: string;
  name: string;
  category: string;
  phase?: string;
  current_badge: IntegrationBadge;
  runtime_status: string;
  bridge_available: boolean;
  reason: string;
}

export interface IntegrationCoverageReport {
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

export interface IntegrationReadinessReport {
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
  status: string;
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

export interface IntegrationStackReport {
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

export function integrationPathSegment(value: string, label = "integration slug"): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Moosewave SDK: ${label} is required`);
  return encodeURIComponent(trimmed);
}

export class IntegrationsResource extends Resource {
  catalog(params: IntegrationCatalogQuery = {}): Promise<IntegrationCatalogResponse> {
    return this.client.request("GET", "/api/v1/integrations/catalog", {
      query: params,
    });
  }

  connections(): Promise<IntegrationConnectionsResponse> {
    return this.client.request("GET", "/api/v1/integrations/connections");
  }

  coverage(): Promise<IntegrationCoverageReport> {
    return this.client.request("GET", "/api/v1/integrations/coverage");
  }

  stacks(): Promise<IntegrationStackReport> {
    return this.client.request("GET", "/api/v1/integrations/stacks");
  }

  readiness(): Promise<IntegrationReadinessReport> {
    return this.client.request("GET", "/api/v1/integrations/readiness");
  }

  recipes(params: IntegrationRecipesQuery = {}): Promise<IntegrationRecipesResponse> {
    return this.client.request("GET", "/api/v1/integrations/recipes", {
      query: params,
    });
  }

  recipe(id: string): Promise<IntegrationRecipeDetailResponse> {
    return this.client.request(
      "GET",
      `/api/v1/integrations/recipes/${integrationPathSegment(id, "recipe id")}`,
    );
  }

  applyRecipe(id: string): Promise<IntegrationRecipeApplyResponse> {
    return this.client.request(
      "POST",
      `/api/v1/integrations/recipes/${integrationPathSegment(id, "recipe id")}/apply`,
    );
  }

  detail(slug: string): Promise<IntegrationDetailResponse> {
    return this.client.request(
      "GET",
      `/api/v1/integrations/${integrationPathSegment(slug)}`,
    );
  }

  contract(slug: string): Promise<IntegrationConnectorContract> {
    return this.client.request(
      "GET",
      `/api/v1/integrations/${integrationPathSegment(slug)}/contract`,
    );
  }

  health(slug: string): Promise<IntegrationHealthReport> {
    return this.client.request(
      "GET",
      `/api/v1/integrations/${integrationPathSegment(slug)}/health`,
    );
  }

  startConnect(slug: string): Promise<IntegrationActionResponse> {
    return this.client.request(
      "POST",
      `/api/v1/integrations/${integrationPathSegment(slug)}/connect/start`,
    );
  }

  finishConnect(slug: string): Promise<IntegrationActionResponse> {
    return this.client.request(
      "POST",
      `/api/v1/integrations/${integrationPathSegment(slug)}/connect/callback`,
    );
  }

  sync(slug: string): Promise<IntegrationActionResponse> {
    return this.client.request(
      "POST",
      `/api/v1/integrations/${integrationPathSegment(slug)}/sync`,
    );
  }

  backfill(slug: string): Promise<IntegrationActionResponse> {
    return this.client.request(
      "POST",
      `/api/v1/integrations/${integrationPathSegment(slug)}/backfill`,
    );
  }

  pause(slug: string): Promise<IntegrationActionResponse> {
    return this.client.request(
      "POST",
      `/api/v1/integrations/${integrationPathSegment(slug)}/pause`,
    );
  }

  disconnect(slug: string): Promise<IntegrationActionResponse> {
    return this.client.request(
      "DELETE",
      `/api/v1/integrations/${integrationPathSegment(slug)}`,
    );
  }
}
