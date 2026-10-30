/**
 * TimelineEvent — one row in the subscriber-detail timeline.
 *
 * Each event is rendered with:
 *   - A small colored dot on the left rail.
 *   - The event type label (humanised) on the first line.
 *   - The campaign subject / detail body on the second line.
 *   - A right-aligned relative-time stamp.
 *
 * Unknown event types fall through to a neutral icon + "event" label —
 * lets the backend add types without crashing older mobile builds.
 */
import { memo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Link } from "expo-router";

import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import type { SubscriberTimelineEvent } from "@/api/mobileParity";

interface TimelineEventProps {
  event: SubscriberTimelineEvent;
  /** When true, hide the connector line above the dot (first row). */
  isFirst?: boolean;
  /** When true, hide the connector line below the dot (last row). */
  isLast?: boolean;
}

function humaniseType(type: string): {
  label: string;
  tone: "accent" | "success" | "warning" | "danger" | "info" | "neutral";
} {
  switch (type) {
    case "subscribe":
    case "subscribed":
      return { label: "Subscribed", tone: "success" };
    case "unsubscribe":
    case "unsubscribed":
      return { label: "Unsubscribed", tone: "warning" };
    case "campaign_sent":
    case "sent":
      return { label: "Email sent", tone: "info" };
    case "campaign_opened":
    case "opened":
      return { label: "Opened", tone: "accent" };
    case "campaign_clicked":
    case "clicked":
      return { label: "Clicked", tone: "accent" };
    case "bounce":
    case "bounced":
      return { label: "Bounced", tone: "danger" };
    case "reply":
    case "replied":
      return { label: "Replied", tone: "accent" };
    case "complaint":
      return { label: "Complaint", tone: "danger" };
    case "tagged":
    case "tag_added":
      return { label: "Tag added", tone: "info" };
    case "tag_removed":
      return { label: "Tag removed", tone: "neutral" };
    default:
      return { label: type.replace(/_/g, " "), tone: "neutral" };
  }
}

// Relative time comes from src/lib/format.ts. The local implementation this
// replaces started at MINUTES and had no negative guard, so a clock-skewed
// future timestamp rendered as "-3m ago" — and it disagreed with the header's
// "Last active" for the very same instant.

export const TimelineEvent = memo(function TimelineEvent({
  event,
  isFirst,
  isLast,
}: TimelineEventProps): ReactNode {
  const { t } = useTheme();
  const { label, tone } = humaniseType(event.type);
  const when = relativeTime(event.occurred_at);
  // VoiceOver used to hear "Opened 3h ago" with no idea WHICH email, even
  // though the subject is rendered visually right below.
  const spoken = [label, event.subject, when].filter(Boolean).join(", ");
  const campaignId = event.campaign_id;
  const dotColor =
    tone === "accent"
      ? t.accent
      : tone === "success"
        ? t.success
        : tone === "warning"
          ? t.warning
          : tone === "danger"
            ? t.danger
            : tone === "info"
              ? t.info
              : t.fgMuted;
  const body = (
    <View
      style={{ flexDirection: "row", gap: 12, paddingVertical: 6 }}
      accessibilityLabel={spoken}
    >
      {/* Rail with connector lines + dot. */}
      <View style={{ width: 14, alignItems: "center" }}>
        <View
          style={{
            width: 2,
            flex: 1,
            backgroundColor: isFirst ? "transparent" : t.borderSubtle,
            marginBottom: 4,
          }}
        />
        <View
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: dotColor,
          }}
        />
        <View
          style={{
            width: 2,
            flex: 1,
            backgroundColor: isLast ? "transparent" : t.borderSubtle,
            marginTop: 4,
          }}
        />
      </View>
      <View style={{ flex: 1, paddingBottom: 4 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "baseline",
            gap: 8,
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.fg,
              ...typeStyle("callout"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
              flex: 1,
            }}
          >
            {label}
          </Text>
          {/* `numeric`: the stamp is pinned to the right of the label's row
              and the exact instant is already in the row's spoken label. */}
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
        </View>
        {event.subject ? (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              marginTop: 2,
            }}
            numberOfLines={2}
          >
            {event.subject}
          </Text>
        ) : null}
      </View>
    </View>
  );

  // Follow the thread from a person's behaviour to the campaign that caused
  // it. Mobile already has a campaign detail screen, so this is one route
  // away; events without a campaign stay inert rather than offering a tap
  // target that goes nowhere.
  if (!campaignId) return body;
  return (
    <Link
      href={{ pathname: "/(tabs)/campaigns/[id]", params: { id: campaignId } }}
      asChild
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${spoken}. Open campaign`}
        // NativeWind v4: static style object only.
        style={{ borderRadius: 8 }}
      >
        {body}
      </Pressable>
    </Link>
  );
});
