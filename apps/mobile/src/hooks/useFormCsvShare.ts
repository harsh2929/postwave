/**
 * hooks/useFormCsvShare.ts — fetch, bound and hand a form's submissions CSV
 * to the OS share sheet. Split from the form-detail route at its complexity
 * budget; takes `toast` as a parameter the way useDiscountsScreen does, so
 * the route stays the only owner of its Toast context.
 */
import { useCallback } from "react";
import { Share } from "react-native";

import type { ToastOptions } from "@/components/Toast";
import { useExportFormSubmissions } from "@/hooks/useFormOps";

type ToastFn = (options: ToastOptions) => void;
import { errorPresentation } from "@/lib/errorCopy";
import { formSubmissionsExportNotice } from "@/lib/formSubmissionsExport";
import { haptics } from "@/lib/haptics";

export function useFormCsvShare(id: string | undefined, toast: ToastFn) {
  const exportCsv = useExportFormSubmissions();

  const share = useCallback(
    (formName: string) => {
      if (!id || exportCsv.isPending) return;
      haptics.tap();
      exportCsv.mutate(
        { id, formName },
        {
          onSuccess: (result) => {
            if (result.included === 0) {
              toast({
                kind: "success",
                message: formSubmissionsExportNotice(result),
              });
              return;
            }
            void Share.share({ message: result.body, title: result.title })
              .then(() =>
                toast({
                  kind: "success",
                  message: formSubmissionsExportNotice(result),
                }),
              )
              .catch(() =>
                toast({
                  kind: "error",
                  message: "Couldn't open the share sheet.",
                }),
              );
          },
          onError: (error) => {
            haptics.error();
            toast({
              kind: "error",
              message:
                errorPresentation(error).message ||
                "Couldn't export the submissions.",
            });
          },
        },
      );
    },
    [exportCsv, id, toast],
  );

  return { share, exporting: exportCsv.isPending };
}
