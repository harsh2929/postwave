/**
 * lib/onsite-growth-api.ts — onsite popups, and the next-best-product model.
 *
 * Three paths were reached by desktop and by no web file: onsite-growth/catalog,
 * nbp/settings and nbp/syntax-example.
 *
 * THIS IS THE FIRST MIXED CATALOGUE IN THE PARITY SWEEP. Every other provider
 * list was uniformly `partial`; this one is 15 supported, 11 partial and 2
 * unavailable across six capability groups. That changes what the UI owes the
 * reader: a blanket "none of this is ready" banner would be FALSE here, and the
 * useful thing is per-capability status so somebody can pick the triggers and
 * targeting rules that actually work.
 *
 * `nbp/settings` carries Go zero times on created_at/updated_at — the third
 * endpoint pair in this sweep to do so.
 *
 * COVERAGE: this module wires 2 of them:
 *   /api/v1/nbp/settings
 *   /api/v1/onsite-growth/catalog
 * The remaining 1 are not called from web. The sentence above
 * describes the gap that was found, not the part that was closed.
 */
import { api } from "@/lib/api";

export interface CapabilityOption {
  key: string;
  label: string;
  /** "supported" | "partial" | "unavailable" */
  runtime_status: string;
}

export interface OnsiteGrowthCatalog {
  schema_version?: string;
  trigger_types: CapabilityOption[];
  targeting_groups: CapabilityOption[];
  frequency_modes: CapabilityOption[];
  experiment_modes: CapabilityOption[];
  winner_metrics: CapabilityOption[];
  spin_reward_types: CapabilityOption[];
}

export interface NbpSettings {
  enabled: boolean;
  recency_exclude_days: number;
  top_n_per_user: number;
  similarity_floor: number;
  refresher_strategy: string;
  refresh_interval_hours: number;
  model_version: number;
  created_at?: string;
  updated_at?: string;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function num(v: unknown): number {
  return Number.isFinite(v) ? Number(v) : 0;
}
function opts(v: unknown): CapabilityOption[] {
  return asArray<CapabilityOption>(v).map((o) => ({
    key: String(o?.key ?? ""),
    label: String(o?.label ?? o?.key ?? ""),
    runtime_status: String(o?.runtime_status ?? "unknown"),
  }));
}

export async function getOnsiteGrowthCatalog(): Promise<OnsiteGrowthCatalog> {
  const res = await api.get<OnsiteGrowthCatalog>("/api/v1/onsite-growth/catalog");
  return {
    schema_version: res?.schema_version,
    trigger_types: opts(res?.trigger_types),
    targeting_groups: opts(res?.targeting_groups),
    frequency_modes: opts(res?.frequency_modes),
    experiment_modes: opts(res?.experiment_modes),
    winner_metrics: opts(res?.winner_metrics),
    spin_reward_types: opts(res?.spin_reward_types),
  };
}

export async function getNbpSettings(): Promise<NbpSettings> {
  const res = await api.get<NbpSettings>("/api/v1/nbp/settings");
  return {
    enabled: res?.enabled === true,
    recency_exclude_days: num(res?.recency_exclude_days),
    top_n_per_user: num(res?.top_n_per_user),
    similarity_floor: num(res?.similarity_floor),
    refresher_strategy:
      typeof res?.refresher_strategy === "string" ? res.refresher_strategy : "",
    refresh_interval_hours: num(res?.refresh_interval_hours),
    model_version: num(res?.model_version),
    created_at: res?.created_at,
    updated_at: res?.updated_at,
  };
}

/** Options that are not fully supported, for a per-group caveat. */
export function notSupported(
  options: readonly CapabilityOption[],
): CapabilityOption[] {
  return options.filter((o) => o.runtime_status !== "supported");
}
