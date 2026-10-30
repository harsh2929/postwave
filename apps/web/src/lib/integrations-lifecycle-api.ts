// SPDX-License-Identifier: AGPL-3.0-only
//
// integrations-lifecycle-api.ts — typed client for the generic integrations
// facade (apps/api/internal/integrations/handlers.go MountRoutes) and the
// native-family lifecycle routes the facade delegates to.
//
// The facade is the same contract desktop reads through
// useIntegrationLifecycleController / useIntegrationRecipeController:
//   reads   GET  /api/v1/integrations/{slug}            (detail)
//           GET  /api/v1/integrations/{slug}/health
//           GET  /api/v1/integrations/{slug}/contract
//           GET  /api/v1/integrations/{connections,coverage,stacks,readiness,recipes}
//           GET  /api/v1/integrations/recipes/{id}
//   writes  POST /api/v1/integrations/{slug}/{connect/start,sync,backfill,pause}
//           DELETE /api/v1/integrations/{slug}
//           POST /api/v1/integrations/recipes/{id}/apply
//
// The facade's lifecycle writes are DELEGATIONS: they answer 202 with the
// owning surface's endpoint and a sentence, and change nothing themselves (a
// planned integration answers 409 with the same shape). Account-specific work
// runs on the native family route (e.g. POST /api/v1/crm/integrations/{id}/
// backfill) against ONE exact connection id — the same dispatch desktop's
// runNativeManagedLifecycleAction performs.
//
// Every response is parsed before it is rendered: a malformed or mismatched
// body (wrong slug, wrong action, wrong recipe) throws, so a screen shows a
// failed read instead of painting another integration's evidence.

import { api } from "./api";

/* ---------- small, strict wire readers --------------------------------- */

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function flag(value: unknown): boolean {
  return value === true;
}

