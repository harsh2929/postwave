/**
 * ApiUsageParts — the leaf pieces of the API usage & cost section: the stat
 * tiles, the per-key rows, the cost-totals table, one ledger line, and the
 * failure block they all share.
 *
 * Every row is ONE accessibility element carrying a spoken sentence from
 * lib/apiUsageDashboard, with its visual children hidden — the UsageBar
 * pattern — so VoiceOver reads "Sends (30d): 1,234, 41/day average." rather
 * than four detached strings.
 *
 * `SectionFailure` exists so a failed read is never a blank slot: it names
 * WHICH read failed, carries the status-aware sentence, and offers Retry only
 * when errorPresentation says a retry can help.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, type TextStyle, View } from "react-native";

import {
  aggregateRowLabel,
  aggregateTotals,
  fmtCentsAsDollars,
  type ApiUsageKeyRow,
  type CostAggregateRow,
  type CostGroupBy,
} from "@/lib/apiUsage";
import {
  costRowSpoken,
  costTotalsSpoken,
  keyRowMeta,
  keyRowSpoken,
  keyRowTitle,
  moreKeysCopy,
  TOP_KEYS_SHOWN,
  topKeys,
  type LedgerLine,
  type UsageStat,
} from "@/lib/apiUsageDashboard";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const HIDE_CHILDREN = {
  importantForAccessibility: "no-hide-descendants" as const,
  accessibilityElementsHidden: true,
};

export function MutedLine({
  children,
  style,
}: {
  children: string;
  style?: TextStyle | undefined;
}) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.fgSubtle,
        fontFamily: FONT.regular,
        ...typeStyle("bodySmall"),
        ...style,
      }}
    >
      {children}
    </Text>
  );
}

export function SectionFailure({
  what,
  message,
  retryable,
  onRetry,
}: {
  /** "API usage", "Cost totals", "Cost ledger" — names the failed read. */
  what: string;
  message: string;
  retryable: boolean;
  onRetry: () => void;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        marginBottom: 12,
        gap: 4,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fg,
          fontFamily: FONT.semibold,
          ...typeStyle("callout"),
        }}
      >
        {`${what} couldn't be loaded.`}
      </Text>
      <MutedLine>{message}</MutedLine>
      {retryable ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={`Retry loading ${what.toLowerCase()}`}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.accent,
              fontFamily: FONT.semibold,
              ...typeStyle("control"),
            }}
          >
            Retry
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Figure({ children, muted }: { children: string; muted?: boolean }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("numeric")}
      style={{
        color: muted ? t.fgMuted : t.fg,
        fontFamily: muted ? FONT.regular : FONT.medium,
        ...typeStyle("numeric"),
        fontVariant: ["tabular-nums"],
        textAlign: "right",
      }}
    >
      {children}
    </Text>
  );
}

export function StatGrid({ stats }: { stats: readonly UsageStat[] }) {
  const { t } = useTheme();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {stats.map((s) => (
        <View
          key={s.key}
          accessible
          accessibilityLabel={s.spoken}
          style={{
            flexBasis: "48%",
            flexGrow: 1,
            backgroundColor: t.surface,
            borderColor: t.borderSubtle,
            borderWidth: 1,
            borderRadius: 12,
            padding: 12,
          }}
        >
          <View {...HIDE_CHILDREN}>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                fontFamily: FONT.regular,
                ...typeStyle("caption"),
              }}
            >
              {s.label}
            </Text>
            <Text
              {...typeCap("heading")}
              style={{
                color: t.fg,
                fontFamily: FONT.semibold,
                ...typeStyle("heading"),
                fontVariant: ["tabular-nums"],
                marginTop: 2,
              }}
            >
              {s.value}
            </Text>
            {s.hint ? (
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fgSubtle,
                  fontFamily: FONT.regular,
                  ...typeStyle("label"),
                  marginTop: 2,
                }}
              >
                {s.hint}
              </Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

function RowShell({
  spoken,
  children,
}: {
  spoken: string;
  children: React.ReactNode;
}) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={spoken}
      style={{
        borderBottomColor: t.borderSubtle,
        borderBottomWidth: 1,
        paddingVertical: 8,
      }}
    >
      <View
        {...HIDE_CHILDREN}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        {children}
      </View>
    </View>
  );
}

