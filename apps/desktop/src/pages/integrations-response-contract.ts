import type {
  IntegrationActionResponse,
  IntegrationActionStatus,
  IntegrationAuditTrailEntry,
  IntegrationBadge,
  IntegrationCatalogItem,
  IntegrationCategoryCoverage,
  IntegrationConnection,
  IntegrationConnectorContract,
  IntegrationCoverageMaturity,
  IntegrationCustomerStackCoverage,
  IntegrationDataDeleteAction,
  IntegrationDetailResponse,
  IntegrationFieldMapping,
  IntegrationHealthCheck,
  IntegrationHealthReport,
  IntegrationHealthState,
  IntegrationLifecycleAction,
  IntegrationPriorityGap,
  IntegrationReadinessCheck,
  IntegrationReadinessIssue,
  IntegrationRecipe,
  IntegrationRecipeApplyResponse,
  IntegrationRecipeBlueprint,
  IntegrationRecipeDetailResponse,
  IntegrationRecipePreparationStatus,
  IntegrationRetryPolicy,
  IntegrationRuntimeStatus,
  IntegrationSetupStep,
  IntegrationStackComponent,
  IntegrationStackGap,
  IntegrationStackStatus,
  IntegrationSyncHistoryEntry,
  IntegrationsCatalogResponse,
  IntegrationsConnectionsResponse,
  IntegrationsCoverageResponse,
  IntegrationsReadinessResponse,
  IntegrationsRecipesResponse,
  IntegrationsStackReport,
} from "../lib/api/integrations-catalog";

// The public catalog is currently roughly 600 entries. These limits leave
// deliberate growth room while preventing a malformed successful response from
// becoming unbounded renderer work.
const MAX_TOP_LEVEL_ITEMS = 2_000;
const MAX_NESTED_ITEMS = 256;
const MAX_COUNT_MAP_KEYS = 512;
const MAX_TEXT_LENGTH = 16_384;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_COUNT = 1_000_000_000;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 4_096;

const INTEGRATION_BADGES: ReadonlySet<IntegrationBadge> = new Set([
  "native",
  "partner",
  "zapier",
  "webhook",
  "api_sdk",
  "migration_only",
  "planned",
]);

const RUNTIME_STATUSES: ReadonlySet<IntegrationRuntimeStatus> = new Set([
  "available",
  "partial",
  "delegated",
  "planned",
]);

const LIFECYCLE_ACTIONS: ReadonlySet<IntegrationLifecycleAction> = new Set([
  "connect/start",
  "connect/callback",
  "oauth/availability",
  "oauth/start",
  "oauth/callback",
  "sync",
  "backfill",
  "pause",
  "disconnect",
  "provider-cleanup/acknowledge",
  "roadmap",
]);

const ACTION_STATUSES: ReadonlySet<IntegrationActionStatus> = new Set([
  "delegated",
  "planned",
  "unavailable",
]);

const RECIPE_PREPARATION_STATUSES: ReadonlySet<IntegrationRecipePreparationStatus> =
  new Set(["delegated", "planned"]);

const HEALTH_STATES: ReadonlySet<IntegrationHealthState> = new Set([
  "planned",
  "action_required",
  "needs_attention",
  "healthy",
  "ready_to_configure",
  "not_configured",
]);

const HEALTH_SEVERITIES = new Set(["info", "ok", "warning", "error"]);
const HEALTH_CHECK_STATES = new Set([
  "info",
  "ok",
  "warning",
  "error",
  "planned",
]);
const READINESS_STATES = new Set(["pass", "fail"]);
const READINESS_SEVERITIES = new Set(["ok", "warning", "blocker"]);

const STACK_STATUSES: ReadonlySet<IntegrationStackStatus> = new Set([
  "empty",
  "ready",
  "covered",
  "partial",
  "gap",
]);

const COVERAGE_MATURITIES: ReadonlySet<IntegrationCoverageMaturity> = new Set([
  "verified_hybrid_ready",
  "verified_native_ready",
  "foundation_hybrid_ready",
  "foundation_cataloged",
  "bridge_ready",
  "planned_only",
  "catalog_only",
  "empty",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT_LENGTH;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || isText(value);
}

function isCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_COUNT
  );
}

function isPercentage(value: unknown): value is number {
  return isCount(value) && value <= 100;
}

function isTimestamp(value: unknown): value is string {
  return isIdentifier(value) && Number.isFinite(Date.parse(value));
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || value === null || isTimestamp(value);
}

