/**
 * StoreAnalyticsCard — the four numbers a store owner checks on a phone.
 *
 * Revenue and average order value come off the wire in INTEGER CENTS with a
 * per-integration currency (`Analytics.RevenueCents` / `.Currency`,
 * apps/api/internal/commerce/types.go:687-696). Both go through `money()` with
 * that currency, so a EUR store reads in euros here exactly as it does
 * everywhere else in the product — the hard-coded `"$" + toFixed(2)` this
 * avoids was a real bug on the agency screen.
 *
 * Compacted figures always ship an exact spoken value beside them: "1.3k
 * orders" is a shape, not a quantity anyone can act on.
 *
 * ABSENCE IS NOT ZERO — the average is the one figure here that can be missing.
 * `Repo.Analytics` only assigns `AverageOrderCents` inside `if out.Orders > 0`
 * (apps/api/internal/commerce/repo.go:2588-2590), so a store with no orders
 * sends a plain `0` that means "never computed", not "zero currency". Every
 * OTHER figure on this card is a genuine `count(*)` and a 0 there is a real
 * measurement, which is why only this one routes through
 * `averageOrderCentsOrNull` and falls back to an em-dash.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { averageOrderCentsOrNull } from "@/lib/commerceOrders";
import { centsToMajor, type CommerceAnalytics } from "@/lib/commerceRollup";
import { compactNum, dateTime, EMDASH, money, num, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function StoreAnalyticsCard({
  analytics,
}: {
  analytics: CommerceAnalytics;
}) {
  const { t } = useTheme();
  const revenue = money(centsToMajor(analytics.revenueCents), analytics.currency);
  const aovCents = averageOrderCentsOrNull(analytics);
  const aov =
    aovCents === null
      ? EMDASH
      : money(centsToMajor(aovCents), analytics.currency);
  const lastOrderRel = relativeTime(analytics.lastOrderAt, { fallback: "" });
  const lastOrderAbs = dateTime(analytics.lastOrderAt, "");

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Figure label="Revenue" value={revenue} />
        <Figure
          label="Orders"
          value={compactNum(analytics.orders)}
          exact={num(analytics.orders)}
        />
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {/* An em-dash is unreadable aloud, so the spoken form says WHY the
            figure is missing rather than announcing a stray punctuation mark. */}
        <Figure
          label="Avg order"
          value={aov}
          {...(aovCents === null
            ? { exact: "No average yet — no orders ingested," }
            : {})}
        />
        <Figure
          label="Customers"
          value={compactNum(analytics.customers)}
          exact={num(analytics.customers)}
        />
      </View>

      {analytics.ordersByStatus.length > 0 ? (
        <View
          accessible
          accessibilityLabel={`Orders by status: ${analytics.ordersByStatus
            .map((row) => `${num(row.count)} ${row.status}`)
            .join(", ")}.`}
          style={{
            flexDirection: "row",
            gap: 6,
            flexWrap: "wrap",
            marginTop: 2,
          }}
        >
          {analytics.ordersByStatus.map((row) => (
            <Pill
              key={row.status}
              label={`${row.status} ${num(row.count)}`}
              tone="neutral"
            />
          ))}
        </View>
      ) : null}

      <Text
        {...typeCap("caption")}
        accessibilityLabel={
          lastOrderAbs
            ? `Last order ${lastOrderAbs}. ${num(analytics.products)} products in the catalogue.`
            : `No orders ingested yet. ${num(analytics.products)} products in the catalogue.`
        }
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {lastOrderRel
          ? `Last order ${lastOrderRel} · ${num(analytics.products)} products`
          : `No orders ingested yet · ${num(analytics.products)} products`}
      </Text>
    </View>
  );
}

/**
 * One figure. Grouped as a single accessible element so VoiceOver reads
 * "1,284 orders" as one fact, and `exact` carries the un-abbreviated number
 * behind any compacted display value.
 */
function Figure({
  label,
  value,
  exact,
}: {
  label: string;
  value: string;
  exact?: string | undefined;
}) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${exact ?? value} ${label}`}
      style={{
        flex: 1,
        backgroundColor: t.bgSubtle,
        borderRadius: 10,
        padding: 12,
      }}
    >
      {/* `figure` is the stat-hero role and takes the scale's tightest ceiling;
          the 18pt size is kept because these are half-width tiles holding a
          currency string, not a full-width dashboard numeral. */}
      <Text
        {...typeCap("figure")}
        numberOfLines={1}
        style={{
          color: t.fg,
          fontSize: 18,
          lineHeight: 22,
          fontWeight: "700",
          fontFamily: FONT.bold,
          fontVariant: ["tabular-nums"],
        }}
      >
        {value}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginTop: 2,
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
