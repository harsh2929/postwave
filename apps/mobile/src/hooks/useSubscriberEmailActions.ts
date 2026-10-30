/**
 * useSubscriberEmailActions — what a tap and a long press on the profile's
 * email address do.
 *
 * COPY is the primary gesture and SHARE the long press. It used to be the
 * other way round, discoverable only through an accessibility label: tapping
 * an address opened a share sheet, which is a strange default when the thing
 * an operator does with an address mid-support-call is paste it somewhere.
 *
 * `copyToClipboard` resolves FALSE rather than throwing on a locked
 * pasteboard, so the receipt branches on the result — a control that says
 * "Copied" when nothing was copied is worse than one that admits the failure.
 */
import { useCallback } from "react";
import { Share } from "react-native";

import { useToast } from "@/components/Toast";
import { copyToClipboard } from "@/lib/clipboard";
import { haptics } from "@/lib/haptics";

export function useSubscriberEmailActions(email: string | undefined) {
  const { toast } = useToast();

  const onCopyEmail = useCallback(() => {
    const address = (email ?? "").trim();
    if (!address) return;
    void copyToClipboard(address).then((copied) => {
      if (copied) {
        haptics.success();
        toast({ kind: "success", message: `Copied ${address}` });
      } else {
        haptics.error();
        toast({ kind: "error", message: "Couldn't copy that address." });
      }
    });
  }, [email, toast]);

  const onShareEmail = useCallback(() => {
    const address = (email ?? "").trim();
    if (!address) return;
    // A dismissed share sheet rejects; that is a user action, not a fault.
    void Share.share({ message: address }).catch(() => undefined);
  }, [email]);

  return { onCopyEmail, onShareEmail };
}
