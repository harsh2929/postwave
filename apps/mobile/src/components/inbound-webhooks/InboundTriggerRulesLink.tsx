/**
 * InboundTriggerRulesLink — the per-endpoint way into its trigger rules.
 *
 * It sits directly under the endpoint card (components/webhooks/
 * InboundEndpointRow) as a slim attached row rather than inside it: the card
 * is shared with the events/enable/rotate levers and this affordance is the
 * only one that opens a SECOND sheet. Keeping it visually attached (negative
 * top margin, matching border) says "this belongs to that endpoint" without
 * a fourth button in an already-wrapping button row.
 *
 * Generic over the endpoint type so the screen can hand it a state setter
 * directly (`onPress={setOpenTriggers}`) instead of a fresh closure per row —
 * the same shape as InboundEndpointRow's `onOpenEvents`.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { forwardArrow } from "@/lib/direction";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface EndpointRef {
  id: string;
  name: string;
  slug: string;
}

export interface InboundTriggerRulesLinkProps<T extends EndpointRef> {
  endpoint: T;
  onPress: (endpoint: T) => void;
}

export function InboundTriggerRulesLink<T extends EndpointRef>({
  endpoint,
  onPress,
}: InboundTriggerRulesLinkProps<T>) {
  const { t } = useTheme();
  const label = endpoint.name || endpoint.slug;
  return (
    <Pressable
      onPress={() => onPress(endpoint)}
      accessibilityRole="button"
      accessibilityLabel={`Manage the trigger rules for ${label}`}
      accessibilityHint="Opens the rules that act on events reaching this endpoint: pause, edit, delete or add one."
      style={{
        marginTop: -4,
        marginBottom: 12,
        marginHorizontal: 8,
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
        borderWidth: 1,
        borderTopWidth: 0,
        borderColor: t.borderSubtle,
        backgroundColor: t.bgSubtle,
        paddingHorizontal: 12,
        paddingVertical: 10,
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <View style={{ flexShrink: 1 }}>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fg,
            ...typeStyle("label"),
            fontFamily: FONT.semibold,
          }}
        >
          Trigger rules
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 1,
          }}
          numberOfLines={1}
        >
          What a matching event enrolls, tags or starts
        </Text>
      </View>
      <Text
        {...typeCap("label")}
        style={{
          color: t.accent,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        {forwardArrow()}
      </Text>
    </Pressable>
  );
}