function isArrayOf<T>(
  value: unknown,
  maximum: number,
  predicate: (entry: unknown) => entry is T,
): value is T[] {
  return (
    Array.isArray(value) && value.length <= maximum && value.every(predicate)
  );
}

function hasUniqueBy<T>(
  values: readonly T[],
  identity: (entry: T) => string,
): boolean {
  const seen = new Set<string>();
  for (const entry of values) {
    const key = identity(entry);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function isUniqueIdentifierArray(
  value: unknown,
  maximum = MAX_NESTED_ITEMS,
): value is string[] {
  return (
    isArrayOf(value, maximum, isIdentifier) &&
    hasUniqueBy(value, (entry) => entry)
  );
}

function isTextArray(
  value: unknown,
  maximum = MAX_NESTED_ITEMS,
): value is string[] {
  return isArrayOf(value, maximum, isText);
}

function isCountMap(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_COUNT_MAP_KEYS &&
    entries.every(([key, count]) => isIdentifier(key) && isCount(count))
  );
}

function isBadge(value: unknown): value is IntegrationBadge {
  return (
    typeof value === "string" &&
    INTEGRATION_BADGES.has(value as IntegrationBadge)
  );
}

function isRuntimeStatus(value: unknown): value is IntegrationRuntimeStatus {
  return (
    typeof value === "string" &&
    RUNTIME_STATUSES.has(value as IntegrationRuntimeStatus)
  );
}

function isLifecycleAction(
  value: unknown,
): value is IntegrationLifecycleAction {
  return (
    typeof value === "string" &&
    LIFECYCLE_ACTIONS.has(value as IntegrationLifecycleAction)
  );
}

function isHealthState(value: unknown): value is IntegrationHealthState {
  return (
    typeof value === "string" &&
    HEALTH_STATES.has(value as IntegrationHealthState)
  );
}

function isCatalogItem(value: unknown): value is IntegrationCatalogItem {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value.slug) &&
    isIdentifier(value.name) &&
    isIdentifier(value.category) &&
    isBadge(value.badge) &&
    isRuntimeStatus(value.runtime_status) &&
    isText(value.summary) &&
    isUniqueIdentifierArray(value.capabilities) &&
    typeof value.native === "boolean" &&
    isOptionalText(value.docs_url) &&
    isOptionalText(value.setup_path) &&
    (value.featured === undefined || typeof value.featured === "boolean") &&
    isOptionalText(value.phase) &&
    (value.sources === undefined || isUniqueIdentifierArray(value.sources))
  );
}

function isCatalogCategory(
  value: unknown,
): value is { key: string; label: string } {
  return (
    isRecord(value) && isIdentifier(value.key) && isIdentifier(value.label)
  );
}

/**
 * Validate the catalog response at the renderer boundary. Unknown object fields
 * remain allowed so additive server fields do not break an older desktop, while
 * every field consumed by the current UI is bounded and type checked.
 */
export function parseIntegrationsCatalog(
  value: unknown,
): IntegrationsCatalogResponse | null {
  if (!isRecord(value)) return null;
  if (
    !isIdentifier(value.schema_version) ||
    !isCount(value.target_public_entries) ||
    !isCount(value.target_native_managed) ||
    !isArrayOf(value.honest_badges, INTEGRATION_BADGES.size, isBadge) ||
    !hasUniqueBy(value.honest_badges, (badge) => badge) ||
    !isArrayOf(value.categories, MAX_NESTED_ITEMS, isCatalogCategory) ||
    !hasUniqueBy(value.categories, (category) => category.key) ||
    !isUniqueIdentifierArray(value.capabilities) ||
    !isArrayOf(value.items, MAX_TOP_LEVEL_ITEMS, isCatalogItem) ||
    !hasUniqueBy(value.items, (item) => item.slug) ||
    !isCountMap(value.counts)
  ) {
    return null;
  }
  const categories = new Set(value.categories.map((category) => category.key));
  if (!value.items.every((item) => categories.has(item.category))) return null;
  return value as unknown as IntegrationsCatalogResponse;
}

function isReadinessCheck(value: unknown): value is IntegrationReadinessCheck {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value.key) &&
    isIdentifier(value.label) &&
    typeof value.state === "string" &&
    READINESS_STATES.has(value.state) &&
    typeof value.severity === "string" &&
    READINESS_SEVERITIES.has(value.severity) &&
    isCount(value.count) &&
    isText(value.message)
  );
}

