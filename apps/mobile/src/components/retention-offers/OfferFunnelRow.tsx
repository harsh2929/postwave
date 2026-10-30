/**
 * OfferFunnelRow — one tier's save offer, and what it has done.
 *
 * The desktop renders this as an eight-column table whose first cell is a raw
 * `paywall_tier_id` UUID. A phone cannot show eight columns and nobody can
 * read a UUID, so the row leads with the tier NAME (resolved from
 * `GET /api/v1/paywall/tiers`, same admin guard) and falls back to a
 * middle-truncated id when that read did not land — a missing name is a
 * cosmetic loss, not an error.
 *
 * THREE PLACES THIS ROW REFUSES TO INVENT A FACT:
 *  - `funnel === null` → every count is an em-dash. The funnel is a separate
 *    read from the catalogue and can fail on its own; zeros would be
 *    indistinguishable from an offer nobody has ever seen.
 *  - `shown === 0` → the acceptance rate is an em-dash, not 0%. The server
 *    only assigns `acceptance_rate` when `t.Shown > 0`, so the wire's 0 means
 *    "no denominator".
 *  - outcomes > shown → raw counters stay visible, but the rate is withheld
 *    and the conflict is named rather than turned into a percentage.
 *  - active + no `stripe_coupon_id` → said out loud without implying that the
 *    unmounted acceptance path could apply a discount.
 *
 * State is carried by WORDS ("Marked active" / "Marked inactive"), never by
 * tint alone and never as a runtime-availability claim.
 *
 * NativeWind v4: static style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { EMDASH, num, percent, truncateMiddle } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import {
  acceptanceRateOf,
  durationLabel,
  offerAmount,
  type RetentionOfferRow,
} from "@/lib/retentionOffers";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function OfferFunnelRow({
  row,
  onPress = null,
}: {
  row: RetentionOfferRow;
  /** Opens the reconciliation-evidence detail sheet. Null keeps the row inert. */
  onPress?: ((row: RetentionOfferRow) => void) | null;
}) {
  const { t } = useTheme();
  const { offer, funnel, tierName } = row;
  const amount = offerAmount(offer);
  const title = tierName ?? `Tier ${truncateMiddle(offer.tierId, 14)}`;
  const spokenTitle = tierName
    ? `${tierName} tier`
    : `Tier with no name on record, id ${offer.tierId}`;
  const rate = acceptanceRateOf(funnel);
  const outcomeConflict =
    funnel !== null &&
    funnel.accepted + funnel.declined + funnel.expired > funnel.shown;
  const unmirrored = offer.active && offer.couponId === "";

  const spokenCounts =
    funnel === null
      ? "Funnel counts unknown — they didn't load."
      : `${num(funnel.shown)} shown, ${num(funnel.accepted)} accepted, ${num(funnel.declined)} declined, ${num(funnel.expired)} expired.`;
  const spokenRate =
    funnel === null
      ? ""
      : outcomeConflict
        ? " Acceptance rate unavailable — recorded outcomes exceed showings."
        : rate === null
        ? " No acceptance rate yet — there is no recorded shown event."
        : ` Acceptance rate ${percent(rate)}.`;

  return (
    <Pressable
      accessible
      onPress={onPress ? () => onPress(row) : undefined}
      disabled={!onPress}
      {...(onPress
        ? {
            accessibilityRole: "button" as const,
            accessibilityHint:
              "Opens the reconciliation detail explaining whether these counters can be trusted.",
          }
        : {})}
      accessibilityLabel={`${spokenTitle}. ${amount.spoken}, for ${durationLabel(offer)}. ${
        offer.active
          ? "Marked active in stored configuration"
          : "Marked inactive in stored configuration"
      }.${unmirrored ? " No Stripe coupon on record; coupon application is unavailable and cannot be inferred." : ""} ${spokenCounts}${spokenRate}`}
      // NativeWind v4: static style object — never the function form.
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
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("callout")}
          numberOfLines={2}
          style={{
            flex: 1,
            color: t.fg,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {title}
        </Text>
        {/* The WORD carries the state; the tint is a second channel, never the
            only one. */}
        <Pill
          label={offer.active ? "Marked active" : "Marked inactive"}
          tone={offer.active ? "warning" : "neutral"}
        />
      </View>

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {amount.label} · {durationLabel(offer)}
      </Text>

      {offer.headline ? (
        <Text
          {...typeCap("caption")}
          numberOfLines={2}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontStyle: "italic",
            fontFamily: FONT.regular,
          }}
        >
          “{offer.headline}”
        </Text>
      ) : null}

      {unmirrored ? (
        <Pill
          label="No Stripe coupon on record"
          tone="warning"
          style={{ alignSelf: "flex-start" }}
        />
      ) : null}

      {outcomeConflict ? (
        <Pill
          label="Outcome-count conflict"
          tone="warning"
          style={{ alignSelf: "flex-start" }}
        />
      ) : null}

      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 12,
          borderTopColor: t.borderSubtle,
          borderTopWidth: 1,
          paddingTop: 8,
        }}
      >
        <Count label="Shown" value={funnel ? num(funnel.shown) : EMDASH} />
        <Count
          label="Accepted"
          value={funnel ? num(funnel.accepted) : EMDASH}
        />
        <Count
          label="Declined"
          value={funnel ? num(funnel.declined) : EMDASH}
        />
        <Count label="Expired" value={funnel ? num(funnel.expired) : EMDASH} />
        <Count
          label="Rate"
          value={funnel === null || rate === null ? EMDASH : percent(rate)}
        />
      </View>
    </Pressable>
  );
}

/**
 * One count. Hidden from assistive tech: the row above is one accessible
 * element whose label already reads all five figures as a sentence, and five
 * more stops saying "Shown, 14" would repeat it without adding a fact.
 */
function Count({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ minWidth: 56 }}
    >
      <Text
        {...typeCap("numeric")}
        style={{
          color: t.fg,
          ...typeStyle("numeric"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
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
          marginTop: 1,
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
