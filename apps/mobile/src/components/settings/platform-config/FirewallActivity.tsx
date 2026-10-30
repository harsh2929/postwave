/**
 * FirewallActivity — the signup firewall's counters and recent events: the
 * viewer-readable half of the firewall sheet (GET /firewall/stats and
 * /firewall/events are both viewer in routeauth/manifest.json).
 *
 * Split from FirewallAdminSheet by responsibility: that file is the settings
 * form and its two admin writes; this one only reads and renders for every
 * role. Rejected is the number an operator opened this for, so it leads.
 * Desktop anchor: components/settings/FirewallSection.tsx
 * (FirewallStatsCards, FirewallEventList) — the empty sentence is desktop's,
 * verbatim, and the action badge is the server's word, verbatim.
 */
import { Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { SheetGroup } from "@/components/settings/platform-config/PlatformConfigPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import {
  useFirewallEventsQuery,
  useFirewallStatsQuery,
} from "@/hooks/useFirewallAdmin";
import {
  firewallActionTone,
  firewallEventDetail,
  windowCountsLine,
  type FirewallActionTone,
  type FirewallEventView,
  type FirewallWindowCounts,
} from "@/lib/firewallAdmin";
import { FONT } from "@/lib/fonts";
import { dateTime } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Desktop's empty sentence, verbatim. */
export const NO_FIREWALL_EVENTS = "No firewall events recorded yet.";

export function FirewallActivity({ enabled }: { enabled: boolean }) {
  const stats = useFirewallStatsQuery(enabled);
  const events = useFirewallEventsQuery(enabled);
  return (
    <>
      <SheetGroup title="Signups">
        {stats.isLoading ? (
          <SkeletonList rows={1} lines={2} label="Loading firewall counts" />
        ) : stats.isError ? (
          <ErrorState
            compact
            error={stats.error}
            onRetry={() => void stats.refetch()}
          />
        ) : stats.data ? (
          <View style={{ flexDirection: "row", gap: 12 }}>
            <CountBlock label="Rejected (24h)" counts={stats.data.last24h} />
            <CountBlock label="Rejected (7d)" counts={stats.data.last7d} />
          </View>
        ) : null}
      </SheetGroup>
      <SheetGroup title="Recent events">
        {events.isLoading ? (
          <SkeletonList rows={3} lines={2} label="Loading firewall events" />
        ) : events.isError ? (
          <ErrorState
            compact
            error={events.error}
            onRetry={() => void events.refetch()}
          />
        ) : (
          <EventList
            events={Array.isArray(events.data) ? events.data : []}
          />
        )}
      </SheetGroup>
    </>
  );
}

function CountBlock({
  label,
  counts,
}: {
  label: string;
  counts: FirewallWindowCounts;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{ flex: 1 }}
      accessible
      accessibilityLabel={`${label}: ${counts.rejected}. ${windowCountsLine(counts)}`}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("title")}
        style={{
          color: counts.rejected > 0 ? t.danger : t.fg,
          ...typeStyle("title"),
          fontFamily: FONT.bold,
        }}
      >
        {String(counts.rejected)}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {windowCountsLine(counts)}
      </Text>
    </View>
  );
}

function pillColor(tone: FirewallActionTone, t: ReturnType<typeof useTheme>["t"]) {
  switch (tone) {
    case "danger":
      return t.danger;
    case "warning":
      return t.warning;
    case "success":
      return t.success;
    default:
      return t.fgMuted;
  }
}

function EventList({ events }: { events: FirewallEventView[] }) {
  const { t } = useTheme();
  if (events.length === 0) {
    return (
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {NO_FIREWALL_EVENTS}
      </Text>
    );
  }
  return (
    <View>
      {events.map((event, index) => {
        const color = pillColor(firewallActionTone(event.action), t);
        return (
          <View
            key={event.id}
            accessible
            accessibilityLabel={`${event.action || "event"}, ${firewallEventDetail(event)}, ${dateTime(event.at)}`}
            style={{
              paddingVertical: 8,
              gap: 2,
              borderTopWidth: index === 0 ? 0 : 1,
              borderTopColor: t.borderSubtle,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View
                style={{
                  borderRadius: 999,
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                  borderWidth: 1,
                  borderColor: color,
                }}
              >
                <Text
                  {...typeCap("caption")}
                  style={{
                    color,
                    ...typeStyle("caption"),
                    fontFamily: FONT.semibold,
                  }}
                >
                  {event.action || "event"}
                </Text>
              </View>
              <Text
                {...typeCap("bodySmall")}
                numberOfLines={1}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                  flex: 1,
                }}
              >
                {firewallEventDetail(event)}
              </Text>
            </View>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {dateTime(event.at)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
