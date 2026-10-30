/**
 * subscriberSavedSegmentDraft — turning the list the operator is LOOKING AT
 * into a saved segment, and the honesty rules around it.
 *
 * The phone applies saved segments (lib/savedSegments.ts) but could not
 * create or delete one, so a view assembled on the road was lost the moment
 * the screen changed. Creation writes the COMPATIBILITY predicate shape —
 * `{filters: {status, q}}` — deliberately:
 *
 *  - desktop's `savedSegmentSnapshot` falls back to `filters` whenever no
 *    v3+ authoritative snapshot is declared, so the bookmark opens there;
 *  - declaring `snapshot.version: 3` without the full column/sort contract
 *    would make desktop REJECT the record outright ("damaged snapshot"), so
 *    the phone must not claim a contract it cannot fill;
 *  - the server compiles `filters.{status,q}` into a previewable AST, so
 *    counts work;
 *  - mobile's own reducer reads the same two fields back, so the chip the
 *    save creates is applicable on the device that created it.
 *
 * An archived-widened view is REFUSED rather than silently narrowed: the
 * filters shape cannot carry the archive axis, and saving "what I see" minus
 * one axis would bookmark a different audience under the same name.
 *
 * Import-free so every rule is unit-tested in the node run.
 */

/** Mobile chip key → engine status the saved filters store. "" = all. */
const CHIP_TO_ENGINE: Record<string, string> = {
  all: "",
  subscribed: "enabled",
  unsubscribed: "blocklisted",
  disabled: "disabled",
  unconfirmed: "unconfirmed",
};

export interface SavedViewState {
  /** SETTLED query — the draft the user is mid-typing is not the view. */
  query: string;
  /** Mobile chip key ("all" | "subscribed" | …). */
  statusKey: string;
  includeArchived: boolean;
}

/** Why this view cannot become a saved segment, or null when it can. */
export function saveableViewProblem(view: SavedViewState): string | null {
  if (view.includeArchived) {
    return "Views that include archived contacts can't be saved from the phone — the bookmark would silently drop that scope.";
  }
  if (CHIP_TO_ENGINE[view.statusKey] === undefined) {
    return "This status filter has no saved-segment equivalent.";
  }
  if (!view.query.trim() && view.statusKey === "all") {
    return "Narrow the list first — the unfiltered directory doesn't need a bookmark.";
  }
  return null;
}

/**
 * The predicate_json for POST /api/v1/segments/saved. Null exactly when
 * `saveableViewProblem` names a problem, so a caller cannot save a view this
 * module refused.
 */
export function buildSavedViewPredicate(
  view: SavedViewState,
): { filters: { status: string; q: string } } | null {
  if (saveableViewProblem(view)) return null;
  return {
    filters: {
      status: CHIP_TO_ENGINE[view.statusKey] ?? "",
      q: view.query.trim(),
    },
  };
}

/** Mirror of the server's validateSavedSegmentText (saved_segments.go:158). */
export function savedSegmentTextProblem(
  name: string,
  description: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name the segment.";
  if ([...trimmed].length > 120) {
    return "The name must be 120 characters or fewer.";
  }
  if ([...description].length > 1000) {
    return "The description must be 1,000 characters or fewer.";
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return "The name can't contain control characters.";
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)) {
    return "The description can't contain control characters.";
  }
  return null;
}

/** Spoken/printed summary of what the bookmark will reproduce. */
export function savedViewSummary(view: SavedViewState): string {
  const parts: string[] = [];
  const q = view.query.trim();
  if (q) parts.push(`search “${q}”`);
  const status = CHIP_TO_ENGINE[view.statusKey];
  if (status) parts.push(`status ${view.statusKey}`);
  return parts.length > 0
    ? `Saves the current view: ${parts.join(" and ")}.`
    : "Saves the current view.";
}

export interface DeleteSegmentCopy {
  title: string;
  message: string;
  confirmLabel: string;
  consequence: string;
}

/**
 * Deleting a bookmark is destructive but small: it removes the shared
 * shortcut, never the people in it. The copy says exactly that scope so the
 * confirm is not scarier — or safer-sounding — than the act.
 */
export function deleteSegmentConfirmCopy(input: {
  name: string;
  visibility: string;
}): DeleteSegmentCopy {
  const shared = input.visibility === "workspace";
  return {
    title: `Delete “${input.name}”?`,
    message: shared
      ? "This saved view is shared with the whole workspace — deleting it removes it for everyone. No subscribers are affected."
      : "This deletes your saved view. No subscribers are affected.",
    confirmLabel: "Delete view",
    consequence: shared
      ? "The workspace loses this shortcut."
      : "The shortcut is removed.",
  };
}
