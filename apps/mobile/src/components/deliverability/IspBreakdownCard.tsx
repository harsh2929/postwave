/**
 * IspBreakdownCard — "Gmail is fine, Microsoft is bouncing".
 *
 * The first branch of every deliverability investigation, and the hub had no
 * answer for it. Two rules this card exists to keep:
 *
 *  - THE VERDICT IS STATED, not left for the reader to derive by comparing
 *    four bounce rates in their head on a 390pt screen. `ispVerdict` picks the
 *    provider to look at first, and refuses to pick one when no bucket has
 *    enough volume to mean anything.
 *  - THE BAR IS NEVER THE ONLY SIGNAL. Each row carries its own exact bounce
 *    rate in text beside the bar, and the whole card carries one spoken
 *    sentence, so nothing here is colour- or length-alone.
 */
import { Text, View } from "react-native";

import { BarChart, type BarDatum } from "@/components/charts/BarChart";
import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { num, percent } from "@/lib/format";
import type { SignalTone } from "@/lib/deliverabilitySignals";
import { ispVerdict, type IspBreakdown } from "@/lib/deliverabilityDiagnostics";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface IspBreakdownCardProps {
  breakdown: IspBreakdown | undefined;
  /** Non-null when the read failed or could not run. */
  unavailableReason: string | null;
}

function pillTone(
  tone: SignalTone,
): "neutral" | "success" | "warning" | "danger" | "info" {
  return tone === "neutral" ? "neutral" : tone;
}

export function IspBreakdownCard({
  breakdown,
  unavailableReason,
}: IspBreakdownCardProps) {
  const { t } = useTheme();
  const buckets = breakdown?.buckets ?? [];
  const verdict = ispVerdict(buckets);

  const data: BarDatum[] = buckets.map((bucket) => ({
    id: bucket.isp,
    label: bucket.label,
    value: bucket.subscribers,
    hint: `${percent(bucket.bounceRate, { digits: 1 })} bounced · ${percent(
      bucket.openRate,
      { digits: 0 },
    )} opened`,
  }));

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
          Where mail lands
        </Text>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {unavailableReason ??
            (breakdown
              ? `Recipients by mailbox provider over the last ${num(
                  breakdown.windowDays,
                )} days.`
              : "Loading provider breakdown…")}
        </Text>
      </View>

      {unavailableReason || buckets.length === 0 ? null : (
        <>
          <View
            accessible
            accessibilityRole="summary"
            accessibilityLabel={
              verdict.sentence || "No provider stands out in this window."
            }
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            {verdict.worst ? (
              <Pill label={verdict.worst.label} tone={pillTone(verdict.tone)} />
            ) : null}
            <Text
              {...typeCap("callout")}
              style={{
                color: verdict.worst ? t.fg : t.fgMuted,
                ...typeStyle("callout"),
                fontFamily: verdict.worst ? FONT.semibold : FONT.regular,
                flexShrink: 1,
              }}
            >
              {verdict.sentence}
            </Text>
          </View>
          <BarChart
            data={data}
            valueNoun="recipient"
            showShare
            {...(verdict.worst ? { emphasise: verdict.worst.isp } : {})}
            maxRows={6}
          />
        </>
      )}
    </View>
  );
}
