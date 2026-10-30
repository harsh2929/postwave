/**
 * RetentionOfferDetailSheet — one offer's reconciliation verdict, ported from
 * desktop's RetentionOfferDetail slideover.
 *
 * The list row shows the funnel NUMBERS; this sheet answers whether they can
 * be TRUSTED. The verdict (lib/retentionEvidence) is a client judgement over
 * the same GET /retention-offers + /funnel payloads the screen already
 * fetched — matched / duplicate / tier-mismatch / outcome-excess / missing /
 * unavailable — and only a `matched` tile earns an acceptance rate. Raw
 * counters are still printed for a non-matched verdict, labelled unverified,
 * exactly as desktop prints them with the `is-untrusted` class.
 *
 * Read-only, like the whole surface (the write side of retention_offers is
 * unmounted server-wide). NativeWind v4: static style objects only.
 */
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Pill } from "@/components/Pill";
import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { FONT } from "@/lib/fonts";
import { EMDASH, date, num, percent, truncateMiddle } from "@/lib/format";
import {
  classifyRetentionFunnel,
  retentionEvidenceExplanation,
  retentionEvidenceLabel,
  retentionEvidenceTone,
  trustedAcceptanceRate,
} from "@/lib/retentionEvidence";
import {
  durationLabel,
  offerAmount,
  type RetentionFunnelTile,
  type RetentionOfferRow,
} from "@/lib/retentionOffers";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface RetentionOfferDetailSheetProps {
  /** The opened row, or null when closed. */
  row: RetentionOfferRow | null;
  /** EVERY funnel tile, unjoined — duplicate detection needs the full list. */
  tiles: readonly RetentionFunnelTile[] | null;
  /** True while the funnel read is still in flight. */
  funnelPending: boolean;
  onClose: () => void;
}

export function RetentionOfferDetailSheet(
  props: RetentionOfferDetailSheetProps,
) {
  const { t } = useTheme();
  const row = props.row;
  const offer = row?.offer ?? null;
  const state = offer
    ? classifyRetentionFunnel(
        offer,
        props.tiles === null ? null : [...props.tiles],
      )
    : "unavailable";
  const matches =
    offer && props.tiles
      ? props.tiles.filter((tile) => tile.offerId === offer.id)
      : [];
  const tile = matches.length === 1 ? (matches[0] ?? null) : null;
  const rate = trustedAcceptanceRate(state, tile);
  const label = retentionEvidenceLabel(state, props.funnelPending);
  const trusted = !props.funnelPending && state === "matched";
  const counterSource = tile ?? row?.funnel ?? null;

  return (
    <ReducedMotionModal
      visible={row !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        {row && offer ? (
          <>
            <SheetHeader
              title={row.tierName ?? `Tier ${truncateMiddle(offer.tierId, 14)}`}
              onClose={props.onClose}
            />
            <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
              <OfferPills
                active={offer.active}
                couponMissing={offer.active && offer.couponId === ""}
              />

              <Line
                label="Offer"
                value={`${offerAmount(offer).label} · ${durationLabel(offer)}`}
              />
              {offer.headline ? (
                <Line label="Headline" value={`“${offer.headline}”`} />
              ) : null}
              {offer.createdAt ? (
                <Line label="Created" value={date(offer.createdAt)} />
              ) : null}

              {/* The verdict. The WORD carries the state; tone is a second
                  channel only. */}
              <View
                style={{
                  borderColor: trusted ? t.border : t.borderSubtle,
                  borderWidth: 1,
                  borderRadius: 12,
                  padding: 12,
                  gap: 6,
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <Text
                    accessibilityRole="header"
                    {...typeCap("callout")}
                    style={{
                      color: t.fg,
                      ...typeStyle("callout"),
                      fontWeight: "600",
                      fontFamily: FONT.semibold,
                      flex: 1,
                    }}
                  >
                    Reconciliation evidence
                  </Text>
                  <Pill
                    label={label}
                    tone={retentionEvidenceTone(state, props.funnelPending)}
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
                  {props.funnelPending
                    ? "The funnel read is still in flight — the verdict lands with it."
                    : retentionEvidenceExplanation(state)}
                </Text>
              </View>

              {/* Counters: trusted at face value, or printed-but-flagged. */}
              {counterSource ? (
                <View style={{ gap: 6 }}>
                  <Text
                    {...typeCap("label")}
                    style={{
                      color: t.fgMuted,
                      ...typeStyle("label"),
                      fontFamily: FONT.semibold,
                    }}
                  >
                    {trusted ? "Funnel" : "Funnel (unverified)"}
                  </Text>
                  {counterSource ? (
                    <Line
                      label={`${num(counterSource.shown)} shown · ${num(counterSource.accepted)} accepted · ${num(counterSource.declined)} declined · ${num(counterSource.expired)} expired`}
                      value={
                        rate === null
                          ? `${EMDASH} rate`
                          : `${percent(rate)} acceptance`
                      }
                    />
                  ) : null}
                </View>
              ) : null}
            </ScrollView>
          </>
        ) : null}
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

/** The state pills — the WORD carries the state, tone is a second channel. */
function OfferPills({
  active,
  couponMissing,
}: {
  active: boolean;
  couponMissing: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 6,
      }}
    >
      <Pill
        label={active ? "Marked active" : "Marked inactive"}
        tone={active ? "warning" : "neutral"}
      />
      {couponMissing ? (
        <Pill label="No Stripe coupon on record" tone="warning" />
      ) : null}
    </View>
  );
}

function SheetHeader({
  title,
  onClose,
}: {
  title: string;
  onClose: () => void;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomColor: t.borderSubtle,
        borderBottomWidth: 1,
        gap: 12,
      }}
    >
      <Text
        numberOfLines={maxLinesAtScale(1, 1)}
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontFamily: FONT.display,
          flexShrink: 1,
        }}
      >
        {title}
      </Text>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close the offer detail"
        style={{
          paddingHorizontal: 8,
          paddingVertical: 6,
          minHeight: 44,
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.accent,
            ...typeStyle("callout"),
            fontFamily: FONT.semibold,
          }}
        >
          Done
        </Text>
      </Pressable>
    </View>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          flexShrink: 1,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
          textAlign: "right",
        }}
      >
        {value}
      </Text>
    </View>
  );
}
