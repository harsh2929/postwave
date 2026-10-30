/**
 * StoreOrdersSection — "and what actually came through the pipe".
 *
 * `StoreAnalyticsCard` above it answers the aggregate question ("3,120 orders,
 * €45,123"). That aggregate cannot tell you whether ingest is CURRENT: a store
 * whose backfill died last Tuesday still totals 3,120 orders forever. The
 * newest few rows are what distinguish "the numbers are big" from "the numbers
 * are still moving", which is the entire reason this surface exists on a phone.
 *
 * A PAGE IS A SAMPLE, NOT A TOTAL. `listCommerceOrders` reads page one only
 * (25 rows, api/commerce.ts:55) because `Repo.ListOrders` keyset-pages on
 * `(ordered_at DESC, id DESC)` (repo.go:2485) — so page one IS "most recent",
 * and the client must neither re-sort it nor present it as a count. Every
 * derived figure here therefore says the sample size out loud: the attribution
 * line reads "of the last 25", never "of all orders". `attributedSlice`
 * returns `sampled` precisely so this cannot be forgotten.
 *
 * MIXED CURRENCY IS A REAL CASE. `Order.Currency` is per-row (types.go:606),
 * so a sample can legitimately disagree with itself. `attributedSlice` reports
 * `currency: ""` for a mixed sample and this renders the COUNT without a money
 * figure rather than summing euros into dollars.
 *
 * NativeWind v4: static style objects only.
 */
import { Text, View } from "react-native";

import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { OrderRow } from "@/components/commerce/OrderRow";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { attributedSlice, type CommerceOrdersPage } from "@/lib/commerceOrders";
import { centsToMajor } from "@/lib/commerceRollup";
import { money, num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * The query is OWNED BY THE PARENT and passed in, rather than called here.
 *
 * That is not styling preference. The parent builds pull-to-refresh from the
 * `refetch` functions handed to `useManualRefresh`, so a query encapsulated in
 * this child is a query the gesture cannot reach — and the newest rows, which
 * are the entire reason this section exists, would be the one thing on screen
 * that a pull failed to update. The analytics card above is wired the same way
 * for the same reason.
 */
export function StoreOrdersSection({
  orders,
  gate,
}: {
  orders: QueryLike & { data?: CommerceOrdersPage | undefined };
  gate: Pick<OnlineQueryGate, "enabled">;
}) {
  const { t } = useTheme();
  const rows = Array.isArray(orders.data?.items) ? orders.data?.items : [];
  const slice = attributedSlice(rows);

  return (
    <View>
      <SectionLabel topMargin={24}>Recent orders</SectionLabel>
      <QueryStates
        query={orders}
        gate={gate}
        isEmpty={rows.length === 0}
        offlineMessage="Reconnect to read this store's recent orders."
        skeleton={<SkeletonList rows={4} lines={2} label="Loading orders" />}
        empty={{
          title: "No orders ingested",
          description:
            "Nothing has arrived from this store yet. If that is a surprise, check the sync cursor on the card above.",
        }}
      >
        <View
          style={{
            backgroundColor: t.surface,
            borderColor: t.borderSubtle,
            borderWidth: 1,
            borderRadius: 14,
            paddingHorizontal: 14,
            paddingBottom: 6,
          }}
        >
          {/* The sample disclosure sits ABOVE the rows, not below them, so it
              is read before the numbers rather than as a correction after. */}
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              paddingTop: 12,
              paddingBottom: 2,
            }}
          >
            {`The ${plural(rows.length, "most recent order")}${
              orders.data?.nextCursor ? " — older orders are on the web admin" : ""
            }`}
          </Text>
          {rows.map((order) => (
            <OrderRow key={order.id} order={order} />
          ))}
        </View>

        {slice.count > 0 ? <AttributionLine slice={slice} /> : null}
      </QueryStates>
    </View>
  );
}

/**
 * Campaign attribution WITHIN the fetched sample.
 *
 * Phrased as "N of the last M" every time. The revenue half is dropped
 * entirely when the sample mixes currencies (`slice.currency === ""`), because
 * a wrong total is worse than a missing one — and it counts only `paid` orders,
 * so a refund cannot credit a campaign for money that came back.
 */
function AttributionLine({
  slice,
}: {
  slice: ReturnType<typeof attributedSlice>;
}) {
  const { t } = useTheme();
  // `cents: true` so this total agrees with the rows it summarises. The
  // default drops a whole-unit ".00", which made a one-order slice read
  // "€125" directly beneath a row reading "€125.00" — the same money twice,
  // spelled two ways, which reads as two different numbers.
  const revenue =
    slice.currency && slice.revenueCents > 0
      ? money(centsToMajor(slice.revenueCents), slice.currency, { cents: true })
      : "";
  const sentence = revenue
    ? `${num(slice.count)} of the last ${num(slice.sampled)} orders came from a campaign, worth ${revenue} in paid orders.`
    : `${num(slice.count)} of the last ${num(slice.sampled)} orders came from a campaign.`;

  return (
    <Text
      accessible
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
        marginTop: 8,
      }}
    >
      {sentence}
    </Text>
  );
}
