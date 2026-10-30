/**
 * DmarcInsightsCard — the ACTIONABLE half of DMARC, which mobile never showed.
 *
 * Desktop's DMARC page states the redesign thesis outright: the raw report
 * list was demoted BELOW the insights so an operator sees what to FIX first.
 * Mobile shipped only the demoted half — a feed of pass/fail counts with no
 * alignment trend, no failing sources and none of the server's suggestions.
 *
 * Rendered here:
 *  - alignment over time as a sparkline with a spoken summary (a chart with no
 *    text alternative is unreadable to a screen reader AND to anyone who
 *    cannot resolve a 2px line);
 *  - the three-way disposition split as a labelled bar;
 *  - the server's suggestions, toned by severity, each with a Share action for
 *    the DNS record it wants published — the one thing a phone can actually do
 *    with a suggestion, since publishing it means pasting it into a registrar;
 *  - top failing sources by IP.
 */
import { Pressable, Share, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FailingSourcesCard } from "@/components/deliverability/FailingSourcesCard";
import { SkeletonCard } from "@/components/Skeleton";
import { Sparkline } from "@/components/charts/Sparkline";
import type { DmarcInsights } from "@/lib/deliverabilityContracts";
import { severityTone, type SignalTone } from "@/lib/deliverabilitySignals";
import { FONT } from "@/lib/fonts";
import { num, percent } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface DmarcInsightsCardProps {
  insights: DmarcInsights | undefined;
  loading: boolean;
  /** Non-null when the insights fetch failed or could not run. */
  unavailableReason: string | null;
  onShareFailed: (message: string) => void;
  /** Present the per-source drill-down; omit to render the list inert. */
  onOpenSource?: ((ip: string) => void) | undefined;
}

function pillTone(
  tone: SignalTone,
): "neutral" | "success" | "warning" | "danger" | "info" {
  return tone === "neutral" ? "neutral" : tone;
}

function Card({ children }: { children: React.ReactNode }) {
  const { t } = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 10,
        gap: 10,
      }}
    >
      {children}
    </View>
  );
}

/** The two non-data states, so the main component stays about the data. */
function Placeholder({ title, body }: { title?: string; body: string }) {
  const { t } = useTheme();
  return (
    <Card>
      {title ? (
        <Text
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            fontFamily: FONT.semibold,
          }}
        >
          {title}
        </Text>
      ) : null}
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {body}
      </Text>
    </Card>
  );
}

