/**
 * CampaignRevenueRow — one campaign's attributed revenue.
 *
 * THREE THINGS THIS ROW REFUSES TO INVENT.
 *
 *  1. REVENUE PER SEND IS AN EM-DASH WHEN THE SERVER OMITTED IT.
 *     `revenue_per_send_cents` is a nil pointer whenever the campaign has no
 *     recorded `sent` events (attribution.go:257-263) — an honest "no
 *     denominator". Rendering 0 would say the campaign earned nothing per send
 *     when what happened is nobody counted its sends.
 *  2. THE ROLLED-UP TAIL IS LABELLED AS AN AGGREGATE. The server folds every
 *     campaign past the top 50 into one row called "(other campaigns)" with an
 *     empty campaign id (attribution.go:240-253). It is a sum across many
 *     campaigns, so its per-send figure is a blended ratio and the row says so
 *     rather than presenting it like a campaign's own performance.
 *  3. REVENUE AND CONVERSIONS ARE NOT DIVIDED. They have different
 *     denominators — see the module note in lib/conversionAttribution — so both
 *     appear as counts and no average order value is derived from them.
 *
 * The row is not pressable: there is no campaign-scoped conversion detail on
 * this device, and a tap that goes nowhere is worse than a row that never
 * offered one.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { centsToUnits } from "@/lib/attributionVerdict";
import type { AttributionItem } from "@/lib/conversionAttribution";
import { EMDASH, money, num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CampaignRevenueRow({
  item,
  currency,
}: {
  item: AttributionItem;
  currency: string;
}) {
  const { t } = useTheme();
  const code = currency || "USD";
  const revenue = money(centsToUnits(item.revenueCents), code, { cents: true });
  const perSend =
    item.revenuePerSendCents === null
      ? EMDASH
      : money(centsToUnits(item.revenuePerSendCents), code, { cents: true });
  const perSendSpoken =
    item.revenuePerSendCents === null
      ? "No revenue per send: this campaign has no recorded sends, so there is no denominator."
      : `${perSend} per send${item.isRollup ? ", blended across every campaign in this row" : ""}.`;
  const name = item.campaignName || "Unnamed campaign";

  return (
    <View
      accessible
      accessibilityLabel={[
        `${name}.`,
        item.isRollup
          ? "A sum of every campaign past the server's top 50, not a single campaign."
          : "",
        `${revenue} attributed in ${code}.`,
        `${plural(item.conversions, "conversion")} across every currency, including conversions with no monetary value.`,
        item.emailsSent > 0
          ? `${plural(item.emailsSent, "send")} recorded.`
          : "No sends recorded.",
        perSendSpoken,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
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
            numberOfLines={2}
          >
            {name}
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
            {plural(item.conversions, "conversion")}
            {item.emailsSent > 0 ? ` · ${plural(item.emailsSent, "send")}` : " · no sends recorded"}
          </Text>
        </View>
        <Text
          // Hidden from assistive tech: the row's label already speaks the
          // exact figure, and a second stop would repeat it.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          {...typeCap("numeric")}
          style={{
            color: t.fg,
            ...typeStyle("numeric"),
            fontVariant: ["tabular-nums"],
            fontFamily: FONT.semibold,
          }}
          numberOfLines={1}
        >
          {revenue}
        </Text>
      </View>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          marginTop: 10,
          flexWrap: "wrap",
        }}
      >
        {item.isRollup ? <Pill label="rolled-up total" tone="info" /> : null}
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {perSend === EMDASH ? `${EMDASH} per send` : `${perSend} per send`}
        </Text>
      </View>
    </View>
  );
}

/** Kept beside the row so the two stay in step if the shape changes. */
export function campaignRowKey(item: AttributionItem, index: number): string {
  if (item.isRollup) return "__rollup__";
  return item.campaignId || `${item.campaignName}-${num(index)}`;
}
