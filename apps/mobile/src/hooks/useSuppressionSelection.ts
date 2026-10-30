/**
 * useSuppressionSelection — selection mode for the suppressions list and the
 * one bulk verb behind it.
 *
 * It lives out of app/(tabs)/suppressions/index.tsx because the screen is already
 * near its function-size budget and because everything here is behaviour:
 * which rows are picked, whether the verb may run, what the receipt says.
 *
 * The policy — ceiling, role, confirm phrase, receipt wording — is all in
 * src/lib/suppressionSelection.ts, which is import-free and unit-tested.
 *
 * The BULK CALL addresses rows by EMAIL, not by row id. That is deliberate and
 * matches the handler's own reasoning (bulk.go bulkDeleteInput): the converged
 * list can render legacy `email_suppressions` rows whose ids do not exist in
 * the X1 table, and email is the identity both tables share. Sending ids for a
 * legacy row would resolve to nothing and report a silent no-op as success.
 */
import { useCallback, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import { haptics } from "@/lib/haptics";
import {
  beginSelection,
  EMPTY_SELECTION,
  parseSuppressionBulkResult,
  selectAllLoaded,
  suppressionBulkAvailability,
  suppressionBulkConfirmCopy,
  suppressionBulkResultMessage,
  suppressionCapMessage,
  toggleSelection,
  type SelectionState,
} from "@/lib/suppressionSelection";
import { OfflineWriteRefusedError } from "@/hooks/useSuppressionOps";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * POST /api/v1/suppressions/bulk-delete — admin scope (main.go:3369 wraps
 * MountX1BulkRoutes in RequireScope(ScopeAdmin)).
 */
function useBulkReleaseSuppressions() {
  const queryClient = useQueryClient();
  const gate = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (emails: readonly string[]): Promise<unknown> => {
      if (!isProbablyOnline()) throw new OfflineWriteRefusedError();
      const { client } = getClient();
      return client.request<unknown>(
        "POST",
        "/api/v1/suppressions/bulk-delete",
        { body: { emails: [...emails] } },
      );
    },
    onSuccess: () => {
      // A bulk verb rewrites an unbounded set and the receipt does not say
      // WHICH rows, so there is nothing honest to project optimistically —
      // invalidating the family is the correct blunt instrument.
      void queryClient.invalidateQueries({
        queryKey: ["suppressions", gate.tenantId, gate.userId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["suppression-trend", gate.tenantId],
      });
    },
  });
}

export function useSuppressionSelection(input: {
  /** Emails of every row materialised right now, in list order. */
  loadedEmails: readonly string[];
  hasAdminRole: boolean;
  online: boolean;
  gated: boolean;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const release = useBulkReleaseSuppressions();
  const [state, setState] = useState<SelectionState>(EMPTY_SELECTION);

  const count = state.ids.length;
  const availability = useMemo(
    () =>
      suppressionBulkAvailability({
        count,
        hasAdminRole: input.hasAdminRole,
        online: input.online,
        gated: input.gated,
      }),
    [count, input.hasAdminRole, input.online, input.gated],
  );

  const exit = useCallback(() => setState(EMPTY_SELECTION), []);

  /**
   * Enter selection mode with nothing picked yet — the header's "Select"
   * button. Long-press seeds a row; this does not, because the user has not
   * pointed at one, and pre-selecting the first row would act on an address
   * they never chose.
   */
  const enter = useCallback(() => setState({ active: true, ids: [] }), []);

  const begin = useCallback((email: string) => {
    if (!email) return;
    haptics.impact();
    setState((prev) =>
      prev.active ? toggleSelection(prev, email).next : beginSelection(email),
    );
  }, []);

  const toggle = useCallback(
    (email: string) => {
      setState((prev) => {
        const result = toggleSelection(prev, email);
        if (result.refused) {
          haptics.error();
          toast({ kind: "info", message: suppressionCapMessage() });
        }
        return result.next;
      });
    },
    [toast],
  );

  const selectLoaded = useCallback(() => {
    const result = selectAllLoaded(input.loadedEmails);
    if (result.capped) {
      toast({ kind: "info", message: suppressionCapMessage() });
    }
    setState(result.next);
  }, [input.loadedEmails, toast]);

  const clear = useCallback(
    () => setState({ active: true, ids: [] }),
    [],
  );

  const onRelease = useCallback(async () => {
    if (!availability.enabled || release.isPending) return;
    const emails = [...state.ids];
    const copy = suppressionBulkConfirmCopy(emails.length);
    const ok = await confirm({
      title: copy.title,
      message: copy.message,
      confirmLabel: copy.confirmLabel,
      consequence: copy.consequence,
      confirmPhrase: copy.confirmPhrase,
      destructive: copy.destructive,
    });
    if (!ok) return;
    try {
      const raw = await release.mutateAsync(emails);
      const result = parseSuppressionBulkResult(raw);
      haptics.success();
      toast({
        // Partial success is INFO, not success: the sentence names what did
        // not happen and a green tick beside it reads as "all done".
        kind:
          result.blocked.length > 0 || result.errors.length > 0
            ? "info"
            : "success",
        message: suppressionBulkResultMessage(result, emails.length),
      });
      exit();
    } catch (e: unknown) {
      haptics.error();
      toast({ kind: "error", message: errorText(e) });
    }
  }, [availability.enabled, confirm, exit, release, state.ids, toast]);

  const allLoadedSelected =
    input.loadedEmails.length > 0 && count >= input.loadedEmails.length;

  return {
    active: state.active,
    ids: state.ids,
    count,
    availability,
    pending: release.isPending,
    allLoadedSelected,
    begin,
    enter,
    toggle,
    selectLoaded,
    clear,
    exit,
    onRelease,
  };
}
