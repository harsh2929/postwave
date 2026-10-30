/**
 * FlowAbTestRow — one in-flow split, led by whether it is still collecting.
 *
 * THE STATUS COMES FIRST because it is the thing that decides whether the
 * numbers underneath mean anything: a `completed` test's counters are a
 * historical record, a `running` test's are a live measurement, and reading
 * one as the other is the mistake this row exists to prevent.
 *
 * NO COLOUR-ONLY STATE. The status badge carries a word, the variant count
 * carries a word, and the row's single accessibility label spells all of it
 * out — the tint is reinforcement, never the message.
 *
 * ONE ACCESSIBILITY STOP, NOT FIVE. Ungrouped, VoiceOver reads a row as
 * "Running", "3 variants", "node abc", then a date, with no relationship
 * between them. Grouped, it is one button that says what the test is and what
 * state it is in.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import {
  flowAbStatusLabel,
  flowAbStatusTone,
} from "@/lib/flowAbPolicy";
import type { MobileFlowAbTest } from "@/lib/flowAbTests";
import { dateTime, plural, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface FlowAbTestRowProps {
  test: MobileFlowAbTest;
  onPress: (test: MobileFlowAbTest) => void;
  now: number;
}

/**
 * The node id IS the title. There is no name column on
 * `automation_flow_ab_tests` and no route that resolves an automation id to a
 * journey name from this payload, so inventing a friendly title would mean
 * inventing the thing it named.
 */
function testTitle(test: MobileFlowAbTest): string {
  return test.nodeID ? `Node ${test.nodeID}` : "Unnamed split";
}

export function FlowAbTestRow({ test, onPress, now }: FlowAbTestRowProps) {
  const { t } = useTheme();
  const status = flowAbStatusLabel(test.status);
  const tone = flowAbStatusTone(test.status);
  const variants = plural(test.variants.length, "variant");
  const updated = test.updatedAt
    ? `Updated ${relativeTime(test.updatedAt, { now })}`
    : "Update time not recorded";
  const verdict = test.winner
    ? test.winner.significant
      ? "A winner has been recorded"
      : "Evaluated, inconclusive"
    : "Not evaluated yet";

  const spoken = [
    `${testTitle(test)}.`,
    `${status}.`,
    `${variants}.`,
    `${verdict}.`,
    updated,
  ].join(" ");

  return (
    <Pressable
      onPress={() => onPress(test)}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint="Opens the split's per-variant counters"
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 10,
        minHeight: 44,
        gap: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <Pill
          label={status}
          tone={tone}
          size="md"
          accessibilityLabel={`Status ${status}`}
        />
        <Pill label={variants} tone="neutral" accessibilityLabel={variants} />
      </View>

      <Text
        numberOfLines={2}
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          fontFamily: FONT.semibold,
        }}
      >
        {testTitle(test)}
      </Text>

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {verdict} · {updated}
        {test.updatedAt ? ` · ${dateTime(test.updatedAt)}` : ""}
      </Text>
    </Pressable>
  );
}
