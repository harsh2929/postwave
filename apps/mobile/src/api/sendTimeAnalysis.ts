/**
 * api/sendTimeAnalysis.ts — transport for the tenant-wide send-time heatmap.
 *
 *   GET /api/v1/send-time-opt/best-time-analysis?days=N
 *
 * THE GUARD, READ OFF THE MOUNT AND NOT OFF THE MANIFEST. The route is
 * registered inside
 *
 *     read := r.With(apikeys.RequireScope(ScopeReadReports, ScopeAdmin))
 *     read.Get("/api/v1/send-time-opt/best-time-analysis", …)
 *
 * (send_time_opt.go:479-489). On the API-KEY path that really is "reports OR
 * admin". On the SESSION path it is not: `RequireScope` calls
 * `requireAdminRoleForScopes`, which returns true as soon as ANY required scope
 * is outside the `readOnlyScopes` allowlist — and `ScopeAdmin` is outside it
 * (apikeys/middleware.go:332-349). `sessionRoleAllowsScopes` then walks EVERY
 * required scope and rejects `admin` for anything below owner/admin
 * (middleware.go:439-458). So a viewer, a member and an editor all get
 * 403 `insufficient_role` here, and the surface is admin-tier.
 *
 * That is not what `internal/routeauth/manifest.json` says — its row for this
 * path carries `session_minimum_role: "viewer"`. Both middlewares run (the
 * manifest one is wired at main.go:2247) and the EFFECTIVE floor is the
 * stricter of the two, so the divergence is fail-closed rather than a hole; it
 * is recorded here because the manifest is the document somebody will read
 * next, and it is wrong. `useSendTimeAnalysis` gates on `admin`.
 *
 * WHY `days` IS CLAMPED CLIENT-SIDE TOO. The handler accepts 1..730 and
 * silently falls back to 90 for anything else (analysis.go:44-48). A silent
 * fallback means a mistyped window renders a different window than the one the
 * control claims, so the value is pinned to the three the screen offers before
 * it is ever sent.
 *
 * Parsing lives in lib/sendTimeAnalysis so the rules are testable in the node
 * vitest environment; this module is only the URL and the envelope.
 */
import {
  DEFAULT_SEND_TIME_LOOKBACK,
  parseSendTimeAnalysis,
  SEND_TIME_LOOKBACKS,
  type SendTimeAnalysis,
  type SendTimeLookback,
} from "@/lib/sendTimeAnalysis";

import { checkedApiResult, rawRequest } from "./request";

export const BEST_TIME_ANALYSIS_PATH =
  "/api/v1/send-time-opt/best-time-analysis";

export class SendTimeAnalysisShapeError extends Error {
  constructor() {
    super("The send-time analysis response was not in the expected shape.");
    this.name = "SendTimeAnalysisShapeError";
  }
}

function clampLookback(days: number): SendTimeLookback {
  return SEND_TIME_LOOKBACKS.includes(days as SendTimeLookback)
    ? (days as SendTimeLookback)
    : DEFAULT_SEND_TIME_LOOKBACK;
}

/**
 * The 168-cell grid for the last `days` days.
 *
 * Throws rather than returning an empty analysis when the body is unusable: an
 * unparseable response and an empty workspace are different states, and the
 * screen renders them differently (house rule 6).
 */
export async function fetchSendTimeAnalysis(
  days: number = DEFAULT_SEND_TIME_LOOKBACK,
): Promise<SendTimeAnalysis> {
  const window = clampLookback(days);
  const res = await checkedApiResult(
    rawRequest<unknown>(
      "GET",
      `${BEST_TIME_ANALYSIS_PATH}?days=${encodeURIComponent(String(window))}`,
    ),
  );
  const parsed = parseSendTimeAnalysis(res.data);
  if (!parsed) throw new SendTimeAnalysisShapeError();
  // The server echoes its own lookback; trust the request when it does not.
  return { ...parsed, lookbackDays: parsed.lookbackDays || window };
}
