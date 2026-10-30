/**
 * lib/navigateTo.ts — push, or replace when you are already there.
 *
 * Every deep link, App-Intent route, share-inbox hand-off and notification tap
 * called `router.push()` unconditionally. Nothing checked whether the target
 * was the screen already on top, so tapping three notifications about the SAME
 * campaign stacked three identical screens and the user then pressed back three
 * times to escape. Desktop's equivalent replaces rather than stacks.
 *
 * The decision is a pure function so it can be unit-tested in the node
 * environment (this module must stay free of react-native/expo imports — see
 * lib/approvalPolicy, lib/chartScale for the same rule). The `useNavigateTo`
 * hook that binds it to expo-router lives in hooks/useNavigateTo.ts.
 */

export interface NavigationTarget {
  pathname: string;
  params?: Record<string, string> | undefined;
}

/**
 * Normalise an Expo pathname for comparison.
 *
 * Route-group segments (`/(tabs)`) are presentation, not identity, and a
 * trailing slash is never meaningful — comparing raw strings would treat
 * `/(tabs)/campaigns/42` and `/campaigns/42/` as different screens and stack a
 * duplicate.
 */
export function normalizeRoutePath(pathname: string): string {
  const withoutGroups = pathname.replace(/\/\([^)]+\)/gu, "");
  const withSlash = withoutGroups.startsWith("/")
    ? withoutGroups
    : `/${withoutGroups}`;
  return withSlash.replace(/\/+$/u, "") || "/";
}

/**
 * Resolve a template pathname + params to the concrete path it will produce.
 *
 * `searchHitRoute` and the notification router both produce
 * `{ pathname: "/(tabs)/campaigns/[id]", params: { id } }`, which renders the
 * same screen as `/campaigns/<id>`; without substitution the comparison would
 * never match and every tap would stack.
 */
export function resolveTargetPath(target: NavigationTarget): string {
  const params = target.params ?? {};
  const substituted = target.pathname.replace(
    /\[([A-Za-z0-9_]+)\]/gu,
    (match, key: string) => {
      const value = params[key];
      return value === undefined ? match : value;
    },
  );
  return normalizeRoutePath(substituted);
}

/**
 * Coerce an expo-router `Href` — which is either a string or
 * `{pathname, params}` — into a NavigationTarget.
 *
 * `routeForEntityLink` returns the union, so without this every caller would
 * repeat the same narrowing and one of them would eventually get it wrong.
 * Returns null for anything that is not a usable route.
 */
export function targetFromHref(href: unknown): NavigationTarget | null {
  if (typeof href === "string") {
    return href ? { pathname: href } : null;
  }
  if (!href || typeof href !== "object") return null;
  const candidate = href as { pathname?: unknown; params?: unknown };
  if (typeof candidate.pathname !== "string" || !candidate.pathname) {
    return null;
  }
  const params: Record<string, string> = {};
  if (candidate.params && typeof candidate.params === "object") {
    for (const [key, value] of Object.entries(
      candidate.params as Record<string, unknown>,
    )) {
      if (typeof value === "string") params[key] = value;
    }
  }
  return Object.keys(params).length
    ? { pathname: candidate.pathname, params }
    : { pathname: candidate.pathname };
}

export type NavigationMode = "push" | "replace";

/**
 * `replace` when the target resolves to the screen already on top, `push`
 * otherwise.
 *
 * Comparison is on the resolved PATH — `[id]` substituted, route groups
 * stripped — so a different campaign is still a push (pressing back to reach
 * the previous campaign is what a user expects) while a repeat of the same
 * screen is collapsed. Query params are deliberately NOT part of the identity:
 * `usePathname()` does not carry them, and re-entering a list screen with a
 * different filter should refine that screen rather than stack another copy of
 * it.
 */
export function navigationMode(
  currentPath: string | null | undefined,
  target: NavigationTarget,
): NavigationMode {
  if (!currentPath) return "push";
  return resolveTargetPath({ pathname: currentPath }) ===
    resolveTargetPath(target)
    ? "replace"
    : "push";
}
