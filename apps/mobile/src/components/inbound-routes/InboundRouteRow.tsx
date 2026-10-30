/**
 * InboundRouteRow — one routing rule, at a glance.
 *
 * WHAT LEADS. The rule's name and whether it is LIVE, in that order. A disabled
 * rule matches nothing from the moment it is switched off while keeping every
 * match it ever made (`MatchRoutes` filters `enabled = true`,
 * routes.go:96-104), so a row that showed "120 matches" without the off state
 * would be the most misleading thing on the screen.
 *
 * THE COUNT IS LIFETIME AND SAYS SO. `match_count` lives on `inbound_routes`
 * and is not the length of anything this screen fetched.
 *
 * State is never colour alone: live/off is a labelled Pill AND the row's spoken
 * label opens with the same word.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { dateTime, num, plural, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import type { InboundRoute } from "@/lib/inboundRoutes";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** The matcher, spelled the way the operator wrote it. */
function matcherLine(route: InboundRoute): string {
  return [
    route.matchRecipient ? `to ${route.matchRecipient}` : "",
    route.matchSubjectPrefix ? `subject "${route.matchSubjectPrefix}…"` : "",
    route.matchFromDomain ? `from ${route.matchFromDomain}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function InboundRouteRow({
  route,
  selected,
  onSelect,
}: {
  route: InboundRoute;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useTheme();
  const last = relativeTime(route.lastMatchedAt, { fallback: "" });
  const absolute = dateTime(route.lastMatchedAt, "");
  const actions = route.actions.length;

  return (
    <Pressable
      onPress={() => onSelect(route.id)}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={[
        route.enabled ? "Live." : "Switched off.",
        `${route.name || "Unnamed rule"}.`,
        matcherLine(route) ? `Matches ${matcherLine(route)}.` : "Matches everything.",
        `${plural(actions, "action")}.`,
        route.matchCount > 0
          ? `${plural(route.matchCount, "lifetime match", "lifetime matches")}.`
          : "It has never matched.",
        absolute ? `Last matched ${absolute}.` : "",
        route.stopOnMatch ? "Stops later rules when it matches." : "",
        selected ? "Showing its matches." : "Show its matches.",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        backgroundColor: t.surface,
        borderColor: selected ? t.accent : t.borderSubtle,
        borderWidth: selected ? 2 : 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
        minHeight: 44,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
            numberOfLines={1}
          >
            {route.name || "Unnamed rule"}
          </Text>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              marginTop: 2,
              fontFamily: FONT.regular,
            }}
            numberOfLines={1}
          >
            {matcherLine(route) || "matches everything"}
          </Text>
        </View>
        <Pill
          label={route.enabled ? "live" : "off"}
          tone={route.enabled ? "success" : "neutral"}
        />
      </View>

      <View
        // Hidden from assistive tech: the row's own label already speaks every
        // figure below in full, and a second stop would repeat them compacted.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          marginTop: 10,
          flexWrap: "wrap",
        }}
      >
        <Meta
          text={
            route.matchCount > 0
              ? `${num(route.matchCount)} lifetime`
              : "never matched"
          }
        />
        <Meta text={plural(actions, "action")} />
        {last ? <Meta text={`last ${last}`} /> : null}
        {route.stopOnMatch ? <Pill label="stops here" tone="info" /> : null}
      </View>
    </Pressable>
  );
}

function Meta({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
      numberOfLines={1}
    >
      {text}
    </Text>
  );
}
