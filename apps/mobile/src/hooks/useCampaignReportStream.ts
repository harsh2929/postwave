/**
 * hooks/useCampaignReportStream.ts — the live-send tail, layered on the poll.
 *
 * `useCampaignReport` polls `/campaigns/{id}/report` every ten seconds while a
 * send is live. That poll STAYS. This hook opens the SSE stream beside it and
 * writes each fresh report into the SAME query cache entry, which takes the
 * worst-case staleness of a number an operator is watching from 10s to ~2s
 * (apps/api/internal/analytics/sse.go polls at 2s server-side).
 *
 * WHY WRITING TO THE CACHE, RATHER THAN RETURNING STATE. Every consumer of the
 * live-send numbers — the detail screen's tiles, the dashboard's active-send
 * strip — already reads them through `useCampaignReport`. Handing the stream's
 * value back as a second source would mean every one of those surfaces
 * choosing between two values that disagree. There is one value; the stream
 * just refreshes it sooner.
 *
 * WHY IT IS SAFE TO OVERWRITE. Each frame is a WHOLE `CampaignReport`, not a
 * patch (see lib/campaignReportStream), and it is checked against this
 * campaign's id before it is applied.
 *
 * DEGRADATION IS THE DESIGN. No stream token, a 401, a runtime with no
 * streaming body, a dead tunnel: `connectSse` retries with backoff and the
 * poll keeps the screen correct throughout. Nothing in the UI branches on
 * whether the stream is up, so there is no state in which this hook can make
 * the screen worse than it was before it existed.
 *
 * IT ONLY RUNS WHILE A SEND IS LIVE, AND ONLY WHILE SOMEONE IS LOOKING. An
 * open socket is a warm radio; a finished campaign's report does not change,
 * and neither does a backgrounded phone's screen. The poll beside it is
 * already foreground-only (`useCampaigns` documents that `focusManager` is
 * bridged to AppState in lib/connectivity and `refetchIntervalInBackground` is
 * left false); layering an UNGATED socket on top of a gated poll would undo
 * NATIVE#10 for this surface — Android holding the socket and its reconnect
 * timers alive, iOS suspending it half-open so the stall watchdog reconnects
 * and re-mints a stream token against a socket the OS already tore down.
 * `createFocusGatedStream` is the same gate lib/eventCacheSync puts around the
 * event bus.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { connectCampaignEvents } from "@/api/campaignEventsStream";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { CampaignReportFrame } from "@/lib/campaignReportStream";
import {
  createFocusGatedStream,
  type FocusGate,
} from "@/lib/eventStreamLifecycle";
import { queryFocusGate } from "@/lib/queryFocusGate";

export interface CampaignReportStreamState {
  /** True while the stream is open and carrying frames. */
  streaming: boolean;
}

export function useCampaignReportStream(
  id: string | undefined,
  options: { live: boolean; focus?: FocusGate },
): CampaignReportStreamState {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  const [streaming, setStreaming] = useState(false);
  const live = options.live;
  const tenantId = gate.tenantId;
  const enabled = gate.enabled;
  const focus = options.focus ?? queryFocusGate;

  useEffect(() => {
    if (!live || !id || !enabled || !tenantId) {
      setStreaming(false);
      return;
    }
    let cancelled = false;
    const stop = createFocusGatedStream({
      focus,
      // The socket is gone, so "streaming" would be a lie the moment the app
      // backgrounds. The poll is what the screen falls back to.
      onPause: () => {
        if (!cancelled) setStreaming(false);
      },
      connect: () =>
        connectCampaignEvents(id, {
          onReport: (report: CampaignReportFrame) => {
            if (cancelled) return;
            // The exact key `useCampaignReport` reads. Keep these in step.
            queryClient.setQueryData(["campaign-report", tenantId, id], report);
          },
          onStatus: (status) => {
            if (cancelled) return;
            setStreaming(status === "open");
          },
        }),
    });
    return () => {
      cancelled = true;
      stop();
      setStreaming(false);
    };
  }, [live, id, enabled, tenantId, queryClient, focus]);

  return { streaming };
}
