/**
 * lib/campaignReportStream.ts — decoding the live-send stream's frames.
 *
 * `GET /api/v1/campaigns/{id}/events` re-emits the WHOLE CampaignReport rather
 * than per-event deltas (apps/api/internal/analytics/sse.go), which is what
 * makes it safe to layer under an existing `/report` poll: a frame is a
 * complete replacement for the polled value, not a patch that could be applied
 * out of order or to the wrong base.
 *
 * Four event names arrive on that stream and only two of them are a report:
 *
 *   snapshot  the state at connect. Always first.
 *   delta     a later state, emitted only when a count actually changed.
 *   anomaly   a detected-anomaly set, a DIFFERENT payload shape entirely.
 *             Writing this into the report cache would replace live send
 *             numbers with an object that has none of them.
 *   error     the server could not refresh; it closes after sending this.
 *
 * Pure and import-free so the discrimination above is node-tested; the hook
 * does the I/O.
 */

/**
 * The fields the live-send surfaces actually read. Deliberately structural and
 * partial rather than an import of `CampaignReport`: this module must stay
 * import-free, and the frame is handed to the query cache as-is anyway.
 */
export interface CampaignReportFrame {
  campaign_id: string;
  sent?: number;
  delivered?: number;
  [key: string]: unknown;
}

export type CampaignStreamFrame =
  | { kind: "report"; event: "snapshot" | "delta"; report: CampaignReportFrame }
  | { kind: "error"; code: string; message: string }
  | { kind: "ignored"; reason: "anomaly" | "unknown-event" | "malformed" | "wrong-campaign" };

/** The event names that carry a full CampaignReport. */
const REPORT_EVENTS = new Set(["snapshot", "delta"]);

/**
 * Decode one frame for a KNOWN campaign id.
 *
 * `expectedCampaignId` is checked against the payload rather than trusted from
 * the URL. The stream is per-campaign, so a mismatch should be impossible —
 * but the consequence of being wrong is one campaign's send numbers painted
 * over another's, on the screen an operator is watching a live send from, and
 * the check costs one string comparison.
 */
export function parseCampaignStreamFrame(
  frame: { event: string; data: string },
  expectedCampaignId: string,
): CampaignStreamFrame {
  const event = frame.event.trim();
  if (event === "anomaly") return { kind: "ignored", reason: "anomaly" };

  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch {
    return { kind: "ignored", reason: "malformed" };
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { kind: "ignored", reason: "malformed" };
  }
  const body = payload as Record<string, unknown>;

  if (event === "error") {
    return {
      kind: "error",
      code: typeof body.code === "string" ? body.code : "analytics_stream_unavailable",
      message:
        typeof body.message === "string" && body.message
          ? body.message
          : "Live analytics could not be refreshed.",
    };
  }

  if (!REPORT_EVENTS.has(event)) {
    return { kind: "ignored", reason: "unknown-event" };
  }
  if (typeof body.campaign_id !== "string" || !body.campaign_id) {
    return { kind: "ignored", reason: "malformed" };
  }
  if (body.campaign_id !== expectedCampaignId) {
    return { kind: "ignored", reason: "wrong-campaign" };
  }
  return {
    kind: "report",
    event: event as "snapshot" | "delta",
    report: body as unknown as CampaignReportFrame,
  };
}

/** The SSE path for one campaign's live metrics. */
export function campaignEventsPath(campaignId: string): string {
  return `/api/v1/campaigns/${encodeURIComponent(campaignId)}/events`;
}