function isReadinessIssue(value: unknown): value is IntegrationReadinessIssue {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value.key) &&
    typeof value.severity === "string" &&
    (value.severity === "warning" || value.severity === "blocker") &&
    isText(value.message) &&
    (value.slug === undefined || isIdentifier(value.slug)) &&
    (value.name === undefined || isText(value.name)) &&
    (value.category === undefined || isIdentifier(value.category)) &&
    isOptionalText(value.remediation)
  );
}

const READINESS_COUNT_FIELDS = [
  "public_entries",
  "target_public_entries",
  "native_managed",
  "target_native_managed",
  "native_verified",
  "target_native_verified",
  "native_partial",
  "native_delegated",
  "bridge_ready",
  "available_recipes",
] as const;

const READINESS_BOOLEAN_FIELDS = [
  "ready",
  "marketable_public_claim",
  "public_parity",
  "native_parity",
  "native_verification_parity",
] as const;

export function parseIntegrationsReadiness(
  value: unknown,
): IntegrationsReadinessResponse | null {
  if (!isRecord(value)) return null;
  if (
    !isIdentifier(value.schema_version) ||
    !isText(value.public_claim) ||
    READINESS_COUNT_FIELDS.some((field) => !isCount(value[field])) ||
    READINESS_BOOLEAN_FIELDS.some(
      (field) => typeof value[field] !== "boolean",
    ) ||
    !isArrayOf(value.checks, MAX_NESTED_ITEMS, isReadinessCheck) ||
    !hasUniqueBy(value.checks, (check) => check.key) ||
    !isArrayOf(value.issues, MAX_TOP_LEVEL_ITEMS, isReadinessIssue) ||
    !hasUniqueBy(
      value.issues,
      (issue) =>
        `${issue.key}\u0000${issue.slug ?? ""}\u0000${issue.category ?? ""}`,
    ) ||
    !isCountMap(value.issue_counts) ||
    !isTextArray(value.recommendations)
  ) {
    return null;
  }
  return value as unknown as IntegrationsReadinessResponse;
}

function isConnection(value: unknown): value is IntegrationConnection {
  if (!isRecord(value)) return false;
  if (
    !isIdentifier(value.slug) ||
    !isIdentifier(value.name) ||
    !isIdentifier(value.category) ||
    !isBadge(value.badge) ||
    !isRuntimeStatus(value.runtime_status) ||
    typeof value.connected !== "boolean" ||
    !isIdentifier(value.status) ||
    !isCount(value.count) ||
    (value.primary_connection_id !== undefined &&
      !isIdentifier(value.primary_connection_id)) ||
    (value.connection_ids !== undefined &&
      !isUniqueIdentifierArray(value.connection_ids, 64)) ||
    !isOptionalTimestamp(value.last_sync_at) ||
    !isOptionalText(value.last_error) ||
    !isOptionalText(value.manage_path) ||
    !isOptionalText(value.source) ||
    !isHealthState(value.health_state) ||
    !isText(value.health_message)
  ) {
    return false;
  }
  if (value.primary_connection_id !== undefined) {
    if (
      !Array.isArray(value.connection_ids) ||
      !value.connection_ids.includes(value.primary_connection_id)
    ) {
      return false;
    }
  }
  return true;
}

export function parseIntegrationsConnections(
  value: unknown,
): IntegrationsConnectionsResponse | null {
  if (!isRecord(value)) return null;
  if (
    !isArrayOf(value.items, MAX_TOP_LEVEL_ITEMS, isConnection) ||
    !hasUniqueBy(value.items, (item) => item.slug) ||
    !isCountMap(value.summary) ||
    !isCount(value.returned) ||
    value.returned !== value.items.length
  ) {
    return null;
  }
  return value as unknown as IntegrationsConnectionsResponse;
}

function isCategoryCoverage(
  value: unknown,
): value is IntegrationCategoryCoverage {
  if (!isRecord(value)) return false;
  const countFields = [
    "total",
    "native_managed",
    "native_verified",
    "native_partial",
    "native_delegated",
    "bridge_ready",
    "planned",
    "available_recipes",
  ] as const;
  return (
    isIdentifier(value.key) &&
    isIdentifier(value.label) &&
    countFields.every((field) => isCount(value[field])) &&
    typeof value.maturity === "string" &&
    COVERAGE_MATURITIES.has(value.maturity as IntegrationCoverageMaturity)
  );
}

