/**
 * LiveDot — the dashboard's freshness receipt.
 *
 * It used to take a single boolean and print "Live" or "Idle", computed during
 * render with nothing driving a re-render. Two things were wrong with that on a
 * phone specifically: polling is suspended while the app is backgrounded, so on
 * resume the first painted frame claimed "Live" beside an hours-old number
 * until the refetch resolved; and even when the badge was right, "Idle" told
 * the user something was stale without telling them how stale.
 *
 * So the caller passes a ticking `now`, and the badge shows the AGE beside the
 * state. The two can never disagree because they are derived from the same
 * instant.
 *
 * The later, larger correction (DASHBOARD#16 / NATIVE#38): the word "Live" is
 * now earned by the realtime PUSH stream, not by a 30-second timer. Which
 * mechanism is actually carrying the screen is decided in
 * lib/dashboardLiveness.ts — see that file for why `/api/v1/dashboard/live` is
 * deliberately not the mobile mechanism — and the stream's health comes from
 * lib/eventBusStatus.ts, which until now was surfaced only on the Diagnostics
 * screen. State is carried by the WORD, so the dot's colour is never the only
 * signal.
 */
import { Text, View } from "react-native";

import { dashboardLiveness, type StreamTone } from "@/lib/dashboardLiveness";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { msg } from "@/lib/i18n";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface LiveDotProps {
  /** Wall-clock ms of the last successful update; 0 when nothing has loaded. */
  lastUpdatedAt: number;
  /** Ticking "now" from the screen, so the badge ages while it is on screen. */
  now: number;
  /** A failed poll is never "live", however recent the last success was. */
  errored?: boolean;
  /**
   * Realtime stream tone from `eventBusFreshness().tone`. Defaults to "off" so
   * an isolated render (or a surface with no stream) degrades to the honest
   * timer wording rather than to an unearned "Live".
   */
  stream?: StreamTone;
}

export function LiveDot({
  lastUpdatedAt,
  now,
  errored = false,
  stream = "off",
}: LiveDotProps) {
  const { t } = useTheme();
  // "not loaded" is copy, not a sentinel — it is read aloud inside the badge's
  // spoken sentence, so it goes through the catalogue like the rest of it.
  const age =
    lastUpdatedAt > 0
      ? relativeTime(lastUpdatedAt, { now })
      : msg("dashboard.live.age.notLoaded");
  const state = dashboardLiveness({
    lastUpdatedAt,
    now,
    errored,
    stream,
    age,
  });
  const color =
    state.tone === "live"
      ? t.success
      : state.tone === "degraded"
        ? t.warning
        : t.fgSubtle;

  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={state.spoken}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 8,
        maxWidth: "100%",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 10,
          paddingVertical: 4,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: t.borderSubtle,
          backgroundColor: t.surface,
          maxWidth: "100%",
        }}
      >
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: color,
          }}
        />
        {/* State is carried by the word as well as the dot colour, so it
            survives colour-blindness and greyscale. */}
        <Text
          // `badgeSmall`: this is a pill in the header bar, beside the title
          // and the share action, and the bar cannot grow with it.
          {...typeCap("badgeSmall")}
          numberOfLines={1}
          style={{
            flexShrink: 1,
            color: t.fgMuted,
            ...typeStyle("badgeSmall"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
            letterSpacing: 0.6,
            textTransform: "uppercase",
          }}
        >
          {state.label}
        </Text>
      </View>
      <Text
        // Hidden from assistive tech: the wrapper's label already says it, and
        // reading the age twice is noise.
        importantForAccessibility="no-hide-descendants"
        {...typeCap("badgeSmall")}
        numberOfLines={1}
        style={{
          flexShrink: 1,
          color: t.fgSubtle,
          ...typeStyle("badgeSmall"),
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
      >
        {age}
      </Text>
    </View>
  );
}
