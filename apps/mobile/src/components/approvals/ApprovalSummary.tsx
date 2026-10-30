/**
 * ApprovalSummary — the header strip above the queue.
 *
 * Answers three questions the previous single count line could not:
 *   - how long is the queue (pending),
 *   - is it moving (approved / rejected in the last 7 days),
 *   - am I the bottleneck (average time to decide).
 *
 * It also states the window those numbers cover. The server caps the list
 * at 100 rows with no cursor, so an unqualified "N total" is a false claim
 * on any workspace with real approval history.
 */
import { Text, View } from "react-native";

import { StatCard } from "@/components/StatCard";
import { exact, num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  formatTimeToDecide,
  type ApprovalDecisionStats,
} from "./approvalPresentation";

export interface ApprovalSummaryProps {
  stats: ApprovalDecisionStats;
  /**
   * "12 requests awaiting a decision". Rendered as a POLITE LIVE REGION: the
   * Pending/All chips swap the whole data set, and without this a VoiceOver
   * user hears nothing at all when they tap one. Null means "nothing honest to
   * say" (empty queue — the EmptyState speaks instead).
   */
  countLine: string | null;
  /**
   * False while the decided-history query has not resolved. A "0 approved
   * this week" that actually means "not loaded yet" is the exact class of
   * lie a monitoring tile must not tell, so the counters render "—".
   */
  decisionsKnown: boolean;
  // NOTE: shownCount / loadedCount / searching are deliberately NOT props.
  // Those three facts reach this component already folded into `countLine`,
  // which is the only form it renders; taking them separately as well would be
  // two sources of truth for one sentence, and the copy decision belongs in
  // approvalCountLine() where it is unit-tested.
  /** Disclosure when the loaded window is a truncation, else null. */
  truncationNotice: string | null;
  /** Escalation-policy explainer for the countdown on rows, else null. */
  escalationNotice: string | null;
}

export function ApprovalSummary({
  stats,
  countLine,
  decisionsKnown,
  truncationNotice,
  escalationNotice,
}: ApprovalSummaryProps) {
  const { t } = useTheme();
  const avg = decisionsKnown
    ? formatTimeToDecide(stats.avgTimeToDecideMs)
    : "—";
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <StatCard
          style={{ flex: 1 }}
          label="Pending"
          value={num(stats.pending)}
          numeric={stats.pending}
          exact={exact(stats.pending, "pending approvals")}
        />
        <StatCard
          style={{ flex: 1 }}
          label="Approved · 7d"
          value={decisionsKnown ? num(stats.approved7d) : "—"}
          {...(decisionsKnown ? { numeric: stats.approved7d } : {})}
          exact={
            decisionsKnown
              ? exact(stats.approved7d, "approved in the last 7 days")
              : "Approval history still loading"
          }
        />
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <StatCard
          style={{ flex: 1 }}
          label="Rejected · 7d"
          value={decisionsKnown ? num(stats.rejected7d) : "—"}
          {...(decisionsKnown ? { numeric: stats.rejected7d } : {})}
          exact={
            decisionsKnown
              ? exact(stats.rejected7d, "rejected in the last 7 days")
              : "Approval history still loading"
          }
        />
        <StatCard
          style={{ flex: 1 }}
          label="Avg decide"
          value={avg}
          exact={
            !decisionsKnown
              ? "Approval history still loading"
              : stats.avgTimeToDecideMs == null
                ? "No decisions in the last 7 days"
                : `Average ${avg} from request to decision, over ${exact(
                    stats.decidedSample,
                    "decisions",
                  )}`
          }
        />
      </View>

      {countLine ? (
        <Text
          {...typeCap("numeric")}
          // Tapping a filter chip changed the list and this count in silence.
          // SearchField announces a SEARCH result count; nothing announced a
          // FILTER one, so a VoiceOver user got no confirmation the chip they
          // just selected did anything at all.
          accessibilityLiveRegion="polite"
          style={{
            color: t.fgMuted,
            ...typeStyle("numeric"),
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
          numberOfLines={1}
        >
          {countLine}
        </Text>
      ) : null}

      {escalationNotice ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {escalationNotice}
        </Text>
      ) : null}

      {truncationNotice ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {truncationNotice}
        </Text>
      ) : null}
    </View>
  );
}
