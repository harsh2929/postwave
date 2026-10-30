/**
 * tagSuggestions — the pure policy behind the tag typeahead.
 *
 * A phone keyboard is the highest-typo-rate input device in the product,
 * and `tags` is a free-text field: a typo silently FORKS the taxonomy
 * ("newsletter" vs "newsleter") with no way to notice or merge from a
 * phone. `GET /api/v1/tag-taxonomy/suggest?q=&limit=` already returns the
 * workspace's live taxonomy ranked by how many subscribers carry each tag
 * (apps/api/internal/tag_taxonomy/tag_taxonomy.go Suggest), so the fix is
 * to offer those names rather than trust the thumb.
 *
 * Import-free on purpose: vitest runs in a NODE environment, so anything
 * that transitively pulls react-native cannot be tested. The ranking and
 * de-duplication rules live here; the hook and the sheet only render them.
 *
 * The server matches with `name ILIKE '%q%'`, so every returned row already
 * CONTAINS the draft. That means an exact-case-insensitive hit is the most
 * valuable suggestion of all, not a redundant one: tapping "vip" when you
 * typed "VIP" adopts the taxonomy's own casing instead of forking it.
 */
import { plural } from "@/lib/format";


/** One row of `GET /api/v1/tag-taxonomy/suggest`. */
export interface TagSuggestion {
  tag: string;
  /** How many subscribers carry the tag. Used only for ordering/copy. */
  subscribers: number;
}

/**
 * Parse the suggest envelope defensively. The handler writes
 * `{items: [{tag, subscribers, registered}], q}`, but a gateway that
 * returns a bare array (or nothing at all) must degrade to "no
 * suggestions" rather than throwing inside a keystroke handler.
 */
export function parseTagSuggestions(raw: unknown): TagSuggestion[] {
  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (raw as { items?: unknown }).items
      : undefined;
  if (!Array.isArray(items)) return [];
  const out: TagSuggestion[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { tag?: unknown; subscribers?: unknown };
    const tag = typeof row.tag === "string" ? row.tag.trim() : "";
    if (!tag) continue;
    const subscribers =
      typeof row.subscribers === "number" && Number.isFinite(row.subscribers)
        ? Math.max(0, Math.trunc(row.subscribers))
        : 0;
    out.push({ tag, subscribers });
  }
  return out;
}

/**
 * Narrow the taxonomy typeahead to the names worth offering under the
 * input, preserving the server's ranking (most-used first).
 *
 *  - Tags already on THIS subscriber are dropped: tapping one would be a
 *    no-op the sheet already refuses, and it would push a usable
 *    suggestion off the visible row.
 *  - Case-insensitive de-duplication, keeping the first (highest-ranked)
 *    spelling, so a taxonomy that already contains both "VIP" and "vip"
 *    doesn't offer the fork it is trying to prevent.
 *  - Capped, because this row sits above the keyboard.
 */
export function filterTagSuggestions(
  items: readonly TagSuggestion[] | undefined,
  currentTags: readonly string[] | undefined,
  limit = 6,
): TagSuggestion[] {
  if (!items?.length || limit <= 0) return [];
  const taken = new Set(
    (currentTags ?? [])
      .map((tag) => tag.trim().toLowerCase())
      .filter((tag) => tag.length > 0),
  );
  const out: TagSuggestion[] = [];
  for (const item of items) {
    const name = item.tag.trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (taken.has(lower)) continue;
    taken.add(lower);
    out.push({ tag: name, subscribers: item.subscribers });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Spoken label for one suggestion chip. VoiceOver gets the exact usage
 * count beside the compacted visual, per the a11y contract — "vip, used by
 * 1,204 subscribers" rather than a bare tag name whose "1.2k" badge is
 * invisible to a screen reader.
 */
export function tagSuggestionLabel(suggestion: TagSuggestion): string {
  if (suggestion.subscribers <= 0) {
    return `Add tag ${suggestion.tag}, not used yet`;
  }
  return `Add tag ${suggestion.tag}, used by ${plural(suggestion.subscribers, "subscriber")}`;
}

/**
 * Whether the draft is a case-variant of an existing taxonomy name (and
 * not an exact match). This is the fork the typeahead exists to prevent,
 * so the sheet says so out loud instead of silently letting "VIP" through
 * beside an established "vip".
 */
export function taxonomyCaseVariant(
  draft: string,
  items: readonly TagSuggestion[] | undefined,
): string | null {
  const trimmed = draft.trim();
  if (!trimmed || !items?.length) return null;
  const lower = trimmed.toLowerCase();
  for (const item of items) {
    const name = item.tag.trim();
    if (!name || name === trimmed) continue;
    if (name.toLowerCase() === lower) return name;
  }
  return null;
}
