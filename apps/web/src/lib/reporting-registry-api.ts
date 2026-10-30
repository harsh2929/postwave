/**
 * lib/reporting-registry-api.ts — the reporting metric registry and the
 * product areas that cannot report.
 *
 * Two paths desktop reached and no web file did.
 *
 * THE OBVIOUS JOIN IS THE WRONG ONE. `reporting/blocked-products` carries a
 * `product_area`, and every metric carries a `product_area` too, so joining
 * them looks natural. It overstates the damage: in this workspace an area
 * join marks 9 of 24 metrics unavailable, when only 6 are. `campaign.bounced`,
 * `campaign.delivery_rate` and `campaign.bounce_rate` all sit in the
 * "deliverability" area and are all `runtime_status: supported` — they report
 * fine. What the deliverability block actually names is a single metric,
 * `deliverability.provider_breakdown`.
 *
 * The authoritative signals are the blocked entry's own `metrics` list and
 * each metric's `runtime_status`. Both agree exactly (6 metrics), so this
 * module joins on the metric KEY and never on the area.
 *
 * `partial` is not `planned`. A partially-supported metric returns some data;
 * a planned one returns none. Collapsing them into "unavailable" throws away
 * the difference between a number to read carefully and no number at all.
 */
import { api } from "@/lib/api";

export type RuntimeStatus = "supported" | "partial" | "planned" | "unknown";

export interface RegisteredMetric {
  key: string;
  label: string;
  product_area: string;
  source: string;
  aggregation: string;
  value_type: string;
  runtime_status: RuntimeStatus;
  dimensions: string[];
}

export interface BlockedProduct {
  product_area: string;
  initiative: string;
  blocked_note: string;
  /** The metric keys this block actually applies to. Authoritative. */
  metrics: string[];
  statuses: string[];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function runtimeStatus(v: unknown): RuntimeStatus {
  return v === "supported" || v === "partial" || v === "planned"
    ? v
    : "unknown";
}

export async function getMetricRegistry(): Promise<{
  metrics: RegisteredMetric[];
  schema_version: string;
}> {
  const r = await api.get<{ items?: unknown; schema_version?: unknown }>(
    "/api/v1/reporting/metric-registry",
  );
  const metrics = asArray<Record<string, unknown>>(r?.items).map((m) => ({
    key: str(m?.key),
    label: str(m?.label),
    product_area: str(m?.product_area),
    source: str(m?.source),
    aggregation: str(m?.aggregation),
    value_type: str(m?.value_type),
    runtime_status: runtimeStatus(m?.runtime_status),
    dimensions: asArray<string>(m?.dimensions),
  }));
  return { metrics, schema_version: str(r?.schema_version) };
}

export async function getBlockedProducts(): Promise<{
  blocked: BlockedProduct[];
  schema_version: string;
}> {
  const r = await api.get<{ items?: unknown; schema_version?: unknown }>(
    "/api/v1/reporting/blocked-products",
  );
  const blocked = asArray<Record<string, unknown>>(r?.items).map((b) => ({
    product_area: str(b?.product_area),
    initiative: str(b?.initiative),
    blocked_note: str(b?.blocked_note),
    metrics: asArray<string>(b?.metrics),
    statuses: asArray<string>(b?.statuses),
  }));
  return { blocked, schema_version: str(r?.schema_version) };
}

/**
 * The blocked entry that applies to a metric, matched BY KEY.
 *
 * Deliberately not matched by product_area — see the module comment. An area
 * match would attach a "cannot report" note to metrics that report fine.
 */
export function blockFor(
  metricKey: string,
  blocked: BlockedProduct[],
): BlockedProduct | null {
  for (const b of blocked) {
    if (b.metrics.includes(metricKey)) return b;
  }
  return null;
}

/** Metrics that return no data at all. `partial` is excluded on purpose. */
export function unavailableMetrics(
  metrics: RegisteredMetric[],
  blocked: BlockedProduct[],
): RegisteredMetric[] {
  return metrics.filter(
    (m) => m.runtime_status === "planned" || blockFor(m.key, blocked) !== null,
  );
}
