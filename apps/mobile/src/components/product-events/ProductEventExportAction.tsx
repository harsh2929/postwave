/**
 * ProductEventExportAction — hand the event feed to someone, from the phone.
 *
 * The Track screen could show the feed and share nothing; desktop's Track page
 * downloads the same rows as a file (Track.tsx:1954). A phone has no download
 * folder a colleague can reach, so the CSV goes to the NATIVE SHARE SHEET —
 * a link to `/api/v1/track/events.csv` would open, unauthenticated, in the
 * recipient's browser and fetch nothing.
 *
 * Everything that makes the artifact safe (row cap, formula-injection guard,
 * dropped payload column, the truncation claim) lives in
 * lib/productEventsExport, where it is tested. This component owns the tap,
 * the busy state, and the sentence afterwards.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useState } from "react";
import { Pressable, Share, Text } from "react-native";

import { useToast } from "@/components/Toast";
import { fetchProductEventsCsv } from "@/api/productEventsExport";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  PRODUCT_EVENT_EXPORT_MAX_ROWS,
  productEventsCsv,
  productEventsExportNotice,
} from "@/lib/productEventsExport";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface ProductEventExportActionProps {
  /** The window on screen; the export asks the server for the same one. */
  days: number;
}

export function ProductEventExportAction({
  days,
}: ProductEventExportActionProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const gate = useOnlineQueryGate();
  const [busy, setBusy] = useState(false);
  const offline = !gate.enabled;

  const onExport = () => {
    if (busy || offline) return;
    haptics.tap();
    setBusy(true);
    fetchProductEventsCsv({ days })
      .then(async (raw) => {
        const csv = productEventsCsv(raw, { days });
        const notice = productEventsExportNotice(csv);
        if (csv.included === 0) {
          toast({ kind: "info", message: notice });
          return;
        }
        await Share.share({ message: csv.body, title: csv.title });
        toast({ kind: "info", message: notice });
      })
      .catch((err: unknown) => {
        haptics.error();
        toast({
          kind: "error",
          message:
            errorPresentation(err).message || "Couldn't export the event feed.",
        });
      })
      .finally(() => setBusy(false));
  };

  return (
    <Pressable
      onPress={onExport}
      disabled={busy || offline}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy || offline, busy }}
      accessibilityLabel={`Export the last ${days} days of product events as CSV`}
      accessibilityHint={
        offline
          ? "Not available offline."
          : `Shares the newest ${PRODUCT_EVENT_EXPORT_MAX_ROWS} events through the share sheet. Event properties are not included.`
      }
      hitSlop={10}
      style={{
        minHeight: 44,
        minWidth: 44,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: busy || offline ? t.fgSubtle : t.accent,
          fontFamily: FONT.semibold,
          ...typeStyle("control"),
        }}
      >
        {busy ? "Exporting…" : "Export"}
      </Text>
    </Pressable>
  );
}
