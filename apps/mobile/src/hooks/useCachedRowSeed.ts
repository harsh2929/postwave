/**
 * useCachedRowSeed — the header identity a detail screen can render on its
 * FIRST frame, taken from the list cache the user just tapped out of.
 *
 * Why this is worth a hook rather than `placeholderData`: the list and the
 * detail are different endpoints with different shapes (the list row is a
 * projection), so seeding the whole detail query with a row would make
 * `isSuccess` true for an object that is missing most of its fields, and
 * every card downstream would have to re-check. This seeds only the two or
 * three strings the HEADER needs, leaves the detail query honestly loading,
 * and disappears the moment real data lands.
 *
 * The lookup itself is pure and unit-tested in src/lib/cachedRowSeed.ts.
 */
import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { cachedString, findCachedRow } from "@/lib/cachedRowSeed";

/**
 * Look `id` up under a list query-key PREFIX (e.g. `["subs", tenantId]`) and
 * return the requested string fields off the matching row.
 *
 * `fields` is fixed-length at the call site, so the returned object is
 * recomputed only when the id or the prefix changes — a cache read on every
 * render of a scrolling screen would be wasteful, and the seed is only ever
 * needed while the detail query is in flight anyway.
 */
export function useCachedRowSeed<F extends string>(
  prefix: readonly unknown[],
  id: string | null | undefined,
  fields: readonly F[],
  idKey = "id",
): Partial<Record<F, string>> {
  const queryClient = useQueryClient();
  const prefixToken = JSON.stringify(prefix);
  const fieldToken = fields.join(",");
  return useMemo(() => {
    const out: Partial<Record<F, string>> = {};
    if (!id) return out;
    // getQueriesData returns [key, data] for EVERY variant under the prefix
    // — each search term, status chip and sort order the user has visited.
    // The row can be in any of them.
    //
    // Guarded: this is a COSMETIC seed for a header, and it must never be the
    // reason a detail screen fails to render. A client without the method (an
    // older version, or a stub) yields no seed and the screen falls back to
    // the placeholder it used before.
    if (typeof queryClient.getQueriesData !== "function") return out;
    const entries = queryClient
      .getQueriesData({ queryKey: prefix })
      .map(([, data]) => data);
    const row = findCachedRow(entries, id, idKey);
    if (!row) return out;
    for (const field of fields) {
      const value = cachedString(row, field);
      if (value !== undefined) out[field] = value;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, prefixToken, fieldToken, id, idKey]);
}
