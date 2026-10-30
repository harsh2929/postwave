/**
 * useSubscriberSelection — selection mode for the subscribers list, and the
 * orchestration around the three bulk verbs.
 *
 * It lives out of app/(tabs)/subscribers/index.tsx because the screen is already at
 * its function-size budget and because everything here is behaviour rather
 * than layout: which rows are picked, whether a verb may run, which sheet is
 * open, what the receipt says, and whether an undo is honest to offer.
 *
 * The policy it enforces (ceiling, role, reversibility, copy) is all in
 * src/lib/subscriberSelection.ts, which is import-free and unit-tested.
 */
import { useCallback, useMemo, useState } from "react";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import type { ListOption } from "@/hooks/useListOptions";
import { useSubscriberBulkActions } from "@/hooks/useSubscriberBulkActions";
import { haptics } from "@/lib/haptics";
import {
  beginSelection,
  bulkAvailability,
  bulkConfirmCopy,
  bulkResultMessage,
  BULK_VERB_SPECS,
  EMPTY_SELECTION,
  MAX_BULK_SELECTION,
  selectAllLoaded,
  selectionCapMessage,
  toggleSelection,
  type BulkResultWire,
  type BulkVerb,
  type SelectionState,
} from "@/lib/subscriberSelection";
import type { ValidationBatchView } from "@/lib/subscriberValidateEmails";

export type BulkSheet = "none" | "tag" | "list" | "validation";