function isPriorityGap(value: unknown): value is IntegrationPriorityGap {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value.slug) &&
    isIdentifier(value.name) &&
    isIdentifier(value.category) &&
    isOptionalText(value.phase) &&
    isBadge(value.current_badge) &&
    isRuntimeStatus(value.runtime_status) &&
    typeof value.bridge_available === "boolean" &&
    isText(value.reason)
  );
}

const COVERAGE_COUNT_FIELDS = [
  "target_public_entries",
  "target_native_managed",
  "target_native_verified",
  "public_entries",
  "native_managed",
  "native_verified",
  "native_partial",
  "native_delegated",
  "public_gap",
  "native_gap",
  "native_verification_gap",
  "bridge_ready",
  "planned",
  "available_recipes",
  "generated_recipes",
] as const;

const COVERAGE_BOOLEAN_FIELDS = [
  "public_parity",
  "native_parity",
  "native_verification_parity",
] as const;

export function parseIntegrationsCoverage(
  value: unknown,
): IntegrationsCoverageResponse | null {
  if (!isRecord(value)) return null;
  if (
    !isIdentifier(value.schema_version) ||
    COVERAGE_COUNT_FIELDS.some((field) => !isCount(value[field])) ||
    COVERAGE_BOOLEAN_FIELDS.some(
      (field) => typeof value[field] !== "boolean",
    ) ||
    !isCountMap(value.badge_counts) ||
    !isCountMap(value.phase_counts) ||
    !isCountMap(value.maturity_counts) ||
    !isArrayOf(value.categories, MAX_NESTED_ITEMS, isCategoryCoverage) ||
    !hasUniqueBy(value.categories, (category) => category.key) ||
    !isArrayOf(value.priority_gaps, MAX_TOP_LEVEL_ITEMS, isPriorityGap) ||
    !hasUniqueBy(value.priority_gaps, (gap) => gap.slug)
  ) {
    return null;
  }
  return value as unknown as IntegrationsCoverageResponse;
}

function isStackComponent(value: unknown): value is IntegrationStackComponent {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value.slug) &&
    isIdentifier(value.name) &&
    isIdentifier(value.role) &&
    typeof value.required === "boolean" &&
    isIdentifier(value.category) &&
    isBadge(value.badge) &&
    isRuntimeStatus(value.runtime_status) &&
    typeof value.available === "boolean" &&
    typeof value.native_managed === "boolean" &&
    typeof value.bridge_available === "boolean" &&
    isOptionalText(value.setup_path) &&
    isText(value.reason)
  );
}

function isCustomerStack(
  value: unknown,
): value is IntegrationCustomerStackCoverage {
  if (!isRecord(value)) return false;
  if (
    !isIdentifier(value.key) ||
    !isIdentifier(value.name) ||
    !isIdentifier(value.segment) ||
    !isText(value.summary) ||
    typeof value.status !== "string" ||
    !STACK_STATUSES.has(value.status as IntegrationStackStatus) ||
    !isPercentage(value.coverage_pct) ||
    !isCount(value.required_covered) ||
    !isCount(value.required_total) ||
    value.required_covered > value.required_total ||
    !isCount(value.optional_covered) ||
    !isCount(value.optional_total) ||
    value.optional_covered > value.optional_total ||
    !isCount(value.native_managed) ||
    !isCount(value.bridge_ready) ||
    (value.planned_gaps !== undefined &&
      !isUniqueIdentifierArray(value.planned_gaps)) ||
    !isArrayOf(value.components, MAX_NESTED_ITEMS, isStackComponent) ||
    !hasUniqueBy(value.components, (component) => component.slug) ||
    !isTextArray(value.next_actions)
  ) {
    return false;
  }
  return true;
}

function isStackGap(value: unknown): value is IntegrationStackGap {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value.slug) &&
    isIdentifier(value.name) &&
    isCount(value.stacks) &&
    isCount(value.required_count) &&
    value.required_count <= value.stacks &&
    isText(value.reason)
  );
}

