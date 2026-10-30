// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed wrappers around the deliverability service's HTTP surface. All
// calls go through `api` from `./api`. In-memory mocks are used only when
// explicit mock mode is enabled.

import { api } from "./api";
import { isMockModeEnabled } from "./mock-mode";
import type {
  AuthCheck,
  CampaignReport,
  Diagnosis,
  DmarcStats,
  PersistedReport,
  PredictResponse,
  ReportDetail,
  Reputation,
  ReputationScore,
  ReputationSnapshot,
} from "./inbox-reality-types";

const USE_MOCKS = isMockModeEnabled();
const loadMocks = () => import("./inbox-reality-mocks");

async function withMockFallback<T>(
  realCall: () => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  if (USE_MOCKS) return await fallback();
  return realCall();
}

export function getCampaignReport(campaignId: string): Promise<CampaignReport> {
  return withMockFallback(
    () =>
      api.get<CampaignReport>(
        `/api/v1/inbox-reality/campaigns/${encodeURIComponent(campaignId)}`,
      ),
    async () => (await loadMocks()).mockCampaignReport(campaignId),
  );
}

export function getReputation(): Promise<Reputation> {
  return withMockFallback(
    async () =>
      normalizeReputation(
        await api.get<Partial<Reputation>>("/api/v1/reputation"),
      ),
    async () => (await loadMocks()).mockReputation(),
  );
}

export function normalizeReputation(
  payload: Partial<Reputation> | null | undefined,
): Reputation {
  return {
    domain: typeof payload?.domain === "string" ? payload.domain : "",
    ip: typeof payload?.ip === "string" ? payload.ip : "",
    google_score: normalizeScore(payload?.google_score),
    microsoft_score: normalizeScore(payload?.microsoft_score),
    sender_score:
      typeof payload?.sender_score === "number" &&
      Number.isFinite(payload.sender_score)
        ? payload.sender_score
        : null,
    blacklist_hits: Array.isArray(payload?.blacklist_hits)
      ? payload.blacklist_hits.filter(
          (hit): hit is string => typeof hit === "string",
        )
      : [],
    checked_at:
      typeof payload?.checked_at === "string" ? payload.checked_at : "",
    data_available: payload?.data_available === true,
    sources_succeeded: Array.isArray(payload?.sources_succeeded)
      ? payload.sources_succeeded.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    sources_failed: Array.isArray(payload?.sources_failed)
      ? payload.sources_failed.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  };
}

function normalizeScore(value: unknown): ReputationScore | null {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : null;
}

// Reputation trend (INBOX-031). Returns oldest-first snapshots so a chart can
// draw left-to-right. `days` bounds the window (default: the service's 90d).
// Defensive normalization: a partial/malformed payload never throws — bad rows
// are dropped, coercion mirrors normalizeReputation.
export async function getReputationHistory(
  opts: { days?: number; limit?: number } = {},
): Promise<ReputationSnapshot[]> {
  return withMockFallback(
    async () => {
      const params = new URLSearchParams();
      if (opts.days != null) params.set("days", String(opts.days));
      if (opts.limit != null) params.set("limit", String(opts.limit));
      const qs = params.toString();
      const payload = await api.get<{ snapshots?: unknown }>(
        `/api/v1/reputation/history${qs ? `?${qs}` : ""}`,
      );
      return normalizeSnapshots(payload?.snapshots);
    },
    async () => (await loadMocks()).mockReputationHistory(),
  );
}

export function normalizeSnapshots(value: unknown): ReputationSnapshot[] {
  if (!Array.isArray(value)) return [];
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return value
    .filter((row): row is Record<string, unknown> => row != null && typeof row === "object")
    .map((row) => ({
      // -1 is the service's "source unavailable" sentinel; keep it so the UI
      // can distinguish it from a genuine 0.
      sender_score: num(row.sender_score, -1),
      google_score: typeof row.google_score === "string" ? row.google_score : "",
      microsoft_score:
        typeof row.microsoft_score === "string" ? row.microsoft_score : "",
      blacklist_hit_count: num(row.blacklist_hit_count, 0),
      data_available: row.data_available === true,
      checked_at: typeof row.checked_at === "string" ? row.checked_at : "",
    }))
    // Drop rows without a PARSEABLE timestamp: a malformed-but-non-empty value
    // would otherwise NaN the chart's date sort and render "Invalid Date".
    .filter(
      (snap) =>
        snap.checked_at !== "" && !Number.isNaN(Date.parse(snap.checked_at)),
    );
}

export function getAuthChecks(): Promise<AuthCheck[]> {
  return withMockFallback(
    () => api.get<AuthCheck[]>("/api/v1/auth-checks"),
    async () => (await loadMocks()).mockAuthChecks(),
  );
}

// DMARC aggregate-report monitoring (INBOX-032). --------------------------

export function getDmarcStats(): Promise<DmarcStats> {
  return withMockFallback(
    async () =>
      normalizeDmarcStats(
        await api.get<Partial<DmarcStats>>("/api/v1/dmarc/stats"),
      ),
    async () => (await loadMocks()).mockDmarcStats(),
  );
}

// normalizeDmarcStats defaults every counter to 0 so a partial or malformed
// payload never renders NaN in the summary tiles (mirrors normalizeReputation).
export function normalizeDmarcStats(
  payload: Partial<DmarcStats> | null | undefined,
): DmarcStats {
  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    total_reports: num(payload?.total_reports),
    total_records: num(payload?.total_records),
    total_count: num(payload?.total_count),
    dkim_pass: num(payload?.dkim_pass),
    dkim_fail: num(payload?.dkim_fail),
    spf_pass: num(payload?.spf_pass),
    spf_fail: num(payload?.spf_fail),
    pass_count: num(payload?.pass_count),
    fail_count: num(payload?.fail_count),
  };
}

export function getDmarcReports(): Promise<PersistedReport[]> {
  return withMockFallback(
    async () => {
      const payload = await api.get<PersistedReport[]>("/api/v1/dmarc/reports");
      return Array.isArray(payload) ? payload : [];
    },
    async () => (await loadMocks()).mockDmarcReports(),
  );
}

export function getDmarcReport(id: string): Promise<ReportDetail> {
  return withMockFallback(
    () =>
      api.get<ReportDetail>(
        `/api/v1/dmarc/reports/${encodeURIComponent(id)}`,
      ),
    async () => (await loadMocks()).mockDmarcReport(id),
  );
}

export interface DiagnosisSignals {
  campaign_id: string;
  domain?: string;
  ip?: string;
  auth: AuthCheck;
  reputation: Reputation;
  seedlist: CampaignReport;
}

export function diagnose(
  campaignId: string,
  signals: DiagnosisSignals,
): Promise<Diagnosis> {
  return withMockFallback(
    () =>
      api.post<Diagnosis>(
        `/api/v1/diagnose/${encodeURIComponent(campaignId)}`,
        signals,
      ),
    async () => (await loadMocks()).mockDiagnosis(campaignId),
  );
}

export interface PredictBody {
  html: string;
  subject: string;
  links?: string[];
  reputation: Reputation;
  auth: AuthCheck;
}

export function predict(body: PredictBody): Promise<PredictResponse> {
  return withMockFallback(
    () => api.post<PredictResponse>("/api/v1/predict", body),
    async () => (await loadMocks()).mockPredict(),
  );
}
