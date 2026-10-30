/**
 * tagCreateDraft — the pure half of "create a tag ahead of use".
 *
 * Desktop authors tags in TagCreateModal (name + palette colour + group +
 * description, with taxonomy suggestions as a typo guard); mobile only ever
 * created one as a SIDE EFFECT of bulk-applying it. This module carries the
 * draft policy for a first-class create sheet: validation mirroring the Go
 * normalisers, the palette vocabulary, the request body builder, and the
 * dedup hint over the taxonomy typeahead.
 *
 * ORPHAN REGISTRATION rides the same POST: a tag applied ad-hoc from the
 * subscriber sheet exists on rows but not in the registry, and
 * `POST /api/v1/tags` with its name REGISTERS it (only a registry row
 * conflicts, answering 409 name_taken). So "create" and desktop's
 * RegisterOrphanModal are one verb here, and the dedup hint says so.
 *
 * Free of react-native imports so node-run vitest covers the policy.
 */
import { num } from "@/lib/format";
import { runeLength, TAG_NAME_MAX_RUNES } from "@/lib/tagInput";
import type { TagSuggestion } from "@/lib/tagSuggestions";

/** Mirrors TagDescriptionMaxRunes (apps/api/internal/tags/tags.go). */
export const TAG_DESCRIPTION_MAX_RUNES = 1024;

/**
 * The server's palette vocabulary, verbatim from `tagPalette`
 * (apps/api/internal/tags/tags.go:48-51). Every id must resolve through
 * `resolveTagColor` — the test pins that, so the two tables cannot drift.
 */
export const TAG_PALETTE: readonly { id: string; label: string }[] = [
  { id: "slate", label: "Slate" },
  { id: "teal", label: "Teal" },
  { id: "sky", label: "Sky" },
  { id: "indigo", label: "Indigo" },
  { id: "violet", label: "Violet" },
  { id: "rose", label: "Rose" },
  { id: "amber", label: "Amber" },
  { id: "lime", label: "Lime" },
];

export interface TagDraft {
  name: string;
  /** A palette id, or "" for no colour. */
  color: string;
  description: string;
  /** Tag-group UUID, or "" for no group. */
  groupId: string;
}

export const EMPTY_TAG_DRAFT: TagDraft = {
  name: "",
  color: "",
  description: "",
  groupId: "",
};

export interface TagDraftValidation {
  /** Inline hint under the name field; null when acceptable. */
  nameHint: string | null;
  descriptionHint: string | null;
  canSubmit: boolean;
}

/**
 * Mirrors `normalizeTagName` / `normalizeTagDescription` so an invalid
 * draft is caught before the round trip rather than coming back as a 400.
 * Rune counts, not UTF-16 lengths — the server counts runes.
 */
export function validateTagDraft(draft: TagDraft): TagDraftValidation {
  const name = draft.name.trim();
  let nameHint: string | null = null;
  if (!name) {
    // No hint for an untouched empty field — the disabled submit carries it.
    nameHint = null;
  } else if (runeLength(name) > TAG_NAME_MAX_RUNES) {
    nameHint = `Tag names are capped at ${TAG_NAME_MAX_RUNES} characters.`;
  }
  const descriptionHint =
    runeLength(draft.description.trim()) > TAG_DESCRIPTION_MAX_RUNES
      ? `Descriptions are capped at ${TAG_DESCRIPTION_MAX_RUNES} characters.`
      : null;
  return {
    nameHint,
    descriptionHint,
    canSubmit: Boolean(name) && nameHint === null && descriptionHint === null,
  };
}

/** The exact JSON `tags.CreateInput` decodes: trimmed, empties omitted. */
export function buildCreateTagBody(draft: TagDraft): {
  name: string;
  color?: string;
  description?: string;
  group_id?: string;
} {
  const description = draft.description.trim();
  const color = draft.color.trim();
  const groupId = draft.groupId.trim();
  return {
    name: draft.name.trim(),
    ...(color ? { color } : {}),
    ...(description ? { description } : {}),
    ...(groupId ? { group_id: groupId } : {}),
  };
}

/**
 * The suggestion that IS this draft, if any — desktop's dedupHint. A
 * case-insensitive exact match means the name already exists in the
 * taxonomy (registered or orphaned), which is worth a sentence before the
 * server is asked.
 */
export function tagCreateDedupHint(
  suggestions: readonly TagSuggestion[],
  name: string,
): TagSuggestion | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  return (
    suggestions.find((s) => s.tag.trim().toLowerCase() === needle) ?? null
  );
}

/**
 * What the dedup hint says. Mobile's suggestion parser does not carry the
 * `registered` flag, so the copy states both outcomes honestly — the POST
 * is the authority: an unregistered (orphan) name is registered by
 * creating it, a registered one answers 409.
 */
export function dedupHintCopy(hint: TagSuggestion): string {
  const carriers =
    hint.subscribers === 1
      ? "1 subscriber already carries"
      : `${num(hint.subscribers)} subscribers already carry`;
  return `${carriers} “${hint.tag}”. If it was never registered in the catalogue, creating it here registers it; if it already is, this will be refused.`;
}

/**
 * The near-miss row under the name field — desktop's "Did you mean". The
 * exact match is excluded (it gets the dedup sentence instead).
 */
export function tagCreateNearMisses(
  suggestions: readonly TagSuggestion[],
  name: string,
  cap = 4,
): TagSuggestion[] {
  const needle = name.trim().toLowerCase();
  if (!needle) return [];
  return suggestions
    .filter((s) => s.tag.trim().toLowerCase() !== needle)
    .slice(0, cap);
}

/**
 * The invalidation root for a successful create. MUST stay a true prefix
 * of every tag read's key — `tagCatalogueKey`, `tagSuggestionsKey` and
 * `tagGroupsKey` all open with ["tags", tenantId] — and the test pins that
 * relationship so a key rename cannot silently orphan the invalidation.
 */
export function tagsInvalidationKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return ["tags", tenantId ?? null];
}