export function parseIntegrationsStacks(
  value: unknown,
): IntegrationsStackReport | null {
  if (!isRecord(value)) return null;
  if (
    !isIdentifier(value.schema_version) ||
    !isPercentage(value.target_coverage_pct) ||
    !isPercentage(value.covered_pct) ||
    !isCount(value.covered_stacks) ||
    !isCount(value.total_stacks) ||
    value.covered_stacks > value.total_stacks ||
    !isCountMap(value.summary) ||
    !isArrayOf(value.stacks, MAX_NESTED_ITEMS, isCustomerStack) ||
    value.total_stacks !== value.stacks.length ||
    !hasUniqueBy(value.stacks, (stack) => stack.key) ||
    !isArrayOf(value.highest_impact_gaps, MAX_NESTED_ITEMS, isStackGap) ||
    !hasUniqueBy(value.highest_impact_gaps, (gap) => gap.slug) ||
    typeof value.newsletter_commerce_ok !== "boolean"
  ) {
    return null;
  }
  return value as unknown as IntegrationsStackReport;
}

function isSetupStep(value: unknown): value is IntegrationSetupStep {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value.title) &&
    isText(value.description) &&
    isOptionalText(value.action) &&
    isOptionalText(value.path) &&
    (value.required_fields === undefined ||
      isUniqueIdentifierArray(value.required_fields, 64))
  );
}

function isFieldMapping(value: unknown): value is IntegrationFieldMapping {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value.source) &&
    isIdentifier(value.target) &&
    typeof value.required === "boolean" &&
    isOptionalText(value.description)
  );
}

interface JsonBudget {
  nodes: number;
}

function isBoundedJson(
  value: unknown,
  depth: number,
  budget: JsonBudget,
): boolean {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return isText(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_NESTED_ITEMS &&
      value.every((entry) => isBoundedJson(entry, depth + 1, budget))
    );
  }
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_NESTED_ITEMS &&
    entries.every(
      ([key, entry]) =>
        isIdentifier(key) && isBoundedJson(entry, depth + 1, budget),
    )
  );
}

function isRecipeBlueprint(
  value: unknown,
): value is IntegrationRecipeBlueprint {
  if (!isRecord(value)) return false;
  if (
    !isIdentifier(value.trigger) ||
    !isIdentifier(value.destination) ||
    !isIdentifier(value.postwave_surface) ||
    (value.required_scopes !== undefined &&
      !isUniqueIdentifierArray(value.required_scopes)) ||
    (value.required_secrets !== undefined &&
      !isUniqueIdentifierArray(value.required_secrets)) ||
    (value.events !== undefined && !isUniqueIdentifierArray(value.events)) ||
    (value.field_mappings !== undefined &&
      (!isArrayOf(value.field_mappings, MAX_NESTED_ITEMS, isFieldMapping) ||
        !hasUniqueBy(
          value.field_mappings,
          (mapping) => `${mapping.source}\u0000${mapping.target}`,
        ))) ||
    (value.sample_payload !== undefined &&
      (!isRecord(value.sample_payload) ||
        !isBoundedJson(value.sample_payload, 0, { nodes: 0 }))) ||
    (value.data_handling !== undefined && !isTextArray(value.data_handling))
  ) {
    return false;
  }
  return true;
}

function isRecipe(value: unknown): value is IntegrationRecipe {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value.id) &&
    isIdentifier(value.name) &&
    isIdentifier(value.provider) &&
    isIdentifier(value.source_slug) &&
    (value.target_slug === undefined || isIdentifier(value.target_slug)) &&
    isText(value.summary) &&
    isBadge(value.badge) &&
    typeof value.available === "boolean" &&
    isCount(value.estimated_minutes) &&
    isOptionalText(value.setup_path) &&
    isOptionalText(value.docs_url) &&
    isUniqueIdentifierArray(value.capabilities) &&
    isArrayOf(value.steps, 64, isSetupStep) &&
    isRecipeBlueprint(value.blueprint)
  );
}

export function parseIntegrationsRecipes(
  value: unknown,
): IntegrationsRecipesResponse | null {
  if (!isRecord(value)) return null;
  if (
    !isArrayOf(value.items, MAX_TOP_LEVEL_ITEMS, isRecipe) ||
    !hasUniqueBy(value.items, (recipe) => recipe.id) ||
    !isCountMap(value.summary)
  ) {
    return null;
  }
  return value as unknown as IntegrationsRecipesResponse;
}

function isHealthCheck(value: unknown): value is IntegrationHealthCheck {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value.key) &&
    isIdentifier(value.label) &&
    typeof value.state === "string" &&
    HEALTH_CHECK_STATES.has(value.state) &&
    isText(value.message)
  );
}

