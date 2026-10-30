/**
 * useAudienceSearchTelemetry — one `subscriber.searched` per settled query.
 *
 * Naively emitting on every `debouncedQ` change would fire before the
 * result count exists, so every event would report "no count yet" and the
 * question the event is for ("how often does a search return nothing?")
 * would be unanswerable. This waits for the query to SETTLE, then emits
 * once per distinct search term.
 *
 * Only the term's LENGTH and the result count leave the device — see
 * src/lib/audienceTelemetryProps.ts.
 */
import { useEffect, useRef } from "react";

import { trackAudienceSearch } from "@/lib/audienceTelemetry";

export function useAudienceSearchTelemetry(
  query: string,
  resultCount: number | undefined,
  isSettled: boolean,
): void {
  const lastSent = useRef<string | null>(null);
  useEffect(() => {
    const term = query.trim();
    if (!term) {
      // Clearing the box arms the next search rather than emitting.
      lastSent.current = null;
      return;
    }
    if (!isSettled || lastSent.current === term) return;
    lastSent.current = term;
    trackAudienceSearch(term, resultCount);
  }, [query, resultCount, isSettled]);
}
