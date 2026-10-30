/**
 * hooks/useInboundUrlHandoff.ts — handing an inbound endpoint's public URL
 * back to the operator: copy is the primary tap, share is for passing it to
 * another app.
 *
 * Extracted from app/(tabs)/inbound-webhooks.tsx by responsibility when the
 * trigger-rules sheet was mounted there (P2.36): the screen component had
 * crossed its function-length budget, and this pair is the one part of it
 * that touches neither query state nor a confirm.
 *
 * Both are results, never questions: a failure lands in the toast lane, not
 * an OS dialog. `name` is typed non-null on the row but can be empty in
 * practice, so the share-sheet title falls back to the slug and never reads
 * "undefined".
 */
import * as Clipboard from "expo-clipboard";
import { useCallback } from "react";
import { Share } from "react-native";

import { useToast } from "@/components/Toast";
import { haptics } from "@/lib/haptics";

/** The fields the hand-off reads; InboundWebhookRow satisfies it structurally. */
export interface InboundUrlHandoffRow {
  name: string;
  slug: string;
  publicUrl?: string;
}

export function useInboundUrlHandoff(): {
  onCopyUrl: (row: InboundUrlHandoffRow) => void;
  onShareUrl: (row: InboundUrlHandoffRow) => void;
} {
  const { toast } = useToast();

  const onCopyUrl = useCallback(
    (row: InboundUrlHandoffRow) => {
      if (!row.publicUrl) return;
      Clipboard.setStringAsync(row.publicUrl)
        .then(() => {
          haptics.success();
          toast({ kind: "success", message: "Inbound URL copied" });
        })
        .catch(() => {
          haptics.error();
          toast({
            kind: "error",
            message:
              "Couldn't reach the clipboard. Use Share, or long-press the URL to select it.",
          });
        });
    },
    [toast],
  );

  const onShareUrl = useCallback(
    (row: InboundUrlHandoffRow) => {
      if (!row.publicUrl) return;
      const label = row.name || row.slug;
      void Share.share(
        { message: row.publicUrl, title: label },
        { dialogTitle: `Inbound URL for ${label}` },
      ).catch(() => {
        toast({ kind: "error", message: "Couldn't open the share sheet." });
      });
    },
    [toast],
  );

  return { onCopyUrl, onShareUrl };
}