export function DmarcInsightsCard({
  insights,
  loading,
  unavailableReason,
  onShareFailed,
  onOpenSource,
}: DmarcInsightsCardProps) {
  const { t } = useTheme();

  if (unavailableReason) {
    return (
      <Placeholder
        title="Alignment insights unavailable"
        body={unavailableReason}
      />
    );
  }
  // A bare "Loading…" string is the pattern this cluster removed everywhere
  // else; the shared Skeleton is reduce-motion aware and a11y-grouped.
  if (loading) return <SkeletonCard lines={3} />;
  if (!insights) {
    return <Placeholder body="Pick a domain to see alignment insights." />;
  }

  // The null check guards the PARENT, not its array field. `omitempty` drops an empty slice and the field is then undefined, so the iteration below throws on a payload the server considers valid.
  const series = (
    Array.isArray(insights.series) ? insights.series : []
  ).map((point) => point.alignedPct);
  const aligned = percent(insights.alignedPct, { digits: 1 });
  const total =
    insights.disposition.none +
    insights.disposition.quarantine +
    insights.disposition.reject;
  const segments: {
    key: string;
    value: number;
    color: string;
    label: string;
  }[] = [
    {
      key: "none",
      value: insights.disposition.none,
      color: t.success,
      label: "Delivered",
    },
    {
      key: "quarantine",
      value: insights.disposition.quarantine,
      color: t.warning,
      label: "Quarantined",
    },
    {
      key: "reject",
      value: insights.disposition.reject,
      color: t.danger,
      label: "Rejected",
    },
  ];

  return (
    <>
      <Card>
        <View
          accessible
          accessibilityLabel={`Alignment ${aligned} over ${insights.periodDays} days, across ${num(insights.totalMessages)} messages in ${num(insights.reportCount)} reports.`}
          style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.semibold,
                letterSpacing: 0.6,
                textTransform: "uppercase",
              }}
            >
              DMARC alignment
            </Text>
            {/* Hero figure sharing its row with a 104pt sparkline: the
                `figure` role's 1.25x ceiling is what keeps them side by side. */}
            <Text
              {...typeCap("figure")}
              style={{
                color: t.fg,
                fontSize: 26,
                lineHeight: 31,
                fontFamily: FONT.bold,
                fontVariant: ["tabular-nums"],
              }}
            >
              {aligned}
            </Text>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {`${num(insights.totalMessages)} messages · ${num(insights.reportCount)} reports${insights.latestPolicy ? ` · p=${insights.latestPolicy}` : ""}`}
            </Text>
          </View>
          {series.length > 1 ? (
            <Sparkline
              values={series}
              width={104}
              height={42}
              accessibilityLabel={`Alignment trend, ${series.length} days, latest ${aligned}`}
            />
          ) : null}
        </View>

        {total > 0 ? (
          <View
            accessible
            accessibilityLabel={segments
              .map((s) => `${s.label} ${num(s.value)}`)
              .join(", ")}
            style={{ gap: 6 }}
          >
            <View
              style={{
                flexDirection: "row",
                height: 10,
                borderRadius: 5,
                overflow: "hidden",
                backgroundColor: t.bgSubtle,
              }}
            >
              {segments.map((segment) =>
                segment.value > 0 ? (
                  <View
                    key={segment.key}
                    style={{
                      flexGrow: segment.value,
                      backgroundColor: segment.color,
                    }}
                  />
                ) : null,
              )}
            </View>
            <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
              {segments.map((segment) => (
                <Text
                  key={segment.key}
                  {...typeCap("numeric")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("numeric"),
                    fontFamily: FONT.regular,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {`${segment.label} ${num(segment.value)}`}
                </Text>
              ))}
            </View>
          </View>
        ) : null}
      </Card>

      <SuggestionsCard
        suggestions={insights.suggestions}
        onShareFailed={onShareFailed}
      />

      <FailingSourcesCard
        sources={insights.topFailingSources}
        onOpenSource={onOpenSource}
      />
    </>
  );
}

/**
 * The server's suggestions, toned by severity, each with a Share action for
 * the DNS record it wants published — the one thing a phone can actually DO
 * with a suggestion, since publishing it means pasting it into a registrar.
 *
 * Its own component so the parent stays a composition rather than one 300-line
 * function; the split is the source budget's rule, and the seam is real.
 */
function SuggestionsCard({
  suggestions,
  onShareFailed,
}: {
  suggestions: DmarcInsights["suggestions"];
  onShareFailed: (message: string) => void;
}) {
  const { t } = useTheme();
  if (suggestions.length === 0) return null;
  return (
    <Card>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.bold,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        What to change
      </Text>
      {suggestions.map((suggestion) => (
        <View key={suggestion.code || suggestion.action} style={{ gap: 4 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <Pill
              label={suggestion.severity || "info"}
              tone={pillTone(severityTone(suggestion.severity))}
            />
            <Text
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontFamily: FONT.semibold,
                flexShrink: 1,
              }}
            >
              {suggestion.action}
            </Text>
          </View>
          {suggestion.reason ? (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              {suggestion.reason}
            </Text>
          ) : null}
          {suggestion.policyRecord ? (
            <Pressable
              onPress={() => {
                haptics.tap();
                void Share.share({
                  message: suggestion.policyRecord,
                }).catch(() => onShareFailed("Couldn't open the share sheet."));
              }}
              accessibilityRole="button"
              accessibilityLabel={`Share the suggested DMARC record: ${suggestion.policyRecord}`}
              hitSlop={8}
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text
                selectable
                {...typeCap("mono")}
                style={{
                  color: t.accent,
                  ...typeStyle("mono"),
                  fontFamily: "Menlo",
                }}
                numberOfLines={2}
                ellipsizeMode="middle"
              >
                {`${suggestion.policyRecord}  \u2934\uFE0E`}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </Card>
  );
}