function texts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function listOf<T>(value: unknown, parse: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const entry of value) {
    const parsed = parse(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

function counts(value: unknown): Record<string, number> {
  const source = rec(value);
  if (!source) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(source)) {
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}

/**
 * Thrown when the server's body cannot be verified as the evidence that was
 * asked for. Rendered as a failed request — never as an empty or healthy one.
 */
export class IntegrationEvidenceError extends Error {
  constructor(what: string) {
    super(
      `The server returned malformed or mismatched ${what}. Nothing is shown in its place.`,
    );
    this.name = "IntegrationEvidenceError";
  }
}

/* ---------- catalog item + connection ---------------------------------- */

export interface LifecycleCatalogItem {
  slug: string;
  name: string;
  category: string;
  badge: string;
  runtime_status: string;
  summary: string;
  capabilities: string[];
  docs_url?: string;
  setup_path?: string;
  native: boolean;
  sources: string[];
}

function parseCatalogItem(value: unknown): LifecycleCatalogItem | null {
  const row = rec(value);
  if (!row || !text(row.slug) || !text(row.name)) return null;
  return {
    slug: text(row.slug),
    name: text(row.name),
    category: text(row.category),
    badge: text(row.badge),
    runtime_status: text(row.runtime_status),
    summary: text(row.summary),
    capabilities: texts(row.capabilities),
    docs_url: optionalText(row.docs_url),
    setup_path: optionalText(row.setup_path),
    native: flag(row.native),
    sources: texts(row.sources),
  };
}

export interface IntegrationConnection {
  slug: string;
  name: string;
  category: string;
  badge: string;
  runtime_status: string;
  connected: boolean;
  status: string;
  count: number;
  primary_connection_id?: string;
  connection_ids: string[];
  last_sync_at?: string;
  last_error?: string;
  manage_path?: string;
  source?: string;
  health_state: string;
  health_message: string;
}

function parseConnection(value: unknown): IntegrationConnection | null {
  const row = rec(value);
  if (!row || !text(row.slug)) return null;
  return {
    slug: text(row.slug),
    name: text(row.name),
    category: text(row.category),
    badge: text(row.badge),
    runtime_status: text(row.runtime_status),
    connected: flag(row.connected),
    status: text(row.status),
    count: count(row.count),
    primary_connection_id: optionalText(row.primary_connection_id),
    connection_ids: texts(row.connection_ids),
    last_sync_at: optionalText(row.last_sync_at),
    last_error: optionalText(row.last_error),
    manage_path: optionalText(row.manage_path),
    source: optionalText(row.source),
    health_state: text(row.health_state),
    health_message: text(row.health_message),
  };
}

/**
 * Every distinct connection id the server reported for a catalog row. The
 * exact-target rule (one id, or nothing account-specific runs) reads this.
 */
export function connectionIds(
  connection: IntegrationConnection | null | undefined,
): string[] {
  if (!connection) return [];
  const ids = [...connection.connection_ids];
  if (connection.primary_connection_id) ids.push(connection.primary_connection_id);
  return Array.from(new Set(ids.filter(Boolean)));
}

/** True when the workspace holds more than one account for this row. */
export function connectionIsAmbiguous(
  connection: IntegrationConnection | null | undefined,
): boolean {
  if (!connection) return false;
  return Math.max(connection.count, connectionIds(connection).length) > 1;
}

/* ---------- health + contract ------------------------------------------ */

export interface HealthCheck {
  key: string;
  label: string;
  state: string;
  message: string;
}

export interface SyncHistoryEntry {
  at?: string;
  action: string;
  status: string;
  attempts: number;
  message: string;
  error?: string;
}

export interface HealthReport {
  state: string;
  severity: string;
  message: string;
  monitoring_surface: string;
  docs_url?: string;
  checks: HealthCheck[];
  retry_policy: {
    mode: string;
    max_attempts: number;
    backoff: string;
    dead_letter: string;
    idempotency: string;
  };
  sync_history: SyncHistoryEntry[];
}

export function parseHealthReport(value: unknown): HealthReport {
  const row = rec(value);
  if (!row || !text(row.state)) {
    throw new IntegrationEvidenceError("integration health");
  }
  const retry = rec(row.retry_policy) ?? {};
  return {
    state: text(row.state),
    severity: text(row.severity),
    message: text(row.message),
    monitoring_surface: text(row.monitoring_surface),
    docs_url: optionalText(row.docs_url),
    checks: listOf(row.checks, (entry) => {
      const check = rec(entry);
      return check && text(check.key)
        ? {
            key: text(check.key),
            label: text(check.label),
            state: text(check.state),
            message: text(check.message),
          }
        : null;
    }),
    retry_policy: {
      mode: text(retry.mode),
      max_attempts: count(retry.max_attempts),
      backoff: text(retry.backoff),
      dead_letter: text(retry.dead_letter),
      idempotency: text(retry.idempotency),
    },
    sync_history: listOf(row.sync_history, (entry) => {
      const run = rec(entry);
      return run && text(run.action)
        ? {
            at: optionalText(run.at),
            action: text(run.action),
            status: text(run.status),
            attempts: count(run.attempts),
            message: text(run.message),
            error: optionalText(run.error),
          }
        : null;
    }),
  };
}

export interface ConnectorContract {
  slug: string;
  owner: string;
  badge: string;
  runtime_status: string;
  native_managed: boolean;
  native_verified: boolean;
  implementation_depth: string;
  public_claim: string;
  auth_modes: string[];
  credential_storage: string;
  secret_policy: string;
  setup_surface: string;
  monitoring: string[];
  lifecycle_actions: string[];
  required_scopes: string[];
  data_objects: string[];
  event_topics: string[];
  compliance_gates: string[];
  privacy_actions: string[];
  rate_limit_policy: string;
  partner_review: string;
}

export function parseConnectorContract(
  value: unknown,
  expectedSlug: string,
): ConnectorContract {
  const row = rec(value);
  if (!row || text(row.slug) !== expectedSlug) {
    throw new IntegrationEvidenceError("connector contract");
  }
  return {
    slug: text(row.slug),
    owner: text(row.owner),
    badge: text(row.badge),
    runtime_status: text(row.runtime_status),
    native_managed: flag(row.native_managed),
    native_verified: flag(row.native_verified),
    implementation_depth: text(row.implementation_depth),
    public_claim: text(row.public_claim),
    auth_modes: texts(row.auth_modes),
    credential_storage: text(row.credential_storage),
    secret_policy: text(row.secret_policy),
    setup_surface: text(row.setup_surface),
    monitoring: texts(row.monitoring),
    lifecycle_actions: texts(row.lifecycle_actions),
    required_scopes: texts(row.required_scopes),
    data_objects: texts(row.data_objects),
    event_topics: texts(row.event_topics),
    compliance_gates: texts(row.compliance_gates),
    privacy_actions: texts(row.privacy_actions),
    rate_limit_policy: text(row.rate_limit_policy),
    partner_review: text(row.partner_review),
  };
}

/* ---------- setup steps + recipes -------------------------------------- */

export interface SetupStep {
  title: string;
  description: string;
  action?: string;
  path?: string;
  required_fields: string[];
}

function parseSetupStep(value: unknown): SetupStep | null {
  const row = rec(value);
  if (!row || !text(row.title)) return null;
  return {
    title: text(row.title),
    description: text(row.description),
    action: optionalText(row.action),
    path: optionalText(row.path),
    required_fields: texts(row.required_fields),
  };
}

export interface FieldMapping {
  source: string;
  target: string;
  required: boolean;
  description?: string;
}

export interface RecipeBlueprint {
  trigger: string;
  destination: string;
  postwave_surface: string;
  required_scopes: string[];
  required_secrets: string[];
  events: string[];
  field_mappings: FieldMapping[];
  data_handling: string[];
}

function parseBlueprint(value: unknown): RecipeBlueprint {
  const row = rec(value) ?? {};
  return {
    trigger: text(row.trigger),
    destination: text(row.destination),
    postwave_surface: text(row.postwave_surface),
    required_scopes: texts(row.required_scopes),
    required_secrets: texts(row.required_secrets),
    events: texts(row.events),
    field_mappings: listOf(row.field_mappings, (entry) => {
      const mapping = rec(entry);
      return mapping && text(mapping.source)
        ? {
            source: text(mapping.source),
            target: text(mapping.target),
            required: flag(mapping.required),
            description: optionalText(mapping.description),
          }
        : null;
    }),
    data_handling: texts(row.data_handling),
  };
}

export interface IntegrationRecipe {
  id: string;
  name: string;
  provider: string;
  source_slug: string;
  target_slug?: string;
  summary: string;
  badge: string;
  available: boolean;
  estimated_minutes: number;
  setup_path?: string;
  docs_url?: string;
  capabilities: string[];
  steps: SetupStep[];
  blueprint: RecipeBlueprint;
}

function parseRecipe(value: unknown): IntegrationRecipe | null {
  const row = rec(value);
  if (!row || !text(row.id) || !text(row.name)) return null;
  return {
    id: text(row.id),
    name: text(row.name),
    provider: text(row.provider),
    source_slug: text(row.source_slug),
    target_slug: optionalText(row.target_slug),
    summary: text(row.summary),
    badge: text(row.badge),
    available: flag(row.available),
    estimated_minutes: count(row.estimated_minutes),
    setup_path: optionalText(row.setup_path),
    docs_url: optionalText(row.docs_url),
    capabilities: texts(row.capabilities),
    steps: listOf(row.steps, parseSetupStep),
    blueprint: parseBlueprint(row.blueprint),
  };
}

/* ---------- detail ------------------------------------------------------ */

export interface IntegrationDetail {
  item: LifecycleCatalogItem;
  connection: IntegrationConnection;
  setup: SetupStep[];
  recipes: IntegrationRecipe[];
  lifecycle_actions: string[];
  health: HealthReport;
  contract: ConnectorContract;
}

export function parseIntegrationDetail(
  value: unknown,
  expectedSlug: string,
): IntegrationDetail {
  const row = rec(value);
  const item = parseCatalogItem(row?.item);
  const connection = parseConnection(row?.connection);
  if (
    !row ||
    !item ||
    !connection ||
    item.slug !== expectedSlug ||
    connection.slug !== expectedSlug
  ) {
    throw new IntegrationEvidenceError("integration detail");
  }
  return {
    item,
    connection,
    setup: listOf(row.setup, parseSetupStep),
    recipes: listOf(row.recipes, parseRecipe),
    lifecycle_actions: texts(row.lifecycle_actions),
    health: parseHealthReport(row.health),
    contract: parseConnectorContract(row.contract, expectedSlug),
  };
}

/* ---------- lifecycle action (delegation) response ---------------------- */

export type FacadeLifecycleAction =
  | "connect/start"
  | "sync"
  | "backfill"
  | "pause"
  | "disconnect";

export interface IntegrationActionResponse {
  slug: string;
  action: string;
  /** "delegated" (202) or "unavailable" (409 for a planned row). */
  status: string;
  message: string;
  delegated_to?: string;
  primary_connection_id?: string;
  connection_ids: string[];
  required_fields: string[];
  docs_url?: string;
  manage_path?: string;
}

export function parseIntegrationActionResponse(
  value: unknown,
  expectedSlug: string,
  expectedAction: FacadeLifecycleAction,
): IntegrationActionResponse {
  const row = rec(value);
  if (
    !row ||
    text(row.slug) !== expectedSlug ||
    text(row.action) !== expectedAction ||
    !text(row.status) ||
    !text(row.message)
  ) {
    throw new IntegrationEvidenceError("lifecycle evidence");
  }
  return {
    slug: text(row.slug),
    action: text(row.action),
    status: text(row.status),
    message: text(row.message),
    delegated_to: optionalText(row.delegated_to),
    primary_connection_id: optionalText(row.primary_connection_id),
    connection_ids: texts(row.connection_ids),
    required_fields: texts(row.required_fields),
    docs_url: optionalText(row.docs_url),
    manage_path: optionalText(row.manage_path),
  };
}

/* ---------- recipe detail + preparation --------------------------------- */

export interface RecipeDetail {
  recipe: IntegrationRecipe;
  source: LifecycleCatalogItem | null;
  target: LifecycleCatalogItem | null;
}

export function parseRecipeDetail(value: unknown, expectedId: string): RecipeDetail {
  const row = rec(value);
  const recipe = parseRecipe(row?.recipe);
  if (!row || !recipe || recipe.id !== expectedId) {
    throw new IntegrationEvidenceError("recipe evidence");
  }
  return {
    recipe,
    source: parseCatalogItem(row.source),
    target: parseCatalogItem(row.target),
  };
}

export interface RecipeApplyResponse {
  recipe_id: string;
  status: string;
  message: string;
  delegated_to?: string;
  manage_path?: string;
  required_fields: string[];
  next_steps: SetupStep[];
  blueprint: RecipeBlueprint;
}

export function parseRecipeApplyResponse(
  value: unknown,
  expectedId: string,
): RecipeApplyResponse {
  const row = rec(value);
  if (
    !row ||
    text(row.recipe_id) !== expectedId ||
    !text(row.status) ||
    !text(row.message)
  ) {
    throw new IntegrationEvidenceError("setup-plan evidence");
  }
  return {
    recipe_id: text(row.recipe_id),
    status: text(row.status),
    message: text(row.message),
    delegated_to: optionalText(row.delegated_to),
    manage_path: optionalText(row.manage_path),
    required_fields: texts(row.required_fields),
    next_steps: listOf(row.next_steps, parseSetupStep),
    blueprint: parseBlueprint(row.blueprint),
  };
}

/* ---------- catalog-wide reports --------------------------------------- */

export interface ConnectionsReport {
  items: IntegrationConnection[];
  summary: Record<string, number>;
  returned: number;
}

export function parseConnectionsReport(value: unknown): ConnectionsReport {
  const row = rec(value);
  if (!row || !Array.isArray(row.items)) {
    throw new IntegrationEvidenceError("connection inventory");
  }
  const items = listOf(row.items, parseConnection);
  return { items, summary: counts(row.summary), returned: count(row.returned) };
}

export interface CoverageCategory {
  key: string;
  label: string;
  total: number;
  native_managed: number;
  bridge_ready: number;
  planned: number;
  available_recipes: number;
  maturity: string;
}

export interface CoveragePriorityGap {
  slug: string;
  name: string;
  category: string;
  reason: string;
  bridge_available: boolean;
}

export interface CoverageReport {
  public_entries: number;
  target_public_entries: number;
  native_managed: number;
  target_native_managed: number;
  native_verified: number;
  target_native_verified: number;
  bridge_ready: number;
  planned: number;
  available_recipes: number;
  public_parity: boolean;
  native_parity: boolean;
  categories: CoverageCategory[];
  priority_gaps: CoveragePriorityGap[];
}

export function parseCoverageReport(value: unknown): CoverageReport {
  const row = rec(value);
  if (!row || typeof row.public_entries !== "number") {
    throw new IntegrationEvidenceError("coverage report");
  }
  return {
    public_entries: count(row.public_entries),
    target_public_entries: count(row.target_public_entries),
    native_managed: count(row.native_managed),
    target_native_managed: count(row.target_native_managed),
    native_verified: count(row.native_verified),
    target_native_verified: count(row.target_native_verified),
    bridge_ready: count(row.bridge_ready),
    planned: count(row.planned),
    available_recipes: count(row.available_recipes),
    public_parity: flag(row.public_parity),
    native_parity: flag(row.native_parity),
    categories: listOf(row.categories, (entry) => {
      const category = rec(entry);
      return category && text(category.key)
        ? {
            key: text(category.key),
            label: text(category.label) || text(category.key),
            total: count(category.total),
            native_managed: count(category.native_managed),
            bridge_ready: count(category.bridge_ready),
            planned: count(category.planned),
            available_recipes: count(category.available_recipes),
            maturity: text(category.maturity),
          }
        : null;
    }),
    priority_gaps: listOf(row.priority_gaps, (entry) => {
      const gap = rec(entry);
      return gap && text(gap.slug)
        ? {
            slug: text(gap.slug),
            name: text(gap.name),
            category: text(gap.category),
            reason: text(gap.reason),
            bridge_available: flag(gap.bridge_available),
          }
        : null;
    }),
  };
}

export interface ReadinessCheck {
  key: string;
  label: string;
  state: string;
  severity: string;
  count: number;
  message: string;
}

export interface ReadinessIssue {
  key: string;
  severity: string;
  slug?: string;
  name?: string;
  message: string;
  remediation?: string;
}

export interface ReadinessReport {
  ready: boolean;
  marketable_public_claim: boolean;
  public_claim: string;
  checks: ReadinessCheck[];
  issues: ReadinessIssue[];
  recommendations: string[];
}

export function parseReadinessReport(value: unknown): ReadinessReport {
  const row = rec(value);
  if (!row || typeof row.ready !== "boolean") {
    throw new IntegrationEvidenceError("readiness report");
  }
  return {
    ready: row.ready,
    marketable_public_claim: flag(row.marketable_public_claim),
    public_claim: text(row.public_claim),
    checks: listOf(row.checks, (entry) => {
      const check = rec(entry);
      return check && text(check.key)
        ? {
            key: text(check.key),
            label: text(check.label),
            state: text(check.state),
            severity: text(check.severity),
            count: count(check.count),
            message: text(check.message),
          }
        : null;
    }),
    issues: listOf(row.issues, (entry) => {
      const issue = rec(entry);
      return issue && text(issue.key)
        ? {
            key: text(issue.key),
            severity: text(issue.severity),
            slug: optionalText(issue.slug),
            name: optionalText(issue.name),
            message: text(issue.message),
            remediation: optionalText(issue.remediation),
          }
        : null;
    }),
    recommendations: texts(row.recommendations),
  };
}

export interface StackComponent {
  slug: string;
  name: string;
  role: string;
  required: boolean;
  category: string;
  badge: string;
  available: boolean;
  reason: string;
}

export interface CustomerStack {
  key: string;
  name: string;
  segment: string;
  summary: string;
  status: string;
  coverage_pct: number;
  required_covered: number;
  required_total: number;
  components: StackComponent[];
  next_actions: string[];
}

export interface StackReport {
  covered_pct: number;
  target_coverage_pct: number;
  covered_stacks: number;
  total_stacks: number;
  stacks: CustomerStack[];
}

export function parseStackReport(value: unknown): StackReport {
  const row = rec(value);
  if (!row || !Array.isArray(row.stacks)) {
    throw new IntegrationEvidenceError("customer-stack report");
  }
  return {
    covered_pct: count(row.covered_pct),
    target_coverage_pct: count(row.target_coverage_pct),
    covered_stacks: count(row.covered_stacks),
    total_stacks: count(row.total_stacks),
    stacks: listOf(row.stacks, (entry) => {
      const stack = rec(entry);
      return stack && text(stack.key)
        ? {
            key: text(stack.key),
            name: text(stack.name) || text(stack.key),
            segment: text(stack.segment),
            summary: text(stack.summary),
            status: text(stack.status),
            coverage_pct: count(stack.coverage_pct),
            required_covered: count(stack.required_covered),
            required_total: count(stack.required_total),
            components: listOf(stack.components, (candidate) => {
              const component = rec(candidate);
              return component && text(component.slug)
                ? {
                    slug: text(component.slug),
                    name: text(component.name),
                    role: text(component.role),
                    required: flag(component.required),
                    category: text(component.category),
                    badge: text(component.badge),
                    available: flag(component.available),
                    reason: text(component.reason),
                  }
                : null;
            }),
            next_actions: texts(stack.next_actions),
          }
        : null;
    }),
  };
}

export interface RecipesReport {
  items: IntegrationRecipe[];
  summary: Record<string, number>;
}

export function parseRecipesReport(value: unknown): RecipesReport {
  const row = rec(value);
  if (!row || !Array.isArray(row.items)) {
    throw new IntegrationEvidenceError("recipe inventory");
  }
  return { items: listOf(row.items, parseRecipe), summary: counts(row.summary) };
}

/* ---------- facade client ----------------------------------------------- */

export interface LifecycleRequestOptions {
  signal?: AbortSignal;
}

// Integration data is workspace/admin scoped: never satisfy it from the
// URL-only offline cache, and never replay a lifecycle write automatically.
const ONLINE_ONCE = { requireOnline: true, maxAttempts: 1 } as const;

export interface ConnectionsQuery {
  footprint?: boolean;
  connected?: boolean;
  q?: string;
  category?: string;
  health?: string;
}

export interface RecipesQuery {
  q?: string;
  source?: string;
  target?: string;
  available?: boolean;
}

export const integrationsLifecycleApi = {
  detail: (slug: string, opts?: LifecycleRequestOptions) =>
    api
      .get<unknown>(`/api/v1/integrations/${encodeURIComponent(slug)}`, {
        ...opts,
        ...ONLINE_ONCE,
      })
      .then((body) => parseIntegrationDetail(body, slug)),

  health: (slug: string, opts?: LifecycleRequestOptions) =>
    api
      .get<unknown>(`/api/v1/integrations/${encodeURIComponent(slug)}/health`, {
        ...opts,
        ...ONLINE_ONCE,
      })
      .then(parseHealthReport),

  contract: (slug: string, opts?: LifecycleRequestOptions) =>
    api
      .get<unknown>(
        `/api/v1/integrations/${encodeURIComponent(slug)}/contract`,
        { ...opts, ...ONLINE_ONCE },
      )
      .then((body) => parseConnectorContract(body, slug)),

  connectStart: (slug: string, opts?: LifecycleRequestOptions) =>
    api
      .post<unknown>(
        `/api/v1/integrations/${encodeURIComponent(slug)}/connect/start`,
        {},
        { ...opts, ...ONLINE_ONCE },
      )
      .then((body) =>
        parseIntegrationActionResponse(body, slug, "connect/start"),
      ),

  sync: (slug: string, opts?: LifecycleRequestOptions) =>
    api
      .post<unknown>(
        `/api/v1/integrations/${encodeURIComponent(slug)}/sync`,
        {},
        { ...opts, ...ONLINE_ONCE },
      )
      .then((body) => parseIntegrationActionResponse(body, slug, "sync")),

  backfill: (slug: string, opts?: LifecycleRequestOptions) =>
    api
      .post<unknown>(
        `/api/v1/integrations/${encodeURIComponent(slug)}/backfill`,
        {},
        { ...opts, ...ONLINE_ONCE },
      )
      .then((body) => parseIntegrationActionResponse(body, slug, "backfill")),

  pause: (slug: string, opts?: LifecycleRequestOptions) =>
    api
      .post<unknown>(
        `/api/v1/integrations/${encodeURIComponent(slug)}/pause`,
        {},
        { ...opts, ...ONLINE_ONCE },
      )
      .then((body) => parseIntegrationActionResponse(body, slug, "pause")),

  disconnect: (slug: string, opts?: LifecycleRequestOptions) =>
    api
      .delete<unknown>(`/api/v1/integrations/${encodeURIComponent(slug)}`, {
        ...opts,
        ...ONLINE_ONCE,
      })
      .then((body) =>
        parseIntegrationActionResponse(body, slug, "disconnect"),
      ),

  connections: (query?: ConnectionsQuery, opts?: LifecycleRequestOptions) =>
    api
      .get<unknown>("/api/v1/integrations/connections", {
        ...opts,
        ...ONLINE_ONCE,
        query: query
          ? {
              footprint: query.footprint,
              connected: query.connected,
              q: query.q || undefined,
              category: query.category || undefined,
              health: query.health || undefined,
            }
          : undefined,
      })
      .then(parseConnectionsReport),

  coverage: (opts?: LifecycleRequestOptions) =>
    api
      .get<unknown>("/api/v1/integrations/coverage", {
        ...opts,
        ...ONLINE_ONCE,
      })
      .then(parseCoverageReport),

  stacks: (opts?: LifecycleRequestOptions) =>
    api
      .get<unknown>("/api/v1/integrations/stacks", { ...opts, ...ONLINE_ONCE })
      .then(parseStackReport),

  readiness: (opts?: LifecycleRequestOptions) =>
    api
      .get<unknown>("/api/v1/integrations/readiness", {
        ...opts,
        ...ONLINE_ONCE,
      })
      .then(parseReadinessReport),

  recipes: (query?: RecipesQuery, opts?: LifecycleRequestOptions) =>
    api
      .get<unknown>("/api/v1/integrations/recipes", {
        ...opts,
        ...ONLINE_ONCE,
        query: query
          ? {
              q: query.q || undefined,
              source: query.source || undefined,
              target: query.target || undefined,
              available: query.available,
            }
          : undefined,
      })
      .then(parseRecipesReport),

  recipeDetail: (id: string, opts?: LifecycleRequestOptions) =>
    api
      .get<unknown>(
        `/api/v1/integrations/recipes/${encodeURIComponent(id)}`,
        { ...opts, ...ONLINE_ONCE },
      )
      .then((body) => parseRecipeDetail(body, id)),

  applyRecipe: (id: string, opts?: LifecycleRequestOptions) =>
    api
      .post<unknown>(
        `/api/v1/integrations/recipes/${encodeURIComponent(id)}/apply`,
        {},
        { ...opts, ...ONLINE_ONCE },
      )
      .then((body) => parseRecipeApplyResponse(body, id)),
};

/* ---------- native families -------------------------------------------- */

/**
 * The native provider families desktop's runNativeManagedLifecycleAction
 * dispatches to (apps/desktop/src/pages/integrations-helpers.ts
 * nativeProviderFamily). Support is deliberately absent: its runtime is
 * release-held server-side (support_integration_runtime_held).
 */
export type NativeLifecycleFamily =
  | "crm"
  | "lead_capture"
  | "review_integration"
  | "loyalty_integration"
  | "subscription_integration"
  | "analytics_integration";

type NativeFamilyBase =
  | "/api/v1/crm/integrations"
  | "/api/v1/lead-integrations"
  | "/api/v1/review-integrations"
  | "/api/v1/loyalty-integrations"
  | "/api/v1/subscription-integrations"
  | "/api/v1/analytics-integrations";

export interface NativeLifecycleClient {
  sync(id: string, opts?: LifecycleRequestOptions): Promise<unknown>;
  backfill(id: string, opts?: LifecycleRequestOptions): Promise<unknown>;
  pause(id: string, opts?: LifecycleRequestOptions): Promise<unknown>;
  disconnect(id: string, opts?: LifecycleRequestOptions): Promise<unknown>;
}

function nativeLifecycleClient(base: NativeFamilyBase): NativeLifecycleClient {
  return {
    sync: (id, opts) =>
      api.post<unknown>(
        `${base}/${encodeURIComponent(id)}/sync`,
        {},
        { ...opts, ...ONLINE_ONCE },
      ),
    backfill: (id, opts) =>
      api.post<unknown>(
        `${base}/${encodeURIComponent(id)}/backfill`,
        {},
        { ...opts, ...ONLINE_ONCE },
      ),
    pause: (id, opts) =>
      api.post<unknown>(
        `${base}/${encodeURIComponent(id)}/pause`,
        {},
        { ...opts, ...ONLINE_ONCE },
      ),
    disconnect: (id, opts) =>
      api.delete<unknown>(`${base}/${encodeURIComponent(id)}`, {
        ...opts,
        ...ONLINE_ONCE,
      }),
  };
}

export const nativeLifecycleClients: Record<
  NativeLifecycleFamily,
  NativeLifecycleClient
> = {
  crm: nativeLifecycleClient("/api/v1/crm/integrations"),
  lead_capture: nativeLifecycleClient("/api/v1/lead-integrations"),
  review_integration: nativeLifecycleClient("/api/v1/review-integrations"),
  loyalty_integration: nativeLifecycleClient("/api/v1/loyalty-integrations"),
  subscription_integration: nativeLifecycleClient(
    "/api/v1/subscription-integrations",
  ),
  analytics_integration: nativeLifecycleClient(
    "/api/v1/analytics-integrations",
  ),
};

function hasSource(item: Pick<LifecycleCatalogItem, "sources">, source: string) {
  return Array.isArray(item.sources) && item.sources.includes(source);
}

/** Mirrors desktop nativeProviderFamily: native badge + owning source. */
export function nativeLifecycleFamily(
  item: Pick<LifecycleCatalogItem, "badge" | "sources">,
): NativeLifecycleFamily | null {
  if (item.badge !== "native") return null;
  if (hasSource(item, "crm")) return "crm";
  if (hasSource(item, "lead_capture")) return "lead_capture";
  if (hasSource(item, "review_integration")) return "review_integration";
  if (hasSource(item, "loyalty_integration")) return "loyalty_integration";
  if (hasSource(item, "subscription_integration")) {
    return "subscription_integration";
  }
  if (hasSource(item, "analytics_integration")) return "analytics_integration";
  return null;
}

/** Hold code the support family answers with (apps/api support_integrations). */
export const SUPPORT_RUNTIME_HOLD_CODE = "support_integration_runtime_held";

/** Support-provider runtime is release-held: nothing may be sent for it. */
export function isSupportRuntimeHeld(
  item: Pick<LifecycleCatalogItem, "category" | "sources">,
): boolean {
  return (
    item.category === "customer_service" ||
    hasSource(item, "support_integration")
  );
}

/** Commerce rows are administered from the commerce surface (desktop parity). */
export function isCommerceOwned(
  item: Pick<LifecycleCatalogItem, "sources">,
): boolean {
  return hasSource(item, "commerce");
}

/** One-line evidence from a native family's lifecycle response. */
export function nativeLifecycleEvidence(body: unknown): string {
  const row = rec(body);
  if (!row) return "";
  const bounded = (value: unknown) =>
    typeof value === "string" ? value.trim().slice(0, 120) : "";
  return [
    bounded(row.status) ? `Status ${bounded(row.status)}` : "",
    bounded(row.run_id) ? `Run ${bounded(row.run_id)}` : "",
    bounded(row.id) ? `Connection ${bounded(row.id)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/* ---------- lead capture ------------------------------------------------ */

export interface LeadProviderField {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  help?: string;
}

export interface LeadProviderSpec {
  provider: string;
  name: string;
  category: string;
  auth_mode: string;
  managed: boolean;
  runtime_status: string;
  sync_model?: string;
  required_settings: LeadProviderField[];
  optional_settings: LeadProviderField[];
  sync_objects: string[];
  docs_url?: string;
}

function parseLeadField(value: unknown): LeadProviderField | null {
  const row = rec(value);
  if (!row || !text(row.key)) return null;
  return {
    key: text(row.key),
    label: text(row.label) || text(row.key),
    required: flag(row.required),
    secret: flag(row.secret),
    help: optionalText(row.help),
  };
}

export function parseLeadProviders(value: unknown): LeadProviderSpec[] {
  const row = rec(value);
  if (!row || !Array.isArray(row.items)) {
    throw new IntegrationEvidenceError("lead provider registry");
  }
  return listOf(row.items, (entry) => {
    const spec = rec(entry);
    return spec && text(spec.provider)
      ? {
          provider: text(spec.provider),
          name: text(spec.name) || text(spec.provider),
          category: text(spec.category),
          auth_mode: text(spec.auth_mode),
          managed: flag(spec.managed),
          runtime_status: text(spec.runtime_status),
          sync_model: optionalText(spec.sync_model),
          required_settings: listOf(spec.required_settings, parseLeadField),
          optional_settings: listOf(spec.optional_settings, parseLeadField),
          sync_objects: texts(spec.sync_objects),
          docs_url: optionalText(spec.docs_url),
        }
      : null;
  });
}

export interface LeadIntegration {
  id: string;
  provider: string;
  name: string;
  status: string;
}

export interface LeadIntegrationInput {
  provider: string;
  name: string;
  credentials_ref: string;
  settings: Record<string, string>;
}

export const leadIntegrationsApi = {
  providers: (opts?: LifecycleRequestOptions) =>
    api
      .get<unknown>("/api/v1/lead-integrations/providers", {
        ...opts,
        ...ONLINE_ONCE,
      })
      .then(parseLeadProviders),

  create: (input: LeadIntegrationInput, opts?: LifecycleRequestOptions) =>
    api
      .post<unknown>("/api/v1/lead-integrations", input, {
        ...opts,
        ...ONLINE_ONCE,
      })
      .then((body): LeadIntegration => {
        const row = rec(body);
        if (!row || !text(row.id) || text(row.provider) !== input.provider) {
          throw new IntegrationEvidenceError("lead integration");
        }
        return {
          id: text(row.id),
          provider: text(row.provider),
          name: text(row.name),
          status: text(row.status),
        };
      }),

  ...nativeLifecycleClients.lead_capture,
};

/**
 * Mirrors desktop leadIntegrationName: the provider name plus the first
 * identifying setting, so two forms from one provider are distinguishable.
 */
export function leadIntegrationName(
  spec: Pick<LeadProviderSpec, "name">,
  settings: Readonly<Record<string, string>>,
): string {
  const identifier =
    settings.form_id ??
    settings.site_id ??
    settings.site_url ??
    settings.form_name ??
    "";
  return identifier ? `${spec.name} ${identifier}` : spec.name;
}

/** Required + optional settings, de-duplicated, in the server's order. */
export function leadProviderFields(
  spec: LeadProviderSpec | null | undefined,
): LeadProviderField[] {
  if (!spec) return [];
  const seen = new Set<string>();
  const out: LeadProviderField[] = [];
  for (const field of [...spec.required_settings, ...spec.optional_settings]) {
    if (seen.has(field.key)) continue;
    seen.add(field.key);
    out.push(field);
  }
  return out;
}

/* ---------- catalog posture filters (pure) ------------------------------ */

export type WorkspaceStateFilter =
  | "all"
  | "connected"
  | "attention"
  | "available"
  | "planned";

export interface CatalogPostureFilter {
  query: string;
  category: string;
  state: WorkspaceStateFilter;
  stack: string;
}

export const EMPTY_POSTURE_FILTER: CatalogPostureFilter = {
  query: "",
  category: "",
  state: "all",
  stack: "",
};

const ATTENTION_STATES = new Set([
  "action_required",
  "degraded",
  "error",
  "failed",
  "needs_attention",
  "unhealthy",
]);

/** Mirrors desktop connectionNeedsAttention. */
export function connectionNeedsAttention(
  connection: IntegrationConnection | undefined,
): boolean {
  if (!connection) return false;
  const health = (connection.health_state || connection.status)
    .trim()
    .toLowerCase();
  return Boolean(connection.last_error?.trim()) || ATTENTION_STATES.has(health);
}

export interface PostureFilterableItem {
  slug: string;
  name: string;
  category: string;
  badge?: string;
  runtime_status: string;
  summary?: string;
  capabilities?: string[];
  sources?: string[];
}

/**
 * Applies search, category, workspace-state (from GET /integrations/
 * connections) and customer-stack (from GET /integrations/stacks) filters.
 * A state filter against an unavailable connection inventory is refused by
 * the UI rather than silently matching nothing; this function treats a
 * missing connection as "not connected".
 */
export function filterCatalogByPosture<T extends PostureFilterableItem>(
  items: readonly T[],
  filter: CatalogPostureFilter,
  connections: ReadonlyMap<string, IntegrationConnection>,
  stacks: readonly CustomerStack[],
): T[] {
  const needle = filter.query.trim().toLowerCase();
  const stack = filter.stack
    ? stacks.find((candidate) => candidate.key === filter.stack)
    : undefined;
  const stackSlugs = stack
    ? new Set(stack.components.map((component) => component.slug))
    : null;
  return items.filter((item) => {
    if (filter.category && item.category !== filter.category) return false;
    if (stackSlugs && !stackSlugs.has(item.slug)) return false;
    const connection = connections.get(item.slug);
    switch (filter.state) {
      case "connected":
        if (connection?.connected !== true) return false;
        break;
      case "attention":
        if (!connectionNeedsAttention(connection)) return false;
        break;
      case "available":
        if (item.runtime_status === "planned" || connection?.connected) {
          return false;
        }
        break;
      case "planned":
        if (item.runtime_status !== "planned") return false;
        break;
      default:
        break;
    }
    if (!needle) return true;
    const haystack = [
      item.slug,
      item.name,
      item.category,
      item.badge ?? "",
      item.runtime_status,
      item.summary ?? "",
      ...(Array.isArray(item.capabilities) ? item.capabilities : []),
      ...(Array.isArray(item.sources) ? item.sources : []),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}
