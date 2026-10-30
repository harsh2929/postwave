/**
 * api/campaignEventsStream.ts — the live-send tail.
 *
 * `GET /api/v1/campaigns/{id}/events` re-emits the full CampaignReport every
 * two seconds while a send is in flight (apps/api/internal/analytics/sse.go).
 * Mobile polled `/report` every ten seconds beside it and never opened it, on
 * two stated grounds that are both false today:
 *
 *   "React Native's fetch has no streaming body, so consuming SSE needs a
 *    polyfill and a native dependency this app does not carry."
 *      The global fetch, yes. `expo/fetch` is already a dependency, already
 *      streams, and `connectEventBus` has been reading a stream through it on
 *      every launch — see api/sseConnect for the full account.
 *
 *   "Its only accepted auth is a stream token, which is a whole credential
 *    lifecycle for a strip."
 *      That lifecycle already exists and already runs on every event-bus open
 *      (POST /api/v1/streams/token, api/streamCredentials). The route IS
 *      `exposure: "credentialed"` in the routeauth manifest and the token IS
 *      mandatory here — that part of the note was right, and it is why a
 *      failed mint must degrade rather than break.
 *
 * WHICH IS WHY THIS IS ADDITIVE. The `/report` poll stays exactly as it was.
 * This layers a faster source on top and writes into the SAME query cache
 * entry, so every failure mode — no token, a 401, a runtime with no streaming
 * body, a tunnel — degrades to precisely the ten-second poll that shipped
 * before, with no branch in the UI.
 */
import {
  campaignEventsPath,
  parseCampaignStreamFrame,
  type CampaignReportFrame,
} from "@/lib/campaignReportStream";

import { connectSse, type SseDisconnect, type SseStatus } from "./sseConnect";
import { buildStreamRequest } from "./streamCredentials";

export interface CampaignEventsHandlers {
  /** A complete, fresh report for this campaign. Safe to overwrite with. */
  onReport: (report: CampaignReportFrame) => void;
  /** The server gave up refreshing; it closes right after. */
  onStreamError?: (error: { code: string; message: string }) => void;
  onStatus?: (status: SseStatus) => void;
  /** Injectable jitter source; exposed for tests. */
  random?: () => number;
  /** Watchdog window; exposed for tests. */
  stallTimeoutMs?: number;
}

/**
 * Open the live-metrics stream for one campaign. Returns a disconnect fn.
 *
 * No gap recovery is requested: every frame is a WHOLE report, so a
 * reconnect's first `snapshot` already carries everything a replay would.
 */
export function connectCampaignEvents(
  campaignId: string,
  handlers: CampaignEventsHandlers,
): SseDisconnect {
  return connectSse({
    label: "campaign-events",
    buildRequest: () => buildStreamRequest(campaignEventsPath(campaignId)),
    onFrame: (frame) => {
      const parsed = parseCampaignStreamFrame(frame, campaignId);
      if (parsed.kind === "report") {
        handlers.onReport(parsed.report);
        return;
      }
      if (parsed.kind === "error") {
        handlers.onStreamError?.({
          code: parsed.code,
          message: parsed.message,
        });
      }
    },
    ...(handlers.onStatus ? { onStatus: handlers.onStatus } : {}),
    ...(handlers.random ? { random: handlers.random } : {}),
    ...(handlers.stallTimeoutMs !== undefined
      ? { stallTimeoutMs: handlers.stallTimeoutMs }
      : {}),
  });
}
