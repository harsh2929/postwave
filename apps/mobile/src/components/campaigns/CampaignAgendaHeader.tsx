/**
 * CampaignAgendaHeader — the day divider in the scheduled-sends agenda.
 *
 * Presentation only. The grouping, the ordering and the today/tomorrow
 * decision are all in lib/campaignAgenda, which is import-free and tested;
 * this component owns exactly one thing the pure module cannot: turning a
 * timestamp into a date in the user's locale, via lib/format.
 *
 * "Overdue" is carried by the WORD, with colour as reinforcement. A section of
 * sends that should already have gone out is the most urgent thing this screen
 * can say, and saying it only in red would say it to nobody using a
 * high-contrast or monochrome display.
 */
import { Text, View } from "react-native";

import type { AgendaEntry } from "@/lib/campaignAgenda";
import { FONT } from "@/lib/fonts";
import { date, plural } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

type HeaderEntry = Extract<AgendaEntry<unknown>, { kind: "header" }>;

export function CampaignAgendaHeader({ entry }: { entry: HeaderEntry }) {
  const { t } = useTheme();
  const overdue = entry.specialTitle === "Overdue";

  const title = entry.specialTitle
    ? entry.specialTitle
    : entry.relativeDay === "today"
      ? "Today"
      : entry.relativeDay === "tomorrow"
        ? "Tomorrow"
        : entry.dayStart != null
          ? date(entry.dayStart)
          : "Scheduled";

  // The relative word alone loses the date; the date alone loses the urgency.
  // Both, on one line, at the smallest prose step.
  const dateSuffix =
    entry.specialTitle == null &&
    entry.relativeDay != null &&
    entry.dayStart != null
      ? date(entry.dayStart)
      : null;

  return (
    <View
      accessibilityRole="header"
      accessible
      accessibilityLabel={`${title}${dateSuffix ? `, ${dateSuffix}` : ""}, ${plural(
        entry.count,
        "campaign",
      )}${overdue ? ". These were due to send and have not." : ""}`}
      style={{
        flexDirection: "row",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 10,
        marginTop: 14,
        marginBottom: 6,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, flex: 1 }}>
        <Text
          {...typeCap("caption")}
          style={{
            color: overdue ? t.danger : t.fgMuted,
            ...typeStyle("caption"),
            letterSpacing: 0.6,
            textTransform: "uppercase",
            fontFamily: FONT.semibold,
          }}
        >
          {overdue ? "⚠ " : ""}
          {title}
        </Text>
        {dateSuffix ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {dateSuffix}
          </Text>
        ) : null}
      </View>
      <Text
        {...typeCap("numeric")}
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={{
          color: t.fgSubtle,
          ...typeStyle("numeric"),
          fontFamily: FONT.medium,
          fontVariant: ["tabular-nums"],
        }}
      >
        {entry.count}
      </Text>
    </View>
  );
}
