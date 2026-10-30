/**
 * SinkMetrics — the audit-sinks header strip: three counters and the
 * "is this current?" line under them.
 *
 * Two things this file exists to fix, both flagged by the governance audit:
 *
 *  - The screen declared its own `card(t)` / `sectionLabel(t)` style factories,
 *    byte-identical to three other enterprise screens and to the real shared
 *    components. The tiles here are `Card`, and the screen's headings are
 *    `SectionLabel` — so a change to card radius is one edit, not five.
 *  - A compliance surface with no freshness signal reads identically whether it
 *    was fetched a second ago or resumed from background two hours later.
 *    `SinkFreshness` states the age of the data, and states it in the SPOKEN
 *    label too, so the answer is available without sight.
 *
 * The counters deliberately render an em-dash rather than `0` when a query
 * failed or never ran: on a monitoring surface a confident zero reads as an
 * all-clear, which is the most dangerous thing an unfetched screen can say.
 */
import { Text, View } from "react-native";

import { Card } from "@/components/Card";
import { type PillTone } from "@/components/Pill";
import { freshnessSentence } from "@/lib/auditGrouping";
import { EMDASH, num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export interface SinkMetricProps {
  label: string;
  value: number | string;
  tone: PillTone;
}

/** One counter tile. */
export function SinkMetric({ label, value, tone }: SinkMetricProps) {
  const { t } = useTheme();
  const color =
    tone === "danger" ? t.danger : tone === "warning" ? t.warning : t.info;
  const display = typeof value === "number" ? num(value) : value;
  return (
    <Card
      variant="compact"
      style={{ flex: 1 }}
      accessible
      accessibilityLabel={
        display === EMDASH ? `${label} unavailable` : `${display} ${label}`
      }
    >
      <Text
        // `figure` is the tightest ceiling in the scale because this tile is
        // one cell of a fixed three-column row — at 3x the row, not just the
        // glyph, is destroyed. No `lineHeight` here: a fixed leading fights
        // the `adjustsFontSizeToFit` shrink pass, which is why this takes
        // `fontSizeFor` rather than the full `typeStyle`.
        {...typeCap("figure")}
        style={{
          color,
          fontSize: fontSizeFor("figure"),
          fontWeight: "700",
          fontFamily: FONT.display,
          fontVariant: ["tabular-nums"],
        }}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
      >
        {display}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          marginTop: 2,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
        }}
        numberOfLines={2}
      >
        {label}
      </Text>
    </Card>
  );
}

export interface SinkMetricStripProps {
  /** Sinks whose breaker is not closed. */
  open: number | string;
  /** Sinks with at least one consecutive failure. */
  failing: number | string;
  /** Dead-lettered batches waiting for replay. */
  dlq: number | string;
}

export function SinkMetricStrip({ open, failing, dlq }: SinkMetricStripProps) {
  return (
    <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
      <SinkMetric label="Circuit open" value={open} tone="danger" />
      <SinkMetric label="Failing" value={failing} tone="warning" />
      <SinkMetric label="DLQ" value={dlq} tone="info" />
    </View>
  );
}

/**
 * "Sink health as of 3m ago."
 *
 * The sentence itself is built by `freshnessSentence` in lib/auditGrouping —
 * a pure, node-testable module — so the wording and the never-loaded case are
 * asserted without mounting react-native. This component only paints it.
 */
export function SinkFreshness({
  updatedAt,
  now,
}: {
  updatedAt: number | null | undefined;
  now?: number;
}) {
  const { t } = useTheme();
  const line = freshnessSentence("Sink health", updatedAt, now);
  if (!line) return null;
  return (
    <Text
      {...typeCap("caption")}
      accessibilityLabel={line}
      style={{
        color: t.fgSubtle,
        marginBottom: 12,
        fontFamily: FONT.regular,
        ...typeStyle("caption"),
      }}
    >
      {line}
    </Text>
  );
}
