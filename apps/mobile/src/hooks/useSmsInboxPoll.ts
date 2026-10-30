/**
 * useSmsInboxPoll — the SMS inbox's freshness machinery, extracted once.
 *
 * `useSmsConversations` and `useSmsThread` were carrying two copies of the same
 * seventy-line polling effect, differing only in which page they fetch. Both
 * copies had to agree on four rules; keeping them in one place is the only way
 * that agreement survives the next edit. `useSmsInbox.ts` keeps the queries,
 * the query keys and the identity binding.
 *
 * THE FOUR RULES, IN ONE PLACE:
 *
 * 1. ONE REQUEST IN FLIGHT. A tick that finds a live controller returns. A
 *    slow network can never fan out into overlapping polls.
 *
 * 2. A LOADED HISTORY WINDOW PAUSES THE POLL. Every continuation page is bound
 *    to the response cutoff that produced it, so once page two exists the head
 *    can be neither replaced nor merged without mixing cutoffs. The poll stops
 *    and says `restart_required`; the operator restarts it by pulling to
 *    refresh, which resets to the latest cutoff.
 *
 * 3. THE HEAD REPLACES, NEVER INVALIDATES. Invalidating an active infinite
 *    query refetches EVERY loaded page — the page fan-out this app works hard
 *    to avoid. Rule 2 guarantees there is at most one cached page here, so
 *    writing `{pages: [head]}` is exact.
 *
 * 4. AN ABORT IS NOT A FAILURE. Unmount and identity change abort in flight;
 *    only a genuine error moves the state to `failed`, which the screen renders
 *    as "showing the last verified page set" rather than as emptiness.
 */
import {
  type InfiniteData,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

export const SMS_INBOX_POLL_MS = 10_000;

export type SmsPollState =
  | "idle"
  | "refreshing"
  | "failed"
  | "restart_required";

export interface SmsPollStateHandle {
  pollState: SmsPollState;
  /** Read inside the interval, where the rendered value would be stale. */
  pollStateRef: RefObject<SmsPollState>;
  updatePollState: (next: SmsPollState) => void;
}

export function useSmsPollState(): SmsPollStateHandle {
  const [pollState, setPollState] = useState<SmsPollState>("idle");
  const pollStateRef = useRef<SmsPollState>("idle");
  const updatePollState = useCallback((next: SmsPollState) => {
    pollStateRef.current = next;
    setPollState(next);
  }, []);
  return { pollState, pollStateRef, updatePollState };
}

/**
 * Pull-to-refresh: throw the infinite query back to page one at the latest
 * response cutoff. This is the ONLY way out of `restart_required`.
 */
export function useSmsFirstPageRefresh(
  client: QueryClient,
  key: readonly unknown[],
  updatePollState: (next: SmsPollState) => void,
): () => Promise<void> {
  return useCallback(async () => {
    updatePollState("refreshing");
    try {
      await client.resetQueries({ queryKey: key, exact: true });
      updatePollState("idle");
    } catch (error) {
      updatePollState("failed");
      throw error;
    }
  }, [client, key, updatePollState]);
}

/**
 * The interval itself. `fetchHead` must be a `useCallback` whose dependencies
 * are exactly the identity and query inputs it closes over — the effect
 * restarts when it changes, which is what binds a poll to one identity.
 */
export function useSmsHeadRefresh<TPage>(input: {
  enabled: boolean;
  queryKey: readonly unknown[];
  fetchHead: (signal: AbortSignal) => Promise<TPage>;
  pollStateRef: RefObject<SmsPollState>;
  updatePollState: (next: SmsPollState) => void;
}): void {
  const client = useQueryClient();
  const { enabled, fetchHead, pollStateRef, queryKey, updatePollState } = input;
  useEffect(() => {
    if (!enabled) {
      updatePollState("idle");
      return;
    }
    updatePollState("idle");
    let active = true;
    let controller: AbortController | null = null;
    const timer = setInterval(() => {
      if (controller || pollStateRef.current === "restart_required") return;
      const current =
        client.getQueryData<InfiniteData<TPage, string | undefined>>(queryKey);
      if (current && current.pages.length > 1) {
        updatePollState("restart_required");
        return;
      }
      controller = new AbortController();
      const requestController = controller;
      updatePollState("refreshing");
      void (async () => {
        try {
          const head = await fetchHead(requestController.signal);
          if (!active || requestController.signal.aborted) return;
          client.setQueryData<InfiniteData<TPage, string | undefined>>(
            queryKey,
            { pages: [head], pageParams: [undefined] },
          );
          updatePollState("idle");
        } catch (error) {
          if (
            active &&
            !requestController.signal.aborted &&
            !(error instanceof Error && error.name === "AbortError")
          ) {
            updatePollState("failed");
          }
        } finally {
          if (controller === requestController) controller = null;
        }
      })();
    }, SMS_INBOX_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
      controller?.abort();
    };
  }, [client, enabled, fetchHead, pollStateRef, queryKey, updatePollState]);
}
