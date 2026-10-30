/**
 * CustomerValueSection — the two customer-value numbers that fit on a phone.
 *
 * The desktop lazily loads a 675-line predicted-value DISTRIBUTION with churn
 * bands. A distribution is a desk artifact: it exists so an analyst can hunt
 * for a shape. The phone-appropriate reduction is the median customer and the
 * size of the at-risk band — one number that says what a typical customer is
 * worth, one that says how much of that is walking out.
 *
 * WHY THERE IS NO CURRENCY SYMBOL, and this is a deliberate, checked decision
 * rather than an oversight. `historic_clv_cents` is
 * `COALESCE(sum(total_cents), 0)` over `commerce_orders` with NO grouping by
 * currency (apps/api/internal/predictive/repo.go:532), so a workspace selling
 * in two currencies has both summed into one integer. Printing "$42.00" against
 * that would assert a denomination the server never established. The figure is
 * shown as a plain amount and the caption says exactly what it is.
 *
 * WHAT IS NOT HERE. The payload also carries `top_profiles` and
 * `at_risk_profiles` — named customer email addresses with churn scores. Those
 * are never parsed (lib/clvSummary.ts), so they cannot reach a phone screen, a
 * screenshot, or the offline vault.
 *
 * NativeWind v4: no Pressable on this card; every style object is static.
 */
import { Text, View } from "react-native";

import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SkeletonCard } from "@/components/Skeleton";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  clvConfidenceLine,
  clvMajorUnits,
  clvUnavailableReason,
  type ClvSummary,
} from "@/lib/clvSummary";
import { FONT } from "@/lib/fonts";
import { EMDASH, dateTime, num, plural } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export interface CustomerValueSectionProps {
  query: QueryLike;
  summary: ClvSummary;
  gate: Pick<OnlineQueryGate, "enabled">;
}

export function CustomerValueSection({
  query,
  summary,
  gate,
}: CustomerValueSectionProps) {
  const { t } = useTheme();
  const reason = clvUnavailableReason(summary);
  const median = clvMajorUnits(summary.medianTotalCents);
  const p90 = clvMajorUnits(summary.p90TotalCents);
  const confidence = clvConfidenceLine(summary);

  return (
    <QueryStates
      query={query}
      // `profileCount === null` is "the server said nothing", which the reason
      // below explains; it is NOT an empty workspace, so it must not render
      // the empty state.
      isEmpty={summary.profileCount === 0}
      gate={gate}
      skeleton={<SkeletonCard lines={3} />}
      empty={{
        title: "No customer-value snapshot yet",
        description:
          "Predicted value is computed from paid commerce orders matched to subscribers. It appears once the predictive model has run for this workspace.",
      }}
    >
      {reason ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            fontFamily: FONT.regular,
            ...typeStyle("bodySmall"),
          }}
        >
          {reason}
        </Text>
      ) : (
        <View style={{ gap: 14 }}>
          <View
            accessible
            accessibilityLabel={`Median customer value ${
              median === null ? "not reported" : num(median)
            }. Top ten percent of customers are worth ${
              p90 === null ? "an unreported amount" : num(p90)
            } or more.`}
          >
            <Text
              {...typeCap("figure")}
              style={{
                color: t.fg,
                fontFamily: FONT.display,
                fontSize: fontSizeFor("figure"),
                letterSpacing: -0.6,
                fontVariant: ["tabular-nums"],
              }}
            >
              {median === null ? EMDASH : num(median)}
            </Text>
            <Text
              {...typeCap("numeric")}
              style={{
                color: t.fgMuted,
                fontFamily: FONT.regular,
                ...typeStyle("numeric"),
                marginTop: 2,
              }}
            >
              {p90 === null
                ? "Median customer value"
                : `Median customer value · top 10% at ${num(p90)}+`}
            </Text>
          </View>

          <View
            accessible
            accessibilityLabel={
              summary.atRiskProfiles === null
                ? "The at-risk band was not reported for this snapshot."
                : `${plural(summary.atRiskProfiles, "customer")} in the at-risk band.`
            }
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.fg,
                fontFamily: FONT.semibold,
                ...typeStyle("callout"),
                fontVariant: ["tabular-nums"],
              }}
            >
              {summary.atRiskProfiles === null
                ? EMDASH
                : num(summary.atRiskProfiles)}
            </Text>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                fontFamily: FONT.regular,
                ...typeStyle("caption"),
                marginTop: 2,
              }}
            >
              {/* "At risk" is a SERVER band (churn risk ≥ 0.6 with non-zero
                  value), not a judgement made here — naming the threshold is
                  what stops the number reading as an opinion. */}
              At risk — customers the model scores at 60% churn risk or higher
              with value on the account
            </Text>
          </View>

          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              fontFamily: FONT.regular,
              ...typeStyle("caption"),
            }}
          >
            {captionFor(confidence, summary.lastCalculatedAt)}
          </Text>
        </View>
      )}
    </QueryStates>
  );
}

/**
 * The card's disclosure line. Three separate facts, none of which is safe to
 * omit: how many rows are confidently scored, WHEN the snapshot was computed
 * (it moves only when the recompute job runs, so it can be days old with
 * nothing else on screen saying so), and the currency caveat.
 */
function captionFor(
  confidence: string | null,
  lastCalculatedAt: string | null,
): string {
  const parts: string[] = [];
  if (confidence) parts.push(confidence);
  parts.push(
    lastCalculatedAt
      ? `Snapshot computed ${dateTime(lastCalculatedAt)}.`
      : "This snapshot has no recorded computation time.",
  );
  parts.push(
    "Amounts are historic plus predicted order value summed from your commerce orders. Moosewave does not record one currency for this figure, so no currency symbol is shown.",
  );
  return parts.join(" ");
}
