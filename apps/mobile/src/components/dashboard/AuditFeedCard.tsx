/**
 * AuditFeedCard — the dashboard's "What's happening" feed.
 *
 * Three changes from the version that lived inline in the route file:
 *
 *  - LOADING LOOKS LIKE CONTENT ARRIVING. It rendered the literal string
 *    "Loading activity…" while a purpose-built Skeleton component sat unused in
 *    the codebase. A bare sentence in a card reads as an error state.
 *  - RECENCY IS LEGIBLE. Timestamps were formatted `{month, day}`, so something
 *    four minutes old read identically to something from this morning — and a
 *    2024 event read as this January. `relativeTime` carries the recency and
 *    the accessibility label carries the exact instant.
 *  - KEYS ARE NAMESPACED. `key={String(e.id ?? i)}` mixed id-space with
 *    index-space: a row with id "3" plus an id-less row landing at index 3
 *    produced duplicate keys. Only the /audit fallback path can emit id-less
 *    rows, which is exactly the path this card falls back to.
 *  - A FAILED FETCH IS NOT AN EMPTY WORKSPACE. This is the whole reason
 *    `failed` exists, and it is not a defensive nicety: the dashboard handler
 *    ships `RecentAudit []DashboardAuditEvent json:"recent_audit,omitempty"`
 *    and DELIBERATELY leaves it empty ("audit actor/action data belongs behind
 *    the dedicated audit:read surface"), so omitempty drops the key on every
 *    response and the /audit fallback is this card's ONLY source in production.
 *    A 403 for a role without `audit:read`, or any 5xx, therefore rendered
 *    "No recent activity." on the app's landing screen — permanently, and for
 *    a whole class of user.
 */
import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { SkeletonList } from "@/components/Skeleton";
import type { DashboardAuditEvent } from "@/hooks/useDashboard";
import { FONT } from "@/lib/fonts";
import { dateTime, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Rows shown. The card is a glance, not the log — "View all" is the log. */
export const AUDIT_FEED_ROWS = 6;

export interface AuditFeedCardProps {
  events: readonly DashboardAuditEvent[] | undefined;
  loading: boolean;
  /** The feed's fetch failed. Error wins over empty — see the header. */
  failed?: boolean | undefined;
}

export function AuditFeedCard({ events, loading, failed }: AuditFeedCardProps) {
  const { t } = useTheme();
  // Array.isArray, not a nullish guard: `?? []` passes a truthy `{}` through to
  // `.slice`, which is not a function on an object — the same crash the two
  // sibling dashboard cards were hardened against.
  const rows = (Array.isArray(events) ? events : []).slice(0, AUDIT_FEED_ROWS);

  if (loading) {
    return <SkeletonList rows={3} lines={1} label="Loading recent activity" />;
  }

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        overflow: "hidden",
      }}
    >
      {rows.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: failed ? t.fgMuted : t.fgSubtle,
            ...typeStyle("bodySmall"),
            padding: 16,
            fontFamily: FONT.regular,
          }}
        >
          {failed
            ? "Recent activity couldn't be loaded, so this list is not the whole story. Open the audit log to retry."
            : "No recent activity."}
        </Text>
      ) : (
        rows.map((event, index) => (
          <AuditRow
            // Namespaced composite: an id-bearing row and an index-keyed one
            // can never collide.
            key={`${event.id ?? "idx"}:${index}`}
            event={event}
            first={index === 0}
          />
        ))
      )}
    </View>
  );
}

function AuditRow({
  event,
  first,
}: {
  event: DashboardAuditEvent;
  first: boolean;
}) {
  const { t } = useTheme();
  const actor = event.actor ?? "system";
  const what = event.description ?? event.action ?? "activity";
  const when = relativeTime(event.at);

  return (
    <Pressable
      // The card shows the six newest events; a row that cannot be followed is
      // a dead end on the app's landing screen, and the seventh event was
      // unreachable from here. Every row opens the full log.
      onPress={() => {
        haptics.tap();
        router.push("/(tabs)/audit");
      }}
      accessibilityRole="button"
      // One stop per row: VoiceOver reads "Ava sent a campaign, Mar 14, 2026 at
      // 4:05 PM. Open the audit log." rather than three fragments ending in a
      // bare date.
      accessibilityLabel={`${actor} ${what}, ${dateTime(event.at, "time unknown")}. Open the audit log.`}
      android_ripple={{ color: t.borderSubtle }}
      // NativeWind v4: static style object only.
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        paddingVertical: 12,
        paddingHorizontal: 14,
        minHeight: 44,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: t.borderSubtle,
      }}
    >
      <Text
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          flex: 1,
          fontFamily: FONT.regular,
        }}
        numberOfLines={1}
      >
        {/* Nested: no own size or leading — an explicit lineHeight inside a
            parent Text mis-centres the run on Android. The ceiling is
            inherited from the parent. */}
        <Text style={{ color: t.fgMuted, fontFamily: FONT.regular }}>
          {actor}
        </Text>{" "}
        {what}
      </Text>
      <Text
        {...typeCap("numeric")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("numeric"),
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
      >
        {when}
      </Text>
    </Pressable>
  );
}
