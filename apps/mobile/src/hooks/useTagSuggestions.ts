/**
 * useTagSuggestions — typeahead over the workspace tag taxonomy.
 *
 *   GET /api/v1/tag-taxonomy/suggest?q=&limit=
 *   → { items: [{ tag, subscribers, registered }], q }
 *
 * The tag box on a subscriber was plain free text whose only feedback was
 * "that tag is already on this subscriber" — a check against THIS row, not
 * against the taxonomy. So a thumb-typo created a brand-new tag that looked
 * identical to the real one in a chip cloud, and mobile has no merge UI to
 * undo it with. This hook is the missing half.
 *
 * Deliberately NOT a `client.tags.list({query})` call: that endpoint is the
 * unpaginated catalogue and returns whole tag records ordered by name. The
 * suggest endpoint is ranked by live usage and capped server-side, which is
 * what a six-chip row above a keyboard needs.
 *
 * Callers pass an ALREADY-DEBOUNCED query (src/hooks/useDebounced.ts) — one
 * request per pause, not per keystroke.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseTagSuggestions,
  type TagSuggestion,
} from "@/lib/tagSuggestions";

/** How many rows to ask the server for (it clamps to [1, 50]). */
const SUGGEST_LIMIT = 8;

export function tagSuggestionsKey(
  tenantId: string | null | undefined,
  query: string,
): readonly unknown[] {
  return ["tags", tenantId ?? null, "suggest", query];
}

export function useTagSuggestions(
  query: string,
  options: { enabled?: boolean } = {},
) {
  const gate = useOnlineQueryGate();
  const q = query.trim();
  // The sheet is closed most of the time; `enabled` keeps a mounted-but-
  // hidden modal from holding a live query open.
  const wanted = options.enabled !== false;
  return useQuery({
    queryKey: tagSuggestionsKey(gate.tenantId, q),
    enabled: gate.enabled && Boolean(gate.tenantId) && wanted,
    // The taxonomy moves slowly and the same prefixes get retyped constantly
    // while a user tags several people in a row.
    staleTime: 60_000,
    queryFn: async (): Promise<TagSuggestion[]> => {
      const { client } = getClient();
      const raw = await client.request<unknown>(
        "GET",
        "/api/v1/tag-taxonomy/suggest",
        { query: { q, limit: SUGGEST_LIMIT } },
      );
      return parseTagSuggestions(raw);
    },
  });
}
