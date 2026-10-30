/**
 * api/analyticsNlq.ts — `POST /api/v1/analytics/nlq`.
 *
 * Verified against apps/api/internal/nql/analytics_nlq.go:
 *   - mounted at `MountAnalyticsRoutes` (line 366) behind
 *     `apikeys.RequireScope(apikeys.ScopeReadReports)` — a SCOPE gate, not a
 *     role gate, and the same scope the rest of this screen's reads already
 *     hold, so no new permission surface;
 *   - request body is `{ question: string }`, ≤16 KiB, ≤2000 runes;
 *   - response is `{ question, answer_kind, template, params, columns, rows,
 *     summary_text, trace }`.
 *
 * Parsing lives in lib/analyticsAnswer so the display rules are testable in a
 * node environment. This module is transport only.
 */
import { getClient } from "@/api/client";
import {
  parseAnalyticsAnswer,
  type AnalyticsAnswer,
} from "@/lib/analyticsAnswer";

export const ANALYTICS_NLQ_PATH = "/api/v1/analytics/nlq";

/** The handler's own cap (`questionMaxLen`). Enforced here so the field can
 *  stop the user before a round trip that will 400. */
export const ANALYTICS_QUESTION_MAX_LEN = 2000;

export async function askAnalytics(question: string): Promise<AnalyticsAnswer> {
  const { client } = getClient();
  const res = await client.request<unknown>("POST", ANALYTICS_NLQ_PATH, {
    body: { question: question.trim() },
  });
  return parseAnalyticsAnswer(res);
}
