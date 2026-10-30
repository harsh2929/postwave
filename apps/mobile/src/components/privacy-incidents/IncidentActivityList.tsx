/**
 * IncidentActivityList — the merged transition + notification ledger.
 *
 * WHY THE LEDGER IS ON THE PHONE AT ALL. The incident row says where the
 * incident IS. Historical `notification` rows are legacy operator assertions,
 * not provider-authenticated delivery evidence; the copy says so explicitly.
 *
 * LOADING IS NOT EMPTINESS, and on this screen the difference is the whole
 * point. Rendering "no activity" while the fetch is in flight would tell an
 * on-call engineer that nothing has been done about a live breach. Until the
 * read lands the list says it is loading; if the read fails it says that too.
 */
import { Text, View } from "react-native";

import { Skeleton } from "@/components/Skeleton";
import { dateTime, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { incidentEventSentence } from "@/lib/privacyIncidentCopy";
import type { IncidentEvent } from "@/lib/privacyIncidents";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface IncidentActivityListProps {
  events: readonly IncidentEvent[];
  loading: boolean;
  failed: boolean;
  now: number;
}

export function IncidentActivityList({
  events,
  loading,
  failed,
  now,
}: IncidentActivityListProps) {
  const { t } = useTheme();

  if (failed) {
    return (
      <Notice
        tone="danger"
        text="The activity ledger could not be loaded. This is not the same as an incident with no activity — pull to refresh."
      />
    );
  }
  // Reopening a stale-time-zero query may provide cached rows while the live
  // verification is in flight. Never render those rows as current evidence.
  if (loading) {
    return (
      <View accessibilityLabel="Loading the incident ledger" accessible>
        <Skeleton height={16} />
        <View style={{ height: 8 }} />
        <Skeleton height={16} width="70%" />
      </View>
    );
  }
  if (events.length === 0) {
    return (
      <Notice
        tone="muted"
        text="Nothing has been recorded against this incident yet — no state change and no notification."
      />
    );
  }

  return (
    <View style={{ gap: 10 }}>
      {events.map((event, index) => {
        const when = event.at
          ? `${relativeTime(event.at, { now })} · ${dateTime(event.at)}`
          : "Time not recorded";
        const sentence = incidentEventSentence(event);
        return (
          <View
            key={
              event.eventId && event.source
                ? `${event.source}:${event.eventId}`
                : `${event.kind}-${event.at}-${index}`
            }
            accessible
            accessibilityLabel={`${sentence}. ${when}.`}
            style={{
              // Logical sides, not physical: the rail must sit on the
              // leading edge of the ledger entry in both layout directions.
              borderStartColor:
                event.kind === "notification" ? t.accent : t.borderSubtle,
              borderStartWidth: 2,
              paddingStart: 10,
            }}
          >
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              {sentence}
            </Text>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                marginTop: 2,
              }}
            >
              {when}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function Notice({ text, tone }: { text: string; tone: "danger" | "muted" }) {
  const { t } = useTheme();
  return (
    <Text
      accessibilityRole={tone === "danger" ? "alert" : "text"}
      accessibilityLabel={text}
      {...typeCap("bodySmall")}
      style={{
        color: tone === "danger" ? t.danger : t.fgMuted,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
      }}
    >
      {text}
    </Text>
  );
}
