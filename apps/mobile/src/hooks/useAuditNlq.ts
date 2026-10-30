/**
 * hooks/useAuditNlq.ts — one question at a time against the audit log.
 *
 * TWO HOOKS, AND THE SPLIT IS THE POINT.
 *
 *  · The BUDGET is a read: `GET /api/v1/audit/nlq/cost-status` is free, costs
 *    the workspace nothing, and answers two things the client would otherwise
 *    have to guess — how many tokens are left today, and whether the pipeline
 *    is configured at all (`nlq_available` is literally `h.NLQLLM != nil`).
 *    So it is a gated `useQuery` like every other read on this screen.
 *
 *  · ASKING is a MUTATION, deliberately. A question spends workspace tokens
 *    against a per-tenant daily cap, so it must never be re-run by a cache
 *    revalidation, a refocus, a window change or a pull-to-refresh. The user
 *    asks; the server answers once; the answer stays until they ask again.
 *
 * The ask is NOT wrapped in `useOnlineQueryGate` — that gate governs automatic
 * fetching, and this fetch only ever happens because a finger pressed Ask. The
 * SHEET hides the control when the session cannot reach the network, which is
 * where that decision belongs.
 *
 * On success the budget query is refreshed from the answer's own `cost_status`
 * block rather than refetched: the server already told us what the question
 * cost, and a second round trip to learn it would be waste on a surface whose
 * entire premise is that requests are expensive.
 */
import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  askAuditNlq,
  fetchAuditNlqCostStatus,
  type AuditNlqCostStatus,
} from "@/api/auditNlq";
import {
  codeFromError,
  messageFromError,
  statusFromError,
} from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  auditNlqAccess,
  auditNlqErrorMessage,
  type AuditNlqAccess,
  type AuditNlqAnswer,
  type AuditNlqBudget,
} from "@/lib/auditNlq";
import {
  auditExecuteFloorMet,
  type AuditViewAuthMode,
  type AuditViewScopeSet,
} from "@/lib/auditSavedViewPolicy";

/**
 * The ONE cache key for the budget probe.
 *
 * `useAuditNlqAsk` writes the post-charge budget straight into it, so if the
 * two spellings drifted the remaining-token line would silently stop updating
 * after a question — the exact failure a shared constructor prevents.
 */
function costStatusKey(
  tenantId: string | null,
  userId: string | null,
): readonly unknown[] {
  return ["audit-nlq-cost", tenantId, userId];
}

/**
 * The budget/availability probe.
 *
 * `enabled` is the caller's permission answer ANDed with the identity gate:
 * there is no reason to spend a request learning a budget the reader is not
 * permitted to spend, and no reason to ask before the scope probe has replied.
 */
export function useAuditNlqCostStatus(enabled: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: costStatusKey(gate.tenantId, gate.userId),
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    queryFn: (): Promise<AuditNlqCostStatus> => fetchAuditNlqCostStatus(),
  });
}

export interface AuditNlqAskState<Row> {
  answer: AuditNlqAnswer<Row> | null;
  asking: boolean;
  /** Reader-facing sentence, already mapped from the handler's error codes. */
  errorMessage: string | null;
  ask: (question: string) => void;
  reset: () => void;
}

export function useAuditNlqAsk<Row>(): AuditNlqAskState<Row> {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (question: string) => askAuditNlq<Row>(question),
    onSuccess: (answer) => {
      // The answer carries the post-charge budget. Write it straight into the
      // probe's cache so the remaining-token line updates without a refetch.
      queryClient.setQueryData<AuditNlqCostStatus>(
        costStatusKey(gate.tenantId, gate.userId),
        (previous) => ({
          budget: answer.budget,
          available: previous?.available ?? true,
        }),
      );
    },
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
      ? auditNlqErrorMessage(
          statusFromError(mutation.error),
          codeFromError(mutation.error),
          messageFromError(mutation.error),
        )
      : null,
    ask,
    reset,
  };
}

export interface AuditNlqController<Row> {
  /** Whether to offer the control at all, and the copy for why not. */
  access: AuditNlqAccess;
  /** Null until the probe answers, or when the reader may not ask. */
  budget: AuditNlqBudget | null;
  ask: AuditNlqAskState<Row>;
  sheetOpen: boolean;
  openSheet: () => void;
  closeSheet: () => void;
}

/**
 * Everything the audit screen needs to offer (or withhold) the Ask control,
 * as one call.
 *
 * Composed here rather than in the screen because the three facts involved —
 * the permission floor, the server's `nlq_available`, and the live budget —
 * only mean anything together: offering the control on any two of them is how
 * a surface ends up rendering an input whose only possible answer is a 403 or
 * a 503.
 */
export function useAuditNlqController<Row>(input: {
  scopes: AuditViewScopeSet | null | undefined;
  mode: AuditViewAuthMode;
}): AuditNlqController<Row> {
  const [sheetOpen, setSheetOpen] = useState(false);
  const floorMet = auditExecuteFloorMet(input);
  const cost = useAuditNlqCostStatus(floorMet === true);
  const ask = useAuditNlqAsk<Row>();
  const openSheet = useCallback(() => setSheetOpen(true), []);
  const closeSheet = useCallback(() => setSheetOpen(false), []);

  return {
    access: auditNlqAccess({
      floorMet,
      mode: input.mode,
      available: cost.data?.available ?? null,
    }),
    budget: cost.data?.budget ?? null,
    ask,
    sheetOpen,
    openSheet,
    closeSheet,
  };
}
