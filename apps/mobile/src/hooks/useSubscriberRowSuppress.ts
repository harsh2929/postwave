/**
 * useSubscriberRowSuppress — Suppress straight from a subscriber row, with
 * its receipt and undo attached.
 *
 * Lifted out of app/(tabs)/subscribers/index.tsx so the screen stays a view (the
 * function was over its complexity budget) and so this behaviour sits beside
 * the profile's twin in useSubscriberProfileActions rather than being a
 * lookalike buried in a list screen.
 *
 * Suppression is reversible server-side, so per the Toast contract this is a
 * destructive action with an undo window rather than a pre-emptive confirm.
 *
 * The Undo carries `restoreStatus`: suppressing writes a suppression row AND
 * blocklists the subscriber, so an undo that only deleted the suppression row
 * would leave the person blocklisted and silently un-mailable.
 */
import { useCallback } from "react";

import { useToast } from "@/components/Toast";
import {
  useSuppressSubscriber,
  useUnsuppressSubscriber,
} from "@/hooks/useSubscribers";
import { trackSubscriberSuppressed } from "@/lib/audienceTelemetry";
import { haptics } from "@/lib/haptics";
import { uiStatusToEngine } from "@/lib/subscriberStatus";

export interface SuppressibleRow {
  id?: string | undefined;
  email: string;
  status?: string | undefined;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "";
}

export function useSubscriberRowSuppress(enabled: boolean) {
  const { toast } = useToast();
  const suppress = useSuppressSubscriber();
  const unsuppress = useUnsuppressSubscriber();

  return useCallback(
    (item: SuppressibleRow) => {
      const id = item.id;
      if (!id || !enabled) return;
      const restoreStatus = uiStatusToEngine(item.status) ?? "enabled";
      haptics.warning();
      suppress.mutate(id, {
        onSuccess: () => {
          haptics.success();
          trackSubscriberSuppressed("row", "suppressed");
          toast({
            kind: "success",
            message: `Suppressed ${item.email}`,
            action: {
              label: "Undo",
              onPress: () =>
                unsuppress.mutate(
                  { id, email: item.email, restoreStatus },
                  {
                    onSuccess: () =>
                      trackSubscriberSuppressed("row", "undone"),
                    onError: (e: unknown) =>
                      toast({
                        kind: "error",
                        message: `Couldn't undo. ${errorText(e)}`.trim(),
                      }),
                  },
                ),
            },
          });
        },
        onError: (e: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message:
              `Couldn't suppress ${item.email}. ${errorText(e)}`.trim(),
          });
        },
      });
    },
    [enabled, suppress, toast, unsuppress],
  );
}
