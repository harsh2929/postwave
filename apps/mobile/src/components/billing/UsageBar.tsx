/**
 * UsageBar — one metered resource on the Plan & usage screen.
 *
 * Accessibility is the reason this is its own component. The original inline
 * version was four unrelated a11y nodes — a label, a count, an unlabelled fill
 * View, and a separate "Over the plan limit." warning — so VoiceOver read
 * "Monthly sends" then "18,432 / 50,000" as two loose strings and said nothing
 * at all about the bar or the breach. Here the whole row is ONE element with
 * `accessibilityRole="progressbar"`, an `accessibilityValue` carrying the real
 * min/max/now, and a spoken sentence that names the resource, the counts and
 * the over-limit state. The children are hidden from the a11y tree so the
 * sentence is not read twice.
 *
 * The colour-coded fill is never the only signal: an exceeded row also renders
 * the words "Over the plan limit."
 */
import { Text, View } from "react-native";

import { usageBarSpoken, usageResourceLabel } from "@/lib/billingNormalize";
import type { PlanUsageRow } from "@/lib/billingNormalize";
import { FONT } from "@/lib/fonts";
import { num, percent } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface UsageBarProps {
  row: PlanUsageRow;
  /** Rendered under the bar — e.g. the send-cap projection. */
  footnote?: { text: string; tone: "warning" | "neutral" } | undefined;
}

export function UsageBar({ row, footnote }: UsageBarProps) {
  const { t } = useTheme();
  const unlimited = row.limit <= 0;
  // `percent` is already clamped to 0..100 and guaranteed finite by
  // normalizePlanSummary, so this can never become width: "NaN%".
  const pct = row.percent;
  const barColor = row.exceeded ? t.danger : t.accent;
  const spoken = footnote ? `${usageBarSpoken(row)} ${footnote.text}` : usageBarSpoken(row);

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={spoken}
      accessibilityValue={{
        min: 0,
        max: unlimited ? 0 : row.limit,
        now: row.current,
        text: percent(pct, { alreadyPercent: true, digits: 0 }),
      }}
      style={{ marginBottom: 16 }}
    >
      <View
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 6,
          }}
        >
          {/* The resource name is prose and reflows (flex: 1); the counts
              beside it are a tabular figure pinned to the row's right edge,
              so they take the tighter DENSE ceiling. */}
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              fontFamily: FONT.medium,
              ...typeStyle("body"),
              flex: 1,
            }}
          >
            {usageResourceLabel(row.resource)}
          </Text>
          <Text
            {...typeCap("numeric")}
            style={{
              color: t.fgMuted,
              fontFamily: FONT.regular,
              ...typeStyle("numeric"),
              fontVariant: ["tabular-nums"],
            }}
          >
            {unlimited
              ? `${num(row.current)} · unlimited`
              : `${num(row.current)} / ${num(row.limit)}`}
          </Text>
        </View>
        {!unlimited ? (
          <View
            style={{
              height: 8,
              borderRadius: 4,
              backgroundColor: t.border,
              overflow: "hidden",
            }}
          >
            <View
              style={{
                width: `${pct}%`,
                height: "100%",
                backgroundColor: barColor,
              }}
            />
          </View>
        ) : null}
        {row.exceeded ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.danger,
              fontFamily: FONT.regular,
              ...typeStyle("label"),
              marginTop: 4,
            }}
          >
            Over the plan limit.
          </Text>
        ) : null}
        {footnote ? (
          <Text
            {...typeCap("label")}
            style={{
              color: footnote.tone === "warning" ? t.warning : t.fgSubtle,
              fontFamily: FONT.regular,
              ...typeStyle("label"),
              marginTop: 4,
            }}
          >
            {footnote.text}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
