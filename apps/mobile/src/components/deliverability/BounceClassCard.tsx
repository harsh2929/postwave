/**
 * BounceClassCard — "the bounces are 5.7.1, not 5.1.1".
 *
 * The second branch of a deliverability investigation, and the one that
 * decides what you DO: a hard bounce is list hygiene, a block is a reputation
 * problem with one provider, a soft bounce is usually nothing. A single
 * "bounce rate" figure collapses all three into one number an operator cannot
 * act on.
 *
 * Rendered as a ranked list rather than a chart because the payload is four to
 * six rows: a bar chart of five categories is a table with extra steps, and
 * the SHARE is the interesting quantity, which reads better as text.
 *
 * Tone is never the only signal — every row carries its class WORD and its own
 * share, and the card carries one spoken sentence per row.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { num, percent } from "@/lib/format";
import {
  bounceClassTone,
  type BounceClassBreakdown,
} from "@/lib/deliverabilityDiagnostics";
import type { SignalTone } from "@/lib/deliverabilitySignals";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface BounceClassCardProps {
  breakdown: BounceClassBreakdown | undefined;
  /** Non-null when the read failed or could not run. */
  unavailableReason: string | null;
}

function pillTone(
  tone: SignalTone,
): "neutral" | "success" | "warning" | "danger" | "info" {
  return tone === "neutral" ? "neutral" : tone;
}

export function BounceClassCard({
  breakdown,
  unavailableReason,
}: BounceClassCardProps) {
  const { t } = useTheme();
  const classes = breakdown?.classes ?? [];

  const body = unavailableReason
    ? unavailableReason
    : !breakdown
      ? "Loading bounce classes…"
      : breakdown.totalBounces === 0
        ? `No bounces recorded in the last ${num(breakdown.windowDays)} days.`
        : `${num(breakdown.totalBounces)} bounces over ${num(
            breakdown.windowDays,
          )} days, by class.`;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 10,
        gap: 10,
      }}
    >
      <View style={{ gap: 4 }}>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.bold,
            letterSpacing: 0.6,
            textTransform: "uppercase",
          }}
        >
          Why they bounced
        </Text>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {body}
        </Text>
      </View>

      {unavailableReason
        ? null
        : classes.map((row) => (
            <View
              key={row.code}
              accessible
              accessibilityLabel={`${row.label}: ${num(row.count)} bounces, ${percent(
                row.share,
                { digits: 0 },
              )} of the total.`}
              style={{ gap: 5 }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    flexShrink: 1,
                  }}
                >
                  <Pill
                    label={row.label}
                    tone={pillTone(bounceClassTone(row.code))}
                  />
                </View>
                <Text
                  {...typeCap("numeric")}
                  style={{
                    color: t.fg,
                    ...typeStyle("numeric"),
                    fontFamily: FONT.semibold,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {`${num(row.count)} · ${percent(row.share, { digits: 0 })}`}
                </Text>
              </View>
              {/* The bar is redundant reinforcement of the figure above it,
                  which is why it carries no accessibility role of its own. */}
              <View
                importantForAccessibility="no-hide-descendants"
                style={{
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: t.bgSubtle,
                  overflow: "hidden",
                }}
              >
                <View
                  style={{
                    width: `${Math.max(2, Math.round(row.share * 100))}%`,
                    height: "100%",
                    borderRadius: 3,
                    backgroundColor:
                      bounceClassTone(row.code) === "danger"
                        ? t.danger
                        : bounceClassTone(row.code) === "warning"
                          ? t.warning
                          : t.fgMuted,
                  }}
                />
              </View>
            </View>
          ))}
    </View>
  );
}
