/**
 * lib/content-quality-api.ts — subject-line patterns, template leaderboard
 * and the latest AI regression run.
 *
 * Three paths desktop reached and no web file did.
 *
 * ALL THREE ARE EMPTY RIGHT NOW, FOR THREE DIFFERENT REASONS, AND THE
 * DIFFERENCE IS THE WHOLE POINT:
 *
 *   - `subject-analyzer/buckets` returns no buckets AND `campaigns_total: 0`.
 *     The absence of patterns is not a finding about subject lines; it is the
 *     consequence of there being nothing to analyse in the 180-day window.
 *     "No patterns found" would read as a verdict on the copy.
 *
 *   - `analytics/template-leaderboard` returns no items with no count beside
 *     it, so it can only say that nothing ranked — not why.
 *
 *   - `ai-regression/runs/latest` returns `run: null`, which means no run has
 *     ever completed. That is categorically different from a run that
 *     completed and found nothing wrong, and rendering both as "no issues"
 *     turns "never checked" into "checked and clean".
 *
 * `window_days` scopes the first of these; a zero campaign count is only
 * meaningful together with the window it was counted over.
 */
import { api } from "@/lib/api";

export interface SubjectBucket {
  attribute?: string;
  bucket?: string;
  campaigns?: number;
  open_rate?: number;
  click_rate?: number;
}

export interface SubjectBuckets {
  buckets: SubjectBucket[];
  campaigns_total: number;
  window_days: number;
}

export interface TemplateLeaderboardItem {
  template_id?: string;
  template_name?: string;
  campaigns_used?: number;
  sent?: number;
  opens?: number;
  clicks?: number;
  open_rate?: number;
  click_rate?: number;
}

export interface LatestRegressionRun {
  id?: string;
  status?: string;
  gate_result?: string | null;
  fidelity_score_mean?: number | null;
  total_examples?: number;
  scored_examples?: number;
  error_examples?: number;
  completed_at?: string | null;
  created_at?: string;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export async function getSubjectBuckets(): Promise<SubjectBuckets> {
  const r = await api.get<Partial<SubjectBuckets>>(
    "/api/v1/subject-analyzer/buckets",
  );
  return {
    buckets: asArray(r?.buckets),
    campaigns_total: num(r?.campaigns_total),
    window_days: num(r?.window_days),
  };
}

export async function getTemplateLeaderboard(): Promise<
  TemplateLeaderboardItem[]
> {
  const r = await api.get<{ items?: unknown }>(
    "/api/v1/analytics/template-leaderboard",
  );
  return asArray<TemplateLeaderboardItem>(r?.items);
}

/** `null` means no regression run has ever completed — not "no issues". */
export async function getLatestRegressionRun(): Promise<LatestRegressionRun | null> {
  const r = await api.get<{ run?: LatestRegressionRun }>(
    "/api/v1/ai-regression/runs/latest",
  );
  return r?.run ?? null;
}

/**
 * Why the subject analyser has nothing to show.
 *
 * Distinguishes "nothing to analyse" from "analysed and found no pattern",
 * because only the second is a statement about the subject lines themselves.
 */
export type SubjectEmptiness = "no-campaigns" | "no-patterns" | "has-buckets";

export function subjectEmptiness(s: SubjectBuckets): SubjectEmptiness {
  if (s.buckets.length > 0) return "has-buckets";
  return s.campaigns_total === 0 ? "no-campaigns" : "no-patterns";
}
