import {
  NAV_ENTRIES,
  type NavEntry,
  type NavGroup,
  type Scope,
  type Surface,
} from "./manifest.js";

/** Look up a single entry by its canonical key. */
export function getEntry(key: string): NavEntry | undefined {
  return NAV_ENTRIES.find((e) => e.key === key);
}

/** The canonical label for an entry key (the per-surface drift killer). */
export function labelFor(key: string): string | undefined {
  return getEntry(key)?.label;
}

/**
 * The space-constrained label for an entry key, falling back to the
 * canonical label. Use on width-limited surfaces (the mobile tab bar).
 */
export function shortLabelFor(key: string): string | undefined {
  const e = getEntry(key);
  return e ? (e.shortLabel ?? e.label) : undefined;
}

/** True when a surface exposes the entry in its primary nav (route is non-null). */
export function entryExposesSurface(entry: NavEntry, surface: Surface): boolean {
  return entry.routes[surface] !== null;
}

/** The set of surfaces that expose an entry, derived from its non-null routes. */
export function surfacesFor(entry: NavEntry): Surface[] {
  return (Object.keys(entry.routes) as Surface[]).filter((s) =>
    entryExposesSurface(entry, s),
  );
}

export interface NavForSurfaceOptions {
  /**
   * When provided, drop entries whose required scope exceeds the caller's.
   * `member` callers see only `member` entries; `admin` callers see all.
   * Omit to get every entry regardless of scope.
   */
  scope?: Scope;
}

/**
 * The ordered list of nav entries a surface should render, in canonical
 * display order. Filters to entries the surface exposes (non-null route) and,
 * optionally, to those within the caller's scope.
 *
 * This is the function every client's nav component should map over instead
 * of its own hand-rolled array.
 */
/**
 * Privilege ordering. A caller sees an entry when their rank is at least the
 * entry's.
 *
 * Typed `Record<Scope, number>` on purpose: adding a member to `Scope` makes
 * this object a COMPILE ERROR until its rank is declared. The previous form
 * asked whether the caller was exactly "member" and the entry exactly "admin",
 * which is a denylist — correct only while those are the only two values. The
 * doc on Scope already describes admin as "workspace admin/owner-only", so a
 * future `owner` split is the expected change, and under the old shape a new
 * owner-only entry would have been VISIBLE to members with nothing failing.
 * A nav entry is an affordance, not an authorisation boundary, but showing
 * privileged chrome to someone who cannot use it is how a UI teaches people
 * that permission errors are normal.
 */
const SCOPE_RANK: Record<Scope, number> = {
  member: 0,
  admin: 1,
};

export function navForSurface(
  surface: Surface,
  opts: NavForSurfaceOptions = {},
): NavEntry[] {
  const callerRank = opts.scope === undefined ? null : SCOPE_RANK[opts.scope];
  return NAV_ENTRIES.filter((e) => {
    if (!entryExposesSurface(e, surface)) return false;
    // Omitting scope still means "every entry", as documented.
    if (callerRank !== null && SCOPE_RANK[e.scope] > callerRank) return false;
    return true;
  });
}

/** The route an entry resolves to on a given surface, or null when unexposed. */
export function routeFor(key: string, surface: Surface): string | null {
  return getEntry(key)?.routes[surface] ?? null;
}

/** Entries belonging to a logical group, in canonical order (all surfaces). */
export function entriesInGroup(group: NavGroup): NavEntry[] {
  return NAV_ENTRIES.filter((e) => e.group === group);
}
