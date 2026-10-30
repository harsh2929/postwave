/**
 * hooks/useSubscriberImports.ts — the import-job list, one job's live detail,
 * and the two writes this surface offers.
 *
 * THE GATE. Both reads use `useOnlineQueryGate` with
 * `enabled: gate.enabled && Boolean(gate.tenantId)`, the app-wide contract that
 * hooks/online-query-gating.test.ts fails the build over. `canRead` is ANDed on
 * top because this surface's reads are admin-only server-side (see
 * lib/subscriberImportVerbs::subscriberImportAccess) — a disabled TanStack query
 * reports `data: undefined, isLoading: false, isError: false`, so without both
 * terms a viewer would be shown "No import jobs", which is a factual claim about
 * the workspace that nobody made.
 *
 * ─── THE POLLING IS THE POINT, AND IT IS BOUNDED THREE WAYS ───
 *
 * An import is the one thing on this surface that changes while you watch it,
 * so a static screen is useless. But Expo Router keeps visited tabs MOUNTED, so
 * an unconditional `refetchInterval` polls forever on a screen nobody is looking
 * at — the battery bug `useDashboard`'s `focused` flag exists to prevent.
 *
 * `importPollIntervalMs` returns `false` unless ALL of these hold:
 *   1. the screen is focused (`useIsFocused` from expo-router),
 *   2. the session can reach the server,
 *   3. the job is `running` (3s) or `queued` (6s).
 * A `preview`, `ready`, `failed` or `cancelled` row cannot change on its own, so
 * the interval stops the moment the job lands — no "one last poll" tail.
 * `refetchIntervalInBackground: false` is belt-and-braces for a backgrounded app.
 *
 * The LIST polls on the same rule, derived from the fastest-moving job it can
 * see, so a list with nothing active is completely idle.
 *
 * ─── WHY NOT /{id}/progress ───
 *
 * That route is Server-Sent Events (`text/event-stream`, 1s frames, held open up
 * to 30 minutes — subscriber_import.go:1206). Fetching it against a running job
 * never returns a body. `GET /{id}` carries the identical counters plus the
 * preflight state the Confirm gate reads, so polling it is strictly more useful
 * here and costs one bounded request per tick.
 *
 * ─── NOTHING IS OPTIMISTIC AND NOTHING IS QUEUED ───
 *
 * Confirming starts a worker that writes subscribers; cancelling stops one
 * partway. Neither is registered in lib/offlineMutationContract, and
 * lib/offlineQueueSafety independently lists `/api/v1/subscriber-imports` in
 * ONLINE_ONLY_PATTERNS, so the offline queue cannot replay either an hour later
 * against a file whose fingerprint may since have been invalidated.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  cancelSubscriberImport,
  confirmSubscriberImport,
  fetchSubscriberImport,
  fetchSubscriberImports,
} from "@/api/subscriberImports";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  importPollIntervalMs,
  type SubscriberImportJobDetail,
  type SubscriberImportPage,
} from "@/lib/subscriberImportJobs";

const LIST_KEY = "subscriber-imports";
const DETAIL_KEY = "subscriber-import";

/**
 * A job list is cheap and changes whenever a teammate uploads on desktop, but
 * it is not itself live — the poll below is what makes it live while something
 * is running, and this only bounds the "came back to the tab" refetch.
 */
const LIST_STALE_MS = 15_000;

export function subscriberImportsQueryKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return [LIST_KEY, tenantId ?? null];
}

export function subscriberImportQueryKey(
  tenantId: string | null | undefined,
  id: string | null,
): readonly unknown[] {
  return [DETAIL_KEY, tenantId ?? null, id ?? null];
}

export interface SubscriberImportsOptions {
  /** False for a non-admin session or an API-key session (see the access policy). */
  canRead: boolean;
  /** `useIsFocused()`. Expo Router keeps unfocused tabs mounted. */
  focused: boolean;
}

export function useSubscriberImports(options: SubscriberImportsOptions) {
  const gate = useOnlineQueryGate();
  // Spelled out at the `enabled` key rather than passed as a variable, because
  // hooks/online-query-gating.test.ts reads the SOURCE and requires the literal
  // `enabled: … gate.enabled` there — a guard that only works if it can see it.
  const live = gate.enabled && Boolean(gate.tenantId) && options.canRead;
  return useQuery({
    queryKey: subscriberImportsQueryKey(gate.tenantId),
    enabled: gate.enabled && Boolean(gate.tenantId) && options.canRead,
    staleTime: LIST_STALE_MS,
    // Derived from the data already in hand: the list re-polls only while it
    // is showing something the worker is actually moving.
    refetchInterval: (query) => {
      const page = query.state.data as SubscriberImportPage | undefined;
      // Same shape guard as the screen: a `for…of` over a restored non-array
      // throws inside TanStack's own scheduler, where nothing catches it.
      if (!page || !Array.isArray(page.jobs)) return false;
      let interval: number | false = false;
      for (const job of page.jobs) {
        const next = importPollIntervalMs(job.status, {
          focused: options.focused,
          online: live,
        });
        if (next !== false && (interval === false || next < interval)) {
          interval = next;
        }
      }
      return interval;
    },
    refetchIntervalInBackground: false,
    queryFn: (): Promise<SubscriberImportPage> => fetchSubscriberImports(),
  });
}

export interface SubscriberImportDetailOptions {
  canRead: boolean;
  focused: boolean;
  /**
   * The status the list already knows. Seeds the interval on the very first
   * tick, before the detail read has resolved, so opening a running job starts
   * polling immediately instead of one interval late.
   */
  knownStatus?: string | null | undefined;
}

export function useSubscriberImport(
  id: string | null,
  options: SubscriberImportDetailOptions,
) {
  const gate = useOnlineQueryGate();
  const live =
    gate.enabled && Boolean(gate.tenantId) && options.canRead && Boolean(id);
  return useQuery({
    queryKey: subscriberImportQueryKey(gate.tenantId, id),
    enabled:
      gate.enabled && Boolean(gate.tenantId) && options.canRead && Boolean(id),
    // The sheet is opened to answer "where is it up to right now"; a cached
    // answer to that is the wrong answer.
    staleTime: 0,
    refetchInterval: (query) => {
      const job = query.state.data as SubscriberImportJobDetail | undefined;
      return importPollIntervalMs(job?.status ?? options.knownStatus ?? null, {
        focused: options.focused,
        online: live,
      });
    },
    refetchIntervalInBackground: false,
    queryFn: (): Promise<SubscriberImportJobDetail> =>
      fetchSubscriberImport(id!),
  });
}

/** Both writes change the list AND the open detail, so both are invalidated. */
function useImportWrite(mutationFn: (id: string) => Promise<void>) {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn,
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({
        queryKey: subscriberImportsQueryKey(gate.tenantId),
      });
      void qc.invalidateQueries({
        queryKey: subscriberImportQueryKey(gate.tenantId, id),
      });
    },
  });
}

export function useConfirmSubscriberImport() {
  return useImportWrite(confirmSubscriberImport);
}

export function useCancelSubscriberImport() {
  return useImportWrite(cancelSubscriberImport);
}
