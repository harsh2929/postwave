/**
 * FlowAbVariantCard — one arm of an in-flow split.
 *
 * THE UNMEASURED CASE IS A FIRST-CLASS BRANCH, NOT A FALLBACK VALUE. The
 * counter table only gains a row once the automation runtime has bucketed
 * somebody into that variant, so a configured arm nobody has entered has NO
 * row — it has not converted at 0%, it has not been measured. Rendering "0%"
 * there would tell an operator their variant is failing when it is simply not
 * receiving traffic, which is a completely different problem with a completely
 * different fix. So `measured: false` renders em-dashes and says why.
 *
 * THE CONTROL IS MARKED because the server's own evaluation is a comparison
 * AGAINST it (`controlVariantID` = `Variants[0].ID`, flowabtests.go:295). A
 * reader who does not know which arm is the baseline cannot interpret the
 * verdict above.
 *
 * SPOKEN VALUES ARE EXACT. The rate is rendered to one decimal place; the
 * accessibility label carries the raw counts it was derived from, so a screen
 * reader user gets the numerator and denominator rather than a rounded
 * percentage (house rule 4).
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import type { FlowAbVariantRow } from "@/lib/flowAbPolicy";
import { TINT_ALPHA, withAlpha } from "@/lib/color";
import { EMDASH, num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface FlowAbVariantCardProps {
  row: FlowAbVariantRow;
  /** True for the arm `flowAbLeader` reports as ahead. Never a "winner". */
  isLeader?: boolean | undefined;
}

/** `conversion_rate` is a 0..1 FRACTION (flowabtests.go:190). */
export function formatConversionRate(row: FlowAbVariantRow): string {
  if (!row.measured) return EMDASH;
  return `${(row.conversionRate * 100).toFixed(1)}%`;
}

export function variantSpokenLabel(row: FlowAbVariantRow): string {
  const parts = [row.label];
  if (row.isControl) parts.push("control");
  if (row.unconfigured) parts.push("not in the current configuration");
  if (!row.measured) {
    parts.push("no assignments recorded, so no conversion rate");
    return parts.join(". ");
  }
  parts.push(
    `${num(row.converted)} converted of ${num(row.assigned)} assigned`,
    `conversion rate ${formatConversionRate(row)}`,
  );
  return parts.join(". ");
}

export function FlowAbVariantCard({ row, isLeader }: FlowAbVariantCardProps) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={variantSpokenLabel(row)}
      style={{
        backgroundColor: isLeader ? withAlpha(t.accent, TINT_ALPHA) : t.surface,
        borderColor: isLeader ? t.accent : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
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
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
        >
          {row.label}
        </Text>
        {row.isControl ? <Pill label="Control" tone="info" /> : null}
        {isLeader ? <Pill label="Ahead" tone="accent" /> : null}
        {row.unconfigured ? <Pill label="Not configured" tone="warning" /> : null}
      </View>

      <Text
        {...typeCap("figure")}
        style={{
          color: row.measured ? t.fg : t.fgSubtle,
          ...typeStyle("figure"),
          fontFamily: FONT.bold,
        }}
      >
        {formatConversionRate(row)}
      </Text>

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {row.measured
          ? `${num(row.converted)} converted of ${num(row.assigned)} assigned`
          : "No assignments recorded — the runtime has not bucketed anyone into this arm"}
      </Text>

      {row.percentage === null ? null : (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          Authored traffic share {row.percentage}%
        </Text>
      )}
    </View>
  );
}
