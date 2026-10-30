/**
 * AuditListParts — the day divider and the end-of-list footer for the audit
 * feed.
 *
 * Split out of the screen so the route file stays readable now that it also
 * carries the export affordance. Both are pure presentation over props; the
 * grouping decision that produces a day header lives in lib/auditGrouping,
 * which is node-testable.
 */
import { Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * One calendar day's divider.
 *
 * `accessibilityRole="header"` is load-bearing: it is what puts the day into
 * VoiceOver's rotor, so a hundred-row log can be traversed a day at a time
 * instead of an event at a time.
 */
export function AuditDayHeader({
  label,
  count,
}: {
  label: string;
  count: number;
}) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={`${label}, ${count} ${count === 1 ? "event" : "events"}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingTop: 10,
        paddingBottom: 6,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          fontWeight: "700",
          fontFamily: FONT.bold,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          ...typeStyle("caption"),
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("numeric")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
          ...typeStyle("numeric"),
        }}
      >
        {count}
      </Text>
    </View>
  );
}

/**
 * The paging footer. Four states, in the order that keeps them honest: nothing
 * loaded (say nothing), fetching (skeleton), failed (retry — never a silent
 * end of history), more available (say nothing, the list will grow), exhausted
 * (say so, so a short window is not mistaken for a truncated one).
 */
export function AuditListFooter({
  fetching,
  hasMore,
  loaded,
  error,
  onRetry,
}: {
  fetching: boolean;
  hasMore: boolean;
  loaded: number;
  error: boolean;
  onRetry: () => void;
}) {
  const { t } = useTheme();
  if (loaded === 0) return null;
  if (fetching) return <SkeletonList rows={2} />;
  if (error) {
    return (
      <ErrorState
        compact
        message="Couldn't load older events."
        onRetry={onRetry}
      />
    );
  }
  if (hasMore) return null;
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        textAlign: "center",
        marginTop: 12,
        fontFamily: FONT.regular,
        ...typeStyle("caption"),
      }}
    >
      End of the log for this window.
    </Text>
  );
}
