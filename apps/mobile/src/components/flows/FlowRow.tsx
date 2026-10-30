/**
 * FlowRow — one flow in the catalogue.
 *
 * The row answers, before any tap: what is this flow called, what does its
 * status actually MEAN given the runtime is contained, how big is it, what
 * starts it, and — the fact visible nowhere else on a phone — whether a
 * subscriber may ever enter it twice.
 *
 * RE-ENTRY IS ON THE ROW ON PURPOSE. `re_enrollment` sat unread for a year,
 * which meant a subscriber entered a flow ONCE EVER; that was the 2026
 * frontier audit's P0. An abandoned-cart or win-back flow left on "Enters
 * once" is a silent misconfiguration that costs revenue quietly, and it is
 * exactly the sort of thing someone notices while scrolling on a phone.
 *
 * THE STATUS PILL IS RUNTIME-AWARE. `flowStatusPresentation` takes the
 * server's own `execution_enabled` because "active" is a column value, not a
 * claim about the world — see the header of lib/flowTopology.
 *
 * NativeWind v4 gotcha: static Pressable style objects only — a function-style
 * `style={({pressed}) => …}` silently drops layout on this stack.
 */
import { memo } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { EMDASH, plural, relativeTime } from "@/lib/format";
import { STATIC_FLOW_LABELS, type FlowLabels } from "@/lib/flowCatalog";
import {
  flowRuntimeExecuting,
  flowStatusPresentation,
  reEnrollmentLabel,
} from "@/lib/flowTopology";
import type { MobileFlow } from "@/lib/flowWire";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface FlowRowProps {
  flow: MobileFlow;
  onPress: (flow: MobileFlow) => void;
  /** `Date.now()` from the screen's ticker, so "edited 2h ago" stays honest. */
  now: number;
  /** Server catalogue labels; the built-in mirror when none has arrived. */
  labels?: FlowLabels;
}

function FlowRowImpl({
  flow,
  onPress,
  now,
  labels = STATIC_FLOW_LABELS,
}: FlowRowProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();

  const executing = flowRuntimeExecuting(flow.runtime);
  const status = flowStatusPresentation(flow.status, executing);
  const reEntry = reEnrollmentLabel(
    flow.reEnrollment,
    flow.reEnrollmentCooldownHours,
  );

  // A flow with no triggers cannot be entered at all. That is a real fact, and
  // an em-dash would understate it, so it gets words.
  const triggers =
    flow.triggers.length === 0
      ? "No trigger"
      : flow.triggers.map((trigger) => labels.trigger(trigger.type)).join(", ");

  const size = `${plural(flow.nodes.length, "step")}`;
  // `updated_at` is NOT NULL server-side, but a null here must read as absent
  // rather than as "just now".
  const edited = flow.updatedAt
    ? `Edited ${relativeTime(flow.updatedAt, { now })}`
    : `Edited ${EMDASH}`;

  return (
    <Pressable
      onPress={() => onPress(flow)}
      accessibilityRole="button"
      accessibilityLabel={`${flow.name}. ${status.spoken} ${size}. Starts on: ${triggers}. ${reEntry}.`}
      accessibilityHint="Opens the flow's steps and version history"
      style={{
        backgroundColor: t.surface,
        borderColor: status.tone === "warning" ? t.warning : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 10,
        gap: 6,
        // 44pt is the touch-target floor; the content already exceeds it, and
        // stating it keeps a future compaction from dropping below.
        minHeight: 44,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          numberOfLines={maxLinesAtScale(2, fontScale)}
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
        >
          {flow.name}
        </Text>
        <Pill
          label={status.label}
          tone={status.tone === "info" ? "info" : status.tone}
          accessibilityLabel={status.spoken}
        />
      </View>

      <Text
        numberOfLines={maxLinesAtScale(1, fontScale)}
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {size} {EMDASH} {edited}
      </Text>

      <Text
        numberOfLines={maxLinesAtScale(2, fontScale)}
        {...typeCap("bodySmall")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        Starts on: {triggers}
      </Text>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <Pill
          label={reEntry}
          tone={flow.reEnrollment === "once" ? "neutral" : "info"}
          accessibilityLabel={`Re-entry policy: ${reEntry}`}
        />
      </View>
    </Pressable>
  );
}

export const FlowRow = memo(FlowRowImpl);
