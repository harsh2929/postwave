/**
 * OrderRow — one ingested order.
 *
 * NOT a Pressable. Every commerce detail route below an order
 * (`/{id}/products/{product_id}/…`) is admin-scoped and none of them is an
 * ORDER detail — `GET /api/v1/commerce/integrations/{id}/orders` is the only
 * order read the API has (commerce/handlers.go:164). A row that looked
 * tappable and did nothing would be worse than a row that plainly isn't, so
 * this is a labelled static element that VoiceOver reads as one fact.
 *
 * Money is per-ORDER currency (`Order.Currency`, types.go:606) — two rows in
 * one page can legitimately disagree, so each row formats with its own.
 *
 * NativeWind v4: static style objects only.
 */
import { Text, View } from "react-native";

import { Pill, type PillTone } from "@/components/Pill";
import type { CommerceOrderClass, CommerceOrderLine } from "@/lib/commerceOrders";
import { centsToMajor } from "@/lib/commerceRollup";
import { dateTime, money, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * Tone is decoration on top of the word, never instead of it: the status text
 * is always rendered inside the Pill, so a colour-blind reader and a
 * screen-reader user both get the same fact the colour carries.
 */
function toneFor(statusClass: CommerceOrderClass): PillTone {
  if (statusClass === "paid") return "success";
  if (statusClass === "refunded") return "warning";
  if (statusClass === "cancelled") return "danger";
  return "neutral";
}

export function OrderRow({ order }: { order: CommerceOrderLine }) {
  const { t } = useTheme();
  const total = money(centsToMajor(order.totalCents), order.currency, {
    cents: true,
  });
  const rel = relativeTime(order.orderedAt, { fallback: "" });
  const abs = dateTime(order.orderedAt, "");
  const who = order.customerEmail || "no email on the order";
  const status = order.status || "status not reported";

  return (
    <View
      accessible
      // The visible row compacts three things into two lines. The label
      // re-states all of them, and uses the ABSOLUTE timestamp because
      // "2 days ago" is not something a support conversation can act on.
      accessibilityLabel={`Order ${order.reference}, ${total}, ${status}. ${who}.${
        abs ? ` Ordered ${abs}.` : " No order date recorded."
      }${order.campaignId ? " Attributed to a campaign." : ""}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 10,
        borderTopWidth: 1,
        borderTopColor: t.borderSubtle,
        minHeight: 44,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text
          {...typeCap("body")}
          numberOfLines={1}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
          }}
        >
          {order.customerEmail || `Order ${order.reference}`}
        </Text>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            marginTop: 3,
            flexWrap: "wrap",
          }}
        >
          <Pill label={status} tone={toneFor(order.statusClass)} />
          {order.campaignId ? <Pill label="campaign" tone="info" /> : null}
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              flexShrink: 1,
            }}
          >
            {rel ? `#${order.reference} · ${rel}` : `#${order.reference}`}
          </Text>
        </View>
      </View>
      <Text
        {...typeCap("numeric")}
        numberOfLines={1}
        style={{
          color: t.fg,
          ...typeStyle("numeric"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
          fontVariant: ["tabular-nums"],
        }}
      >
        {total}
      </Text>
    </View>
  );
}
