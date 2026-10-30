/**
 * rfm-helpers — pure aggregation/formatting logic for the Segments
 * page "RFM & predictive" section (full-surface wiring #26).
 *
 * The wire gives us one RFMScoreRow per email (GET
 * /api/v1/predictive/rfm/segments → {items}); the UI wants:
 *
 *   - a Recency × Frequency heat-grid of subscriber counts (the
 *     Monetary dimension is collapsed — stated honestly in the UI),
 *   - per-segment-key counts ordered by the server's own catalog,
 *   - honest toast copy for the admin recompute action built from the
 *     server's {run, predictions, rfm_scores} response.
 *
 * Kept out of the component so all of it is unit-testable without a DOM.
 */

import type {
  PredictiveRecomputeResult,
  RFMScoreRow,
} from "../../lib/api-client";
import type { HeatmapRow } from "../charts/Heatmap";

/** RFM scores are 1..5 on the wire (apps/api/internal/predictive). */
const SCORE_MIN = 1;
const SCORE_MAX = 5;

export interface RFMGrid {
  /** Heatmap rows, recency 5 (most recent) first. */
  rows: HeatmapRow[];
  /** Column headers F1..F5. */
  columns: string[];
  /** Rows aggregated into the grid. */
  counted: number;
  /** Rows with out-of-range scores we refused to place (kept honest). */
  skipped: number;
}

/**
 * Bucket per-email RFM rows into a 5×5 Recency × Frequency count grid.
 * Cells with zero subscribers are `null` so the Heatmap renders "—"
 * instead of a misleading zero-intensity block.
 */
export function buildRFMGrid(items: RFMScoreRow[] | undefined | null): RFMGrid {
  // counts[r-1][f-1]
  const counts: number[][] = Array.from({ length: SCORE_MAX }, () =>
    Array.from({ length: SCORE_MAX }, () => 0),
  );
  let counted = 0;
  let skipped = 0;
  // `items` is absent/non-array when the rfm/segments response is empty
  // or minimal — treat it as an empty grid rather than throwing.
  for (const it of Array.isArray(items) ? items : []) {
    const r = it.recency_score;
    const f = it.frequency_score;
    if (
      !Number.isInteger(r) ||
      !Number.isInteger(f) ||
      r < SCORE_MIN ||
      r > SCORE_MAX ||
      f < SCORE_MIN ||
      f > SCORE_MAX
    ) {
      skipped += 1;
      continue;
    }
    counts[r - 1]![f - 1]! += 1;
    counted += 1;
  }
  const rows: HeatmapRow[] = [];
  // Recency 5 (most recent) on top.
  for (let r = SCORE_MAX; r >= SCORE_MIN; r--) {
    const values = counts[r - 1]!.map((c) => (c > 0 ? c : null));
    const size = counts[r - 1]!.reduce((a, b) => a + b, 0);
    rows.push({
      label: r === SCORE_MAX ? "R5 · recent" : r === SCORE_MIN ? "R1 · cold" : `R${r}`,
      size,
      values,
    });
  }
  return {
    rows,
    columns: Array.from(
      { length: SCORE_MAX },
      (_, i) => `F${i + 1}`,
    ),
    counted,
    skipped,
  };
}

export interface RFMSegmentCatalogEntry {
  key: string;
  label: string;
}

/**
 * The catalog response types `rfm_segments` as `unknown[]` — narrow it
 * to the `{key, label}` rows the Go handler actually emits, dropping
 * anything malformed.
 */
export function parseRFMSegmentCatalog(
  value: unknown,
): RFMSegmentCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  const out: RFMSegmentCatalogEntry[] = [];
  for (const v of value) {
    if (v && typeof v === "object") {
      const rec = v as Record<string, unknown>;
      if (typeof rec.key === "string" && rec.key) {
        out.push({
          key: rec.key,
          label: typeof rec.label === "string" && rec.label ? rec.label : rec.key,
        });
      }
    }
  }
  return out;
}

export interface RFMSegmentCount {
  key: string;
  label: string;
  count: number;
}

/**
 * Count scored rows per segment_key, ordered by the server catalog
 * (so "Champions" leads and "Insufficient data" trails, matching the
 * backend's own ordering). Keys the catalog doesn't know are appended
 * verbatim rather than dropped — honesty over tidiness.
 */
export function rfmSegmentCounts(
  items: RFMScoreRow[] | undefined | null,
  catalog: RFMSegmentCatalogEntry[],
): RFMSegmentCount[] {
  const byKey = new Map<string, number>();
  for (const it of Array.isArray(items) ? items : []) {
    const key = it.segment_key || "unknown";
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  const out: RFMSegmentCount[] = [];
  for (const entry of catalog) {
    out.push({
      key: entry.key,
      label: entry.label,
      count: byKey.get(entry.key) ?? 0,
    });
    byKey.delete(entry.key);
  }
  for (const [key, count] of byKey) {
    out.push({ key, label: key, count });
  }
  return out;
}

export interface ToastCopy {
  ok: boolean;
  message: string;
  detail?: string;
}

/**
 * Honest copy for the recompute toast. Reports exactly what the server
 * returned — scored vs insufficient profiles, and the persisted
 * prediction / RFM-score counts — and surfaces a failed run as an
 * error even though the HTTP call itself succeeded.
 */
export function recomputeToastCopy(
  result: PredictiveRecomputeResult,
): ToastCopy {
  const run = result.run;
  if (run.status === "failed" || run.error) {
    return {
      ok: false,
      message: "Predictive recompute failed",
      detail: run.error || `Run ${run.id} finished with status "${run.status}".`,
    };
  }
  const scored = run.scored_profiles;
  const insufficient = run.insufficient_profiles;
  if (scored === 0 && result.predictions === 0 && result.rfm_scores === 0) {
    return {
      ok: true,
      message: "Recompute ran — no profiles scored",
      detail:
        insufficient > 0
          ? `${insufficient.toLocaleString()} profile${insufficient === 1 ? "" : "s"} had too little order history to score.`
          : "No subscriber order history found to score.",
    };
  }
  return {
    ok: true,
    message: `Scored ${scored.toLocaleString()} profile${scored === 1 ? "" : "s"}`,
    detail:
      `${result.predictions.toLocaleString()} predictions and ${result.rfm_scores.toLocaleString()} RFM scores stored` +
      (insufficient > 0
        ? `; ${insufficient.toLocaleString()} skipped (insufficient data).`
        : "."),
  };
}

/**
 * Honest caption for the predictive-profiles table (#26). The wire
 * (GET /predictive/profiles?segment=&limit=) has a limit but no
 * offset/total, so when the page comes back full the only true
 * statement is "at least this many" — say so instead of implying the
 * list is complete.
 */
export function profilesCaption(
  shown: number,
  limit: number,
  segmentLabel: string | null,
): string {
  const scope = segmentLabel ? `in "${segmentLabel}"` : "across all segments";
  if (shown === 0) return `No scored profiles ${scope}.`;
  const n = shown.toLocaleString();
  if (shown >= limit) {
    return `Showing the first ${n} profiles ${scope} — the server caps the page at ${limit.toLocaleString()}; raise the limit to see more.`;
  }
  return `${n} profile${shown === 1 ? "" : "s"} ${scope}.`;
}

/** Format integer cents as a currency-ish string (same as Discounts). */
export function fmtCents(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

/** Format a 0..1 fraction as a percentage, e.g. 0.37 → "37%". */
export function fmtPct01(v: number, digits = 0): string {
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}
