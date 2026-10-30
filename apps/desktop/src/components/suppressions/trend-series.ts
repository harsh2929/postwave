/**
 * trend-series — pure series-building logic behind
 * SuppressionsTrendChart. Lives in a .ts module (not the .tsx
 * component) so the node-environment vitest suite can import it
 * without a JSX transform.
 */

// Type-only import: erased at compile time, so importing this module
// never pulls the .tsx chart component into a node test run.
import type { MultiLineSeries } from "../charts/MultiLineChart";
import type { SuppressionTrendPoint } from "../../lib/api-client";

/** Per-reason display labels — distinct per key so legend toggles
 *  (keyed by label) never collide. Covers both the canonical X1 enum
 *  and the legacy free-form values old rows still carry. */
export const TREND_REASON_LABELS: Readonly<Record<string, string>> = {
  hard_bounce: "Hard bounce",
  spam_complaint: "Spam complaint",
  complaint: "Complaint",
  manual_unsubscribe: "Manual unsub",
  global_unsubscribe: "Global unsub",
  unsubscribe: "Unsub",
  manual: "Manual",
  list_manual: "List manual",
  spam_trap: "Spam trap",
  blocklist_auto: "Auto blocklist",
  soft_bounce_threshold: "Soft-bounce threshold",
  invalid_email: "Invalid email",
  role_address: "Role address",
  dsar_deletion: "DSAR deletion",
};

/** Series order is stable so palette colors don't reshuffle on refresh. */
const REASON_ORDER = [
  "hard_bounce",
  "spam_complaint",
  "complaint",
  "manual_unsubscribe",
  "global_unsubscribe",
  "unsubscribe",
  "manual",
  "list_manual",
  "spam_trap",
  "blocklist_auto",
  "soft_bounce_threshold",
  "invalid_email",
  "role_address",
  "dsar_deletion",
];

/**
 * Build one MultiLineChart series per reason that actually appears in
 * the window. Known reasons keep a stable order; unknown reasons the
 * server may add later are appended alphabetically (future-proof).
 * When the server sent day totals but no per-reason breakdown, a
 * single "All" series is emitted from `count` instead of nothing.
 */
export function buildTrendSeries(
  points: SuppressionTrendPoint[],
): MultiLineSeries[] {
  const totals = new Map<string, number>();
  for (const p of points) {
    for (const [key, v] of Object.entries(p.by_reason ?? {})) {
      totals.set(key, (totals.get(key) ?? 0) + (v || 0));
    }
  }
  const known = REASON_ORDER.filter((k) => (totals.get(k) ?? 0) > 0);
  const extras = [...totals.keys()]
    .filter((k) => !REASON_ORDER.includes(k) && (totals.get(k) ?? 0) > 0)
    .sort();
  const out: MultiLineSeries[] = [...known, ...extras].map((key) => ({
    label: TREND_REASON_LABELS[key] ?? key,
    values: points.map((p) => ({
      date: p.date,
      count: p.by_reason?.[key] ?? 0,
    })),
  }));
  if (out.length === 0 && points.some((p) => p.count > 0)) {
    out.push({
      label: "All",
      values: points.map((p) => ({ date: p.date, count: p.count })),
    });
  }
  return out;
}

/** Sum of the window — drives the empty state + one-point summary. */
export function trendTotal(points: SuppressionTrendPoint[]): number {
  return points.reduce((acc, p) => acc + (p.count || 0), 0);
}
