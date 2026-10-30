/**
 * hooks/useDiscountEditDraft.ts — the edit-a-discount draft, lifted out of
 * `src/components/discounts/DiscountEditSheet.tsx`.
 *
 * The sheet edits exactly two things — an expiry and a redemption cap — and
 * both are INTENTS rather than values, which is the part worth isolating:
 *
 *  - "keep" is not the same as "set it to what it already is". A discount can
 *    be edited by two people, so the patch must say what the operator ASKED
 *    for, not what the row happened to show when the sheet opened. An empty
 *    cap field therefore means "don't touch the cap", never "set it to blank".
 *  - CLEARING is its own intent, distinct from an empty field. `capCleared`
 *    exists because "" and "remove the limit" would otherwise be the same
 *    keystroke, and one of them is destructive.
 *
 * `buildDiscountPatch` turns the pair into a patch plus the sentence shown on
 * success; it is pure and separately tested, so this hook only owns the draft
 * state and the write.
 */
import { useCallback, useMemo, useState } from "react";

import {
  buildDiscountPatch,
  type CapIntent,
  type ExpiryIntent,
} from "@/lib/discountEdit";
import { useUpdateDiscount, type DiscountRow } from "@/hooks/useDiscountOps";
import { errorPresentation } from "@/lib/errorCopy";
import { haptics } from "@/lib/haptics";

export interface DiscountEditDraftInput {
  row: DiscountRow | null;
  onClose: () => void;
  toast: (options: {
    kind: "success" | "error" | "warning" | "info";
    message: string;
  }) => void;
}

export function useDiscountEditDraft({
  row,
  onClose,
  toast,
}: DiscountEditDraftInput) {
  const update = useUpdateDiscount();
  const [expiry, setExpiry] = useState<ExpiryIntent>({ kind: "keep" });
  const [capText, setCapText] = useState("");
  const [capCleared, setCapCleared] = useState(false);

  // Clearing wins over typing: if both are somehow set, the destructive
  // intent is the one the operator last chose deliberately.
  const capIntent: CapIntent = capCleared
    ? { kind: "clear" }
    : capText.trim() === ""
      ? { kind: "keep" }
      : { kind: "raise", value: Number(capText.trim()) };

  const result = useMemo(
    () => (row ? buildDiscountPatch(row, { expiry, cap: capIntent }) : null),
    // capIntent is rebuilt every render; depend on its inputs instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [row, expiry, capText, capCleared],
  );

  const close = useCallback(() => {
    setExpiry({ kind: "keep" });
    setCapText("");
    setCapCleared(false);
    onClose();
  }, [onClose]);

  const onSave = useCallback(() => {
    if (!row || !result?.ok) return;
    haptics.tap();
    update
      .mutateAsync({ code: row.code, patch: result.patch })
      .then(() => {
        haptics.success();
        toast({ kind: "success", message: result.summary });
        close();
      })
      .catch((e: unknown) => {
        haptics.error();
        toast({ kind: "error", message: errorPresentation(e).message });
      });
  }, [close, result, row, toast, update]);

  return {
    expiry,
    setExpiry,
    capText,
    setCapText,
    capCleared,
    setCapCleared,
    result,
    saving: update.isPending,
    close,
    onSave,
  };
}
