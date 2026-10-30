/**
 * SequenceFunnelSummary — journey-wide reach / opens / clicks.
 *
 * Sits above the per-node numbers StepCanvas renders on each tile. Split from
 * SequenceParticipants.tsx when that file crossed its source budget; the seam
 * is real, since this reads a different endpoint under a DIFFERENT SCOPE
 * (`read:reports` + the heavy-read limiter, versus read:campaigns +
 * read:subscribers for the participants list), which is why a 403 here is an
 * expected answer for some tokens rather than a bug.
 */
import { Text, View } from "react-native";

import { Card } from "@/components/Card";
import { SkeletonList } from "@/components/Skeleton";
import {
  SectionHeading,
  SectionNotice,
} from "@/components/sequences/SectionChrome";
import { useSequenceFunnel } from "@/hooks/useSequences";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { funnelSummary } from "@/lib/sequenceFunnel";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * Totals for the whole journey, above the per-step numbers on each node.
 *
 * `entered` is the FIRST position's reach, not the sum of every row — see
 * lib/sequenceFunnel. When the report is empty this says why instead of
 * drawing a row of confident zeros: nothing in this repository writes
 * `sequence_funnel_events` (migration 0367's header states it), so an empty
 * funnel is the expected answer, not a load failure.
 */
export function SequenceFunnelSummary({
  id,
  visible,
}: {
  id: string | undefined;
  visible: boolean;
}) {
  const { t } = useTheme();
  const query = useSequenceFunnel(id, visible);
  if (!visible) return null;

  const status = query.data?.error?.status ?? 0;
  if (query.isLoading) {
    return (
      <Card style={{ marginTop: 16, gap: 10 }}>
        <SectionHeading title="Funnel" />
        <SkeletonList rows={1} lines={2} />
      </Card>
    );
  }
  if (status === 403) {
    return (
      <Card style={{ marginTop: 16, gap: 10 }}>
        <SectionHeading title="Funnel" />
        <SectionNotice
          state={{
            kind: "error",
            title: "Reports aren't visible to your role",
            // read:reports is a DIFFERENT scope from the read:campaigns that
            // shows the topology, so this 403 is expected for some tokens.
            message:
              "Per-step funnel numbers need reporting access. Ask an admin.",
            retryable: false,
          }}
          onRetry={() => void query.refetch()}
        />
      </Card>
    );
  }
  const summary = funnelSummary(query.data?.data ?? null);
  return (
    <Card style={{ marginTop: 16, gap: 10 }}>
      <SectionHeading
        title="Funnel"
        detail={
          summary.hasData
            ? `${plural(summary.entered, "subscriber")} entered`
            : undefined
        }
      />
      {summary.hasData ? (
        <View style={{ flexDirection: "row", gap: 20, flexWrap: "wrap" }}>
          <SummaryCell
            label="Entered"
            value={summary.entered}
            spoken={`${plural(summary.entered, "subscriber")} entered`}
          />
          <SummaryCell
            label="Opened"
            value={summary.opened}
            spoken={`${plural(summary.opened, "open")}, ${Math.round(summary.openRate)} percent of entrants`}
          />
          <SummaryCell
            label="Clicked"
            value={summary.clicked}
            spoken={`${plural(summary.clicked, "click")}, ${Math.round(summary.clickRate)} percent of entrants`}
          />
          {summary.worstDropoffPosition !== null ? (
            <View style={{ justifyContent: "center" }}>
              <Text
                {...typeCap("numeric")}
                accessibilityLabel={`Biggest drop-off is ${Math.round(summary.worstDropoffPct)} percent, at step ${summary.worstDropoffPosition + 1}`}
                style={{
                  color: t.warning,
                  ...typeStyle("numeric"),
                  fontFamily: FONT.medium,
                }}
              >
                −{Math.round(summary.worstDropoffPct)}% at step{" "}
                {summary.worstDropoffPosition + 1}
              </Text>
            </View>
          ) : null}
        </View>
      ) : (
        <SectionNotice
          state={{
            kind: "empty",
            title: "No funnel events yet",
            message:
              "Per-step reach, opens and clicks appear here once sequence delivery runs. This build has no qualified delivery runtime, so no events have been recorded.",
          }}
          onRetry={() => void query.refetch()}
        />
      )}
    </Card>
  );
}

function SummaryCell({
  label,
  value,
  spoken,
}: {
  label: string;
  value: number;
  spoken: string;
}) {
  const { t } = useTheme();
  return (
    <View accessible accessibilityLabel={spoken}>
      <Text
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontFamily: FONT.semibold,
          fontVariant: ["tabular-nums"],
        }}
      >
        {value}
      </Text>
      <Text
        {...typeCap("badgeSmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("badgeSmall"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
