/**
 * FlowAbTestSheet — one split's arms, its live counters, and its stored
 * verdict, in that order.
 *
 * A SHEET RATHER THAN A ROUTE, for the same reason IncidentDetailSheet is one:
 * the rhythm is open → read → next, and it keeps this surface to a single
 * route file. (The app-wide entity-detail Stack conversion is deliberately
 * deferred; this does not pre-empt it.)
 *
 * THE VERDICT IS DATED, ALWAYS. `winner` is only written by
 * `POST /{id}/evaluate`, which also ends the test (`setWinner`,
 * flowabtests.go:205). So it describes the counters AS OF `evaluated_at`, and
 * the counters below it may have moved since. Presenting it undated would let
 * a reader take a week-old verdict as the current state of a running test.
 *
 * THE LIVE READ IS SEPARATE FROM THE CONFIG READ AND FAILS SEPARATELY. The
 * arms come from the list row; the counters come from `/results`. If the
 * counters fail, the arms still render and the counter block says the fetch
 * failed — a failed fetch is never an empty list (house rule 8).
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { Pill } from "@/components/Pill";
import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { SectionLabel } from "@/components/SectionLabel";
import { FlowAbVariantCard } from "@/components/flow-ab/FlowAbVariantCard";
import {
  FLOW_AB_SCOPE_NOTE,
  flowAbLeader,
  flowAbStatusLabel,
  flowAbStatusTone,
  flowAbTotals,
  flowAbVariantRows,
  flowAbWinnerNotice,
} from "@/lib/flowAbPolicy";
import type { MobileFlowAbResult, MobileFlowAbTest } from "@/lib/flowAbTests";
import { dateTime, EMDASH, num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface FlowAbTestSheetProps {
  /** The list row — always present while the sheet is open. */
  test: MobileFlowAbTest | null;
  /** The refreshed read; falls back to `test` until it lands. */
  detail: MobileFlowAbTest | null;
  results: readonly MobileFlowAbResult[];
  resultsLoading: boolean;
  resultsFailed: boolean;
  onClose: () => void;
}

/** The one-line answer to "is this collecting?". */
function collectionLine(
  assigned: number | null,
  measuredVariants: number,
  totalVariants: number,
): string {
  if (assigned === null) {
    return `No assignments recorded on any of ${num(totalVariants)} arms.`;
  }
  return `${num(assigned)} assigned across ${num(measuredVariants)} of ${num(totalVariants)} arms.`;
}

export function FlowAbTestSheet(props: FlowAbTestSheetProps) {
  const { t } = useTheme();
  const open = props.test !== null;
  const current = props.detail ?? props.test;
  const rows = flowAbVariantRows(current, props.resultsFailed ? [] : props.results);
  const totals = flowAbTotals(rows);
  const leader = flowAbLeader(rows);
  const winner = flowAbWinnerNotice(
    current?.winner,
    (id) => rows.find((r) => r.variantID === id)?.label ?? id,
  );
  const status = flowAbStatusLabel(current?.status ?? "");

  return (
    <ReducedMotionModal
      visible={open}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            paddingHorizontal: 16,
            paddingVertical: 12,
          }}
        >
          <Text
            numberOfLines={2}
            {...typeCap("title")}
            style={{
              color: t.fg,
              ...typeStyle("title"),
              fontFamily: FONT.bold,
              flexShrink: 1,
            }}
          >
            {current?.nodeID ? `Node ${current.nodeID}` : "Unnamed split"}
          </Text>
          <Pressable
            onPress={props.onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={{
              minWidth: 44,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("body")}
              style={{
                color: t.accent,
                ...typeStyle("body"),
                fontFamily: FONT.semibold,
              }}
            >
              Done
            </Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 14 }}
        >
          <View
            style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}
          >
            <Pill
              label={status}
              tone={flowAbStatusTone(current?.status ?? "")}
              size="md"
              accessibilityLabel={`Status ${status}`}
            />
            <Pill
              label={`Automation ${current?.automationID || EMDASH}`}
              tone="neutral"
              accessibilityLabel={
                current?.automationID
                  ? `Automation ${current.automationID}`
                  : "Automation not recorded"
              }
            />
          </View>

          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {collectionLine(
              totals.assigned,
              totals.measuredVariants,
              totals.totalVariants,
            )}
          </Text>

          {winner ? (
            <View
              accessible
              accessibilityLabel={`${winner.headline}. ${winner.detail}${
                current?.winner?.evaluatedAt
                  ? `. Evaluated ${dateTime(current.winner.evaluatedAt)}`
                  : ""
              }`}
              style={{
                backgroundColor: t.surface,
                borderColor:
                  winner.tone === "success" ? t.success : t.borderSubtle,
                borderWidth: 1,
                borderRadius: 14,
                padding: 14,
                gap: 6,
              }}
            >
              <Text
                {...typeCap("body")}
                style={{
                  color: t.fg,
                  ...typeStyle("body"),
                  fontFamily: FONT.semibold,
                }}
              >
                {winner.headline}
              </Text>
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                }}
              >
                {winner.detail}
              </Text>
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                }}
              >
                {current?.winner?.evaluatedAt
                  ? `Evaluated ${dateTime(current.winner.evaluatedAt)} — the counters below may have moved since.`
                  : "Evaluation time not recorded."}
              </Text>
            </View>
          ) : null}

          <SectionLabel subtitle={leaderSubtitle(leader)}>Arms</SectionLabel>

          {props.resultsFailed ? (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.danger,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              The live counters could not be loaded, so every rate below is
              unknown rather than zero. Pull to refresh the list and reopen.
            </Text>
          ) : null}
          {props.resultsLoading && props.results.length === 0 ? (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              Loading counters…
            </Text>
          ) : null}

          {rows.map((row) => (
            <FlowAbVariantCard
              key={row.variantID}
              row={row}
              isLeader={leader.kind === "ahead" && leader.variantID === row.variantID}
            />
          ))}

          <MobileScopeNotice body={FLOW_AB_SCOPE_NOTE} />
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

/** The subtitle under "Arms" — the only comparative claim on this screen. */
export function leaderSubtitle(
  leader: ReturnType<typeof flowAbLeader>,
): string {
  switch (leader.kind) {
    case "no_comparison":
      return "Fewer than two arms have any assignments, so there is nothing to compare.";
    case "insufficient":
      return `Too few assignments to compare — the smaller arm has ${num(leader.smallest)}, below the ${num(leader.floor)} this screen requires before naming a leader.`;
    case "level":
      return "The two leading arms are level to the tenth of a point shown.";
    case "ahead":
      return `${leader.label} is ahead by ${leader.marginPoints.toFixed(1)} points. Ahead is not a result — the winner is decided by the evaluation on desktop.`;
  }
}
