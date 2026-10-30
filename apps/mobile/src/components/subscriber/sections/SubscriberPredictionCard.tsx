/**
 * SubscriberPredictionCard — the predictive profile mobile was throwing away.
 *
 * AUDIENCE#28: `prediction`, `expected_next_order_at` and
 * `order_cadence_metrics` all ship on the subscriber DETAIL GET
 * (apps/api/internal/subscribers/types.go:215/225/231) and mobile dropped every
 * one of them at the SubscriberDetailSummary boundary. Desktop wraps the same
 * data in RFMProfileCard; this is the phone-sized read of it.
 *
 * NO NEW REQUEST. Everything here comes off the object `useSubscriber` already
 * has, so the card costs nothing on a cellular connection and works from the
 * offline snapshot exactly as the rest of the profile does.
 *
 * Three rules the shape of this card exists to honour:
 *
 *  - ABSENCE IS NOT ZERO. An unscored address renders NOTHING — no card, no
 *    "$0.00 lifetime value", no "0% churn". `normalizePrediction` returns null
 *    and the component returns null with it.
 *  - THE CAVEAT TRAVELS WITH THE NUMBER. `data_sufficiency` is rendered
 *    directly under the figures, not tucked into a tooltip, because a churn
 *    percentage from two orders is visually identical to one from two hundred.
 *  - STATE IS NEVER COLOUR-ALONE. The churn band ships as a labelled Pill
 *    ("High risk") and the meter carries an exact spoken percentage.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import {
  Card,
  Label,
  MiniStat,
} from "@/components/subscriber/SubscriberDetailPrimitives";
import { FONT } from "@/lib/fonts";
import { date as fmtDate, money as fmtMoney, percent } from "@/lib/format";
import {
  cadenceSentence,
  churnBand,
  isThinEvidence,
  nextOrderProjection,
  nextOrderSentence,
  normalizeOrderCadence,
  normalizePrediction,
  predictionSpokenSummary,
  sufficiencyNote,
  type ChurnDriver,
  type NextOrderProjection,
  type NormalizedPrediction,
  type OrderCadence,
} from "@/lib/subscriberPrediction";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const IMPACT_TONE = {
  high: "danger",
  medium: "warning",
  low: "neutral",
  unknown: "neutral",
} as const;

const IMPACT_LABEL = {
  high: "High impact",
  medium: "Medium impact",
  low: "Low impact",
  unknown: "Impact not scored",
} as const;

const spokenMoney = (major: number) => fmtMoney(major, "USD", { cents: true });

export function SubscriberPredictionCard({
  prediction,
  expectedNextOrderAt,
  orderCadenceMetrics,
  modelVersion,
  now,
}: {
  prediction: unknown;
  expectedNextOrderAt?: string | null | undefined;
  orderCadenceMetrics?: unknown;
  /** `prediction_model_version` — lineage, shown only when the API sent it. */
  modelVersion?: string | null | undefined;
  /** Injected so the "expected in N days" line is deterministic under test. */
  now?: number | undefined;
}) {
  const { t } = useTheme();
  const model = normalizePrediction(prediction);
  const nextOrder = nextOrderProjection(expectedNextOrderAt, now ?? Date.now());
  const cadence = normalizeOrderCadence(orderCadenceMetrics);

  // Nothing was ever modelled for this address. Say nothing rather than
  // rendering a card full of em-dashes that reads as a broken screen.
  if (!model && !nextOrder && !cadence) return null;

  const caveat = model ? sufficiencyNote(model.sufficiency) : null;

  return (
    <Card style={{ marginTop: 12 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Label>Predicted</Label>
        {model ? <ChurnPill model={model} /> : null}
      </View>

      {model ? <PredictionFigures model={model} /> : null}

      {caveat ? (
        <Text
          // `alert` because the caveat changes what the numbers above MEAN;
          // it is not decorative small print.
          accessibilityRole="alert"
          {...typeCap("caption")}
          style={{
            color: t.warning,
            ...typeStyle("caption"),
            marginTop: 10,
            fontFamily: FONT.regular,
          }}
        >
          {caveat}
        </Text>
      ) : null}

      {model && model.drivers.length > 0 ? (
        <View style={{ marginTop: 12 }}>
          <Label style={{ marginBottom: 6 }}>Why</Label>
          {model.drivers.map((driver) => (
            <DriverRow key={driver.key} driver={driver} />
          ))}
        </View>
      ) : null}

      <RepeatPurchase nextOrder={nextOrder} cadence={cadence} />

      <Provenance
        calculatedAt={model?.calculatedAt ?? null}
        modelVersion={modelVersion ?? null}
      />
    </Card>
  );
}

function ChurnPill({ model }: { model: NormalizedPrediction }) {
  const band = churnBand(model.churnRisk);
  if (!band) return null;
  return (
    <Pill
      label={band.label}
      tone={band.tone}
      accessibilityLabel={
        model.churnRisk === null
          ? band.label
          : `${band.label}. Churn probability ${percent(model.churnRisk, { digits: 0 })}.`
      }
    />
  );
}

function PredictionFigures({ model }: { model: NormalizedPrediction }) {
  const { t } = useTheme();
  const thin = isThinEvidence(model.sufficiency);
  return (
    <View
      // ONE spoken sentence for the whole numeric block: a screen-reader user
      // should not have to walk three compacted currency tiles and a
      // percentage to learn the verdict.
      accessible
      accessibilityLabel={predictionSpokenSummary(model, spokenMoney)}
      style={{ marginTop: 10, flexDirection: "row", flexWrap: "wrap", gap: 8 }}
    >
      {model.value ? (
        <>
          <MiniStat
            label={thin ? "Est. total" : "Total value"}
            value={fmtMoney(model.value.total)}
            t={t}
          />
          <MiniStat
            label="Realised"
            value={fmtMoney(model.value.historic)}
            t={t}
          />
          <MiniStat
            label="Forecast"
            value={fmtMoney(model.value.predicted)}
            t={t}
          />
        </>
      ) : null}
      {model.churnRisk !== null ? (
        <MiniStat
          label="Churn risk"
          value={percent(model.churnRisk, { digits: 0 })}
          t={t}
        />
      ) : null}
      {model.confidence !== null ? (
        <MiniStat
          label="Confidence"
          value={percent(model.confidence, { digits: 0 })}
          t={t}
        />
      ) : null}
    </View>
  );
}

function RepeatPurchase({
  nextOrder,
  cadence,
}: {
  nextOrder: NextOrderProjection | null;
  cadence: OrderCadence | null;
}) {
  const { t } = useTheme();
  if (!nextOrder && !cadence) return null;
  return (
    <View style={{ marginTop: 12 }}>
      <Label style={{ marginBottom: 6 }}>Repeat purchase</Label>
      {nextOrder ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: nextOrder.overdue ? t.warning : t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {nextOrderSentence(nextOrder, (iso) => fmtDate(iso))}
        </Text>
      ) : null}
      {cadence ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 3,
            fontFamily: FONT.regular,
          }}
        >
          {cadenceSentence(cadence, (iso) => fmtDate(iso))}
        </Text>
      ) : null}
    </View>
  );
}

function Provenance({
  calculatedAt,
  modelVersion,
}: {
  calculatedAt: string | null;
  modelVersion: string | null;
}) {
  const { t } = useTheme();
  const line = [
    calculatedAt ? `Scored ${fmtDate(calculatedAt)}` : null,
    modelVersion ? `model ${modelVersion}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (!line) return null;
  return (
    <Text
      {...typeCap("badgeSmall")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("badgeSmall"),
        marginTop: 12,
        fontFamily: FONT.regular,
      }}
    >
      {line}
    </Text>
  );
}

function DriverRow({ driver }: { driver: ChurnDriver }) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${driver.label}${driver.value ? `, ${driver.value}` : ""}. ${IMPACT_LABEL[driver.impact]}.`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        paddingVertical: 5,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {driver.label}
        </Text>
        {driver.value ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              fontVariant: ["tabular-nums"],
            }}
          >
            {driver.value}
          </Text>
        ) : null}
      </View>
      {/* The impact band is a WORD, not a colour — an unscored driver says so
          instead of quietly rendering as the neutral "low" tone. */}
      <Pill label={IMPACT_LABEL[driver.impact]} tone={IMPACT_TONE[driver.impact]} />
    </View>
  );
}
