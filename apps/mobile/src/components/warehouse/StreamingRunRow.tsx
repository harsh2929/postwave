/**
 * StreamingRunRow — one shipped (or unshipped) streaming-export window.
 *
 * WHAT LEADS. The window's end time and the OUTCOME: an operator scanning the
 * list wants the one red word and the hour it belongs to. The cursor range is
 * the second line because it is what "caught up" is measured in; on a window
 * that did not land it is replaced by the server's own admission that issue
 * evidence exists and is withheld (`sanitizeRun` blanks the message).
 *
 * WHY THERE IS NO PRESS. Unlike the batch `RunRow`, nothing opens from here:
 * the item route does not exist for streaming runs and the sanitized row IS
 * everything the phone will ever be told. A Pressable that opened nothing
 * would be a promise the screen cannot keep.
 *
 * State is never colour alone: the outcome is a labelled Pill AND the row's
 * spoken label starts with the same word.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { EMDASH, dateTime, duration } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import {
  streamingRunRowModel,
  type StreamingExportRun,
} from "@/lib/streamingExportRuns";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function StreamingRunRow({ run }: { run: StreamingExportRun }) {
  const { t } = useTheme();
  const row = streamingRunRowModel(run);
  const ends = dateTime(row.windowEnd, "");
  const took = row.durationMs === null ? "" : duration(row.durationMs);
  const failedLook = row.tone === "danger" || row.issueFlag;

  return (
    <View
      accessible
      accessibilityLabel={[
        `${row.status}.`,
        row.issueFlag ? "Issue recorded." : "",
        ends ? `Window ending ${ends}.` : "Window with no end time recorded.",
        `${row.detail}.`,
        `${row.shipped}.`,
        took ? `Took ${took}.` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        backgroundColor: t.surface,
        borderColor: failedLook ? t.danger : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
        minHeight: 44,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            flex: 1,
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
          numberOfLines={1}
        >
          {ends ? `Window ending ${ends}` : "Window with no end time"}
        </Text>
        <Pill label={row.status} tone={row.tone} />
        {row.issueFlag ? <Pill label="issue recorded" tone="warning" /> : null}
      </View>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: failedLook ? t.danger : t.fgMuted,
          ...typeStyle("bodySmall"),
          marginTop: 4,
          fontFamily: failedLook ? FONT.semibold : FONT.regular,
        }}
      >
        {row.detail}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 6,
          fontFamily: FONT.regular,
        }}
      >
        {[row.shipped, took ? `took ${took}` : `${EMDASH} no duration`].join(
          " · ",
        )}
      </Text>
    </View>
  );
}
