/**
 * SendTimeSegmentScopeCard — "pick a scope, see its week".
 *
 * WHAT IT FIXES. Everything else on this screen answers for the WHOLE
 * workspace. That is the right default and the only thing a tenant-wide
 * aggregate can say, but it stops being useful the moment the send in hand goes
 * to one audience: a weekday-morning B2B list and a weekend-evening consumer
 * list average into a curve that describes neither, and the operator has no way
 * to ask which of the two they are about to mail. Desktop has had the scoped
 * read since SendTime.tsx:33 (`useSendTimeAudienceSignals`); mobile had the
 * tenant grid alone.
 *
 * WHY IT SITS BESIDE THE MAIN GRID RATHER THAN REPLACING IT. The two answers
 * are complementary — the tenant week is measured from what was actually SENT
 * (opens over deliveries per hour), the segment week is a MODEL over subscriber
 * engagement history. Swapping the screen's content on a chip press would make
 * them look like two views of one number. They are two numbers.
 *
 * THE 404 IS AN ANSWER, NOT A FAULT. Below thirty subscribers with open history
 * the server refuses with `insufficient_data` and its own sentence — "need >= 30
 * subscribers with open history; have 4" (dow_pattern.go:446-452). That sentence
 * is rendered VERBATIM: it carries the threshold and this segment's actual
 * count, and no re-wording here could be more accurate than the server's own.
 *
 * OFFLINE AND ROLE. The whole screen is admin-gated upstream
 * (`useCanReadSendTimeAnalysis`), and this read sits behind the same floor, so
 * there is no separate role state to draw. Offline, the chips are withheld
 * rather than offered-and-broken: this is a live aggregate with no cached form.
 *
 * NativeWind v4: static Pressable styles only (Chip complies).
 */
import { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { ErrorState } from "@/components/ErrorState";
import { Skeleton } from "@/components/Skeleton";
import { SendTimeSegmentWeek } from "@/components/sendtime/SendTimeSegmentWeek";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useSegments } from "@/hooks/useSegments";
import { useSendTimeSegmentHeatmap } from "@/hooks/useSendTimeSegmentHeatmap";
import { FONT } from "@/lib/fonts";
import { deviceOffsetMinutes } from "@/lib/sendTimeLabels";
import {
  segmentSampleSentence,
  segmentWindowLocalLabel,
  segmentWindowUtcLabel,
} from "@/lib/sendTimeSegmentHeatmap";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function Line({
  children,
  tone,
}: {
  children: string;
  tone?: "muted" | "strong";
}) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: tone === "muted" ? t.fgSubtle : tone === "strong" ? t.fg : t.fgMuted,
        ...typeStyle("bodySmall"),
        fontFamily: tone === "strong" ? FONT.semibold : FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}

export function SendTimeSegmentScopeCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const [segmentId, setSegmentId] = useState<string | null>(null);

  const segments = useSegments();
  const heatmap = useSendTimeSegmentHeatmap(segmentId);
  const offsetMinutes = useMemo(() => deviceOffsetMinutes(), []);

  // `?? []` would substitute only for null/undefined and pass a truthy
  // non-array straight into `.map` (lib/nullishArrayGuard.test.ts).
  const rows = Array.isArray(segments.data) ? segments.data : [];
  const chosen = rows.find((row) => row.id === segmentId) ?? null;
  const outcome = heatmap.data ?? null;

  return (
    <Card style={{ gap: 12 }}>
      <View style={{ gap: 4 }}>
        <Text
          accessibilityRole="header"
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.semibold,
            textTransform: "uppercase",
            letterSpacing: 0.8,
          }}
        >
          One audience&apos;s week
        </Text>
        <Line>
          The grid above averages the whole workspace. Pick a segment to see
          when that audience alone is modelled to read.
        </Line>
      </View>

      {!gate.enabled ? (
        <Line tone="muted">
          You&apos;re offline, so a segment&apos;s week can&apos;t be loaded.
          Reconnect and pull to refresh.
        </Line>
      ) : rows.length === 0 ? (
        <Line tone="muted">
          {segments.isPending
            ? "Loading your segments…"
            : "This workspace has no segments yet, so there is no narrower audience to ask about."}
        </Line>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
        >
          <Chip
            label="Whole workspace"
            active={segmentId === null}
            accessibilityLabel="Whole workspace — the grid above"
            onPress={() => setSegmentId(null)}
          />
          {rows.map((row) => (
            <Chip
              key={row.id}
              label={row.name}
              active={segmentId === row.id}
              accessibilityLabel={`Show the send-time week for ${row.name}`}
              onPress={() => setSegmentId(row.id)}
            />
          ))}
        </ScrollView>
      )}

      {segmentId === null ? null : heatmap.isPending ? (
        <Skeleton width="100%" height={120} />
      ) : heatmap.isError ? (
        <ErrorState compact error={heatmap.error} onRetry={heatmap.refetch} />
      ) : outcome === null ? null : outcome.kind === "refused" ? (
        <View style={{ gap: 4 }}>
          <Line tone="strong">
            {chosen
              ? `${chosen.name} can't be modelled yet`
              : "This segment can't be modelled yet"}
          </Line>
          {/* The server's own sentence, verbatim: it names the threshold AND
              this segment's count, which nothing on the client knows. */}
          <Line>
            {outcome.refusal.message ??
              "The server did not say how far below its minimum this segment is."}
          </Line>
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          <SendTimeSegmentWeek pattern={outcome.pattern} />
          <View style={{ gap: 2 }}>
            <Line tone="strong">
              {`Strongest: ${segmentWindowLocalLabel(
                outcome.pattern.best,
                offsetMinutes,
              )}`}
            </Line>
            <Line tone="muted">
              {`${segmentWindowUtcLabel(outcome.pattern.best)} · your device's time above`}
            </Line>
            {outcome.pattern.secondary ? (
              <Line>
                {`Second window: ${segmentWindowLocalLabel(
                  outcome.pattern.secondary,
                  offsetMinutes,
                )} (${segmentWindowUtcLabel(outcome.pattern.secondary)})`}
              </Line>
            ) : null}
          </View>
          <Line tone="muted">{segmentSampleSentence(outcome.pattern)}</Line>
        </View>
      )}
    </Card>
  );
}
