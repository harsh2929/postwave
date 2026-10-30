/**
 * lib/lifecycle-api.ts — lifecycle stages, growth sources and goals.
 *
 * Six paths were reached by desktop and by no web file: lifecycle/stages,
 * lifecycle/distribution, growth-source/summary, goals, goals/progress and
 * isp-breakdown.
 *
 * `lifecycle/stages` is the DECLARED vocabulary; `lifecycle/distribution` is
 * where people actually are. A stage present in the vocabulary with nobody in
 * it is a real and useful fact — it means the stage is configured and unused —
 * so the two are fetched separately rather than deriving the stage list from
 * whatever the distribution happens to contain.
 *
 * COVERAGE: this module wires five lifecycle/read-model paths:
 *   /api/v1/growth-source/summary
 *   /api/v1/isp-breakdown
 *   /api/v1/isp-breakdown/by-campaign/{id}
 *   /api/v1/lifecycle/distribution
 *   /api/v1/lifecycle/stages
 * Goals list/progress and administration live in the strict, concurrency-aware
 * `goals-admin-api` module rather than this older read-model adapter.
 */
import { api } from "@/lib/api";

export interface StageCount {
  stage: string;
  count: number;
}

export interface GrowthSource {
  consent_source: string;
  source_platform?: string;
  count: number;
}

export interface GrowthSummary {
  sources: GrowthSource[];
  total_new_subs: number;
  window_days: number;
  since?: string;
}

export interface IspBucket {
  isp: string;
  subscribers: number;
  sent: number;
  opens: number;
  clicks: number;
  bounces: number;
  complaints: number;
  open_rate: number;
  click_rate: number;
  bounce_rate: number;
  complaint_rate: number;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function num(v: unknown): number {
  return Number.isFinite(v) ? Number(v) : 0;
}

/** The declared vocabulary — not the same as where people are. */
export async function listLifecycleStages(): Promise<string[]> {
  const res = await api.get<{ stages?: unknown }>("/api/v1/lifecycle/stages");
  return asArray<string>(res?.stages);
}

export async function getLifecycleDistribution(): Promise<StageCount[]> {
  const res = await api.get<{ items?: unknown }>(
    "/api/v1/lifecycle/distribution",
  );
  return asArray<StageCount>(res?.items).map((r) => ({
    stage: String(r?.stage ?? ""),
    count: num(r?.count),
  }));
}

export async function getGrowthSummary(): Promise<GrowthSummary> {
  const res = await api.get<GrowthSummary>("/api/v1/growth-source/summary");
  return {
    sources: asArray<Partial<GrowthSource>>(res?.sources).map((source) => ({
      consent_source: String(source?.consent_source ?? "unknown"),
      source_platform:
        typeof source?.source_platform === "string"
          ? source.source_platform
          : undefined,
      count: num(source?.count),
    })),
    total_new_subs: num(res?.total_new_subs),
    window_days: num(res?.window_days),
    since: res?.since,
  };
}

export async function getIspBreakdown(): Promise<IspBucket[]> {
  const res = await api.get<{ buckets?: unknown }>("/api/v1/isp-breakdown");
  return normalizeIspBuckets(res?.buckets);
}

/**
 * Campaign ids are UUIDs on the server, which casts the path segment with
 * `::uuid` — anything else is an internal error there, not a clean 400, so a
 * hand-typed id is checked before it is sent.
 */
export const CAMPAIGN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * GET /api/v1/isp-breakdown/by-campaign/{id} — the same per-provider rollup,
 * scoped to one campaign's delivery events instead of a time window. The
 * server echoes `campaign_id`; a response for any other campaign is refused
 * rather than rendered under the one that was picked.
 */
export async function getIspBreakdownByCampaign(
  campaignId: string,
): Promise<IspBucket[]> {
  const res = await api.get<{ campaign_id?: unknown; buckets?: unknown }>(
    `/api/v1/isp-breakdown/by-campaign/${encodeURIComponent(campaignId)}`,
  );
  if (res?.campaign_id !== campaignId) {
    throw new Error(
      "The provider breakdown answered for a different campaign, so it is not shown.",
    );
  }
  return normalizeIspBuckets(res?.buckets);
}

function normalizeIspBuckets(value: unknown): IspBucket[] {
  return asArray<Partial<IspBucket>>(value).map((bucket) => ({
    isp: String(bucket?.isp ?? "unknown"),
    subscribers: num(bucket?.subscribers),
    sent: num(bucket?.sent),
    opens: num(bucket?.opens),
    clicks: num(bucket?.clicks),
    bounces: num(bucket?.bounces),
    complaints: num(bucket?.complaints),
    open_rate: num(bucket?.open_rate),
    click_rate: num(bucket?.click_rate),
    bounce_rate: num(bucket?.bounce_rate),
    complaint_rate: num(bucket?.complaint_rate),
  }));
}
