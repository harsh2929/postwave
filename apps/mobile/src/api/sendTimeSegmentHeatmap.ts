/**
 * api/sendTimeSegmentHeatmap.ts — GET /api/v1/send-time-opt/heatmap.
 *
 * ROUTE AND FLOOR, READ AT THE HANDLER. Mounted by
 * `send_time_opt.Deps.MountPatternRoutes` (dow_pattern.go:459-466), wired from
 * `internal/server/campaign_sending.go:106`, behind
 * `apikeys.RequireScope(ScopeReadReports, ScopeAdmin)`.
 *
 * The routeauth manifest row records `session_minimum_role: "viewer"` for this
 * path, and that row UNDERSTATES the live floor: `ScopeAdmin` appearing in the
 * RequireScope list makes `requireAdminRoleForScopes` true, which makes
 * `sessionRoleAllowsScopes` demand owner/admin on the session path
 * (apikeys/middleware.go:332-458). The same drift is already documented for the
 * screen's other read in app/(tabs)/send-time.tsx. It costs nothing here: the
 * only surface that calls this is that screen, which is already admin-gated by
 * `useCanReadSendTimeAnalysis`, so no session that reaches this function would
 * have been refused under either reading.
 *
 * WHY THIS DOES NOT GO THROUGH `checkedApiResult`. A 404 from this endpoint is
 * an ANSWER, not a fault — "this segment has fewer than 30 subscribers with
 * open history" — and its wording lives in the response BODY. `checkedApiResult`
 * throws an Error carrying status/code but deliberately not `payload`, so the
 * sentence would be lost at exactly the call that needs it. This function reads
 * `res.error.payload` itself and hands the refusal back as a value.
 *
 * Parsing lives in lib/sendTimeSegmentHeatmap so it is node-testable; this
 * module is only the URL and the envelope.
 */
import {
  parseSegmentSendTimePattern,
  segmentHeatmapRefusal,
  type SegmentHeatmapRefusal,
  type SegmentSendTimePattern,
} from "@/lib/sendTimeSegmentHeatmap";

import { rawRequest } from "./request";

export type SegmentHeatmapOutcome =
  | { kind: "pattern"; pattern: SegmentSendTimePattern }
  | { kind: "refused"; refusal: SegmentHeatmapRefusal };

/**
 * `segment_id` OR `campaign_id` — the handler 400s `missing_params` without
 * one. Mobile only ever asks by segment: the campaign form exists to resolve a
 * campaign back to its segment, and every caller here already has the segment.
 */
export function segmentHeatmapPath(segmentId: string): string {
  const params = new URLSearchParams({ segment_id: segmentId });
  return `/api/v1/send-time-opt/heatmap?${params.toString()}`;
}

export async function fetchSegmentSendTimeHeatmap(
  segmentId: string,
): Promise<SegmentHeatmapOutcome> {
  const res = await rawRequest<unknown>("GET", segmentHeatmapPath(segmentId));
  if (res.error) {
    const refusal = segmentHeatmapRefusal(res.error.status, res.error.payload);
    if (refusal) return { kind: "refused", refusal };
    const err = new Error(res.error.message) as Error & {
      status?: number;
      code?: string;
    };
    err.status = res.error.status;
    if (res.error.code) err.code = res.error.code;
    throw err;
  }
  const pattern = parseSegmentSendTimePattern(res.data);
  if (!pattern) {
    throw new Error(
      "The server answered, but its week couldn't be read. Pull to refresh.",
    );
  }
  return { kind: "pattern", pattern };
}
