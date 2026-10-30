/**
 * hooks/useInboxRealityPrediction.ts — run the pre-send placement prediction
 * for the draft currently on screen.
 *
 * Two properties the inline effect this replaces did not have:
 *
 *  - IT WAITS FOR ITS INPUTS. Reputation and sending history now resolve
 *    through the query cache (see `useInboxRealitySignals`), which means they
 *    arrive a beat after mount. Predicting immediately and again on arrival
 *    would show the user two different verdicts for one unchanged draft, so
 *    nothing is requested until the signals have settled — including settling
 *    on "this workspace has none".
 *  - IT NEVER SHOWS THE TRANSPORT STRING. Failure copy comes from the pure
 *    map in lib/inboxRealityCopy, so a send sheet cannot print an SDK message
 *    at someone who is one tap from mailing their list.
 */
import { useEffect, useState } from "react";

import {
  predictInboxPlacement,
  type InboxRealityPrediction,
} from "@/api/inboxReality";
import { useInboxRealitySignals } from "@/hooks/useInboxRealitySignals";
import { inboxRealityErrorCopy } from "@/lib/inboxRealityCopy";

export interface InboxRealityPredictionState {
  loading: boolean;
  prediction: InboxRealityPrediction | null;
  /** Stable, user-facing copy. Never the SDK's message. */
  error: string | null;
}

export function useInboxRealityPrediction(
  subject: string,
  bodyHtml: string,
): InboxRealityPredictionState {
  const { reputation, history, settled } = useInboxRealitySignals();
  const [state, setState] = useState<InboxRealityPredictionState>({
    loading: true,
    prediction: null,
    error: null,
  });

  useEffect(() => {
    if (!settled) return;
    let cancelled = false;
    setState({ loading: true, prediction: null, error: null });
    void (async () => {
      const res = await predictInboxPlacement({
        subject,
        bodyHtml,
        ...(reputation ? { reputation } : {}),
        ...(history ? { history } : {}),
        // Absence is an answer, not a gap to fill with a second uncached fetch.
        signalsResolved: true,
      });
      if (cancelled) return;
      setState(
        res.error
          ? {
              loading: false,
              prediction: null,
              error: inboxRealityErrorCopy(res.error.status),
            }
          : { loading: false, prediction: res.data, error: null },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [subject, bodyHtml, settled, reputation, history]);

  return state;
}
