/**
 * DmarcReportRow — one raw DMARC aggregate report.
 *
 * Extracted from the screen so the route file stays a composition of filters
 * and a list rather than 160 lines of row JSX (and so the screen keeps its
 * source budget). The row is inert-looking no longer: tapping it expands the
 * reporter, published policy, arrival time and report id in place — four lines
 * of text, not a screen.
 */
import { memo } from "react";
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import type { DmarcReport } from "@/hooks/useDmarcOps";
import {
  passRate,
  policyLabel,
  policyTone,
  reportAge,
  reportDateRange,
} from "@/lib/dmarcView";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface DmarcReportRowProps {
  row: DmarcReport;
  expanded: boolean;
  /**
   * Takes the row rather than closing over it, so the screen can hand every
   * cell ONE stable callback. An `onToggle={() => ...}` built inside
   * `renderItem` is a changed prop on a `React.memo`'d row, which made
   * expanding one report re-render every other visible one.
   */
  onToggle: (row: DmarcReport) => void;
  /** Ticking clock so "received 3h ago" does not freeze on a mounted screen. */
  now: number;
}

function DmarcReportRowImpl({
  row,
  expanded,
  onToggle,
  now,
}: DmarcReportRowProps) {
  const { t } = useTheme();
  const rate = passRate(row.passCount, row.failCount);
  const policy = policyLabel(row);
  const dateText = reportDateRange(row.dateBegin, row.dateEnd);
  const a11y = `${row.domain || "Unknown domain"}, ${rate.label}, ${num(row.passCount)} passing, ${num(row.failCount)} failing, ${dateText}${policy ? `, ${policy}` : ""}`;
  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityHint={
        expanded ? "Hides the report details" : "Shows the report details"
      }
      accessibilityState={{ expanded }}
      onPress={() => onToggle(row)}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            flex: 1,
          }}
          numberOfLines={1}
        >
          {row.domain || "Unknown domain"}
        </Text>
        <Pill
          label={rate.label}
          tone={rate.tone === "neutral" ? "neutral" : rate.tone}
        />
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          marginTop: 4,
          flexWrap: "wrap",
        }}
      >
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {row.orgName || "Unknown reporter"}
        </Text>
        {policy ? (
          <Pill
            label={policy}
            tone={policyTone(row) === "neutral" ? "neutral" : policyTone(row)}
          />
        ) : null}
      </View>
      <View
        style={{
          flexDirection: "row",
          gap: 12,
          marginTop: 8,
          flexWrap: "wrap",
        }}
      >
        <Text
          {...typeCap("numeric")}
          style={{
            color: t.success,
            ...typeStyle("numeric"),
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
        >
          {`Pass ${num(row.passCount)}`}
        </Text>
        <Text
          {...typeCap("numeric")}
          style={{
            color: row.failCount > 0 ? t.danger : t.fgSubtle,
            ...typeStyle("numeric"),
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
        >
          {`Fail ${num(row.failCount)}`}
        </Text>
        <Text
          {...typeCap("numeric")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("numeric"),
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
        >
          {`Total ${num(rate.total)}`}
        </Text>
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 6,
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
        numberOfLines={1}
      >
        {dateText}
      </Text>
      {expanded ? (
        <View
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            gap: 4,
          }}
        >
          <DetailLine label="Reporter" value={row.orgName || "—"} />
          <DetailLine
            label="Published policy"
            value={policy ?? "None published"}
          />
          <DetailLine
            label="Received"
            value={reportAge(row.receivedAt, now) ?? "—"}
          />
          <DetailLine label="Report ID" value={row.id || "—"} mono />
        </View>
      ) : null}
    </Pressable>
  );
}

export const DmarcReportRow = memo(DmarcReportRowImpl);

/** One label/value pair inside an expanded report. */
function DetailLine({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 10,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      <Text
        selectable
        {...typeCap(mono ? "mono" : "caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle(mono ? "mono" : "caption"),
          fontFamily: mono ? "Menlo" : FONT.regular,
          flexShrink: 1,
          textAlign: "right",
        }}
        numberOfLines={2}
        ellipsizeMode="middle"
      >
        {value}
      </Text>
    </View>
  );
}
