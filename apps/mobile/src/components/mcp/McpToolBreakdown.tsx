/**
 * McpToolBreakdown — which tools and which keys the window's calls came from,
 * plus the status-class split.
 *
 * `showShare` IS DELIBERATELY OFF ON BOTH CHARTS. BarChart's share is computed
 * against the sum of the rows it was handed, and these rows are the server's
 * `LIMIT 5` over `tool_name <> ''` (apikeycalls.go:379-385). A "62% of calls"
 * derived from that denominator would be a percentage of the top five, printed
 * next to a headline count of every call — two different denominators on one
 * card. The honest version is counts plus `mcpToolCoverageNotice`, which states
 * the shortfall in the server's own terms.
 *
 * THE STATUS SPLIT IS NOT A CHART. `statusBreakdown` has at most four rows and
 * they are ordinal classes, not a ranking; a bar chart would sort 5xx above 2xx
 * whenever failures dominated and imply the classes are comparable magnitudes
 * of the same thing. Four labelled counts read faster and cannot mislead.
 */
import { Text, View } from "react-native";

import { BarChart, type BarDatum } from "@/components/charts/BarChart";
import { SectionLabel } from "@/components/SectionLabel";
import { num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { mcpToolCoverageNotice, type McpStats } from "@/lib/mcpActivity";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** The server's own vocabulary for a status class, spelled out. */
const CLASS_WORD: Readonly<Record<number, string>> = {
  2: "2xx succeeded",
  3: "3xx redirected",
  4: "4xx rejected",
  5: "5xx server errors",
};

export function McpToolBreakdown({ stats }: { stats: McpStats }) {
  const { t } = useTheme();
  const coverage = mcpToolCoverageNotice(stats);

  const toolRows: BarDatum[] = stats.topTools.map((tool) => ({
    id: tool.toolName,
    label: tool.toolName,
    value: tool.calls,
  }));
  const keyRows: BarDatum[] = stats.topApiKeys.map((key) => ({
    id: key.apiKeyId || key.apiKeyPrefix || "unknown-key",
    // A deleted key row leaves `apiKeyId` null and the prefix behind; saying so
    // is better than a blank bar the reader cannot attribute to anything.
    label: key.apiKeyPrefix || "Deleted key",
    value: key.calls,
    ...(key.apiKeyId ? {} : { hint: "This key no longer exists" }),
  }));

  return (
    <View>
      <SectionLabel
        subtitle="The server returns the busiest five of each. Tool names come from an optional header, so untagged calls are counted in the headline but not here."
      >
        Where the calls came from
      </SectionLabel>

      {toolRows.length > 0 ? (
        <BarChart data={toolRows} title="Busiest tools" valueNoun="calls" />
      ) : (
        <Note text="No call in this window carried a tool name. That does not mean no tools ran — it means none of them set the tool header." />
      )}

      {coverage ? <Note text={coverage} /> : null}

      {keyRows.length > 0 ? (
        <View style={{ marginTop: 12 }}>
          <BarChart data={keyRows} title="Busiest keys" valueNoun="calls" />
        </View>
      ) : null}

      <SectionLabel>How they answered</SectionLabel>
      {stats.statusBreakdown.length === 0 ? (
        <Note text="No status classes were returned for this window." />
      ) : (
        <View
          style={{
            backgroundColor: t.surface,
            borderColor: t.borderSubtle,
            borderWidth: 1,
            borderRadius: 14,
            padding: 14,
            gap: 8,
          }}
        >
          {stats.statusBreakdown.map((row) => {
            const word = CLASS_WORD[row.statusClass] ?? `${row.statusClass}xx`;
            return (
              <View
                key={row.statusClass}
                accessible
                accessibilityLabel={`${word}, ${plural(row.calls, "call")}`}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  minHeight: 28,
                }}
              >
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("bodySmall"),
                    flex: 1,
                    fontFamily: FONT.regular,
                  }}
                  numberOfLines={1}
                >
                  {word}
                </Text>
                <Text
                  {...typeCap("numeric")}
                  style={{
                    color: t.fg,
                    ...typeStyle("numeric"),
                    fontVariant: ["tabular-nums"],
                    fontFamily: FONT.semibold,
                  }}
                >
                  {num(row.calls)}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

function Note({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("label")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("label"),
        marginTop: 8,
        fontFamily: FONT.regular,
      }}
    >
      {text}
    </Text>
  );
}
