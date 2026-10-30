/**
 * PairwiseSection — each non-control variant compared against the control.
 *
 * Extracted from the A/B results route (which was over its size budget) and
 * given the guard it was missing: the section used to render its
 * "Pairwise significance" heading and Bonferroni caption unconditionally,
 * then map `variants.filter(v => !v.is_control)` — with each row additionally
 * returning null when the frequentist/Bayesian maps were absent or
 * non-finite. If the backend flagged no control, or keyed the maps
 * differently, the result was a labelled VOID: a heading and a caption with
 * nothing at all underneath and no explanation.
 *
 * Now the renderable rows are computed first, and an empty set renders an
 * honest empty state in place of the whole block.
 */
import { Text, View } from "react-native";

import { EmptyState } from "@/components/EmptyState";
import { SectionLabel } from "@/components/SectionLabel";
import { SignificanceBadge } from "@/components/abtest/SignificanceBadge";
import type {
  ABBayesianOutcome,
  ABFrequentistOutcome,
  ABResultsResponse,
  ABResultsVariant,
} from "@/api/abTests";
import { abComparisonKey } from "@/lib/abResults";
import { percent } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

interface PairwiseRow {
  variant: ABResultsVariant;
  freq: ABFrequentistOutcome;
  bay: ABBayesianOutcome;
  label: string;
}

/**
 * Formats an ALREADY-SCALED percent value (e.g. 42.1 meaning 42.1%) to one
 * decimal, guarding non-finite numbers. Deliberately not `campaignRate`: these
 * are Bayesian probabilities the caller has already multiplied by 100, and
 * campaignRate would re-scale anything below 1 (turning a genuine 0.5% into
 * 50%). Routed through the shared `percent` formatter so the locale, digit
 * count and em-dash fallback match every other number in the app.
 */
function fmtPct1(p: number): string {
  return percent(p, { alreadyPercent: true, digits: 1 });
}

export function pairwiseRows(result: ABResultsResponse): PairwiseRow[] {
  const rows: PairwiseRow[] = [];
  for (const variant of result.variants) {
    if (variant.is_control) continue;
    const key = abComparisonKey(variant.variant_label, variant.variant_index);
    const freq = result.frequentist[key];
    const bay = result.bayesian[key];
    if (!freq || !bay) continue;
    if (!Number.isFinite(freq.z_score) || !Number.isFinite(freq.p_value)) {
      continue;
    }
    rows.push({
      variant,
      freq,
      bay,
      label: variant.variant_label ?? `Variant ${variant.variant_index + 1}`,
    });
  }
  return rows;
}

function KeyVal({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          fontSize: 10,
          letterSpacing: 0.5,
          fontWeight: "600",
          fontFamily: FONT.semibold,
          textTransform: "uppercase",
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("mono")}
        style={{
          color: t.fg,
          fontSize: 14,
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
          marginTop: 2,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function PairwiseCard({
  row,
  bonferroniApplied,
  correctedAlpha,
  numComparisons,
}: {
  row: PairwiseRow;
  bonferroniApplied: boolean;
  correctedAlpha: number;
  numComparisons: number;
}) {
  const { t } = useTheme();
  const { freq, bay, label } = row;
  const sigCorrected = freq.significant_after_correction === true;
  const sigRaw = freq.significant_at_95 === true;
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 8,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fg,
          fontSize: 14,
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label} vs. Control
      </Text>
      <SignificanceBadge
        significant={sigCorrected}
        label={bonferroniApplied ? "Bonferroni" : "95%"}
        hint={
          sigCorrected
            ? `z=${freq.z_score.toFixed(2)} · p=${freq.p_value.toFixed(3)} < α=${correctedAlpha.toFixed(3)}`
            : sigRaw
              ? `z=${freq.z_score.toFixed(2)} · p=${freq.p_value.toFixed(3)} crosses 95% raw but not after Bonferroni (${numComparisons} comparisons)`
              : `z=${freq.z_score.toFixed(2)} · p=${freq.p_value.toFixed(3)}`
        }
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
        <KeyVal
          label="Lift"
          value={
            Number.isFinite(freq.lift_percent)
              ? `${freq.lift_percent >= 0 ? "+" : ""}${freq.lift_percent.toFixed(1)}%`
              : "—"
          }
        />
        <KeyVal label="P(B > A)" value={fmtPct1(bay.prob_b_better * 100)} />
        <KeyVal
          label="Expected lift"
          value={fmtPct1(bay.expected_lift * 100)}
        />
      </View>
      <Text
        {...typeCap("caption")}
        style={{ color: t.fgSubtle, fontSize: 11, fontFamily: FONT.regular }}
      >
        95% credible interval: [
        {fmtPct1((bay.credible_interval_95?.[0] ?? Number.NaN) * 100)},{" "}
        {fmtPct1((bay.credible_interval_95?.[1] ?? Number.NaN) * 100)}]
      </Text>
    </View>
  );
}

export function PairwiseSection({ result }: { result: ABResultsResponse }) {
  const { t } = useTheme();
  const rows = pairwiseRows(result);

  if (rows.length === 0) {
    return (
      <>
        <SectionLabel>Pairwise significance</SectionLabel>
        <EmptyState
          title="Pairwise stats aren't available for this test yet"
          description="Every arm needs a flagged control and enough engagement for the frequentist and Bayesian comparisons to resolve."
        />
      </>
    );
  }

  return (
    <>
      <SectionLabel>Pairwise significance</SectionLabel>
      {result.bonferroni.applied_to_frequentist ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontSize: 11,
            fontFamily: FONT.regular,
            marginBottom: 8,
            lineHeight: 16,
          }}
        >
          Bonferroni: {result.bonferroni.num_comparisons}{" "}
          {result.bonferroni.num_comparisons === 1
            ? "comparison"
            : "comparisons"}
          , corrected α = {result.bonferroni.corrected_alpha.toFixed(4)}.
          significant_after_correction is the conservative read.
        </Text>
      ) : null}
      <View style={{ gap: 12 }}>
        {rows.map((row) => (
          <PairwiseCard
            key={row.variant.id}
            row={row}
            bonferroniApplied={result.bonferroni.applied_to_frequentist}
            correctedAlpha={result.bonferroni.corrected_alpha}
            numComparisons={result.bonferroni.num_comparisons}
          />
        ))}
      </View>
    </>
  );
}
