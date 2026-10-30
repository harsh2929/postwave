/**
 * useSuppressionRowActions — un-suppress (with its undo) and the CSV export,
 * lifted out of app/(tabs)/suppressions/index.tsx so the screen stays a view once it
 * became channel-aware.
 *
 * Both carry a rule that is easy to get wrong and invisible when it is:
 *
 *  - UN-SUPPRESS IS REVERSIBLE, so it gets an undo toast rather than a
 *    pre-confirm — re-adding is a single POST. The undo re-sends the ORIGINAL
 *    reason, not a generic one, so an undone bounce goes back as a bounce.
 *  - THE EXPORT IS NOT FILTERED. The endpoint expresses "the newest N
 *    addresses" and takes no search or reason parameter, so a filtered-looking
 *    export must not be presented as one, and the on-screen `total` (which IS
 *    filtered while searching) must not become its denominator.
 */
import { useCallback } from "react";
import { Share } from "react-native";

import { useToast } from "@/components/Toast";
import {
  useAddSuppression,
  useExportSuppressions,
  useRemoveSuppression,
  type SuppressionRow,
} from "@/hooks/useSuppressionOps";
import { haptics } from "@/lib/haptics";
import {
  suppressionCsv,
  suppressionExportNotice,
  SUPPRESSION_EXPORT_MAX_ROWS,
} from "@/lib/suppressionExport";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useSuppressionRowActions(input: {
  /** True when a search term or reason chip is narrowing the screen. */
  filtered: boolean;
  /** The server's count for the CURRENT query. */
  total: number;
}) {
  const { toast } = useToast();
  const remove = useRemoveSuppression();
  const add = useAddSuppression();
  const exportCsv = useExportSuppressions();
  const { filtered, total } = input;

  const onUnsuppress = useCallback(
    (row: SuppressionRow) => {
      const email = (row.email ?? "").trim();
      if (!email) return;
      const reason = (row.reason ?? "").trim() || "list_manual";
      remove
        .mutateAsync(email)
        .then(() => {
          haptics.success();
          toast({
            kind: "success",
            message: `${email} un-suppressed`,
            action: {
              label: "Undo",
              onPress: () => {
                add
                  .mutateAsync({ email, reason })
                  .then(() => toast({ kind: "info", message: "Restored" }))
                  .catch((e: unknown) =>
                    toast({
                      kind: "error",
                      message: `Couldn't restore it. ${errorText(e)}`.trim(),
                    }),
                  );
              },
            },
          });
        })
        .catch((e: unknown) => {
          haptics.error();
          toast({ kind: "error", message: errorText(e) });
        });
    },
    [add, remove, toast],
  );

  const onExport = useCallback(() => {
    haptics.tap();
    exportCsv
      .mutateAsync(SUPPRESSION_EXPORT_MAX_ROWS)
      .then(async (raw) => {
        // A filtered denominator would understate the real list, so withhold
        // it rather than print a number the export does not mean.
        const csv = suppressionCsv(raw, { total: filtered ? 0 : total });
        const notice = suppressionExportNotice(csv, { filtered });
        if (csv.included === 0) {
          toast({ kind: "info", message: notice });
          return;
        }
        await Share.share({ message: csv.body, title: csv.title });
        toast({ kind: "info", message: notice });
      })
      .catch((e: unknown) => {
        haptics.error();
        toast({ kind: "error", message: errorText(e) });
      });
  }, [exportCsv, filtered, toast, total]);

  /**
   * Manual add, used by the header "+" sheet. Exposed from here rather than
   * from the screen so the ADD mutation has exactly one owner — the undo path
   * above uses the same one, and two instances would make a queued undo and a
   * manual add report each other's pending state.
   */
  const onAdd = useCallback(
    (
      request: { email: string; reason: string },
      callbacks: { onDone: () => void },
    ) => {
      add
        .mutateAsync(request)
        .then(() => {
          haptics.success();
          callbacks.onDone();
          toast({ kind: "success", message: `${request.email} suppressed` });
        })
        .catch((e: unknown) => {
          haptics.error();
          toast({ kind: "error", message: errorText(e) });
        });
    },
    [add, toast],
  );

  return {
    onUnsuppress,
    onExport,
    onAdd,
    adding: add.isPending,
    exporting: exportCsv.isPending,
  };
}
