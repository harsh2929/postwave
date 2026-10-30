/**
 * lib/savedAnalyticsViews.ts — named reporting presets for the Analytics
 * screen, stored beside the screen's other remembered state.
 *
 * NO SERVER IS INVOLVED, and that is a finding rather than an omission: the
 * desktop's saved views are client-side too (saved-views-storage.ts, encrypted
 * localStorage). There is no `/analytics/views` route in
 * routeauth/manifest.json to call, so a mobile view is stored the way every
 * other mobile preference is — `lib/listPreferences`, scoped to
 * origin + tenant + user, so one workspace's presets never appear in another.
 *
 * WHAT A VIEW CAPTURES. Desktop's preset is `{range, vsPrevious}`. The phone
 * has no vs-previous toggle — the deliverability card always compares against
 * the preceding window — so the mobile preset captures the two controls this
 * screen ACTUALLY has: the reporting window, and the breakdown comparison
 * (which dimension, which metric). A preset that stored a control the screen
 * does not own would restore nothing on apply.
 *
 * WHY A STORED VIEW IS VALIDATED AGAINST A VOCABULARY ON EVERY READ. These
 * values are sent to the server as query parameters (`dimension`, `metric`)
 * where anything outside the whitelist is a 400, and a preset saved by an
 * older build can name a metric this build no longer has. A view whose
 * vocabulary no longer resolves is DROPPED rather than coerced: silently
 * applying "opens" to a chip labelled "Revenue" is worse than the chip
 * disappearing.
 *
 * Pure and free of react-native imports (house rule 6).
 */

export interface SavedAnalyticsView {
  /** Stable local id; also the React key. */
  id: string;
  name: string;
  range: string;
  dimension: string;
  metric: string;
}

/** The vocabularies a stored view must still resolve against. */
export interface ViewVocabulary {
  ranges: readonly string[];
  dimensions: readonly string[];
  metrics: readonly string[];
}

/** How many presets one identity may keep. */
export const MAX_SAVED_VIEWS = 12;

/** The longest name a chip can carry without becoming an ellipsis. */
export const MAX_VIEW_NAME = 32;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Total parser over the stored JSON string. Storage is a string on this
 * platform, so every failure mode — a truncated write, a value written by an
 * older shape, an outright `undefined` — arrives here, and a throw would take
 * the whole Analytics screen down on mount.
 */
export function parseSavedViews(
  raw: unknown,
  vocab: ViewVocabulary,
): SavedAnalyticsView[] {
  let decoded: unknown = raw;
  if (typeof raw === "string") {
    try {
      decoded = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const list = Array.isArray(decoded) ? decoded : [];
  const out: SavedAnalyticsView[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const name = text(row.name);
    const range = text(row.range);
    const dimension = text(row.dimension);
    const metric = text(row.metric);
    if (!name) continue;
    // The vocabulary check, not a cast: an unknown value here would become a
    // 400 the next time the screen fetched a breakdown.
    if (
      !vocab.ranges.includes(range) ||
      !vocab.dimensions.includes(dimension) ||
      !vocab.metrics.includes(metric)
    ) {
      continue;
    }
    const id = text(row.id) || `${name.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, range, dimension, metric });
    if (out.length >= MAX_SAVED_VIEWS) break;
  }
  return out;
}

/** What goes back to storage. */
export function serializeSavedViews(views: readonly SavedAnalyticsView[]): string {
  return JSON.stringify(views.slice(0, MAX_SAVED_VIEWS));
}

/**
 * Why this name cannot be saved, or null when it can.
 *
 * A same-name save REPLACES rather than erroring — re-saving "Weekly check"
 * after changing the window is the common case, and forcing a delete first
 * would make the feature feel broken. The name is only rejected when it is
 * empty or too long to render.
 */
export function savedViewNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the view a name so you can find it again.";
  if (trimmed.length > MAX_VIEW_NAME) {
    return `Keep the name to ${MAX_VIEW_NAME} characters or fewer.`;
  }
  return null;
}

/**
 * Insert or replace, newest first, capped. Case-insensitive on the name: two
 * chips reading "weekly" and "Weekly" are the same preset to a reader, and
 * keeping both makes the row unusable.
 */
export function upsertSavedView(
  views: readonly SavedAnalyticsView[],
  view: SavedAnalyticsView,
): SavedAnalyticsView[] {
  const key = view.name.trim().toLowerCase();
  const kept = views.filter(
    (existing) => existing.name.trim().toLowerCase() !== key,
  );
  return [{ ...view, name: view.name.trim() }, ...kept].slice(
    0,
    MAX_SAVED_VIEWS,
  );
}

export function removeSavedView(
  views: readonly SavedAnalyticsView[],
  id: string,
): SavedAnalyticsView[] {
  return views.filter((view) => view.id !== id);
}

/** True when the screen's current controls already match this view. */
export function viewIsActive(
  view: SavedAnalyticsView,
  current: { range: string; dimension: string; metric: string },
): boolean {
  return (
    view.range === current.range &&
    view.dimension === current.dimension &&
    view.metric === current.metric
  );
}

/**
 * The line under a chip, assembled from labels the screen already renders
 * elsewhere so a preset never invents a vocabulary of its own.
 */
export function savedViewSummary(labels: {
  range: string;
  metric: string;
  dimension: string;
}): string {
  return `${labels.range} · ${labels.metric} by ${labels.dimension}`;
}

/** The spoken chip: the name alone tells VoiceOver nothing about what applies. */
export function savedViewSpoken(
  view: SavedAnalyticsView,
  labels: { range: string; metric: string; dimension: string },
  active: boolean,
): string {
  const state = active ? ", currently applied" : "";
  return `${view.name}: ${savedViewSummary(labels)}${state}. Double tap to apply, or press and hold to delete.`;
}

/** The delete confirmation. A preset is cheap to remake, so no typing gate. */
export function deleteViewConfirm(view: SavedAnalyticsView): {
  title: string;
  message: string;
  confirmLabel: string;
} {
  return {
    title: `Delete “${view.name}”?`,
    message:
      "The preset is removed from this device for this workspace. The numbers it points at are not affected.",
    confirmLabel: "Delete",
  };
}

/** The empty row's sentence: what the control is for, before one exists. */
export const SAVED_VIEWS_EMPTY =
  "Save the window and breakdown you check most often, then bring it back in one tap.";
