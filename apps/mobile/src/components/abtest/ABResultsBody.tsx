/**
 * ABResultsBody — the winner banner, the per-variant cards, and the pairwise
 * comparison, once the payload has been validated.
 *
 * Extracted so the route file's render stays a readable state ladder rather
 * than a 150-line nested ternary. It also carries the "refining, not
 * reloading" treatment: while a metric switch is in flight the numbers stay
 * on screen at reduced opacity instead of being replaced by a spinner.
 */
import { Text, View } from "react-native";

import { PairwiseSection } from "@/components/abtest/PairwiseSection";
import { ResultsCard } from "@/components/abtest/ResultsCard";
import { WeightDriftSection } from "@/components/abtest/WeightDriftSection";
import { WinnerBanner } from "@/components/abtest/WinnerBanner";
import { SectionLabel } from "@/components/SectionLabel";
import type { ABResultsResponse } from "@/api/abTests";
import { abComparisonKey } from "@/lib/abResults";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface ABResultsBodyProps {
  result: ABResultsResponse;
  metricLabel: string;
  /** True while a metric switch or refresh is in flight. */
  refining: boolean;
  /**
   * Taken from the ROUTE, not from `result.campaign_id`: the payload validator
   * checks the collections it renders and nothing else, so a gateway that
   * omitted the id would send the allocation read to `/campaigns/undefined/`.
   */
  campaignId: string;
}

export function ABResultsBody({
  result,
  metricLabel,
  refining,
  campaignId,
}: ABResultsBodyProps) {
  const { t } = useTheme();
  const winningVariant = result.variants.find(
    (variant) => variant.variant_index === result.winner?.variant_index,
  );
  const winnerFrequentist = winningVariant
    ? result.frequentist[
        abComparisonKey(
          winningVariant.variant_label,
          winningVariant.variant_index,
        )
      ]
    : undefined;
  const decided =
    result.winner != null && result.winner.method !== "not_decided";

  return (
    <View
      style={{ marginTop: 16, opacity: refining ? 0.6 : 1 }}
      {...(refining
        ? { accessibilityLabel: `Updating ${metricLabel} results` }
        : {})}
    >
      <WinnerBanner
        variantIndex={result.winner?.variant_index ?? -1}
        method={result.winner?.method ?? "not_decided"}
        confidence={result.winner?.confidence ?? 0}
        {...(typeof winnerFrequentist?.lift_percent === "number"
          ? { liftPercent: winnerFrequentist.lift_percent }
          : {})}
        variantLabel={winningVariant?.variant_label ?? null}
      />

      <SectionLabel topMargin={4}>Variants</SectionLabel>
      <View style={{ gap: 10 }}>
        {result.variants.map((v) => (
          <ResultsCard
            key={v.id}
            variant={v}
            metricLabel={metricLabel}
            isWinner={
              decided && result.winner?.variant_index === v.variant_index
            }
          />
        ))}
      </View>

      {/* Directly under Variants, because it answers the question the static
          cards raise: is this split a decision or a discovery? Renders nothing
          at all for a fixed split. */}
      <WeightDriftSection campaignId={campaignId} />

      <PairwiseSection result={result} />

      {result.bonferroni.notes ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontSize: 11,
            fontFamily: FONT.regular,
            marginTop: 12,
            lineHeight: 16,
          }}
        >
          {result.bonferroni.notes}
        </Text>
      ) : null}
    </View>
  );
}
