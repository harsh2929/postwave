// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";

import { auditInvestigationStreamUrl } from "@/lib/audit-investigations-api";
import { whenStreamsMayOpen } from "@/lib/realtime/stream-gate";

export type InvestigationStreamMode =
  | "connecting"
  | "live"
  | "polling"
  | "closed";

/** One frame off GET /api/v1/audit/investigations/{id}/stream. */
export interface InvestigationStreamEvent {
  type: string;
  status?: string;
  message?: string;
  ts?: string;
}

/** How often the detail is re-read once the live stream has given up. */
export const INVESTIGATION_POLL_INTERVAL_MS = 15_000;

const MAX_LOG = 20;

/** The named events the server emits (`event: status|complete|finding`). */
const EVENT_NAMES = ["status", "complete", "finding"] as const;

/**
 * Live status for one investigation, with a polling fallback.
 *
 * The stream is how the badge and the decision controls flip without a
 * reload when someone else approves or rejects the plan. `onStatus` fires
 * for every frame that carries a status, so the caller can refetch the
 * persisted row rather than trust the frame.
 *
 * On error the socket is closed and `mode` becomes "polling" for the rest of
 * this mount — the caller turns that into a `refetchInterval`. EventSource
 * would retry a transient drop by itself, but a 404/503 refusal never comes
 * back and the two are indistinguishable from the client; a visible
 * "polling every 15s" beats a silent reconnect loop that may never open.
 */
export function useInvestigationStream(
  id: string | null,
  onStatus: (status: string) => void,
): { mode: InvestigationStreamMode; events: InvestigationStreamEvent[] } {
  const [mode, setMode] = useState<InvestigationStreamMode>(
    id ? "connecting" : "closed",
  );
  const [events, setEvents] = useState<InvestigationStreamEvent[]>([]);
  // Readable from the long-lived listener without re-subscribing per render.
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    if (!id) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      setMode("polling");
      return;
    }
    let cancelled = false;
    let es: EventSource | null = null;
    setMode("connecting");
    setEvents([]);

    const handle = (raw: Event): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse((raw as MessageEvent<string>).data);
      } catch {
        // One malformed frame costs one frame, not the subscription.
        return;
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const frame = parsed as Partial<InvestigationStreamEvent>;
      const entry: InvestigationStreamEvent = {
        ...frame,
        type: typeof frame.type === "string" ? frame.type : raw.type,
      };
      setEvents((prev) => [...prev.slice(-(MAX_LOG - 1)), entry]);
      if (typeof frame.status === "string" && frame.status) {
        onStatusRef.current(frame.status);
      }
    };

    // Opening waits for the page to finish loading and go idle once; see
    // lib/realtime/stream-gate.ts. An EventSource is a high-priority request,
    // and this page's own detail read has to arrive first.
    const cancelPendingOpen = whenStreamsMayOpen(() => {
      void (async () => {
        const url = await auditInvestigationStreamUrl(id);
        if (cancelled) return;
        try {
          es = new EventSource(url, { withCredentials: true });
        } catch {
          setMode("polling");
          return;
        }
        es.onopen = () => setMode("live");
        for (const name of EVENT_NAMES) es.addEventListener(name, handle);
        es.onerror = () => {
          es?.close();
          es = null;
          setMode("polling");
        };
      })();
    });

    return () => {
      cancelled = true;
      cancelPendingOpen();
      es?.close();
      es = null;
    };
  }, [id]);

  return { mode, events };
}
