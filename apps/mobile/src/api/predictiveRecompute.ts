/**
 * api/predictiveRecompute.ts — the analytics screen's one predictive WRITE.
 *
 *   POST /api/v1/predictive/recompute   admin / `admin` scope
 *   (apps/api/internal/predictive/predictive.go:128, manifest.json
 *   session_minimum_role "admin", review_status "reviewed")
 *
 * ONLINE-ONLY, DELIBERATELY, and never queued offline: the run is synchronous,
 * it rewrites the coverage rollup and the RFM bands the card above is showing,
 * and its RESULT is the reason to press it. A replay hours later would rewrite
 * those numbers while nobody is looking at them.
 *
 * `checkedApiResult` so a 403 REJECTS: an admin-only write that resolved
 * quietly would render as a successful run that scored nothing.
 */
import { checkedApiResult, rawRequest } from "@/api/request";
import { parseRunResult, type PredictiveRunResult } from "@/lib/predictiveRecompute";

export async function postPredictiveRecompute(): Promise<PredictiveRunResult> {
  const res = await checkedApiResult(
    rawRequest<unknown>("POST", "/api/v1/predictive/recompute"),
  );
  return parseRunResult(res.data);
}
