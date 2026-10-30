/**
 * hooks/useResendConfirmation.ts — re-send a double-opt-in confirmation for a
 * pending submission. Split from the form-detail route at its complexity
 * budget; `toast` arrives as a parameter (the useDiscountsScreen idiom).
 *
 * Not a react-query mutation: this is a one-shot side effect with no cached
 * result of its own, and the only thing that changes afterwards is the
 * submission list — which is invalidated rather than patched, because the
 * server owns the status the row renders.
 *
 * 409 IS NOT A FAILURE: it means somebody confirmed between the screen
 * loading and the tap. The intent is satisfied, but nothing was sent — so it
 * must never say "sent".
 */
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { resendFormConfirmation } from "@/api/forms";
import type { ToastOptions } from "@/components/Toast";
import { errorPresentation } from "@/lib/errorCopy";
import { haptics } from "@/lib/haptics";

type ToastFn = (options: ToastOptions) => void;

export function useResendConfirmation(
  formId: string | undefined,
  tenantId: string | null,
  toast: ToastFn,
) {
  const queryClient = useQueryClient();
  const [resending, setResending] = useState(false);

  const resend = useCallback(
    async (row: { id: string; email?: string | null }) => {
      if (!formId || resending) return;
      setResending(true);
      haptics.tap();
      try {
        const result = await resendFormConfirmation(formId, row.id);
        haptics.success();
        toast({
          kind: "success",
          message: result.alreadyConfirmed
            ? `${row.email ?? "That address"} is already confirmed.`
            : `Confirmation re-sent to ${row.email ?? "that address"}.`,
        });
        void queryClient.invalidateQueries({
          queryKey: ["form-submissions", tenantId, formId],
        });
      } catch (err) {
        haptics.error();
        toast({
          kind: "error",
          message:
            errorPresentation(err).message ||
            "Couldn't resend that confirmation.",
        });
      } finally {
        setResending(false);
      }
    },
    [formId, queryClient, resending, tenantId, toast],
  );

  return { resend, resending };
}
