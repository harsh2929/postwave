import type {
  ApiErr,
  IntegrationBadge,
  IntegrationCatalogItem,
  IntegrationConnection,
  IntegrationRecipe,
  IntegrationSetupStep,
  IntegrationsStackReport,
} from "../lib/api-client";

export const ALL_FILTER = "all";

export function integrationApiErrorDetail(error: ApiErr["error"]): string {
  const message = error.message.trim().slice(0, 480);
  const evidence = [
    error.code ? `Code ${error.code.slice(0, 80)}` : "",
    error.requestId ? `Request ${error.requestId.slice(0, 120)}` : "",
    error.retryAfterSeconds !== undefined
      ? `Retry after ${Math.max(0, Math.round(error.retryAfterSeconds))}s`
      : "",
  ].filter(Boolean);
  return [message || "The integration request failed.", ...evidence].join(
    " · ",
  );
}

export type IntegrationConnectionFilter =
  | "all"
  | "connected"
  | "attention"
  | "available"
  | "planned";

export type IntegrationCatalogSort =
  | "recommended"
  | "name"
  | "category"
  | "status";

export function badgeLabel(
  badge: IntegrationBadge,
  runtimeStatus?: IntegrationCatalogItem["runtime_status"],
): string {
  switch (badge) {
    case "api_sdk":
      return "API/SDK";
    case "migration_only":
      return "Migration-only";
    case "native":
      if (runtimeStatus === "partial") return "Native foundation";
      if (runtimeStatus === "delegated") return "Native delegated";
      return "Native";
    case "partner":
      return "Partner";
    case "planned":
      return "Planned";
    case "webhook":
      return "Webhook";
    case "zapier":
      return "Zapier";
  }
}

export function categoryLabel(
  key: string,
  labels: Map<string, string>,
): string {
  return labels.get(key) ?? titleize(key);
}

