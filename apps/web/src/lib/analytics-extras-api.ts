/**
 * lib/analytics-extras-api.ts — cohorts, fatigue and engagement classification.
 *
 * Three `/api/v1/analytics/*` paths were reached by desktop and by no web file.
 *
 * `engagement-classification/summary` carries the same three-way split as the
 * human-reach endpoint — human / machine / UNKNOWN — plus its own `unit` and
 * `methodology`. The `unit` matters: this counts INTERACTION EVENTS, not
 * people, so the same number means something different from the recipient
 * counts elsewhere in the product. Both are carried through.
 */
import { api } from "@/lib/api";

export interface Cohort {
  cohort_label: string;
  cohort_size: number;
  /** Mature weekly engagement percentages; trailing immature weeks are omitted. */
  weeks: number[];
}

export interface FatigueDecile {
  sends_bucket: string;
  subscribers: number;
  open_rate: number;
  unsub_rate: number;
}

export interface EngagementClassification {
  /** "interaction_events" — events, not people. */
  unit: string;
  /** The server's written explanation. Render verbatim. */
  methodology: string;
  human: number;
  machine: number;
  /** Never allocated to either side. */
  unknown: number;
  total: number;
  classifier_version: string;
  window_start?: string;
  window_end?: string;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function num(v: unknown): number {
  return Number.isFinite(v) ? Number(v) : 0;
}

export async function listCohorts(): Promise<Cohort[]> {
  const res = await api.get<unknown>("/api/v1/analytics/cohorts");
  // This endpoint returns a BARE ARRAY, not an envelope.
  return asArray<Cohort>(res).map((c) => ({
    cohort_label: String(c?.cohort_label ?? ""),
    cohort_size: num(c?.cohort_size),
    weeks: asArray<unknown>(c?.weeks).map(num),
  }));
}

export async function getFatigueDeciles(): Promise<FatigueDecile[]> {
  const res = await api.get<{ deciles?: unknown }>("/api/v1/analytics/fatigue");
  return asArray<Partial<FatigueDecile>>(res?.deciles).map((row) => ({
    sends_bucket:
      typeof row?.sends_bucket === "string" ? row.sends_bucket : "—",
    subscribers: num(row?.subscribers),
    open_rate: num(row?.open_rate),
    unsub_rate: num(row?.unsub_rate),
  }));
}

export async function getEngagementClassification(): Promise<EngagementClassification> {
  const res = await api.get<EngagementClassification>(
    "/api/v1/analytics/engagement-classification/summary",
  );
  return {
    unit: typeof res?.unit === "string" ? res.unit : "",
    methodology: typeof res?.methodology === "string" ? res.methodology : "",
    human: num(res?.human),
    machine: num(res?.machine),
    unknown: num(res?.unknown),
    total: num(res?.total),
    classifier_version:
      typeof res?.classifier_version === "string" ? res.classifier_version : "",
    window_start: res?.window_start,
    window_end: res?.window_end,
  };
}
