/**
 * hooks/useAuditInvestigations.ts — the AI investigation queue.
 *
 * Wire contract, read off apps/api/internal/server/audit_operations.go:79-83
 * (the mount site, which is where the GATES actually are) and
 * apps/api/internal/handlers/audit_investigations.go:
 *
 *   GET  /api/v1/audit/investigations?status=&limit=   RequireScope(audit:read)
 *        → { investigations: [...] }  — full rows, findings and actions included
 *   GET  /api/v1/audit/investigations/{id}             RequireScope(audit:read)
 *   POST /api/v1/audit/investigations/{id}/approve     RequireScope(ADMIN)
 *   POST /api/v1/audit/investigations/{id}/reject      RequireScope(ADMIN)
 *   GET  /api/v1/audit/investigations/{id}/stream      SSE — a trigger (below)
 *
 * TWO DIFFERENT GATES ON ONE SCREEN, which is the whole reason this hook
 * takes two booleans instead of one:
 *
 *   - READING is the `audit:read` SCOPE, the same one the log itself uses.
 *   - DECIDING is `apikeys.ScopeAdmin`, which is not in `readOnlyScopes`, so
 *     `RequireScope`'s session branch additionally demands owner|admin
 *     (apikeys/middleware.go:213-226). An auditor holding audit:read but not
 *     admin can read every investigation and decide none of them — so the
 *     screen must render the queue and withhold only the buttons.
 *
 * `limit` is clamped server-side to 1..200 (default 50) and there is NO
 * cursor, so this list is a bounded window by construction and the screen
 * says so rather than implying completeness.
 */
import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { connectInvestigationStream } from "@/api/auditStream";
import { getClient } from "@/api/client";
import { auditTailStreamRefreshDelay } from "@/lib/auditTail";
import {
  createFocusGatedStream,
  type FocusGate,
} from "@/lib/eventStreamLifecycle";
import { queryFocusGate } from "@/lib/queryFocusGate";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  normalizeInvestigation,
  normalizeInvestigationList,
  type AuditInvestigation,
  type InvestigationStatus,
} from "@/lib/auditInvestigations";

/** The server's own default, stated rather than inherited silently. */
export const INVESTIGATIONS_PAGE_LIMIT = 50;

function listKey(tenantId: string | null | undefined, status: string | null) {
  return ["audit-investigations", tenantId, status] as const;
}

/**
 * Shared by the declarative detail query and the imperative re-read below.
 *
 * They MUST be the same key: a re-read on a different key would leave the two
 * copies free to disagree, which is the exact failure this whole path exists
 * to prevent.
 */
function detailKey(tenantId: string | null | undefined, id: string | null) {
  return ["audit-investigation", tenantId, id] as const;
}

async function fetchInvestigation(
  id: string,
): Promise<AuditInvestigation | null> {
  const { client } = getClient();
  const res = await client.request<unknown>(
    "GET",
    `/api/v1/audit/investigations/${encodeURIComponent(id)}`,
  );
  return normalizeInvestigation(res);
}

export function useAuditInvestigations(
  enabled: boolean,
  status?: InvestigationStatus | undefined,
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: listKey(gate.tenantId, status ?? null),
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<AuditInvestigation[]> => {
      const { client } = getClient();
      const qs = new URLSearchParams({
        limit: String(INVESTIGATIONS_PAGE_LIMIT),
      });
      if (status) qs.set("status", status);
      const res = await client.request<unknown>(
        "GET",
        `/api/v1/audit/investigations?${qs.toString()}`,
      );
      return normalizeInvestigationList(res);
    },
  });
}

/**
 * One investigation, re-read on open with `staleTime: 0`.
 *
 * The list is a snapshot from whenever the screen last fetched, and a
 * teammate can have decided the row in between. Approve/reject are
 * irreversible from this client, so the detail always re-asks.
 */
export function useAuditInvestigation(id: string | null | undefined) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: detailKey(gate.tenantId, id ?? null),
    enabled: gate.enabled && Boolean(gate.tenantId && id),
    staleTime: 0,
    queryFn: () => fetchInvestigation(id!),
  });
}

/**
 * The same re-read, callable from a decision handler.
 *
 * `useAuditInvestigation` above was written for exactly this hazard and could
 * never serve it: a decision starts from a row in a LIST, inside a callback,
 * and a declarative query keyed on an id cannot be awaited there. So the
 * safety re-read had no caller and approve/reject fired straight off a list
 * snapshot that a teammate may have decided minutes ago.
 *
 * Goes through `fetchQuery` rather than a bare request so the answer lands in
 * the same cache the detail query reads, and `staleTime: 0` guarantees it is a
 * real round trip rather than a cache hit — which would re-read nothing.
 */
export function useInvestigationReread() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useCallback(
    (id: string): Promise<AuditInvestigation | null> =>
      queryClient.fetchQuery({
        queryKey: detailKey(tenantId, id),
        staleTime: 0,
        queryFn: () => fetchInvestigation(id),
      }),
    [queryClient, tenantId],
  );
}

export interface InvestigationDecisionInput {
  id: string;
  decision: "approve" | "reject";
  /** Required for a rejection — the server 400s on an empty reason. */
  reason?: string;
}

export function useInvestigationDecision() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ["audit-investigations", tenantId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["audit-investigation", tenantId],
    });
  };
  return useMutation({
    mutationFn: async (input: InvestigationDecisionInput) => {
      const { client } = getClient();
      const path = `/api/v1/audit/investigations/${encodeURIComponent(
        input.id,
      )}/${input.decision}`;
      // NEVER send `action_ids`: the handler answers 422
      // partial_approval_unsupported, and the UI must not imply per-action
      // approval is a thing that exists.
      const body =
        input.decision === "reject"
          ? { reason: (input.reason ?? "").trim() }
          : {};
      return client.request<Record<string, unknown>>("POST", path, { body });
    },
    // Success AND the 409 conflict both mean our cached copy is stale.
    onSuccess: invalidate,
    onError: (err: unknown) => {
      const status =
        err && typeof err === "object" && "status" in err
          ? Number((err as { status?: unknown }).status) || 0
          : 0;
      if (status === 409) invalidate();
    },
  });
}

/**
 * The live half the sheet gained back: while it is OPEN and a still-mutable
 * investigation exists, hold ONE status stream and let each transition frame
 * re-read the list — the same trigger-not-payload discipline as
 * hooks/useAuditTail, with the same cooldown so a burst of transitions
 * collapses into a single request. Focus-gated (createFocusGatedStream) so a
 * backgrounded phone is not reconnecting a socket the OS tore down, and every
 * way the stream can fail lands back on pull-to-refresh, which is untouched.
 */
export function useInvestigationStreamTrigger(input: {
  enabled: boolean;
  investigationId: string | null;
  refetch: () => unknown;
  /** Overridable for tests; production callers omit it. */
  focus?: FocusGate;
}) {
  const gate = useOnlineQueryGate();
  const refetchRef = useRef(input.refetch);
  refetchRef.current = input.refetch;
  const focus = input.focus ?? queryFocusGate;
  const id = input.investigationId;
  const streamEnabled =
    input.enabled && gate.enabled && Boolean(gate.tenantId) && Boolean(id);

  useEffect(() => {
    if (!streamEnabled || !id) return;
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
      onPause: () => {
        if (pending !== null) {
          clearTimeout(pending);
          pending = null;
        }
      },
      connect: () =>
        connectInvestigationStream(id, {
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
  }, [streamEnabled, id, focus]);
}
