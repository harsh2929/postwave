/**
 * AnomalyHistoryCard — what fired, when, and how bad.
 *
 * The card renders NOTHING when there is nothing to report. That is deliberate:
 * an "All clear" card on a healthy workspace would occupy the most valuable
 * space on the screen every day to say nothing, and would train the reader to
 * skip the region on the one day it matters.
 *
 * It also never says "spiked" without the evidence: the observed value, the
 * baseline it is being compared to, and the z-score all travel with the claim.
 * The multiple ("11× normal") is suppressed when the baseline is zero, because
 * "∞× normal" is not something anyone can act on.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { SectionLabel } from "@/components/SectionLabel";
import { anomalyTone, severityMultiple, type AnomalyEvent } from "@/lib/anomalies";
import { FONT } from "@/lib/fonts";
import { num, relativeTime, dateTime } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AnomalyHistoryCardProps {
  events: readonly AnomalyEvent[];
}

function evidence(event: AnomalyEvent): string {
  const parts = [`${num(event.value)} observed`];
  if (event.mean !== null) parts.push(`${num(Math.round(event.mean))} average`);
  const multiple = severityMultiple(event);
  if (multiple !== null) parts.push(`${multiple.toFixed(1)}× normal`);
  if (event.zScore !== null) parts.push(`${event.zScore.toFixed(1)}σ`);
  return parts.join(" · ");
}

export function AnomalyHistoryCard({ events }: AnomalyHistoryCardProps) {
  const { t } = useTheme();
  // Array.isArray, not `.length === 0`: on a truthy non-array `{}` the length
  // check is falsy and execution falls through to the iteration below, which
  // throws and takes the dashboard down. The caller passes `q.data ?? []`, a
  // NULLISH guard that does not catch it; reachable from a restored persisted
  // cache written by an older response shape.
  const list = Array.isArray(events) ? events : [];
  if (list.length === 0) return null;

  return (
    <View>
      <SectionLabel>Detected anomalies</SectionLabel>
      <View
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        {list.map((event, index) => (
          <View
            key={event.id}
            accessible
            accessibilityLabel={`${event.label} anomaly, ${evidence(event)}, detected ${dateTime(event.detectedAt, "at an unknown time")}`}
            style={{
              gap: 6,
              paddingVertical: 12,
              paddingHorizontal: 14,
              borderTopWidth: index === 0 ? 0 : 1,
              borderTopColor: t.borderSubtle,
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
                  fontWeight: "600",
                  flex: 1,
                }}
                numberOfLines={1}
              >
                {event.label}
              </Text>
              {/* Tone AND text: severity is never colour-alone. */}
              <Pill
                label={anomalyTone(event) === "danger" ? "Severe" : "Elevated"}
                tone={anomalyTone(event)}
              />
            </View>
            <Text
              // `numeric`, not prose: the evidence line is a run of tabular
              // figures, and its 1.4x ceiling keeps "412 observed · 38
              // average · 11× normal · 6.2σ" from becoming four lines.
              {...typeCap("numeric")}
              style={{
                color: t.fgMuted,
                ...typeStyle("numeric"),
                fontFamily: FONT.regular,
                fontVariant: ["tabular-nums"],
              }}
            >
              {evidence(event)}
            </Text>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              Detected {relativeTime(event.detectedAt)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