export function titleize(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function filterIntegrationItems(
  items: IntegrationCatalogItem[],
  query: string,
  category: string,
  badge: string,
): IntegrationCatalogItem[] {
  const needle = query.trim().toLowerCase();
  return items.filter((item) => {
    if (category !== ALL_FILTER && item.category !== category) return false;
    if (badge !== ALL_FILTER && item.badge !== badge) return false;
    if (!needle) return true;
    const haystack = [
      item.slug,
      item.name,
      item.category,
      item.badge,
      item.runtime_status,
      item.summary,
      ...(item.capabilities ?? []),
      ...(item.sources ?? []),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

function connectionNeedsAttention(
  connection: IntegrationConnection | undefined,
): boolean {
  if (!connection) return false;
  const health = (connection.health_state ?? connection.status)
    .trim()
    .toLowerCase();
  return (
    Boolean(connection.last_error?.trim()) ||
    [
      "action_required",
      "degraded",
      "error",
      "failed",
      "needs_attention",
      "unhealthy",
    ].includes(health)
  );
}

/**
 * Apply workspace-state filtering and a deterministic operator-first order.
 * Search/category/badge filtering remains in `filterIntegrationItems` so the
 * same text contract is reusable by lightweight clients and tests.
 */
export function refineIntegrationItems(
  items: IntegrationCatalogItem[],
  connections: Map<string, IntegrationConnection>,
  connectionFilter: IntegrationConnectionFilter,
  sort: IntegrationCatalogSort,
): IntegrationCatalogItem[] {
  const filtered = items.filter((item) => {
    const connection = connections.get(item.slug);
    switch (connectionFilter) {
      case "connected":
        return connection?.connected === true;
      case "attention":
        return connectionNeedsAttention(connection);
      case "available":
        return item.runtime_status !== "planned" && !connection?.connected;
      case "planned":
        return item.runtime_status === "planned";
      case "all":
        return true;
    }
  });

  const statusRank = (item: IntegrationCatalogItem): number => {
    const connection = connections.get(item.slug);
    if (connectionNeedsAttention(connection)) return 0;
    if (connection?.connected) return 1;
    if (item.featured && item.runtime_status !== "planned") return 2;
    if (item.runtime_status === "available") return 3;
    if (item.runtime_status === "partial") return 4;
    if (item.runtime_status === "delegated") return 5;
    return 6;
  };

  return [...filtered].sort((left, right) => {
    if (sort === "name") return left.name.localeCompare(right.name);
    if (sort === "category") {
      return (
        left.category.localeCompare(right.category) ||
        left.name.localeCompare(right.name)
      );
    }
    if (sort === "status") {
      return (
        statusRank(left) - statusRank(right) ||
        left.name.localeCompare(right.name)
      );
    }
    return (
      statusRank(left) - statusRank(right) ||
      Number(Boolean(right.featured)) - Number(Boolean(left.featured)) ||
      left.name.localeCompare(right.name)
    );
  });
}

export function summarizeIntegrations(
  items: IntegrationCatalogItem[],
  connections: IntegrationConnection[],
): {
  total: number;
  native: number;
  connected: number;
  delegated: number;
  planned: number;
} {
  return {
    total: items.length,
    native: items.filter((item) => item.badge === "native").length,
    connected: connections.filter((item) => item.connected).length,
    delegated: items.filter((item) => item.runtime_status === "delegated")
      .length,
    planned: items.filter((item) => item.runtime_status === "planned").length,
  };
}

export function countAvailableRecipes(recipes: IntegrationRecipe[]): number {
  return recipes.filter((recipe) => recipe.available).length;
}

export function firstActionableSetupStep(
  steps: IntegrationSetupStep[],
): IntegrationSetupStep | null {
  return steps.find((step) => Boolean(step.action && step.path)) ?? null;
}

export type NativeProviderFamily =
  | "crm"
  | "lead_capture"
  | "review_integration"
  | "loyalty_integration"
  | "subscription_integration"
  | "support_integration"
  | "analytics_integration";

export type NativeConnectTarget = NativeProviderFamily | "warehouse";

export function integrationHasSource(
  item: IntegrationCatalogItem,
  source: string,
): boolean {
  return (item.sources ?? []).includes(source);
}

export function nativeProviderFamily(
  item: IntegrationCatalogItem,
): NativeProviderFamily | null {
  if (item.badge !== "native") return null;
  if (integrationHasSource(item, "crm")) return "crm";
  if (integrationHasSource(item, "lead_capture")) return "lead_capture";
  if (integrationHasSource(item, "review_integration")) {
    return "review_integration";
  }
  if (integrationHasSource(item, "loyalty_integration")) {
    return "loyalty_integration";
  }
  if (integrationHasSource(item, "subscription_integration")) {
    return "subscription_integration";
  }
  if (integrationHasSource(item, "support_integration")) {
    return "support_integration";
  }
  if (integrationHasSource(item, "analytics_integration")) {
    return "analytics_integration";
  }
  return null;
}

export function nativeConnectTarget(
  item: IntegrationCatalogItem,
  action: "connect" | "sync",
): NativeConnectTarget | null {
  if (action !== "connect" || item.badge !== "native") return null;
  const family = nativeProviderFamily(item);
  if (family) return family;
  return item.category === "warehouse" ? "warehouse" : null;
}

export function lifecycleActionLabel(action: string): string {
  switch (action) {
    case "connect/start":
      return "Connect";
    case "connect/callback":
      return "Complete OAuth";
    case "sync":
      return "Sync now";
    case "backfill":
      return "Backfill";
    case "pause":
      return "Pause";
    case "disconnect":
      return "Disconnect";
    case "roadmap":
      return "Roadmap";
    default:
      return titleize(action);
  }
}

export function lifecycleActionButtonClass(action: string): string {
  switch (action) {
    case "connect/start":
    case "sync":
    case "backfill":
      return "btn btn-primary";
    case "disconnect":
      return "btn btn-danger";
    default:
      return "btn";
  }
}

export function lifecycleActionNeedsConnection(action: string): boolean {
  return ["sync", "backfill", "pause", "disconnect"].includes(action);
}

export function filterIntegrationRecipes(
  recipes: IntegrationRecipe[],
  query: string,
  badge: string,
  availability: "all" | "ready" | "planned",
): IntegrationRecipe[] {
  const needle = query.trim().toLowerCase();
  return recipes.filter((recipe) => {
    if (badge !== ALL_FILTER && recipe.badge !== badge) return false;
    if (availability === "ready" && !recipe.available) return false;
    if (availability === "planned" && recipe.available) return false;
    if (!needle) return true;
    const haystack = [
      recipe.id,
      recipe.name,
      recipe.provider,
      recipe.source_slug,
      recipe.target_slug ?? "",
      recipe.summary,
      recipe.badge,
      recipe.blueprint?.trigger ?? "",
      recipe.blueprint?.destination ?? "",
      recipe.blueprint?.postwave_surface ?? "",
      ...(recipe.blueprint?.required_scopes ?? []),
      ...(recipe.blueprint?.required_secrets ?? []),
      ...(recipe.blueprint?.events ?? []),
      ...(recipe.blueprint?.data_handling ?? []),
      ...(recipe.blueprint?.field_mappings ?? []).flatMap((field) => [
        field.source,
        field.target,
        field.description ?? "",
      ]),
      ...(recipe.capabilities ?? []),
      ...(recipe.steps ?? []).flatMap((step) => [
        step.title,
        step.description,
        step.action ?? "",
        step.path ?? "",
        ...(step.required_fields ?? []),
      ]),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export function filterIntegrationStacks(
  report: IntegrationsStackReport,
  query: string,
  category: string,
  badge: string,
): Pick<IntegrationsStackReport, "stacks" | "highest_impact_gaps"> {
  const needle = query.trim().toLowerCase();
  const filteredComponentSlugs = new Set(
    report.stacks.flatMap((stack) =>
      stack.components
        .filter(
          (component) =>
            (category === ALL_FILTER || component.category === category) &&
            (badge === ALL_FILTER || component.badge === badge),
        )
        .map((component) => component.slug),
    ),
  );
  const stacks = report.stacks.filter((stack) => {
    if (
      category !== ALL_FILTER &&
      !stack.components.some((component) => component.category === category)
    ) {
      return false;
    }
    if (
      badge !== ALL_FILTER &&
      !stack.components.some((component) => component.badge === badge)
    ) {
      return false;
    }
    if (!needle) return true;
    const haystack = [
      stack.key,
      stack.name,
      stack.segment,
      stack.summary,
      stack.status,
      ...stack.components.flatMap((component) => [
        component.slug,
        component.name,
        component.role,
        component.category,
        component.badge,
        component.runtime_status,
        component.reason,
      ]),
      ...stack.next_actions,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
  const highest_impact_gaps = report.highest_impact_gaps.filter((gap) => {
    if (
      (category !== ALL_FILTER || badge !== ALL_FILTER) &&
      !filteredComponentSlugs.has(gap.slug)
    ) {
      return false;
    }
    if (!needle) return true;
    return [gap.slug, gap.name, gap.reason]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
  return { stacks, highest_impact_gaps };
}
