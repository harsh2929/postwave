/**
 * lib/navDeepLinks.ts — resolving LIST-level links the entity grammar cannot.
 *
 * @postwave/route-map's `ENTITIES` declares exactly four things a link can
 * point at: approval, subscriber, campaign, sequence. Mobile ships 40 secondary
 * screens. So `moosewave://dmarc`, `moosewave://suppressions`,
 * `https://app.moosewave.com/app/audit` — every link a teammate would actually
 * paste into Slack to say "look at this screen" — parsed to null,
 * `planDeepLinkNavigation` returned `{kind:"ignore"}`, and the app opened on
 * whatever screen was last shown. The same null is why a notification whose
 * `deep_link` points at a list produced a completely dead tap.
 *
 * Widening `ENTITIES` is the cross-surface fix and it is not a mobile change:
 * that table is shared with web and desktop, and an entity there implies an
 * `<id>` and a detail route on every surface, which is exactly what these
 * DESTINATIONS do not have. This module is the mobile-side complement — no
 * ids, no detail routes, just "which screen is this link naming" — resolved
 * against the SAME manifest the More menu and the palette read, so a link can
 * never reach a screen the app does not have.
 *
 * Grammar, deliberately narrow:
 *
 *   moosewave://<slug>                     → /(tabs)/<route>
 *   moosewave://<slug>/                    → same (a trailing slash is noise)
 *   https://<trusted-host>/app/<slug>     → same
 *
 * Anything with extra path segments is REJECTED rather than truncated: an
 * unrecognised `/app/tags/42` must stay unrecognised (and get the "couldn't
 * open that link" notice) instead of silently landing the user on the tag list
 * and implying that tag 42 is what they are looking at.
 *
 * Import-free of react-native by construction, so it is unit-testable in the
 * node vitest environment.
 */
import { MOBILE_SECONDARY_ROUTES } from "@/lib/mobileRouteManifest";

/**
 * Universal-link hosts. Mirrors the private allowlist in lib/deepLinks.ts —
 * duplicated rather than exported from there because that module imports
 * expo-router types, and this one must stay loadable in a node test.
 */
const TRUSTED_HOSTS = new Set([
  "app.moosewave.com",
  "moosewave.com",
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

/**
 * The five bottom-tab destinations. They are not in MOBILE_SECONDARY_ROUTES
 * (that table is "everything behind More") but they are the most likely thing
 * for a link to name.
 *
 * `campaigns` and `subscribers` are the PLURAL list routes. The singular
 * `moosewave://campaign/<id>` stays with route-map's entity parser, which runs
 * first — the two grammars are disjoint by number, not by precedence.
 */
const PRIMARY_TAB_SLUGS: Readonly<Record<string, string>> = {
  dashboard: "/(tabs)/dashboard",
  subscribers: "/(tabs)/subscribers",
  campaigns: "/(tabs)/campaigns",
  approvals: "/(tabs)/approvals",
  more: "/(tabs)/more",
};

/** Channel-specific aliases that intentionally land inside a shared screen. */
const NESTED_DESTINATION_SLUGS: Readonly<Record<string, string>> = {
  "push-suppressions": "/(tabs)/suppressions?channel=push",
};

/** slug → mobile route, built once from the manifest. */
const SLUG_ROUTES: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>([
    ...Object.entries(PRIMARY_TAB_SLUGS),
    ...Object.entries(NESTED_DESTINATION_SLUGS),
  ]);
  for (const route of MOBILE_SECONDARY_ROUTES) {
    // The route KEY is the canonical slug ("audit-sinks", "sms-suppressions").
    map.set(route.key.toLowerCase(), route.route);
    // …and so is the route's own last path segment, so `moosewave://sms` and
    // `moosewave://sms-suppressions` both work without the caller having to
    // know which of the two spellings the table happens to use.
    const tail = route.route.split("/").filter(Boolean).pop();
    if (tail && !map.has(tail.toLowerCase())) {
      map.set(tail.toLowerCase(), route.route);
    }
  }
  return map;
})();

/** Every slug this grammar accepts. Exported for the consistency test. */
export function knownNavLinkSlugs(): string[] {
  return [...SLUG_ROUTES.keys()].sort();
}

/** Resolve a bare slug to a mobile route, or null. */
export function routeForNavSlug(slug: string): string | null {
  const key = slug.trim().toLowerCase();
  if (!key) return null;
  return SLUG_ROUTES.get(key) ?? null;
}

const MAX_NAV_LINK_URL_BYTES = 2048;

/**
 * Longest search term a destination link may carry. Long enough for an email
 * address or a campaign name, short enough that a link cannot smuggle a
 * payload into a screen through its search box.
 */
const MAX_NAV_LINK_QUERY_CHARS = 320;

/**
 * The ONE query parameter a destination link may carry through: a search term
 * for the list it names.
 *
 * NATIVE#23 is what needs it. The Android share target forwards a shared email
 * address as `moosewave://subscribers?q=<address>`, and dropping the term would
 * land the user on the full subscriber list having thrown away the only reason
 * they shared it. Everything else in the query string is still discarded, so a
 * link cannot set arbitrary route params.
 *
 * Screens that do not read `q` simply ignore it.
 */
function navLinkSearchSuffix(parsed: URL): string {
  const term = parsed.searchParams.get("q");
  if (!term) return "";
  const trimmed = term.trim();
  if (!trimmed || trimmed.length > MAX_NAV_LINK_QUERY_CHARS) return "";
  // Re-encoded from the DECODED value, so a double-encoded or malformed
  // escape in the incoming link cannot survive into the route.
  return `?q=${encodeURIComponent(trimmed)}`;
}

function appendAllowedSearch(route: string, parsed: URL): string {
  const suffix = navLinkSearchSuffix(parsed);
  return suffix && route.includes("?")
    ? `${route}&${suffix.slice(1)}`
    : `${route}${suffix}`;
}

/**
 * Resolve a destination link to a mobile route path, or null.
 *
 * Returns a plain path string (not an `Href`) so this module stays free of
 * expo-router; the caller casts once.
 */
export function routeForNavLink(rawUrl: string): string | null {
  if (!rawUrl || rawUrl.length > MAX_NAV_LINK_URL_BYTES) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  // Credentials or a fragment mean this did not come from anywhere we trust.
  if (parsed.username || parsed.password || parsed.hash) return null;

  if (parsed.protocol === "postwave:") {
    if (parsed.port) return null;
    // `moosewave://tags` puts "tags" in hostname and leaves the path empty.
    const path = parsed.pathname.replace(/\/+$/u, "");
    if (path !== "") return null;
    const route = routeForNavSlug(parsed.hostname);
    return route ? appendAllowedSearch(route, parsed) : null;
  }

  if (parsed.protocol !== "https:") return null;
  if (!TRUSTED_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  // Exactly /app/<slug>. A third segment is an entity link that route-map
  // already had its chance at, and truncating it would be a lie.
  if (segments.length !== 2 || segments[0] !== "app") return null;
  const route = routeForNavSlug(segments[1] ?? "");
  return route ? appendAllowedSearch(route, parsed) : null;
}
