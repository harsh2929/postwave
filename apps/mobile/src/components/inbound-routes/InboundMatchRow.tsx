/**
 * InboundMatchRow — one message this rule matched.
 *
 * WHAT LEADS. The subject, because that is what an operator recognises. The
 * recipient and sender follow, because a routing rule's whole job is to send
 * mail addressed one way somewhere in particular, and a match to the WRONG
 * recipient is the failure mode that a subject alone would hide.
 *
 * A MATCH IS NOT AN OUTCOME. Matching only records that the rule fired; whether
 * its actions ran is a separate table and a separate request. This row
 * therefore carries no success/failure state at all — inventing one from the
 * match would be the screen's easiest lie. Selecting the row is what asks.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { Pressable, Text } from "react-native";

import { transitionLabel } from "@/lib/direction";
import { dateTime, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import type { InboundRouteMatch } from "@/lib/inboundRoutes";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function InboundMatchRow({
  match,
  selected,
  onSelect,
}: {
  match: InboundRouteMatch;
  selected: boolean;
  onSelect: (id: number) => void;
}) {
  const { t } = useTheme();
  const when = relativeTime(match.matchedAt, { fallback: "" });
  const absolute = dateTime(match.matchedAt, "");
  const subject = match.subject || "(no subject)";

  return (
    <Pressable
      onPress={() => onSelect(match.id)}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={[
        `${subject}.`,
        match.fromEmail ? `From ${match.fromEmail}.` : "No sender recorded.",
        match.recipient ? `To ${match.recipient}.` : "No recipient recorded.",
        absolute ? `Matched ${absolute}.` : "No match time recorded.",
        selected ? "Showing what its actions did." : "Show what its actions did.",
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
        {subject}
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
        {/* `transitionLabel` rather than a literal arrow: sender-to-recipient
            is a direction, and a hardcoded "→" points the wrong way the moment
            the layout mirrors for an RTL locale. */}
        {transitionLabel(
          match.fromEmail || "unknown sender",
          match.recipient || "unknown recipient",
        )}
      </Text>
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 8,
          fontFamily: FONT.regular,
        }}
      >
        {when || "no match time"}
      </Text>
    </Pressable>
  );
}
