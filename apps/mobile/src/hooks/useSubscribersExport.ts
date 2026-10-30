/**
 * useSubscribersExport — the applied subscriber view as a shareable CSV.
 *
 * `GET /api/v1/subscribers/export.csv` is viewer-scoped (routeauth manifest)
 * and streams the SAME filtered set the list shows (SUB-107), so this hook's
 * job is only honesty: refuse to export a view that has not settled, request
 * with exactly the applied filters, and hand the share sheet a bounded,
 * injection-safe re-emission. All of those rules live in
 * src/lib/subscriberExport.ts, where they are unit-tested; this hook is the
 * transport + receipt.
 *
 * `asText` is required — the endpoint answers `text/csv`, and it keeps the
 * SDK's `readTextLimited` transfer ceiling in play on cellular.
 */
import { useCallback } from "react";
import { Share } from "react-native";
import { useMutation } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useToast } from "@/components/Toast";
import { haptics } from "@/lib/haptics";
import {
  subscriberExportBlockedReason,
  subscriberExportCsv,
  subscriberExportNotice,
  subscriberExportScope,
  subscribersExportPath,
  type SubscriberExportView,
} from "@/lib/subscriberExport";

export interface SubscribersExportInput {
  view: SubscriberExportView;
  /** The list's own total for the applied view; drives truncation honesty. */
  serverTotal: number | undefined;
  /** What the status chips call the audience, e.g. "unsubscribed subscribers". */
  statusNoun: string;
  draftQuery: string;
  loading: boolean;
  gated: boolean;
  online: boolean;
}

export function useSubscribersExport(input: SubscribersExportInput) {
  const { toast } = useToast();

  const fetchCsv = useMutation({
    mutationFn: async (view: SubscriberExportView): Promise<string> => {
      const { client } = getClient();
      return client.request<string>("GET", subscribersExportPath(view), {
        asText: true,
      });
    },
  });

  const blockedReason = subscriberExportBlockedReason({
    draftQuery: input.draftQuery,
    settledQuery: input.view.query,
    loading: input.loading,
    gated: input.gated,
    online: input.online,
  });

  const { view, serverTotal, statusNoun } = input;
  const onExport = useCallback(() => {
    if (blockedReason) {
      toast({ kind: "info", message: blockedReason });
      return;
    }
    haptics.tap();
    fetchCsv
      .mutateAsync(view)
      .then(async (raw) => {
        const scope = subscriberExportScope({
          query: view.query,
          statusNoun,
          includeArchived: view.includeArchived,
        });
        const csv = subscriberExportCsv(raw, { scope, serverTotal });
        const notice = subscriberExportNotice(csv);
        if (csv.included === 0) {
          toast({ kind: "info", message: notice });
          return;
        }
        await Share.share({ message: csv.body, title: csv.title });
        toast({ kind: "info", message: notice });
      })
      .catch((e: unknown) => {
        haptics.error();
        toast({
          kind: "error",
          message:
            `Couldn't export this view. ${e instanceof Error ? e.message : ""}`.trim(),
        });
      });
  }, [blockedReason, fetchCsv, serverTotal, statusNoun, toast, view]);

  return { onExport, exporting: fetchCsv.isPending };
}
