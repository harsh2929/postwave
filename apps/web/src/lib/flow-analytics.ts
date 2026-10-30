// SPDX-License-Identifier: AGPL-3.0-only
//
// Tolerant reader for the `Flow.analytics` jsonb blob (FLOW-007). The backend
// stores analytics as an untyped map (map[string]any) and different producers
// may spell keys differently, so this normalizes the common shapes into a
// typed metrics view and computes a conversion rate when the inputs exist.
// Pure + DOM-free for node unit tests.

export interface FlowMetrics {
  entered?: number;
  active?: number;
  completed?: number;
  converted?: number;
  /** 0..1, computed as converted/entered when both are present. */
  conversionRate?: number;
  revenueCents?: number;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** First defined numeric value among the given keys. */
function pick(
  src: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const k of keys) {
    const v = num(src[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}

export function readFlowMetrics(
  analytics: Record<string, unknown> | undefined | null,
): FlowMetrics {
  if (!analytics || typeof analytics !== "object") return {};
  const src = analytics as Record<string, unknown>;

  const entered = pick(src, ["entered", "total_entered", "enrolled"]);
  const active = pick(src, ["active", "in_progress", "current"]);
  const completed = pick(src, ["completed", "finished"]);
  const converted = pick(src, ["converted", "conversions", "goal_reached"]);
  const revenueCents = pick(src, [
    "revenue_cents",
    "revenue",
    "attributed_revenue_cents",
  ]);

  let conversionRate = num(src.conversion_rate);
  if (
    conversionRate === undefined &&
    entered !== undefined &&
    entered > 0 &&
    converted !== undefined
  ) {
    conversionRate = converted / entered;
  }

  return {
    ...(entered !== undefined ? { entered } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(completed !== undefined ? { completed } : {}),
    ...(converted !== undefined ? { converted } : {}),
    ...(conversionRate !== undefined ? { conversionRate } : {}),
    ...(revenueCents !== undefined ? { revenueCents } : {}),
  };
}

/** Whether any metric is populated (so the UI can hide an empty panel). */
export function hasFlowMetrics(metrics: FlowMetrics): boolean {
  return Object.keys(metrics).length > 0;
}

export function formatMetricNumber(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);
}

export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(rate < 0.1 ? 1 : 0)}%`;
}

export function formatRevenueCents(cents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/** Per-node drop-off, keyed by node id, when the backend supplies it. Reads a
 *  `nodes`/`node_stats` sub-map of `{ entered, exited/dropped }`. */
export interface NodeDropOff {
  entered?: number;
  dropped?: number;
  /** 0..1 */
  rate?: number;
}

export function readNodeDropOff(
  analytics: Record<string, unknown> | undefined | null,
): Map<string, NodeDropOff> {
  const out = new Map<string, NodeDropOff>();
  if (!analytics || typeof analytics !== "object") return out;
  const raw =
    (analytics as Record<string, unknown>).node_stats ??
    (analytics as Record<string, unknown>).nodes;
  if (!raw || typeof raw !== "object") return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const rec = value as Record<string, unknown>;
    const entered = num(rec.entered);
    const dropped = pick(rec, ["dropped", "exited", "drop_off"]);
    let rate = num(rec.drop_off_rate);
    if (rate === undefined && entered && entered > 0 && dropped !== undefined) {
      rate = dropped / entered;
    }
    out.set(id, {
      ...(entered !== undefined ? { entered } : {}),
      ...(dropped !== undefined ? { dropped } : {}),
      ...(rate !== undefined ? { rate } : {}),
    });
  }
  return out;
}
