/**
 * CachedNotice — "you are reading a snapshot, captured N ago".
 *
 * `loadOfflineCapableSnapshot` returned cached values bare, so on the snapshot
 * path a screen rendered a SUCCESSFUL query (isError false, isFetching false)
 * and showed day-old rows as though they were current. An operator triaging a
 * complaint offline could read a stale suppression list — including a stale
 * "removed" state — and tell a customer something untrue.
 *
 * `StaleDataBanner` did not cover this: it is wired to `isError && rows.length`,
 * which the snapshot path never triggers.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { snapshotNotice } from "@/lib/deliverabilitySnapshots";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface CachedNoticeProps {
  backing: { fromSnapshot: boolean; capturedAt: number | null } | undefined;
  /** Ticking clock so "Cached 3h ago" does not freeze on a mounted screen. */
  now?: number | undefined;
}

export function CachedNotice({ backing, now }: CachedNoticeProps) {
  const { t } = useTheme();
  const message = snapshotNotice(backing, (capturedAt) =>
    relativeTime(capturedAt, now === undefined ? {} : { now }),
  );
  if (!message) return null;
  return (
    <View
      accessible
      accessibilityRole="alert"
      accessibilityLabel={message}
      style={{
        backgroundColor: t.bgSubtle,
        borderColor: t.border,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        marginBottom: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
      }}
    >
      {/* A glyph, not just a tint — colour alone is not a status. */}
      <Text
        allowFontScaling={false}
        importantForAccessibility="no"
        style={{ color: t.fgMuted, fontSize: 13, fontFamily: FONT.regular }}
      >
        ⧖
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          flex: 1,
        }}
      >
        {message}
      </Text>
    </View>
  );
}