function isRetryPolicy(value: unknown): value is IntegrationRetryPolicy {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value.mode) &&
    isCount(value.max_attempts) &&
    isText(value.backoff) &&
    isText(value.dead_letter) &&
    isText(value.idempotency)
  );
}

function isSyncHistoryEntry(
  value: unknown,
): value is IntegrationSyncHistoryEntry {
  if (!isRecord(value)) return false;
  return (
    isOptionalTimestamp(value.at) &&
    isIdentifier(value.action) &&
    isIdentifier(value.status) &&
    (value.attempts === undefined || isCount(value.attempts)) &&
    isText(value.message) &&
    isOptionalText(value.error)
  );
}

function isAuditTrailEntry(
  value: unknown,
): value is IntegrationAuditTrailEntry {
  if (!isRecord(value)) return false;
  return (
    isOptionalTimestamp(value.at) &&
    isIdentifier(value.action) &&
    isIdentifier(value.actor) &&
    isText(value.message)
  );
}

function isDataDeleteAction(
  value: unknown,
): value is IntegrationDataDeleteAction {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value.method) &&
    isText(value.path) &&
    isText(value.description)
  );
}

function isHealthReport(value: unknown): value is IntegrationHealthReport {
  if (!isRecord(value)) return false;
  return (
    isHealthState(value.state) &&
    typeof value.severity === "string" &&
    HEALTH_SEVERITIES.has(value.severity) &&
    isText(value.message) &&
    isIdentifier(value.monitoring_surface) &&
    isOptionalText(value.docs_url) &&
    isArrayOf(value.checks, MAX_NESTED_ITEMS, isHealthCheck) &&
    hasUniqueBy(value.checks, (check) => check.key) &&
    isRetryPolicy(value.retry_policy) &&
    isArrayOf(value.sync_history, MAX_NESTED_ITEMS, isSyncHistoryEntry) &&
    isArrayOf(value.audit_trail, MAX_NESTED_ITEMS, isAuditTrailEntry) &&
    isArrayOf(value.data_delete, MAX_NESTED_ITEMS, isDataDeleteAction)
  );
}

function isConnectorContract(
  value: unknown,
): value is IntegrationConnectorContract {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value.slug) &&
    isIdentifier(value.owner) &&
    isBadge(value.badge) &&
    isRuntimeStatus(value.runtime_status) &&
    typeof value.native_managed === "boolean" &&
    typeof value.native_verified === "boolean" &&
    isIdentifier(value.implementation_depth) &&
    isText(value.public_claim) &&
    isUniqueIdentifierArray(value.auth_modes) &&
    isText(value.credential_storage) &&
    isText(value.secret_policy) &&
    isIdentifier(value.setup_surface) &&
    isUniqueIdentifierArray(value.monitoring) &&
    isArrayOf(value.lifecycle_actions, 32, isLifecycleAction) &&
    hasUniqueBy(value.lifecycle_actions, (action) => action) &&
    (value.bridge_channels === undefined ||
      isUniqueIdentifierArray(value.bridge_channels)) &&
    (value.required_scopes === undefined ||
      isUniqueIdentifierArray(value.required_scopes)) &&
    isUniqueIdentifierArray(value.data_objects) &&
    isUniqueIdentifierArray(value.event_topics) &&
    isUniqueIdentifierArray(value.compliance_gates) &&
    isUniqueIdentifierArray(value.privacy_actions) &&
    isText(value.rate_limit_policy) &&
    isText(value.partner_review)
  );
}

export function parseIntegrationDetail(
  value: unknown,
  expectedSlug?: string,
): IntegrationDetailResponse | null {
  if (!isRecord(value)) return null;
  if (
    !isCatalogItem(value.item) ||
    !isConnection(value.connection) ||
    !isArrayOf(value.setup, 64, isSetupStep) ||
    !isArrayOf(value.recipes, MAX_TOP_LEVEL_ITEMS, isRecipe) ||
    !hasUniqueBy(value.recipes, (recipe) => recipe.id) ||
    !isArrayOf(value.lifecycle_actions, 32, isLifecycleAction) ||
    !hasUniqueBy(value.lifecycle_actions, (action) => action) ||
    !isHealthReport(value.health) ||
    !isConnectorContract(value.contract)
  ) {
    return null;
  }
  const itemSlug = value.item.slug;
  if (
    (expectedSlug !== undefined && itemSlug !== expectedSlug) ||
    value.connection.slug !== itemSlug ||
    value.contract.slug !== itemSlug ||
    value.connection.category !== value.item.category ||
    value.connection.badge !== value.item.badge ||
    value.connection.runtime_status !== value.item.runtime_status ||
    value.contract.badge !== value.item.badge ||
    value.contract.runtime_status !== value.item.runtime_status ||
    value.connection.health_state !== value.health.state ||
    !value.recipes.every(
      (recipe) =>
        recipe.source_slug === itemSlug || recipe.target_slug === itemSlug,
    )
  ) {
    return null;
  }
  return value as unknown as IntegrationDetailResponse;
}

