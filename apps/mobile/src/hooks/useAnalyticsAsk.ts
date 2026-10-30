/**
 * hooks/useAnalyticsAsk.ts — one question at a time against
 * `POST /api/v1/analytics/nlq`.
 *
 * A MUTATION, not a query, and deliberately: asking costs the workspace model
 * tokens against a daily cap (`audit.DailyCostTracker`, enforced in the
 * handler), so it must never be re-run by a cache revalidation, a window
 * change, a refocus or a pull-to-refresh. The user asks; the server answers
 * once; the answer stays on screen until they ask something else.
 *
 * It is also NOT wrapped in `useOnlineQueryGate` the way the reads on this
 * screen are — the gate governs automatic fetching, and this fetch only ever
 * happens because a finger pressed Ask. The screen still hides the control
 * when the session cannot reach the network, which is where that decision
 * belongs.
 */
import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";

import { askAnalytics } from "@/api/analyticsNlq";
import { codeFromError, messageFromError, statusFromError } from "@/api/request";
import {
  analyticsAskErrorMessage,
  type AnalyticsAnswer,
} from "@/lib/analyticsAnswer";

export interface AnalyticsAskState {
  answer: AnalyticsAnswer | null;
  asking: boolean;
  /** Reader-facing sentence, already mapped from the handler's error codes. */
  errorMessage: string | null;
  ask: (question: string) => void;
  reset: () => void;
}

export function useAnalyticsAsk(): AnalyticsAskState {
  const mutation = useMutation({
    mutationFn: (question: string) => askAnalytics(question),
  });

  const { mutate, reset: resetMutation } = mutation;
  const ask = useCallback(
    (question: string) => {
      const trimmed = question.trim();
      if (!trimmed) return;
      mutate(trimmed);
    },
    [mutate],
  );
  const reset = useCallback(() => resetMutation(), [resetMutation]);

  return {
    answer: mutation.data ?? null,
    asking: mutation.isPending,
    errorMessage: mutation.error
      ? analyticsAskErrorMessage(
          statusFromError(mutation.error),
          codeFromError(mutation.error),
          messageFromError(mutation.error),
        )
      : null,
    ask,
    reset,
  };
}
