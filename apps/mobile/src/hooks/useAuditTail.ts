/**
 * hooks/useAuditTail.ts — the mobile answer to desktop's live audit tail.
 *
 * Desktop streams `GET /api/v1/audit/stream` (SSE) and PREPENDS rows as they
 * arrive. Mobile does not — not because it cannot (it can: the stream is
 * opened below, through `expo/fetch`, the same way the event bus has been
 * reading one on every launch) but because prepending is the wrong behaviour
 * on a phone. WHICH mechanism carries the freshness matters, and the two
 * obvious ones are wrong:
 *
 *  1. PUTTING `refetchInterval` ON THE LIST IS EXPENSIVE AND GETS WORSE THE
 *     LONGER YOU INVESTIGATE. `useAuditLog` is an infinite query; TanStack v5
 *     refetches EVERY loaded page on an interval tick. An operator who has
 *     paged back through six pages of an incident would be issuing six
 *     requests every poll, against the most expensive read in the product.
 *  2. AUTO-PREPENDING MOVES THE LIST UNDER THE READER'S THUMB. On a phone
 *     that is not a feature; it is how you lose the row you were reading.
 *
 * So this hook issues ONE bounded request per tick — the newest page of the
 * SAME window and actor filter the screen is showing — and reports only HOW
 * MANY rows are newer than what is on screen. Cost is flat regardless of
 * paging depth, and nothing moves without a deliberate tap.
 *
 * ── THE STREAM SITS ON TOP OF THAT, AS A TRIGGER ───────────────────────────
 * While the tail is on, `GET /api/v1/audit/stream` is opened alongside the
 * poll. A frame does NOT become a row and does NOT become a count: the stream
 * is tenant-wide and knows nothing about the actor/window filters this hook is
 * applying, so the only honest thing it can say is "something happened". It
 * re-runs the probe, which is what knows.
 *
 * Two properties make that safe rather than expensive. The re-check is
 * rate-limited to one per AUDIT_TAIL_STREAM_MIN_REFRESH_MS, so a burst of rows
 * on a busy tenant collapses into a single request instead of one per frame.
 * And the 20s poll is left completely untouched, so every way the stream can
 * fail — no credential, a 401, a dead tunnel, a runtime with no streaming body
 * — lands back on exactly the behaviour that shipped before it.
 *
 * ── AND ONLY WHILE SOMEONE IS LOOKING ──────────────────────────────────────
 * The poll is already foreground-only (`refetchIntervalInBackground: false`,
 * over the AppState→focusManager bridge in lib/connectivity). The socket has
 * to be too, or the cheaper half of this hook is the only half that respects
 * NATIVE#10: a backgrounded phone would hold the stream open, and its stall
 * watchdog would keep reconnecting and re-minting stream tokens against a
 * socket the OS has already torn down. `createFocusGatedStream` is the same
 * gate lib/eventCacheSync puts around the event bus.
 *
 * The counting and the copy live in lib/auditTail so they are testable in the
 * node environment; this file is only the query and the socket.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { connectAuditStream } from "@/api/auditStream";
import { getClient } from "@/api/client";
import {
  auditLogPath,
  normalizeAuditPage,
  type AuditFilters,
} from "@/hooks/useAudit";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  AUDIT_TAIL_INTERVAL_MS,
  AUDIT_TAIL_PROBE_LIMIT,
  auditTailStreamRefreshDelay,
  countNewerRows,
  type AuditTailState,
} from "@/lib/auditTail";
import {
  createFocusGatedStream,
  type FocusGate,
} from "@/lib/eventStreamLifecycle";
import { queryFocusGate } from "@/lib/queryFocusGate";

export interface AuditTailOptions {
  /** The operator turned the tail on. */
  enabled: boolean;
  /** Highest audit id currently rendered, or null when nothing is loaded. */
  newestId: number | null;
  /** The SAME server-side narrowing the list is using. */
  filters: AuditFilters;
  /** Overridable for tests; production callers omit it. */
  focus?: FocusGate;
}

export function useAuditTail({
  enabled,
  newestId,
  filters,
  focus = queryFocusGate,
}: AuditTailOptions): AuditTailState {
  const gate = useOnlineQueryGate();
  const actorType = filters.actorType ?? null;
  const since = filters.since ?? null;
  const query = useQuery({
    // `newestId` participates in the key on purpose: after the reader loads
    // the new rows the previous count is not merely stale, it is WRONG, and
    // showing it for even one tick tells them to load rows they already have.
    queryKey: [
      "audit-tail",
      gate.tenantId,
      actorType,
      since,
      // The advanced facets change what the probe counts, so they are part
      // of its identity too.
      filters.action ?? null,
      filters.resourceType ?? null,
      filters.resourceId ?? null,
      filters.actorLabel ?? null,
      newestId,
    ],
    // Nothing to compare against before the first page lands, and a tail
    // running offline would just error on a timer.
    enabled:
      enabled && gate.enabled && Boolean(gate.tenantId) && newestId !== null,
    refetchInterval: AUDIT_TAIL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    // The answer IS the poll; serving a cached one would freeze the counter.
    staleTime: 0,
    // A failed probe must not turn into a red banner over a working log —
    // the tail is an enrichment, and the list below it is unaffected.
    retry: false,
    queryFn: async (): Promise<number> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        auditLogPath(AUDIT_TAIL_PROBE_LIMIT, null, filters),
      );
      return countNewerRows(normalizeAuditPage(res).rows, newestId);
    },
  });

  // The stream trigger. `refetch` is read through a ref so the effect below
  // depends only on whether the tail should be RUNNING — otherwise every
  // render would tear the socket down and mint a new stream token.
  const refetch = query.refetch;
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const streamEnabled =
    enabled && gate.enabled && Boolean(gate.tenantId) && newestId !== null;

  useEffect(() => {
    if (!streamEnabled) return;
    let lastRefreshAt: number | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const run = (): void => {
      pending = null;
      if (cancelled) return;
      lastRefreshAt = Date.now();
      void refetchRef.current();
    };

    const stop = createFocusGatedStream({
      focus,
      // A re-check queued behind the cooldown must not fire while the app is
      // backgrounded: it would be a request nobody is waiting for, against the
      // most expensive read in the product, on a screen that is not on.
      onPause: () => {
        if (pending !== null) {
          clearTimeout(pending);
          pending = null;
        }
      },
      connect: () =>
        connectAuditStream({
          onActivity: () => {
            if (cancelled || pending !== null) return;
            const delay = auditTailStreamRefreshDelay(lastRefreshAt, Date.now());
            if (delay === 0) {
              run();
              return;
            }
            pending = setTimeout(run, delay);
          },
        }),
    });

    return () => {
      cancelled = true;
      if (pending !== null) clearTimeout(pending);
      stop();
    };
  }, [streamEnabled, focus]);

  const count = query.data ?? 0;
  return {
    count,
    atLeast: count >= AUDIT_TAIL_PROBE_LIMIT,
    live: enabled && gate.enabled && newestId !== null,
  };
}