export function KeyRows({ rows }: { rows: readonly ApiUsageKeyRow[] }) {
  const { t } = useTheme();
  const shown = topKeys(rows);
  const more = moreKeysCopy(rows.length, TOP_KEYS_SHOWN);
  if (shown.length === 0) return null;
  return (
    <View style={{ marginTop: 16 }}>
      <Text
        accessibilityRole="header"
        {...typeCap("body")}
        style={{
          color: t.fg,
          fontFamily: FONT.semibold,
          ...typeStyle("body"),
          marginBottom: 4,
        }}
      >
        Usage by API key
      </Text>
      {shown.map((row) => (
        <RowShell key={row.id} spoken={keyRowSpoken(row)}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              numberOfLines={1}
              {...typeCap("body")}
              style={{
                color: t.fg,
                fontFamily: FONT.medium,
                ...typeStyle("body"),
              }}
            >
              {keyRowTitle(row)}
            </Text>
            {keyRowMeta(row) ? (
              <Text
                numberOfLines={1}
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  fontFamily: FONT.regular,
                  ...typeStyle("caption"),
                }}
              >
                {keyRowMeta(row)}
              </Text>
            ) : null}
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Figure>{`${num(row.sends)} sends`}</Figure>
            <Figure muted>{fmtCentsAsDollars(row.costCents)}</Figure>
          </View>
        </RowShell>
      ))}
      {more ? <MutedLine style={{ marginTop: 6 }}>{more}</MutedLine> : null}
    </View>
  );
}

export function CostRows({
  rows,
  by,
}: {
  rows: readonly CostAggregateRow[];
  by: CostGroupBy;
}) {
  const { t } = useTheme();
  const totals = aggregateTotals(rows);
  return (
    <View>
      {rows.map((row, idx) => (
        // aggregateRowLabel collapses blank buckets to one placeholder, so
        // the label alone is not unique; the index makes the key distinct.
        <RowShell key={`${aggregateRowLabel(row, by)}:${idx}`} spoken={costRowSpoken(row, by)}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              numberOfLines={1}
              {...typeCap("body")}
              style={{
                color: t.fg,
                fontFamily: FONT.medium,
                ...typeStyle("body"),
              }}
            >
              {aggregateRowLabel(row, by)}
            </Text>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                fontFamily: FONT.regular,
                ...typeStyle("caption"),
              }}
            >
              {`${num(row.count)} entries · qty ${num(row.quantity)}`}
            </Text>
          </View>
          <Figure>{fmtCentsAsDollars(row.cents)}</Figure>
        </RowShell>
      ))}
      <View
        accessible
        accessibilityLabel={costTotalsSpoken(rows)}
        style={{ paddingVertical: 8 }}
      >
        <View
          {...HIDE_CHILDREN}
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              fontFamily: FONT.semibold,
              ...typeStyle("body"),
            }}
          >
            Total
          </Text>
          <Figure>{fmtCentsAsDollars(totals.cents)}</Figure>
        </View>
      </View>
    </View>
  );
}

export function LedgerRow({ line }: { line: LedgerLine }) {
  const { t } = useTheme();
  return (
    <RowShell spoken={line.spoken}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          {...typeCap("body")}
          style={{
            color: t.fg,
            fontFamily: FONT.medium,
            ...typeStyle("body"),
          }}
        >
          {line.kind}
        </Text>
        <Text
          numberOfLines={1}
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            ...typeStyle("caption"),
          }}
        >
          {`${line.when} · key ${line.key}`}
        </Text>
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Figure>{line.cost}</Figure>
        <Figure muted>{`qty ${line.quantity}`}</Figure>
      </View>
    </RowShell>
  );
}
