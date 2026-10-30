/**
 * The profile's identity card: avatar, name, email, status, joined and last
 * active, plus the engagement gauge.
 *
 * Split out of SubscriberDetailSections.tsx, which had grown into a
 * 17-prop grab-bag that every new profile section made worse.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { Avatar } from "@/components/subscriber/Avatar";
import { SubscriberLifecyclePill } from "@/components/subscriber/sections/SubscriberLifecyclePill";
import { EngagementGauge } from "@/components/subscriber/EngagementGauge";
import { Card } from "@/components/subscriber/SubscriberDetailPrimitives";
import { FONT } from "@/lib/fonts";
import { date as fmtDate, relativeTime } from "@/lib/format";
import {
  subscriberPrimaryLabel,
  subscriberSecondaryLabel,
  type SubscriberIdentityFields,
} from "@/lib/subscriberIdentity";
import {
  subscriberStatusLabel,
  subscriberStatusTone,
} from "@/lib/subscriberStatus";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberHeaderCard({
  subscriberId,
  subscriber,
  status,
  joinedAt,
  lastActiveAt,
  engagementScore,
  onCopyEmail,
  onShareEmail,
}: {
  subscriberId: string;
  subscriber: SubscriberIdentityFields;
  /** Engine status (from the timeline stats when present, else the row). */
  status: string | undefined;
  joinedAt: string | null | undefined;
  lastActiveAt: string | null | undefined;
  /** null renders no gauge at all rather than a misleading zero. */
  engagementScore: number | null;
  /** Primary tap on the address. */
  onCopyEmail: () => void;
  /** Long press on the address. */
  onShareEmail: () => void;
}) {
  const { t } = useTheme();
  const name = subscriberPrimaryLabel(subscriber);
  const secondary = subscriberSecondaryLabel(subscriber);
  const joined = fmtDate(joinedAt, "");
  const lastActive = relativeTime(lastActiveAt, { fallback: "" });

  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Avatar subscriber={subscriber} size={40} />
            <View style={{ flex: 1 }}>
              <Text
                {...typeCap("heading")}
                style={{
                  color: t.fg,
                  ...typeStyle("heading"),
                  fontWeight: "600",
                  fontFamily: FONT.semibold,
                }}
                numberOfLines={2}
              >
                {name}
              </Text>
              {secondary ? (
                // COPY is the primary tap; share moved to the long press.
                // Tapping an address to open a share sheet was a strange
                // default — the thing an operator does with an address on a
                // support call is paste it somewhere, and the affordance was
                // discoverable only through its accessibility label.
                <Pressable
                  onPress={onCopyEmail}
                  onLongPress={onShareEmail}
                  delayLongPress={350}
                  accessibilityRole="button"
                  accessibilityLabel={`Email address ${secondary}. Double tap to copy`}
                  accessibilityHint="Long press to share it instead"
                  accessibilityActions={[
                    { name: "copy", label: "Copy email address" },
                    { name: "share", label: "Share email address" },
                  ]}
                  onAccessibilityAction={(event) => {
                    if (event.nativeEvent.actionName === "share") onShareEmail();
                    else onCopyEmail();
                  }}
                  hitSlop={10}
                  // A declared floor: this is a one-line target inside a card
                  // whose padding is not a tap-target guarantee.
                  style={{ minHeight: 44, justifyContent: "center" }}
                >
                  <Text
                    {...typeCap("bodySmall")}
                    style={{
                      color: t.fgMuted,
                      ...typeStyle("bodySmall"),
                      fontFamily: FONT.regular,
                    }}
                    selectable
                    numberOfLines={1}
                  >
                    {secondary}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
          <View
            style={{
              marginTop: 8,
              flexDirection: "row",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 6,
            }}
          >
            {/* Human label, never the Postgres enum. */}
            <Pill
              label={subscriberStatusLabel(status)}
              tone={subscriberStatusTone(status)}
              size="md"
            />
            {/* Where this person sits in the funnel. Renders nothing when the
                gateway has no lifecycle route, so an older server degrades to
                the status pill alone rather than an error. */}
            <SubscriberLifecyclePill subscriberId={subscriberId} />
          </View>
          {joined ? (
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("label"),
                marginTop: 8,
                fontVariant: ["tabular-nums"],
                fontFamily: FONT.regular,
              }}
            >
              Subscribed {joined}
            </Text>
          ) : null}
          {lastActive ? (
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("label"),
                marginTop: 2,
                fontVariant: ["tabular-nums"],
                fontFamily: FONT.regular,
              }}
            >
              Last active {lastActive}
            </Text>
          ) : null}
        </View>
        {engagementScore == null ? null : (
          <EngagementGauge score={engagementScore} />
        )}
      </View>
    </Card>
  );
}