export function useSubscriberSelection(input: {
  /** Ids of every row currently materialised, in list order. */
  loadedIds: readonly string[];
  hasAdminRole: boolean;
  online: boolean;
  gated: boolean;
  /**
   * Addresses for a set of selected ids, from the rows on screen. `skipped`
   * counts selected rows with no address — named in the receipt, never
   * silently dropped. Optional so screens without the validate verb (and
   * older tests) need not thread it.
   */
  emailsForIds?: (ids: readonly string[]) => { emails: string[]; skipped: number };
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const bulk = useSubscriberBulkActions();
  const [state, setState] = useState<SelectionState>(EMPTY_SELECTION);
  const [sheet, setSheet] = useState<BulkSheet>("none");
  const [validation, setValidation] = useState<{
    view: ValidationBatchView;
    skipped: number;
  } | null>(null);

  const count = state.ids.length;
  const availability = useMemo(
    () =>
      bulkAvailability({
        count,
        hasAdminRole: input.hasAdminRole,
        online: input.online,
        gated: input.gated,
      }),
    [count, input.hasAdminRole, input.online, input.gated],
  );

  const exit = useCallback(() => {
    setState(EMPTY_SELECTION);
    setSheet("none");
  }, []);

  const begin = useCallback(
    (id: string) => {
      if (!id) return;
      haptics.impact();
      setState((prev) => (prev.active ? toggleSelection(prev, id).next : beginSelection(id)));
    },
    [],
  );

  const toggle = useCallback(
    (id: string) => {
      setState((prev) => {
        const result = toggleSelection(prev, id);
        if (result.refused) {
          haptics.warning();
          toast({ kind: "warning", message: selectionCapMessage() });
          return prev;
        }
        haptics.tap();
        return result.next;
      });
    },
    [toast],
  );

  const selectAll = useCallback(() => {
    const result = selectAllLoaded(input.loadedIds);
    haptics.tap();
    setState(result.next);
    if (result.capped) toast({ kind: "warning", message: selectionCapMessage() });
  }, [input.loadedIds, toast]);

  const clear = useCallback(() => {
    haptics.tap();
    setState((prev) => ({ active: prev.active, ids: [] }));
  }, []);

  /**
   * Report one verb's outcome. `affected`/`skipped` come straight from the
   * server so a partially-applied write is never presented as a clean one.
   */
  const report = useCallback(
    (verb: BulkVerb, result: BulkResultWire, requested: number, undo?: () => void) => {
      haptics.success();
      const spec = BULK_VERB_SPECS[verb];
      toast({
        kind: "success",
        message: bulkResultMessage(verb, result, requested),
        // Only reversible verbs get an undo. bulk/unsubscribe mints no
        // recovery path server-side, and an Undo that silently failed would
        // be worse than none.
        ...(spec.reversible && undo
          ? { action: { label: "Undo", onPress: undo } }
          : {}),
      });
      exit();
    },
    [exit, toast],
  );

  const fail = useCallback(
    (verb: BulkVerb, error: unknown) => {
      haptics.error();
      const detail = error instanceof Error ? error.message : "";
      toast({
        kind: "error",
        message: `Couldn't ${BULK_VERB_SPECS[verb].label.toLowerCase()}. ${detail}`.trim(),
      });
    },
    [toast],
  );

  const emailsForIds = input.emailsForIds;

  /** Open the right sheet, or run the verb that needs no extra input. */
  const startVerb = useCallback(
    async (verb: BulkVerb) => {
      if (!availability.enabled) return;
      if (verb === "tag") {
        setSheet("tag");
        return;
      }
      if (verb === "add-to-list") {
        setSheet("list");
        return;
      }
      if (verb === "validate") {
        // Surface validation: runs immediately (nothing to configure), keeps
        // the selection alive — the point of checking is to act on the result.
        const resolved = emailsForIds?.([...state.ids]) ?? {
          emails: [],
          skipped: state.ids.length,
        };
        if (resolved.emails.length === 0) {
          haptics.error();
          toast({
            kind: "error",
            message: "None of the selected rows carry an email address.",
          });
          return;
        }
        try {
          const view = await bulk.validate.mutateAsync(resolved.emails);
          haptics.success();
          setValidation({ view, skipped: resolved.skipped });
          setSheet("validation");
        } catch (error) {
          fail("validate", error);
        }
        return;
      }
      const copy = bulkConfirmCopy("unsubscribe", count);
      if (copy) {
        const ok = await confirm({
          title: copy.title,
          message: copy.message,
          confirmLabel: copy.confirmLabel,
          consequence: copy.consequence,
          destructive: copy.destructive,
          ...(copy.confirmPhrase ? { confirmPhrase: copy.confirmPhrase } : {}),
        });
        if (!ok) return;
      }
      const ids = [...state.ids];
      try {
        const result = await bulk.unsubscribe.mutateAsync(ids);
        report("unsubscribe", result, ids.length);
      } catch (error) {
        fail("unsubscribe", error);
      }
    },
    [
      availability.enabled,
      bulk.unsubscribe,
      bulk.validate,
      confirm,
      count,
      emailsForIds,
      fail,
      report,
      state.ids,
      toast,
    ],
  );

  const applyTag = useCallback(
    async (tag: string) => {
      const ids = [...state.ids];
      setSheet("none");
      try {
        const result = await bulk.tag.mutateAsync({ ids, tag });
        report("tag", result, ids.length, () => {
          bulk.untag
            .mutateAsync({ ids, tag })
            .then(() => toast({ kind: "info", message: `Removed “${tag}”` }))
            .catch((e: unknown) =>
              toast({
                kind: "error",
                message: `Couldn't remove “${tag}”. ${e instanceof Error ? e.message : ""}`.trim(),
              }),
            );
        });
      } catch (error) {
        fail("tag", error);
      }
    },
    [bulk.tag, bulk.untag, fail, report, state.ids, toast],
  );

  const applyList = useCallback(
    async (list: ListOption) => {
      const ids = [...state.ids];
      setSheet("none");
      try {
        const result = await bulk.addToList.mutateAsync({ ids, listId: list.id });
        // Add-to-list is additive and idempotent server-side, but there is no
        // bulk REMOVE-from-list route, so no undo is offered rather than one
        // that cannot be honoured.
        report("add-to-list", result, ids.length);
      } catch (error) {
        fail("add-to-list", error);
      }
    },
    [bulk.addToList, fail, report, state.ids],
  );

  // "Everything selectable is selected" — which, past the ceiling, means the
  // ceiling rather than the loaded count.
  const allLoadedSelected =
    input.loadedIds.length > 0 &&
    count >= Math.min(input.loadedIds.length, MAX_BULK_SELECTION);

  return {
    active: state.active,
    ids: state.ids,
    count,
    availability,
    pending: bulk.pending,
    sheet,
    allLoadedSelected,
    begin,
    toggle,
    selectAll,
    clear,
    exit,
    startVerb,
    applyTag,
    applyList,
    validation,
    closeSheet: useCallback(() => setSheet("none"), []),
  };
}
