/**
 * FlowStepRow — one step in the vertical topology.
 *
 * Indent carries branch depth, a rail carries "there is more below", and the
 * leg label ("If yes" / "If no") carries which arm of a split you are reading.
 * That is the whole vocabulary; anything more becomes a diagram you navigate
 * rather than a list you read.
 *
 * THREE THINGS THIS ROW REFUSES TO DO
 *
 *  1. It never renders an unset field as a value. A `wait` with no
 *     `duration_seconds` says "not set", never "0 seconds" — lib/flowNodeDetail
 *     enforces that, and an incomplete fact is styled as a WARNING because the
 *     server's own validator treats it as the thing that makes a graph
 *     non-executable.
 *  2. It never uses colour alone. An incomplete step carries the word "not
 *     set" and an accessibility label that says so.
 *  3. It never claims an unreachable step is broken. "Nothing leads here" is
 *     a statement about the graph's wiring, which is what the reader is
 *     usually hunting for.
 *
 * INDENT IS CAPPED at FLOW_TOPOLOGY_MAX_DEPTH by the topology builder, so a
 * pathologically nested flow cannot push text off the right edge of a phone.
 *
 * NativeWind v4 gotcha: static style objects only.
 */
import { memo } from "react";
import { Text, useWindowDimensions, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { STATIC_FLOW_LABELS, type FlowLabels } from "@/lib/flowCatalog";
import { flowNodeFacts } from "@/lib/flowNodeDetail";
import { flowNodeKind, type FlowTopologyRow } from "@/lib/flowTopology";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

/** Points of indent per branch level. Small: depth is a hint, not a maze. */
const INDENT_STEP = 14;

export interface FlowStepRowProps {
  row: FlowTopologyRow;
  /** Ordinal shown in the rail, 1-based. */
  index: number;
  /** False for the last row, which draws no connector below itself. */
  hasNext: boolean;
  /**
   * How a node type becomes words. Defaults to the built-in mirror so this row
   * still renders correctly for any caller that has no catalogue in hand —
   * which is every caller before the catalogue query resolves.
   */
  labels?: FlowLabels;
}

function FlowStepRowImpl({
  row,
  index,
  hasNext,
  labels = STATIC_FLOW_LABELS,
}: FlowStepRowProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();

  const facts = flowNodeFacts(row.node);
  const incomplete = facts.some((fact) => fact.incomplete === true);
  const kind = flowNodeKind(row.node.type);
  const label = labels.node(row.node.type);

  const legLabel =
    row.leg === "true" ? "If yes" : row.leg === "false" ? "If no" : null;

  const spokenFacts = facts
    .map((fact) => `${fact.label}: ${fact.value}`)
    .join(". ");
  const spoken = [
    `Step ${index}`,
    legLabel,
    label,
    spokenFacts,
    row.unreachable ? "Nothing in this flow leads here." : null,
    incomplete
      ? "A required setting is missing, so this step cannot run."
      : null,
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <View
      accessible
      accessibilityLabel={spoken}
      style={{
        flexDirection: "row",
        gap: 10,
        marginStart: row.depth * INDENT_STEP,
      }}
    >
      {/* The rail: an ordinal and the connector to the next step. */}
      <View style={{ alignItems: "center", width: 24 }}>
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: incomplete ? t.warning : t.borderSubtle,
            backgroundColor: t.bgSubtle,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            {...typeCap("badgeSmall")}
            style={{
              color: incomplete ? t.warning : t.fgMuted,
              ...typeStyle("badgeSmall"),
              fontFamily: FONT.semibold,
            }}
          >
            {index}
          </Text>
        </View>
        {hasNext ? (
          <View
            // Decorative: the ordering it depicts is already in the spoken
            // label of every row, so announcing it again would be noise.
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ flex: 1, width: 1, backgroundColor: t.borderSubtle, minHeight: 12 }}
          />
        ) : null}
      </View>

      <View style={{ flex: 1, paddingBottom: hasNext ? 12 : 0, gap: 3 }}>
        {legLabel ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.semibold,
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
          >
            {legLabel}
          </Text>
        ) : null}

        <Text
          numberOfLines={maxLinesAtScale(2, fontScale)}
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
          }}
        >
          {label}
        </Text>

        {facts.map((fact) => (
          <Text
            key={fact.label}
            numberOfLines={maxLinesAtScale(2, fontScale)}
            {...typeCap("bodySmall")}
            style={{
              color: fact.incomplete === true ? t.warning : t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {fact.label}: {fact.value}
          </Text>
        ))}

        {row.unreachable ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.warning,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            Nothing in this flow leads here.
          </Text>
        ) : null}

        {/* The node id is the only handle a desktop editor shares with this
            preview, so it is worth carrying — quietly, at the bottom. */}
        <Text
          numberOfLines={1}
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {row.node.id}
          {kind === "split" && row.nextIds.length > 0
            ? ` · ${row.nextIds.length} outgoing`
            : ""}
        </Text>
      </View>
    </View>
  );
}

export const FlowStepRow = memo(FlowStepRowImpl);
