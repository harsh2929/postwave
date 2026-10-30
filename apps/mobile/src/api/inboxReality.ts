/**
 * api/inboxReality.ts — the pre-send placement predictor.
 *
 * The signal loader below is a LAST RESORT, not the normal path. It fires two
 * uncached `rawRequest`s (reputation + dashboard stats) outside TanStack Query
 * and outside the online gate, and the only caller — the pre-send banner —
 * re-invokes prediction on every debounced content change, so it used to
 * re-fetch a dashboard payload the app already holds under
 * `["dashboard-stats", tenantId, range]` once per edit.
 *
 * Callers that can read those two things from the query cache should pass
 * `signalsResolved: true` (see `hooks/useInboxRealitySignals`), which skips the
 * loader entirely — including when the resolved answer is "this workspace has
 * no sending history", which is a real answer and not a reason to go asking
 * the network again.
 */
import { rawRequest, type AIApiResult } from "./request";
import {
  inboxRealityHistoryFromStats,
  type InboxRealityHistory,
  type InboxRealityHistorySource,
} from "@/lib/inboxRealityHistory";
import type { InboxRealityRiskBreakdown } from "@/lib/inboxRealityRisk";

export interface InboxRealityPlacement {
  primary: number;
  promotions: number;
  spam: number;
}

export interface InboxRealityPrediction {
  predicted: InboxRealityPlacement;
  content?: unknown;
  risk?: InboxRealityRiskBreakdown;
  at?: string;
}

export interface InboxRealityPredictInput {
  subject: string;
  bodyHtml: string;
  links?: string[];
  reputation?: {
    domain?: string;
    ip?: string;
    google_score?: "low" | "medium" | "high";
    microsoft_score?: "low" | "medium" | "high";
    sender_score?: number;
    blacklist_hits?: string[];
    checked_at?: string;
    data_available?: boolean;
    sources_succeeded?: string[];
    sources_failed?: string[];
  };
  history?: InboxRealityHistory;
  /**
   * The caller has already resolved reputation and history (from the query
   * cache) and does not want the uncached loader below run as a fallback.
   * "Resolved" includes resolving to ABSENT — a workspace with no sending
   * history has none, and re-asking the network cannot conjure one.
   */
  signalsResolved?: boolean;
}

/** The reputation block, as the predictor accepts it. */
export type InboxRealityReputation = InboxRealityPredictInput["reputation"];

export const INBOX_REALITY_REPUTATION_PATH = "/api/v1/reputation";

export async function loadAuthoritativeInboxRealitySignals(): Promise<{
  reputation?: InboxRealityReputation;
  history?: InboxRealityHistory;
}> {
  const [rep, stats] = await Promise.all([
    rawRequest<InboxRealityReputation>("GET", INBOX_REALITY_REPUTATION_PATH),
    rawRequest<InboxRealityHistorySource>("GET", "/api/v1/dashboard/stats"),
  ]);

  const history = inboxRealityHistoryFromStats(stats?.data);

  return {
    ...(!rep?.error && rep?.data ? { reputation: rep.data } : {}),
    ...(history ? { history } : {}),
  };
}

export async function predictInboxPlacement(
  input: InboxRealityPredictInput,
): Promise<AIApiResult<InboxRealityPrediction>> {
  const loaded =
    input.signalsResolved || (input.reputation && input.history)
      ? {}
      : await loadAuthoritativeInboxRealitySignals();
  const reputation = input.reputation ?? loaded.reputation;
  const history = input.history ?? loaded.history;
  const body = {
    html: input.bodyHtml,
    subject: input.subject,
    links: input.links ?? [],
    ...(reputation ? { reputation } : {}),
    ...(history ? { history } : {}),
  };
  const res = await rawRequest<InboxRealityPrediction | null>(
    "POST",
    "/api/v1/predict",
    body,
  );
  if (res.error) return { data: null, error: res.error };
  if (!res.data?.predicted) {
    return {
      data: null,
      error: { status: 0, message: "predictor returned no placement" },
    };
  }
  return { data: res.data, error: null };
}
