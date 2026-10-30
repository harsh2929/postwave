/**
 * tagInput — client-side validation for the free-text tag box, matching
 * the server's `normalizeTagName` (apps/api/internal/tags/tags.go:366)
 * so an invalid tag is caught before the round trip instead of coming
 * back as a raw 400 in an alert.
 *
 * The server counts RUNES, not UTF-16 code units, so `"👍".length === 2`
 * would let a 64-emoji tag through and then reject it. `Array.from`
 * counts the same units Go's `utf8.RuneCountInString` does.
 */

/** Mirrors TagNameMaxRunes in apps/api/internal/tags/tags.go. */
export const TAG_NAME_MAX_RUNES = 64;

/** Rune (code point) length, matching Go's utf8.RuneCountInString. */
export function runeLength(value: string): number {
  return Array.from(value).length;
}

/** Truncate to at most `max` runes without splitting a surrogate pair. */
export function limitRunes(value: string, max = TAG_NAME_MAX_RUNES): string {
  const runes = Array.from(value);
  return runes.length <= max ? value : runes.slice(0, max).join("");
}

export type TagValidationCode = "empty" | "too_long" | "duplicate" | "ok";

export interface TagValidation {
  code: TagValidationCode;
  /** Null when the input is acceptable; otherwise the inline hint text. */
  hint: string | null;
  /** Whether the Add affordance should be enabled. */
  canAdd: boolean;
}

/**
 * Validate a draft tag against the server's rules AND the tags already on
 * this subscriber. Returns the hint the input should render underneath
 * itself — one place, one policy, so the three reasons an Add is refused
 * are all explained rather than silently greying out the button.
 */
export function validateTagDraft(
  draft: string,
  currentTags: readonly string[] | undefined,
): TagValidation {
  const trimmed = draft.trim();
  if (!trimmed) return { code: "empty", hint: null, canAdd: false };

  const length = runeLength(trimmed);
  if (length > TAG_NAME_MAX_RUNES) {
    return {
      code: "too_long",
      hint: `Tags are at most ${TAG_NAME_MAX_RUNES} characters (this one is ${length}).`,
      canAdd: false,
    };
  }

  const lower = trimmed.toLowerCase();
  const duplicate = (currentTags ?? []).some(
    (tag) => tag.trim().toLowerCase() === lower,
  );
  if (duplicate) {
    return {
      code: "duplicate",
      hint: "That tag is already on this subscriber.",
      canAdd: false,
    };
  }

  return { code: "ok", hint: null, canAdd: true };
}

/**
 * Compute the next tag set after adding `tag`. Case-insensitively deduped
 * so "VIP" and "vip" don't both land on the row, and the original casing
 * of an already-present tag is preserved. Returns null when the tag is
 * blank or already present (→ no PATCH needed).
 *
 * The result is what gets PATCHed: `tags` is a FULL-ARRAY REPLACE on
 * PATCH /api/v1/subscribers/{id}, so the caller must always send the whole
 * set — see the serialisation note in useUpdateSubscriberTags.
 */
export function nextTagsAfterAdd(
  current: readonly string[] | undefined,
  tag: string,
): string[] | null {
  const trimmed = tag.trim();
  if (!trimmed) return null;
  const existing = current ?? [];
  const lower = trimmed.toLowerCase();
  if (existing.some((t) => t.trim().toLowerCase() === lower)) return null;
  return [...existing, trimmed];
}

/**
 * Compute the next tag set after removing `tag` (case-insensitive match).
 * Returns null when nothing would change (→ no PATCH needed).
 */
export function nextTagsAfterRemove(
  current: readonly string[] | undefined,
  tag: string,
): string[] | null {
  const existing = current ?? [];
  const lower = tag.trim().toLowerCase();
  const next = existing.filter((t) => t.trim().toLowerCase() !== lower);
  return next.length === existing.length ? null : next;
}