export function parseIntegrationRecipeDetail(
  value: unknown,
  expectedRecipeID?: string,
): IntegrationRecipeDetailResponse | null {
  if (!isRecord(value)) return null;
  if (
    !isRecipe(value.recipe) ||
    !isCatalogItem(value.source) ||
    (value.target !== undefined && !isCatalogItem(value.target))
  ) {
    return null;
  }
  if (
    (expectedRecipeID !== undefined && value.recipe.id !== expectedRecipeID) ||
    value.source.slug !== value.recipe.source_slug
  ) {
    return null;
  }
  // Some recipe targets are owning surfaces (for example "migrations") rather
  // than catalog tiles, so the handler legitimately omits `target`. When a
  // target object is present, however, it must be the recipe's declared target.
  if (
    value.target !== undefined &&
    value.target.slug !== value.recipe.target_slug
  ) {
    return null;
  }
  return value as unknown as IntegrationRecipeDetailResponse;
}

export interface ExpectedIntegrationActionIdentity {
  slug?: string;
  action?: IntegrationLifecycleAction;
}

export function parseIntegrationActionResponse(
  value: unknown,
  expected: ExpectedIntegrationActionIdentity = {},
): IntegrationActionResponse | null {
  if (!isRecord(value)) return null;
  if (
    !isIdentifier(value.slug) ||
    !isLifecycleAction(value.action) ||
    typeof value.status !== "string" ||
    !ACTION_STATUSES.has(value.status as IntegrationActionStatus) ||
    !isText(value.message) ||
    !isOptionalText(value.delegated_to) ||
    (value.primary_connection_id !== undefined &&
      !isIdentifier(value.primary_connection_id)) ||
    (value.connection_ids !== undefined &&
      !isUniqueIdentifierArray(value.connection_ids, 64)) ||
    (value.required_fields !== undefined &&
      !isUniqueIdentifierArray(value.required_fields, 64)) ||
    !isOptionalText(value.docs_url) ||
    !isOptionalText(value.manage_path)
  ) {
    return null;
  }
  if (
    (expected.slug !== undefined && value.slug !== expected.slug) ||
    (expected.action !== undefined && value.action !== expected.action)
  ) {
    return null;
  }
  if (
    value.primary_connection_id !== undefined &&
    (!Array.isArray(value.connection_ids) ||
      !value.connection_ids.includes(value.primary_connection_id))
  ) {
    return null;
  }
  return value as unknown as IntegrationActionResponse;
}

export function parseIntegrationRecipeApplyResponse(
  value: unknown,
  expectedRecipeID?: string,
): IntegrationRecipeApplyResponse | null {
  if (!isRecord(value)) return null;
  if (
    !isIdentifier(value.recipe_id) ||
    typeof value.status !== "string" ||
    !RECIPE_PREPARATION_STATUSES.has(
      value.status as IntegrationRecipePreparationStatus,
    ) ||
    !isText(value.message) ||
    !isOptionalText(value.delegated_to) ||
    !isOptionalText(value.manage_path) ||
    (value.required_fields !== undefined &&
      !isUniqueIdentifierArray(value.required_fields, 64)) ||
    (value.next_steps !== undefined &&
      !isArrayOf(value.next_steps, 64, isSetupStep)) ||
    !isRecipeBlueprint(value.blueprint)
  ) {
    return null;
  }
  if (expectedRecipeID !== undefined && value.recipe_id !== expectedRecipeID) {
    return null;
  }
  return value as unknown as IntegrationRecipeApplyResponse;
}

// The endpoint currently uses /apply even though it prepares a delegated
// blueprint. Export an explicit semantic alias for future controller wiring.
export const parseIntegrationRecipePrepareResponse =
  parseIntegrationRecipeApplyResponse;
