/**
 * AnalyticsExportButton — the Analytics header's export affordance.
 *
 * DASHBOARD#40. The screen could share a sentence about a metric and nothing
 * else; this shares the rows behind them. What is exported is exactly what is
 * ON SCREEN — assembled from the query cache — because the two server-side CSV
 * endpoints the desktop uses are per-campaign and per-report-run, and neither
 * of them contains this screen's workspace-wide series. See lib/analyticsExport.ts.
 *
 * The button is present even when a section failed: the export names what it
 * could not include, which is the fact a reader most needs and the one a
 * silently-partial file would hide. It is only hidden when there is nothing at
 * all to send, because offering to share an empty file is a broken promise.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Share, Text } from "react-native";

import { useToast } from "@/components/Toast";
import {
  analyticsExportNotice,
  buildAnalyticsCsv,
  type AnalyticsExportSeries,
} from "@/lib/analyticsExport";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AnalyticsExportButtonProps {
  rangeLabel: string;
  series: readonly AnalyticsExportSeries[];
  /** Sections that errored or were never loaded, named in the file. */
  unavailable: readonly string[];
}

export function AnalyticsExportButton({
  rangeLabel,
  series,
  unavailable,
}: AnalyticsExportButtonProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const rows = series.reduce((sum, entry) => sum + entry.rows.length, 0);
  if (rows === 0) return null;

  const onExport = () => {
    haptics.tap();
    const result = buildAnalyticsCsv({
      rangeLabel,
      takenAt: new Date().toISOString(),
      series,
      unavailable,
    });
    const notice = analyticsExportNotice(result);
    void Share.share({ message: result.body, title: result.title })
      .then(() => toast({ kind: "success", message: notice }))
      // A failed share is a RESULT, not a question: the toast lane, not an OS
      // dialog that costs a tap to dismiss.
      .catch(() =>
        toast({ kind: "error", message: "Couldn't open the share sheet." }),
      );
  };

  return (
    <Pressable
      onPress={onExport}
      accessibilityRole="button"
      accessibilityLabel={`Export ${rows} analytics row${rows === 1 ? "" : "s"} for ${rangeLabel} as CSV`}
      accessibilityHint={
        unavailable.length > 0
          ? `${unavailable.join(", ")} could not be read and will be named as missing in the file.`
          : "Opens the share sheet with a CSV of the numbers on this screen."
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
        // `control`: this shares the header row with the title and subtitle,
        // neither of which can reflow around it.
        {...typeCap("control")}
        style={{
          color: t.accent,
          fontFamily: FONT.semibold,
          ...typeStyle("control"),
        }}
      >
        Export
      </Text>
    </Pressable>
  );
}
