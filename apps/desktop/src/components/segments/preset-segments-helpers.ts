/**
 * preset-segments-helpers — pure paging/copy logic for the preset
 * segment "Recipes" gallery (full-surface wiring #25).
 *
 * Kept out of the component so the honesty invariants are unit-testable
 * under the node-env vitest setup:
 *
 *   - The member-preview pager must never claim a next page exists when
 *     the server returned a short page (`count < limit`).
 *   - The range label only cites the card total (computed when the
 *     gallery loaded) as an approximation — presets are live SQL, so
 *     the total can drift between the list call and the page call.
 */

import type { PresetSegment } from "../../lib/api/preset-segments";

export interface PresetPageWindow {
  /** e.g. "1–25 of ~1,204" — total is approximate (see above). */
  rangeLabel: string;
  hasPrev: boolean;
  hasNext: boolean;
}

/**
 * Compute the pager state for one page of a preset member preview.
 *
 * @param offset   requested offset (0-based)
 * @param limit    requested page size
 * @param returned number of rows the server actually returned (`count`
 *                 on the wire — it is the page length, NOT a total)
 * @param total    live total from the preset card at gallery-load time;
 *                 pass null when unknown.
 */
export function presetPageWindow(
  offset: number,
  limit: number,
  returned: number,
  total: number | null,
): PresetPageWindow {
  const hasPrev = offset > 0;
  // A full page means there may be more; a short page is authoritative
  // (the server ran out of rows). We deliberately ignore `total` here —
  // it was computed earlier and may be stale.
  const hasNext = returned === limit && limit > 0;
  if (returned === 0) {
    return {
      rangeLabel: hasPrev ? "No members on this page" : "No members",
      hasPrev,
      hasNext: false,
    };
  }
  const from = offset + 1;
  const to = offset + returned;
  const totalPart =
    total != null && total > 0 ? ` of ~${total.toLocaleString()}` : "";
  return {
    rangeLabel: `${from.toLocaleString()}–${to.toLocaleString()}${totalPart}`,
    hasPrev,
    hasNext,
  };
}

/**
 * Seed text for the natural-language segment builder when the user
 * asks to recreate a preset as a saved segment.
 *
 * The preset's `description` is the server's own prose definition of
 * the cohort (apps/api/internal/preset_segments — e.g. "subscribers
 * with at least one open or click in the last 30 days"), so it's the
 * most faithful input we can hand the deterministic text compiler.
 */
export function presetRecreateText(preset: PresetSegment): string {
  const desc = preset.description.trim();
  if (desc) return desc;
  return preset.label.trim();
}
