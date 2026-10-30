import type { CommerceIntegration, IntegrationCatalogItem } from "./api-client";
import type { DesktopRoute } from "./desktop-router";

export const COMMERCE_ADMINISTRATION_TASKS = [
  "connect",
  "manage",
  "sync",
  "backfill",
  "pause",
  "disconnect",
] as const;

export type CommerceAdministrationTask =
  (typeof COMMERCE_ADMINISTRATION_TASKS)[number];

export interface CommerceAdministrationIntent {
  task: CommerceAdministrationTask;
  provider: string;
  integrationId?: string;
}

const TASK_OVERLAYS: Record<CommerceAdministrationTask, string> = {
  connect: "connect-store",
  manage: "manage-store",
  sync: "sync-store",
  backfill: "backfill-store",
  pause: "pause-store",
  disconnect: "disconnect-store",
};

const OVERLAY_TASKS = new Map(
  Object.entries(TASK_OVERLAYS).map(([task, overlay]) => [
    overlay,
    task as CommerceAdministrationTask,
  ]),
);

const COMMERCE_PROVIDER_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const COMMERCE_INTEGRATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

function isCommerceProviderSlug(value: string): boolean {
  return value.length <= 64 && COMMERCE_PROVIDER_RE.test(value);
}

export function isCommerceOwnedIntegration(
  item: Pick<IntegrationCatalogItem, "sources">,
): boolean {
  return (item.sources ?? []).includes("commerce");
}

export function commerceTaskForLifecycleAction(
  action: string,
): CommerceAdministrationTask | null {
  switch (action) {
    case "connect/start":
      return "connect";
    case "sync":
      return "sync";
    case "backfill":
      return "backfill";
    case "pause":
      return "pause";
    case "disconnect":
      return "disconnect";
    default:
      return null;
  }
}

export function commerceAdministrationRoute(
  intent: CommerceAdministrationIntent,
): DesktopRoute {
  const provider = intent.provider.trim();
  if (!isCommerceProviderSlug(provider)) {
    throw new TypeError("Commerce provider must be a safe provider slug");
  }
  const overlayName = TASK_OVERLAYS[intent.task];
  if (!overlayName) throw new TypeError("Commerce administration task is invalid");
  const integrationId = intent.integrationId?.trim();
  if (
    intent.integrationId !== undefined &&
    (!integrationId || !COMMERCE_INTEGRATION_ID_RE.test(integrationId))
  ) {
    throw new TypeError("Commerce integration id is invalid");
  }
  return {
    section: "commerce",
    tab: "integrations",
    filters: [{ key: "provider", value: provider }],
    overlay: {
      name: overlayName,
      ...(integrationId ? { resourceId: integrationId } : {}),
    },
  };
}

/**
 * Match a route intent to a Commerce-owned connection without ever allowing a
 * provider-only fallback to override an explicit integration id. Both fields
 * must match when the handoff carries an id, which keeps edited/deep-linked
 * routes from targeting a different provider's store.
 */
export function resolveCommerceAdministrationTarget(
  integrations: readonly CommerceIntegration[] | null,
  intent: CommerceAdministrationIntent | null,
): CommerceIntegration | null {
  if (!integrations || !intent) return null;
  const provider = intent.provider.trim().toLowerCase();
  return (
    integrations.find((integration) => {
      if (integration.provider.trim().toLowerCase() !== provider) return false;
      return intent.integrationId
        ? integration.id === intent.integrationId
        : true;
    }) ?? null
  );
}

export function parseCommerceAdministrationIntent(
  route: DesktopRoute,
): CommerceAdministrationIntent | null {
  if (
    route.section !== "commerce" ||
    (route.tab !== undefined && route.tab !== "integrations") ||
    !route.overlay
  ) {
    return null;
  }
  const task = OVERLAY_TASKS.get(route.overlay.name);
  if (!task) return null;
  const providerFilters = (route.filters ?? []).filter(
    (filter) => filter.key === "provider",
  );
  if (providerFilters.length !== 1 || (route.filters ?? []).length !== 1) {
    return null;
  }
  const provider = providerFilters[0]?.value.trim() ?? "";
  if (!isCommerceProviderSlug(provider)) return null;
  const integrationId = route.overlay.resourceId;
  if (
    integrationId !== undefined &&
    !COMMERCE_INTEGRATION_ID_RE.test(integrationId)
  ) {
    return null;
  }
  return {
    task,
    provider,
    ...(integrationId ? { integrationId } : {}),
  };
}
