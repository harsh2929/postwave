/**
 * RecoveryRow — one shopper waiting on one promise.
 *
 * Split from `StoreRecoverySection` for the same reason `OrderRow` is split
 * from `StoreOrdersSection`: the row is where the honesty rules live, and they
 * are easier to hold in one head when the list mechanics are somewhere else.
 *
 * THREE RULES THIS ROW ENFORCES.
 *
 *  1. STATE IS NEVER COLOUR-ALONE. The pill carries the server's own word, so
 *     "eligible" is readable with the colour channel removed entirely.
 *
 *  2. AN ANONYMOUS ROW SAYS SO. `customer_email` / `subscriber_email` are both
 *     nullable — a cart-recovery link can be created for a cart with no
 *     identified shopper, and the back-in-stock table's CHECK only requires
 *     ONE of subscriber_id/subscriber_email
 *     (0199_klaviyo_commerce_lifecycle_foundation.sql:386). A row whose email
 *     is absent is shown as "No email on the request", never as a blank line
 *     that reads like a rendering bug.
 *
 *  3. A PRICE TARGET IS ONLY SHOWN WHEN ONE WAS SET. The watcher table's CHECK
 *     requires target_price_cents OR min_drop_percent, not both (:447), so
 *     exactly one of the two lines below is normally present. Rendering a
 *     missing target as "$0.00" would state a threshold nobody chose.
 *
 * NativeWind v4: static style objects only.
 */
import { Text, View } from "react-native";

import { Pill, type PillTone } from "@/components/Pill";
import type { RecoveryLine, RecoveryStatusClass } from "@/lib/commerceRecovery";
import { centsToMajor } from "@/lib/commerceRollup";
import { EMDASH, money, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * `eligible` is the only warning tone on this surface, and that is the point:
 * it is the one state that represents work the product owes a shopper.
 * `notified` and `converted` are both outcomes, so both read as success.
 */
const TONE: Record<RecoveryStatusClass, PillTone> = {
  open: "neutral",
  eligible: "warning",
  notified: "success",
  converted: "success",
  closed: "neutral",
  other: "info",
};

export function RecoveryRow({ row }: { row: RecoveryLine }) {
  const { t } = useTheme();
  const subject = row.subject || "No email on the request";
  const threshold = thresholdLine(row);
  // The clock that matters differs by state. For an eligible row it is "how
  // long have we owed this person"; for anything else it is "how long has this
  // existed" — showing the wrong one turns a three-day breach into a
  // three-day-old signup.
  const stamp =
    row.statusClass === "eligible" && row.eligibleAt
      ? `Eligible ${relativeTime(row.eligibleAt)}`
      : row.notifiedAt
        ? `Told ${relativeTime(row.notifiedAt)}`
        : row.startedAt
          ? `Started ${relativeTime(row.startedAt)}`
          : EMDASH;

  return (
    <View
      accessible
      accessibilityLabel={[
        subject,
        `status ${row.status || "unknown"}`,
        row.reference ? `reference ${row.reference}` : "",
        threshold,
        stamp,
      ]
        .filter(Boolean)
        .join(". ")}
      style={{
        paddingVertical: 12,
        borderBottomColor: t.borderSubtle,
        borderBottomWidth: 1,
        gap: 4,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          numberOfLines={1}
          {...typeCap("body")}
          style={{
            color: row.subject ? t.fg : t.fgSubtle,
            ...typeStyle("body"),
            fontFamily: FONT.medium,
            flexShrink: 1,
          }}
        >
          {subject}
        </Text>
        <Pill
          label={row.status || "unknown"}
          tone={TONE[row.statusClass]}
          accessibilityLabel={`Status: ${row.status || "unknown"}`}
        />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {[row.reference, threshold, stamp].filter(Boolean).join(" · ")}
      </Text>
    </View>
  );
}

/**
 * The watcher's threshold, or "" when the row is not a watcher.
 *
 * `money` is given `cents: true` so a €19.00 target does not render as "€19"
 * next to an original price that kept its decimals — the same money spelled
 * two ways reads as two different numbers.
 */
function thresholdLine(row: RecoveryLine): string {
  if (row.kind !== "price-drops") return "";
  const currency = row.currency || "USD";
  if (row.targetPriceCents !== null) {
    return `Target ${money(centsToMajor(row.targetPriceCents), currency, { cents: true })}`;
  }
  if (row.minDropPercent !== null) {
    return `Wants ${row.minDropPercent}% off`;
  }
  return "";
}
