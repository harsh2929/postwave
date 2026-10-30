/**
 * ListInsightCards — the three per-list read cards that close desktop's
 * Analytics/Activity/Suppression-Forms-Automations tabs on mobile:
 *
 *   ListEngagementCard  how the list ENGAGES over the window (desktop
 *                       AnalyticsTab engagement breakdown)
 *   ListActivityCard    what just happened to the list (desktop ActivityTab)
 *   ListCrossRefsCard   which suppressions/forms/automations touch THIS
 *                       list, as linked count rows into the existing
 *                       workspace screens (desktop Suppression/Forms/
 *                       Automations tabs)
 *
 * All three are viewer reads; each card owns its query via the hooks in
 * hooks/useListInsights.ts and stays silent while its section is off-screen
 * (the screen passes `undefined` as the id). Errors render as errors — a
 * failed read is never an empty feed.
 */
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";

import { ErrorState } from "@/components/ErrorState";
import { Card, Label } from "@/components/subscriber/SubscriberDetailPrimitives";
import {
  useListActivity,
  useListCrossRefs,
  useListEngagement,
} from "@/hooks/useListInsights";
import { forwardChevron } from "@/lib/direction";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { listActivityKindLabel } from "@/lib/listInsightRows";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function Stat({ label, value }: { label: string; value: number }) {
  const { t } = useTheme();
  return (
    <View style={{ minWidth: 72 }}>
      <Text
        {...typeCap("title")}
        style={{ color: t.fg, ...typeStyle("title"), fontFamily: FONT.semibold }}
      >
        {value}
      </Text>
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
    </View>
  );
}

export function ListEngagementCard({ listId }: { listId: string | undefined }) {
  const { t } = useTheme();
  const engagement = useListEngagement(listId);

  if (engagement.isError) {
    return (
      <Card accessibilityLabel="Engagement" style={{ marginBottom: 12 }}>
        <Label>Engagement</Label>
        <ErrorState
          compact
          error={engagement.error}
          onRetry={() => void engagement.refetch()}
        />
      </Card>
    );
  }
  const data = engagement.data;
  return (
    <Card accessibilityLabel="Engagement" style={{ marginBottom: 12 }}>
      <Label>Engagement</Label>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 4,
        }}
      >
        {data
          ? `Events from current members over the last ${data.windowDays} days.`
          : "Loading…"}
      </Text>
      {data ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 16,
            marginTop: 12,
          }}
        >
          <Stat label="Opens" value={data.opens} />
          <Stat label="Clicks" value={data.clicks} />
          <Stat label="Unsubs" value={data.unsubs} />
          <Stat label="Complaints" value={data.complaints} />
          <Stat label="Bounces" value={data.bounces} />
        </View>
      ) : null}
    </Card>
  );
}

const ACTIVITY_SHOWN = 30;

export function ListActivityCard({ listId }: { listId: string | undefined }) {
  const { t } = useTheme();
  const activity = useListActivity(listId);

  if (activity.isError) {
    return (
      <Card accessibilityLabel="List activity" style={{ marginBottom: 12 }}>
        <Label>Activity</Label>
        <ErrorState
          compact
          error={activity.error}
          onRetry={() => void activity.refetch()}
        />
      </Card>
    );
  }
  const rows = Array.isArray(activity.data) ? activity.data : [];
  return (
    <Card accessibilityLabel="List activity" style={{ marginBottom: 12 }}>
      <Label>Activity</Label>
      {activity.isLoading ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            marginTop: 6,
          }}
        >
          Loading…
        </Text>
      ) : rows.length === 0 ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            marginTop: 6,
          }}
        >
          Nothing recorded for this list yet.
        </Text>
      ) : (
        rows.slice(0, ACTIVITY_SHOWN).map((event, i) => (
          <View
            key={`${event.at}-${event.email}-${i}`}
            style={{
              paddingVertical: 8,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: t.border,
            }}
          >
            <View
              style={{ flexDirection: "row", justifyContent: "space-between" }}
            >
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fg,
                  ...typeStyle("label"),
                  fontFamily: FONT.medium,
                  flexShrink: 1,
                }}
                numberOfLines={1}
              >
                {listActivityKindLabel(event.kind)}
                {event.email ? ` · ${event.email}` : ""}
              </Text>
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                  marginStart: 8,
                }}
              >
                {relativeTime(event.at, { fallback: "" })}
              </Text>
            </View>
            {event.detail ? (
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                }}
                numberOfLines={1}
              >
                {event.detail}
              </Text>
            ) : null}
          </View>
        ))
      )}
    </Card>
  );
}

export function ListCrossRefsCard({ listId }: { listId: string | undefined }) {
  const { t } = useTheme();
  const refs = useListCrossRefs(listId);

  if (refs.isError) {
    return (
      <Card accessibilityLabel="Connected to this list" style={{ marginBottom: 12 }}>
        <Label>Connected</Label>
        <ErrorState
          compact
          error={refs.error}
          onRetry={() => void refs.refetch()}
        />
      </Card>
    );
  }
  const data = refs.data;
  if (!data) {
    return (
      <Card accessibilityLabel="Connected to this list" style={{ marginBottom: 12 }}>
        <Label>Connected</Label>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            marginTop: 6,
          }}
        >
          Loading…
        </Text>
      </Card>
    );
  }

  const rows: { key: string; label: string; route: string }[] = [
    {
      key: "suppressions",
      label: `Suppressed members · ${data.suppressedTotal}`,
      route: "/(tabs)/suppressions",
    },
    {
      key: "forms",
      label: `Forms targeting this list · ${data.forms.length}`,
      route: "/(tabs)/forms",
    },
    {
      key: "automations",
      label: `Automations touching this list · ${data.automations.length}`,
      route: "/(tabs)/flows",
    },
  ];

  return (
    <Card accessibilityLabel="Connected to this list" style={{ marginBottom: 12 }}>
      <Label>Connected</Label>
      {rows.map((row, i) => (
        <Pressable
          key={row.key}
          onPress={() => router.push(row.route as never)}
          accessibilityRole="button"
          accessibilityLabel={row.label}
          style={{
            paddingVertical: 11,
            borderTopWidth: i === 0 ? 0 : 1,
            borderTopColor: t.border,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.fg,
              ...typeStyle("label"),
              fontFamily: FONT.medium,
              flexShrink: 1,
            }}
            numberOfLines={1}
          >
            {row.label}
          </Text>
          {/* The drill-in affordance. It comes from lib/direction so it points
            at the leading edge once the layout mirrors, and it is held out of
            the a11y tree because the Pressable's own label already says where
            the row goes. `allowFontScaling={false}` is right here for the same
            reason it is on every other chevron in the app: an affordance glyph
            that grows to 3x beside a capped label is a rendering bug, not an
            accommodation. */}
          <Text
            allowFontScaling={false}
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={{ color: t.fgSubtle, fontSize: 13, fontFamily: FONT.regular }}
          >
            {forwardChevron()}
          </Text>
        </Pressable>
      ))}
    </Card>
  );
}
