/**
 * BenchmarkSection — the answer to "is 34% good?".
 *
 * The three deliverability tiles above this section are the app's most-read
 * numbers and, on their own, unreadable: nothing on the phone told a user
 * whether a 34% open rate was a triumph or a symptom. This puts each rate
 * beside its platform benchmark and says which way the difference points.
 *
 * Backed by GET /api/v1/dashboard/benchmarks
 * (apps/api/internal/analytics/dashboard_layout.go), whose averages are
 * ILLUSTRATIVE public figures until the platform aggregate has run. That is not
 * a footnote we may drop — the server sends its own `note` for exactly this
 * reason, and a comparison whose provenance is hidden is a comparison the
 * reader cannot weigh. So the note is always printed, and each row carries the
 * benchmark's own `source`.
 *
 * The section self-gates: no rows, no card. On a workspace with no measured
 * rates there is nothing to compare, and a card of em-dashes beside industry
 * averages reads as "you score zero" rather than "we have not measured you".
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonCard } from "@/components/Skeleton";
import { FONT } from "@/lib/fonts";
import { percent } from "@/lib/format";
import {
  compareAll,
  type BenchmarkComparison,
  type BenchmarkVerdict,
  type Benchmarks,
} from "@/lib/benchmarks";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface BenchmarkSectionProps {
  benchmarks: Benchmarks | undefined;
  loading: boolean;
  rates: {
    opens: number | null;
    clicks: number | null;
    bounces: number | null;
  };
}

function verdictTone(
  verdict: BenchmarkVerdict,
): "success" | "warning" | "neutral" {
  switch (verdict) {
    case "ahead":
      return "success";
    case "behind":
      return "warning";
    case "level":
      return "neutral";
  }
}

function verdictWord(verdict: BenchmarkVerdict): string {
  switch (verdict) {
    case "ahead":
      return "Ahead";
    case "behind":
      return "Behind";
    case "level":
      return "In line";
  }
}

export function BenchmarkSection({
  benchmarks,
  loading,
  rates,
}: BenchmarkSectionProps) {
  const { t } = useTheme();

  if (loading) {
    return (
      <View>
        <SectionLabel topMargin={20}>Against the benchmark</SectionLabel>
        <SkeletonCard lines={3} />
      </View>
    );
  }

  const rows = benchmarks ? compareAll(rates, benchmarks) : [];
  // Nothing measured, or no benchmark to measure against: say nothing rather
  // than printing industry averages with em-dashes beside them.
  if (rows.length === 0) return null;

  return (
    <View>
      <SectionLabel topMargin={20}>Against the benchmark</SectionLabel>
      <View
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 16,
          overflow: "hidden",
        }}
      >
        {rows.map((row, index) => (
          <BenchmarkRow key={row.metric} row={row} first={index === 0} />
        ))}
        {benchmarks?.note ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              paddingHorizontal: 14,
              paddingBottom: 12,
              paddingTop: 2,
            }}
          >
            {benchmarks.note}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function BenchmarkRow({
  row,
  first,
}: {
  row: BenchmarkComparison;
  first: boolean;
}) {
  const { t } = useTheme();
  const own = percent(row.own);
  const average = percent(row.average);

  return (
    <View
      accessible
      // One stop per row, opening with the verdict: a reader swiping through
      // three rows needs "behind" before "3.4% against 2.1%".
      accessibilityLabel={`${row.label}. ${verdictWord(row.verdict)}. ${row.sentence} Yours ${own}, benchmark ${average}. ${row.source}.`}
      style={{
        gap: 6,
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: t.borderSubtle,
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
          {...typeCap("body")}
          numberOfLines={1}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
        >
          {row.label}
        </Text>
        {/* The WORD carries the verdict; the tone only reinforces it, so the
            row still reads correctly in greyscale. */}
        <Pill label={verdictWord(row.verdict)} tone={verdictTone(row.verdict)} />
      </View>
      <Text
        {...typeCap("numeric")}
        style={{
          color: t.fgMuted,
          ...typeStyle("numeric"),
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
      >
        {own} yours · {average} benchmark
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {row.source}
      </Text>
    </View>
  );
}
