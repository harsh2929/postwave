/**
 * HubScoreCard — the answer to "is our sending healthy right now?", in one
 * glance and one VoiceOver stop.
 *
 * Three rules it exists to enforce:
 *  - The score is never colour-alone. The grade WORD sits next to the number
 *    and the whole tile carries a spoken sentence, so a red ring is redundant
 *    reinforcement rather than the only signal.
 *  - A missing score renders "—", not 0. `hubHeadline` owns that distinction.
 *  - The 30-sample history is a sparkline with a real accessibility label, not
 *    a decorative squiggle.
 */
import { Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Pill } from "@/components/Pill";
import { Sparkline } from "@/components/charts/Sparkline";
import { FONT } from "@/lib/fonts";
import { num, percent } from "@/lib/format";
import type { SignalTone } from "@/lib/deliverabilitySignals";
import {
  hubHeadline,
  hubRates,
  rateTone,
  trendCaption,
  type HubLike,
} from "@/lib/deliverabilityHubView";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface HubScoreCardProps {
  hub: HubLike | undefined;
  loading: boolean;
}

function toneToPill(
  tone: SignalTone,
): "neutral" | "success" | "warning" | "danger" | "info" {
  return tone === "neutral" ? "neutral" : tone;
}

export function HubScoreCard({ hub, loading }: HubScoreCardProps) {
  const { t } = useTheme();
  const headline = hubHeadline(hub);
  const rates = hubRates(hub);
  const color =
    headline.tone === "danger"
      ? t.danger
      : headline.tone === "warning"
        ? t.warning
        : headline.tone === "success"
          ? t.success
          : headline.tone === "info"
            ? t.info
            : t.fgMuted;

  return (
    <Card style={{ marginBottom: 12 }}>
      <View
        accessible
        accessibilityLabel={
          loading && !hub
            ? "Deliverability score loading"
            : `${headline.spoken}. ${trendCaption(hub)}.`
        }
        style={{ flexDirection: "row", alignItems: "center", gap: 14 }}
      >
        <View style={{ flex: 1 }}>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              fontFamily: FONT.semibold,
              letterSpacing: 0.6,
              textTransform: "uppercase",
            }}
          >
            Deliverability score
          </Text>
          <View
            style={{
              flexDirection: "row",
              alignItems: "baseline",
              gap: 8,
              marginTop: 4,
            }}
          >
            {/* The hero figure sits in a row with "/ 100", the grade pill and
                a 104pt sparkline. 40pt is a deliberate size above the `figure`
                role's 30 — but it takes the role's 1.25x ceiling, which is what
                stops it from evicting the sparkline at a 3x text setting. */}
            <Text
              {...typeCap("figure")}
              style={{
                color,
                fontSize: 40,
                lineHeight: 44,
                fontFamily: FONT.bold,
                fontVariant: ["tabular-nums"],
              }}
            >
              {headline.score}
            </Text>
            <Text
              {...typeCap("numeric")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("numeric"),
                fontFamily: FONT.regular,
              }}
            >
              / 100
            </Text>
            {headline.grade !== "—" ? (
              <Pill label={headline.grade} tone={toneToPill(headline.tone)} />
            ) : null}
          </View>
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              marginTop: 4,
              fontFamily: FONT.regular,
            }}
          >
            {trendCaption(hub)}
          </Text>
        </View>
        {hub && hub.history.length > 1 ? (
          <Sparkline
            values={hub.history}
            width={104}
            height={44}
            accessibilityLabel={`Score history, ${hub.history.length} samples, latest ${headline.score}`}
          />
        ) : null}
      </View>

      <View
        style={{
          flexDirection: "row",
          gap: 8,
          marginTop: 14,
          flexWrap: "wrap",
        }}
      >
        {rates.map((rate) => {
          const tone = hub ? rateTone(rate.key, rate.value) : "neutral";
          const text = hub ? percent(rate.value, { digits: 2 }) : "—";
          return (
            <View
              key={rate.key}
              accessible
              accessibilityLabel={`${rate.label} ${text}`}
              style={{
                flexGrow: 1,
                flexBasis: 90,
                backgroundColor: t.bgSubtle,
                borderRadius: 10,
                paddingHorizontal: 10,
                paddingVertical: 8,
                gap: 2,
              }}
            >
              <Text
                {...typeCap("badgeSmall")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("badgeSmall"),
                  fontFamily: FONT.medium,
                }}
                numberOfLines={1}
              >
                {rate.label}
              </Text>
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
              >
                {/* A dot AND a tone — the figure is never status-by-colour alone,
                    because the label below spells the same judgement out. */}
                <Text
                  {...typeCap("numeric")}
                  style={{
                    color:
                      tone === "danger"
                        ? t.danger
                        : tone === "warning"
                          ? t.warning
                          : tone === "success"
                            ? t.success
                            : t.fg,
                    fontSize: 15,
                    lineHeight: 20,
                    fontFamily: FONT.semibold,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {text}
                </Text>
              </View>
            </View>
          );
        })}
      </View>

      {hub ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 10,
            fontFamily: FONT.regular,
          }}
        >
          {`Over the last ${hub.windowDays} days · ${num(hub.sends7d)} sends in the last 7`}
        </Text>
      ) : null}
    </Card>
  );
}
