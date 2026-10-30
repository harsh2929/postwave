/**
 * LandingLeadRow — one captured lead.
 *
 * A lead is a `growth_surface_events` row with `event_type = 'conversion'`:
 * an address, an instant, and whatever arbitrary JSON the public form posted
 * as `metadata` (`PublicLandingConvert` passes `body.Metadata` straight
 * through, so there is NO fixed schema to lay out). `leadDetails` renders the
 * pairs that are actually there, bounded in both count and length — inventing
 * field names would be inventing data, and an unbounded hostile payload would
 * blow the row's height out.
 *
 * The address can legitimately be empty (`COALESCE(email, '')`), and an empty
 * string must never render as a blank line pretending to be an address —
 * `leadDisplayEmail` gives it words.
 */
import { memo } from "react";
import { Text, useWindowDimensions, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { dateTime, EMDASH, relativeTime } from "@/lib/format";
import { leadDetails, leadDisplayEmail, type MobileLead } from "@/lib/landingPages";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface LandingLeadRowProps {
  lead: MobileLead;
  now: number;
}

function LandingLeadRowImpl({ lead, now }: LandingLeadRowProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const details = leadDetails(lead);
  const email = leadDisplayEmail(lead);
  const when = lead.at ? relativeTime(lead.at, { now }) : EMDASH;
  const whenSpoken = lead.at
    ? `Captured ${dateTime(lead.at)}`
    : "No capture time was recorded";

  return (
    <View
      accessible
      accessibilityLabel={`${
        lead.email ? lead.email : "No address was captured"
      }. ${whenSpoken}.${
        details.length
          ? ` ${details.map((d) => `${d.key}: ${d.value}`).join(". ")}.`
          : ""
      }`}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 4,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <Text
          numberOfLines={maxLinesAtScale(1, fontScale)}
          {...typeCap("bodySmall")}
          style={{
            color: lead.email ? t.fg : t.fgSubtle,
            ...typeStyle("bodySmall"),
            fontFamily: lead.email ? FONT.medium : FONT.regular,
            flexShrink: 1,
          }}
        >
          {email}
        </Text>
        <Text
          {...typeCap("numeric")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("numeric"),
            fontFamily: FONT.regular,
          }}
        >
          {when}
        </Text>
      </View>

      {details.map((detail) => (
        <Text
          key={detail.key}
          numberOfLines={maxLinesAtScale(1, fontScale)}
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {detail.key}: {detail.value}
        </Text>
      ))}
    </View>
  );
}

export const LandingLeadRow = memo(LandingLeadRowImpl);
