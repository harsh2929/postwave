// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useCallback, useMemo, useState } from "react";

import type { TrackSubscriberScope } from "@/lib/track-api";

/**
 * The product-event investigation scope shared by the catalogue, the feed's
 * event column, the scope tokens and the subscriber picker. One owner holds
 * it and passes `eventName` / `subscriber.id` to the feed query, the live
 * tail subscription and the CSV export, so all three always agree.
 */
export interface TrackInvestigationScope {
  eventName: string;
  subscriber: TrackSubscriberScope | null;
  /** Toggle: picking the active event name again clears it (desktop parity). */
  pickEventName: (eventName: string) => void;
  clearEventName: () => void;
  setSubscriber: (subscriber: TrackSubscriberScope | null) => void;
  clearSubscriber: () => void;
  clearAll: () => void;
}

export function useTrackInvestigationScope(): TrackInvestigationScope {
  const [eventName, setEventName] = useState("");
  const [subscriber, setSubscriberState] =
    useState<TrackSubscriberScope | null>(null);

  const pickEventName = useCallback((next: string) => {
    const trimmed = next.trim();
    setEventName((current) => (current === trimmed ? "" : trimmed));
  }, []);
  const clearEventName = useCallback(() => setEventName(""), []);
  const setSubscriber = useCallback(
    (next: TrackSubscriberScope | null) => setSubscriberState(next),
    [],
  );
  const clearSubscriber = useCallback(() => setSubscriberState(null), []);
  const clearAll = useCallback(() => {
    setEventName("");
    setSubscriberState(null);
  }, []);

  return useMemo(
    () => ({
      eventName,
      subscriber,
      pickEventName,
      clearEventName,
      setSubscriber,
      clearSubscriber,
      clearAll,
    }),
    [
      clearAll,
      clearEventName,
      clearSubscriber,
      eventName,
      pickEventName,
      setSubscriber,
      subscriber,
    ],
  );
}
