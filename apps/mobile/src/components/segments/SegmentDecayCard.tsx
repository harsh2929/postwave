/**
 * SegmentDecayCard — the decay radar on the segment detail screen.
 *
 * A segment silently losing 80% of its members is the away-from-desk alert:
 * it is why the next campaign under-delivers, and mobile could not see it. The
 * server has detected and stored these events for a long time, and every one
 * of the four routes was already consumed by web — mobile called none of them,
 * so a dismissal could only ever be recorded on a desktop and the two surfaces
 * disagreed about what had been handled.
 *
 * Three honesty rules live here:
 *
 *  - THE CARD IS SILENT WHEN THERE IS NOTHING TO SAY. No events, no card —
 *    a permanent "No anomalies" panel trains people to stop reading it, and a
 *    skeleton for a card that is usually absent is worse: it promises content
 *    that will not arrive on a healthy segment.
 *  - THE NARRATION IS THE SERVER'S SENTENCE, VERBATIM. It is model-authored
 *    on the server; re-wording it here would put words in its mouth.
 *  - AN ERROR IS NOT "ALL CLEAR". A failed read renders the error, because
 *    rendering nothing would say the segment is healthy.
 */
import { Pressable, Text, View } from "react-native";

import { Card, Label } from "@/components/subscriber/SubscriberDetailPrimitives";
import { ErrorState } from "@/components/ErrorState";
import { Pill } from "@/components/Pill";
import type { SegmentDecayEvent } from "@/api/segmentDecay";
import { FONT } from "@/lib/fonts";
import { date as fmtDate, plural } from "@/lib/format";
import { decayChangeSentence, decayKindPresentation } from "@/lib/segmentDecay";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface SegmentDecayCardProps {
  events: SegmentDecayEvent[] | undefined;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  /** Null below editor — `write:subscribers` is the dismiss route's floor. */
  onDismiss: ((event: SegmentDecayEvent) => void) | null;
  /** Id of the event currently being dismissed, if any. */
  dismissingId?: string | null;
}

export function SegmentDecayCard({
  events,
  isError,
  error,
  onRetry,
  onDismiss,
  dismissingId = null,
}: SegmentDecayCardProps) {
  const { t } = useTheme();
  // `Array.isArray`, not `?? []`: a truthy non-array from a rehydrated cache
  // written by an older build would walk straight into `.map` and throw
  // (src/lib/nullishArrayGuard.test.ts states the rule).
  const rows = Array.isArray(events) ? events : [];

  // Nothing to report and nothing broken: render nothing at all.
  if (!isError && rows.length === 0) return null;

  return (
    <Card>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Label>Decay radar</Label>
        {rows.length > 0 ? (
          <Text
            {...typeCap("label")}
            accessibilityLabel={plural(rows.length, "open alert")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {plural(rows.length, "open alert")}
          </Text>
        ) : null}
      </View>

      {isError ? (
        <View style={{ marginTop: 8 }}>
          <ErrorState error={error} onRetry={onRetry} />
        </View>
      ) : null}

      <View style={{ marginTop: 8, gap: 14 }}>
        {rows.map((event) => {
          const kind = decayKindPresentation(event.anomalyKind);
          const change = decayChangeSentence(event);
          const busy = dismissingId === event.id;
          return (
            <View key={event.id} style={{ gap: 4 }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <Pill label={kind.label} tone={kind.tone} />
                {event.snapshotDate ? (
                  <Text
                    {...typeCap("label")}
                    style={{
                      color: t.fgSubtle,
                      ...typeStyle("label"),
                      fontFamily: FONT.regular,
                    }}
                  >
                    {fmtDate(event.snapshotDate, event.snapshotDate)}
                  </Text>
                ) : null}
              </View>
              {change ? (
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fg,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.regular,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {change}
                </Text>
              ) : null}
              {event.narration ? (
                // The server's own sentence, unedited.
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {event.narration}
                </Text>
              ) : null}
              {onDismiss ? (
                <Pressable
                  onPress={() => onDismiss(event)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={`Dismiss ${kind.label} alert${
                    event.snapshotDate ? ` from ${event.snapshotDate}` : ""
                  }`}
                  accessibilityState={{ disabled: busy, busy }}
                  // NativeWind v4: a static style object. The function form
                  // silently drops layout on Pressable.
                  style={{ minHeight: 44, justifyContent: "center" }}
                >
                  <Text
                    {...typeCap("control")}
                    style={{
                      color: busy ? t.fgSubtle : t.accent,
                      ...typeStyle("control"),
                      fontFamily: FONT.semibold,
                    }}
                  >
                    {busy ? "Dismissing…" : "Dismiss"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}
      </View>
    </Card>
  );
}
