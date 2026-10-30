const ROUTE_VERSION = 1;
const ROUTE_STATE_KEY = "__postwaveDesktopRoute";
const ROUTE_STORAGE_PREFIX = "postwave.desktop.route.v1";
const MAX_SCROLL_TOP = 10_000_000;

export type DesktopHistorySource =
  | "navigation"
  | "deep-link"
  | "history"
  | "restore"
  | "identity";

export interface DesktopHistoryState {
  [ROUTE_STATE_KEY]: typeof ROUTE_VERSION;
  canonicalUrl: string;
  scope: string | null;
  source: DesktopHistorySource;
  scrollTop: number;
  /** Monotonic position for lossless Back/Forward lifecycle rollback. */
  index: number | null;
}

export function parseDesktopHistoryState(
  value: unknown,
): DesktopHistoryState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (
    state[ROUTE_STATE_KEY] !== ROUTE_VERSION ||
    typeof state.canonicalUrl !== "string" ||
    (state.scope !== null && typeof state.scope !== "string") ||
    (state.source !== "navigation" &&
      state.source !== "deep-link" &&
      state.source !== "history" &&
      state.source !== "restore" &&
      state.source !== "identity") ||
    typeof state.scrollTop !== "number" ||
    !Number.isFinite(state.scrollTop) ||
    (state.index !== undefined &&
      (typeof state.index !== "number" ||
        !Number.isSafeInteger(state.index) ||
        state.index < 0))
  ) {
    return null;
  }
  return {
    [ROUTE_STATE_KEY]: ROUTE_VERSION,
    canonicalUrl: state.canonicalUrl,
    scope: state.scope,
    source: state.source,
    scrollTop: state.scrollTop,
    index: typeof state.index === "number" ? state.index : null,
  };
}

export function createDesktopHistoryState({
  canonicalUrl,
  scope,
  source,
  scrollTop,
  index,
}: Omit<DesktopHistoryState, typeof ROUTE_STATE_KEY>): DesktopHistoryState {
  return {
    [ROUTE_STATE_KEY]: ROUTE_VERSION,
    canonicalUrl,
    scope,
    source,
    scrollTop: clampedScrollTop(scrollTop),
    index,
  };
}

export function clampedScrollTop(value: number): number {
  return Math.max(0, Math.min(MAX_SCROLL_TOP, Math.round(value)));
}

function identityFingerprint(user: string, tenant: string): string {
  const value = `${user}\u001f${tenant}`;
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left ^= code;
    left = Math.imul(left, 0x01000193);
    right ^= code + index;
    right = Math.imul(right, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

/** Opaque, deterministic scope for identity-bound navigation caches. */
export function desktopRouteIdentityScope(
  user: string | null | undefined,
  tenant: string | null | undefined,
): string | null {
  const normalizedUser = user?.trim();
  const normalizedTenant = tenant?.trim();
  return normalizedUser && normalizedTenant
    ? identityFingerprint(normalizedUser, normalizedTenant)
    : null;
}

export function routeTimestampIsCurrent(
  at: number,
  ttl: number,
  now: number,
): boolean {
  return Number.isFinite(at) && at <= now + 5 * 60 * 1000 && at >= now - ttl;
}

export function desktopRouteStorageKey(scope: string): string {
  return `${ROUTE_STORAGE_PREFIX}:${scope}`;
}

export type IdentityRouteResolution =
  | { kind: "clear" }
  | { kind: "adopt-current"; scrollTop: number }
  | { kind: "restore-scoped"; scope: string };

export function resolveIdentityRoute(
  previousScope: string | null,
  nextScope: string | null,
  currentState: DesktopHistoryState | null,
  currentSection: string,
): IdentityRouteResolution {
  if (!nextScope) return { kind: "clear" };
  const stateBelongsToNext = currentState?.scope === nextScope;
  const isUnscopedExplicitRoute =
    currentState?.scope == null && currentState?.source === "deep-link";
  if (stateBelongsToNext || isUnscopedExplicitRoute) {
    return {
      kind: "adopt-current",
      scrollTop: currentState?.scrollTop ?? 0,
    };
  }
  const identityChanged =
    (previousScope !== null && previousScope !== nextScope) ||
    (currentState?.scope != null && !stateBelongsToNext);
  if (identityChanged || currentSection === "dashboard") {
    return { kind: "restore-scoped", scope: nextScope };
  }
  return {
    kind: "adopt-current",
    scrollTop: currentState?.scrollTop ?? 0,
  };
}
