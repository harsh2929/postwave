/**
 * CampaignBenchmarkBody — this campaign against the workspace's own baseline.
 *
 * A separate file rather than another entry in `CampaignInsightBodies`: the
 * comparison has three parts (figures, verdict, rank) whose polarity rules are
 * subtle enough that they deserve to be read next to the module documenting
 * them (lib/campaignBenchmark.ts), not buried among six other bodies.
 *
 * The one rule to keep in mind while reading this file: `verdict` has ALREADY
 * been polarity-corrected by the server, so `above` means BETTER for every
 * metric including bounce and complaint rate — while `percentile` has NOT, so
 * it is stated as a plain fact and never as a rank to be proud of. That is why
 * the verdict is the thing that gets colour and the percentile is the thing
 * that gets muted ink.
 *
 * State is never colour-alone (house rule 4): every verdict carries its
 * sentence, and the sentence is what VoiceOver reads.
 */
import { Text, View } from "react-native";

import type { ThemeTokens } from "@/lib/theme";
import {
  benchmarkRowSpoken,
  benchmarkUnavailableSentence,
  percentileSentence,
  verdictSentence,
  type BenchmarkMetric,
  type CampaignBenchmark,
} from "@/lib/campaignBenchmark";
import { FONT } from "@/lib/fonts";
import { EMDASH, percent } from "@/lib/format";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface CampaignBenchmarkBodyProps {
  benchmark: CampaignBenchmark;
  t: ThemeTokens;
}

function verdictColor(metric: BenchmarkMetric, t: ThemeTokens): string {
  if (!metric.available || metric.verdict === null) return t.fgMuted;
  if (metric.verdict === "above") return t.success;
  if (metric.verdict === "below") return t.danger;
  return t.fgMuted;
}

export function CampaignBenchmarkBody({
  benchmark,
  t,
}: CampaignBenchmarkBodyProps) {
  const unavailable = benchmarkUnavailableSentence(benchmark);

  return (
    <View style={{ gap: 12 }}>
      {unavailable ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            fontFamily: FONT.regular,
            ...typeStyle("bodySmall"),
          }}
        >
          {unavailable}
        </Text>
      ) : null}

      {benchmark.metrics.map((metric) => {
        const rank = percentileSentence(metric);
        return (
          <View
            key={metric.key}
            accessible
            accessibilityLabel={benchmarkRowSpoken(metric)}
            style={{ gap: 2 }}
          >
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <Text
                {...typeCap("label")}
                numberOfLines={2}
                style={{
                  color: t.fg,
                  fontFamily: FONT.medium,
                  ...typeStyle("label"),
                  flexShrink: 1,
                }}
              >
                {metric.label}
              </Text>
              <Text
                {...typeCap("numeric")}
                style={{
                  color: t.fg,
                  fontFamily: FONT.semibold,
                  ...typeStyle("numeric"),
                  fontVariant: ["tabular-nums"],
                }}
              >
                {/* FRACTIONS on this endpoint — the report card above returns
                    percentages. See lib/campaignBenchmark.ts. */}
                {metric.value === null ? EMDASH : percent(metric.value, { digits: 2 })}
              </Text>
            </View>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                fontFamily: FONT.regular,
                ...typeStyle("caption"),
                fontVariant: ["tabular-nums"],
              }}
            >
              {`Your average: ${
                metric.baseline === null
                  ? EMDASH
                  : percent(metric.baseline, { digits: 2 })
              }`}
            </Text>
            <Text
              {...typeCap("caption")}
              style={{
                // The verdict is the one thing here that carries a judgement,
                // and it is always accompanied by its own words — the colour
                // is reinforcement, never the message.
                color: verdictColor(metric, t),
                fontFamily: FONT.medium,
                ...typeStyle("caption"),
              }}
            >
              {verdictSentence(metric)}
            </Text>
            {rank ? (
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  fontFamily: FONT.regular,
                  ...typeStyle("caption"),
                }}
              >
                {rank}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
