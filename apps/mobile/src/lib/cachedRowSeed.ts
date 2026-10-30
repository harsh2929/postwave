/**
 * cachedRowSeed — find the row a detail screen is about inside the LIST
 * query cache that the user just tapped.
 *
 * The defect this closes: drilling into an entity showed a header with no
 * identity in it — "Subscriber" with a blank subtitle, "Segment" as a title —
 * for the whole of the detail round trip, even though the row the user
 * tapped is still mounted one screen away with the name and the email
 * already in memory. Detail routes are siblings in the Tabs navigator, so
 * the list screen is not even unmounted (see LOVE-V#1); the data is right
 * there.
 *
 * This module is the pure half: given whatever `QueryClient.getQueriesData`
 * returned for a list root, dig out the one row whose id matches. It has to
 * cope with the four cache shapes the app actually stores under a list root:
 *
 *   1. a bare array of rows                       (segments)
 *   2. `{ items: [...] }`                          (single-page list)
 *   3. `{ pages: [ <1 or 2 above> ] }`             (useInfiniteQuery)
 *   4. `{ value: <1..3> }`                         (snapshot-backed reads)
 *
 * Everything is defensive: a cache entry is untrusted here in the same way
 * network JSON is, because a stale build's shape can still be sitting in a
 * rehydrated cache. A shape it cannot read yields null, and the caller falls
 * back to the placeholder it used before — never a crash, and never a
 * confidently wrong header.
 *
 * Import-free (no react-native, no @tanstack/react-query) so it is unit-
 * testable in the node environment.
 */

export type CachedRow = Record<string, unknown>;

function isRecord(value: unknown): value is CachedRow {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The ONLY keys treated as containers. Walking every key would pull
 * unrelated nested objects (a row's `meta.owner`, say) into the candidate set
 * and could match the wrong entity's id — the one failure mode worse than a
 * blank header.
 */
const CONTAINER_KEYS = ["value", "pages", "items", "rows"] as const;

/**
 * Depth-limited unwrap of one cache entry into a flat list of candidate row
 * objects.
 *
 * A record is a ROW when it carries none of the container keys, and a
 * CONTAINER otherwise — which is what lets the same walk read a bare array, a
 * `{items}` page, a `{pages:[{items}]}` infinite cache and a
 * `{value:{pages:[{items}]}}` snapshot without four code paths.
 *
 * The depth cap is what makes a self-referential rehydrated entry terminate
 * rather than hang; the deepest real shape above is five levels.
 */
function collectRows(node: unknown, depth: number, out: CachedRow[]): void {
  if (depth > 8 || out.length >= 2000) return;
  if (Array.isArray(node)) {
    for (const entry of node) {
      if (out.length >= 2000) return;
      collectRows(entry, depth + 1, out);
    }
    return;
  }
  if (!isRecord(node)) return;
  const containers = CONTAINER_KEYS.filter((key) => key in node);
  if (containers.length === 0) {
    out.push(node);
    return;
  }
  for (const key of containers) collectRows(node[key], depth + 1, out);
}

/** Every row object reachable inside the supplied cache entries. */
export function cachedRows(entries: readonly unknown[]): CachedRow[] {
  const out: CachedRow[] = [];
  for (const entry of entries) collectRows(entry, 0, out);
  return out;
}

/**
 * The first cached row whose `idKey` equals `id`.
 *
 * Matching is exact-string on the stringified value: ids are uuids or
 * emails, and a loose match here would put another person's name in the
 * header — the one failure mode that is worse than a blank one.
 */
export function findCachedRow(
  entries: readonly unknown[],
  id: string | null | undefined,
  idKey = "id",
): CachedRow | null {
  const needle = (id ?? "").trim();
  if (!needle) return null;
  for (const row of cachedRows(entries)) {
    const candidate = row[idKey];
    if (candidate == null) continue;
    if (String(candidate) === needle) return row;
  }
  return null;
}

/** A string field off a cached row, or undefined when it is not usable. */
export function cachedString(
  row: CachedRow | null,
  key: string,
): string | undefined {
  if (!row) return undefined;
  const value = row[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
