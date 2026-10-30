/**
 * BestTimeScheduleCard — "send at each recipient's best time", with the dry
 * run the operator needs to trust it.
 *
 * Desktop has had per-recipient send-time scheduling plus a 24-hour
 * distribution preview since sto-recipient-distribution-preview; mobile had
 * only the single audience-wide "best hour UTC" banner. The decision is one
 * toggle and one confirm, so it belongs on a phone — but committing it blind
 * does not, which is why the histogram, the warm-up-cap check and the burst
 * check are all rendered BEFORE Save is reachable.
 *
 * The histogram is plain Views with percentage heights, not a chart library:
 * 24 fixed categories against a common baseline is the one shape that needs no
 * axis machinery. Colour comes from the chart palette's sequential ramp (the
 * only sanctioned source), the peak column is additionally marked with a
 * caption line, and every column carries its exact spoken value — so the chart
 * never encodes anything in colour alone.
 */
import { Text, View } from "react-native";

import { ChipRow } from "@/components/ChipRow";
import { SkeletonGroup, Skeleton } from "@/components/Skeleton";
import { ActionButton } from "@/components/campaigns/CampaignDetailControls";
import { ContextualHintButton } from "@/components/onboarding/ContextualHintButton";
import {
  BEST_TIME_WINDOWS,
  bestTimeHeadline,
  bestTimeHourBars,
  bestTimeNotices,
  bestTimePeakBar,
  type BestTimeNoticeTone,
  type BestTimeSchedulePreview,
} from "@/lib/bestTimeSchedule";
import { chartPalette } from "@/lib/chartPalette";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const CHART_HEIGHT = 84;
/** Ticks that stay legible at 24 columns on a 375pt phone. */
const AXIS_TICK_HOURS = new Set([0, 6, 12, 18]);

export interface BestTimeScheduleCardProps {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  withinDays: number;
  onWithinDaysChange: (next: number) => void;
  preview: BestTimeSchedulePreview | null;
  loading: boolean;
  problem: string | null;
  retryable: boolean;
  onRetry: () => void;
  /** Disables the toggle itself (offline, viewer role, save in flight). */
  disabled?: boolean | undefined;
}

export function BestTimeScheduleCard(props: BestTimeScheduleCardProps) {
  const { t, theme } = useTheme();
  const palette = chartPalette(theme);

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: props.enabled ? t.accent : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        marginTop: 12,
      }}
    >
      {/* The hint sits BESIDE the toggle group, never inside it: the group is
          one `accessible` switch to VoiceOver and would swallow a nested
          button. Same copy desktop shows for this field. */}
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 4 }}>
        <View style={{ flex: 1 }}>
          <BestTimeToggle
            enabled={props.enabled}
            onToggle={props.onToggle}
            disabled={props.disabled}
            t={t}
          />
        </View>
        <ContextualHintButton hintKey="campaign.send-window" compact />
      </View>

      {props.enabled ? (
        <View style={{ marginTop: 12, gap: 10 }}>
          <View>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                marginBottom: 6,
                fontFamily: FONT.medium,
              }}
            >
              Spread the send over
            </Text>
            <ChipRow
              accessibilityLabel="Scheduling window"
              paddingHorizontal={0}
              value={String(props.withinDays)}
              onChange={(next) => props.onWithinDaysChange(Number(next))}
              options={BEST_TIME_WINDOWS.map((w) => ({
                value: String(w.value),
                label: w.label,
                accessibilityLabel: `Spread the send over ${w.label}`,
              }))}
            />
          </View>

          {props.loading ? (
            <SkeletonGroup label="Previewing the schedule">
              <Skeleton height={CHART_HEIGHT} radius={8} />
            </SkeletonGroup>
          ) : props.problem ? (
            <View style={{ gap: 8 }}>
              <Text
                {...typeCap("label")}
                accessibilityRole="alert"
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("label"),
                  fontFamily: FONT.regular,
                }}
              >
                {props.problem}
              </Text>
              {props.retryable ? (
                <View style={{ flexDirection: "row" }}>
                  <ActionButton label="Try again" onPress={props.onRetry} />
                </View>
              ) : null}
            </View>
          ) : (
            <BestTimeReading
              preview={props.preview}
              t={t}
              ramp={palette.sequential}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

function BestTimeToggle({
  enabled,
  onToggle,
  disabled,
  t,
}: {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  disabled: boolean | undefined;
  t: ThemeTokens;
}) {
  return (
    <View
      accessibilityRole="switch"
      accessible
      accessibilityLabel="Send at each recipient's best time"
      accessibilityHint="Schedules every recipient at the hour they are most likely to open, instead of one fixed time."
      accessibilityState={{ checked: enabled, disabled: Boolean(disabled) }}
      onAccessibilityTap={() => {
        if (!disabled) onToggle(!enabled);
      }}
      style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
    >
      <View style={{ flex: 1 }}>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          Send at each recipient&apos;s best time
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            marginTop: 2,
            fontFamily: FONT.regular,
          }}
        >
          {enabled
            ? "The time below is the START of the window, not the moment everyone receives it."
            : "One fixed time for everyone, unless you turn this on."}
        </Text>
      </View>
      <ActionButton
        label={enabled ? "On" : "Off"}
        primary={enabled}
        onPress={() => onToggle(!enabled)}
        disabled={disabled}
      />
    </View>
  );
}

function BestTimeReading({
  preview,
  t,
  ramp,
}: {
  preview: BestTimeSchedulePreview | null;
  t: ThemeTokens;
  ramp: readonly string[];
}) {
  const bars = bestTimeHourBars(preview?.distribution);
  const peak = bestTimePeakBar(bars);
  const notices = bestTimeNotices(preview);

  return (
    <View style={{ gap: 10 }}>
      <Text
        {...typeCap("label")}
        accessibilityLiveRegion="polite"
        style={{
          color: t.fg,
          ...typeStyle("label"),
          fontFamily: FONT.medium,
        }}
      >
        {bestTimeHeadline(preview)}
      </Text>

      {peak ? (
        <View>
          <View
            accessibilityRole="image"
            accessibilityLabel={`Recipients by hour, UTC. Busiest hour ${peak.label}:00 with ${plural(peak.count, "recipient")}.`}
            style={{
              flexDirection: "row",
              alignItems: "flex-end",
              gap: 2,
              height: CHART_HEIGHT,
            }}
          >
            {bars.map((bar) => (
              <View
                key={bar.hour}
                accessible
                accessibilityLabel={bar.spoken}
                style={{
                  flex: 1,
                  height: `${Math.max(3, Math.round(bar.ratio * 100))}%`,
                  borderTopLeftRadius: 2,
                  borderTopRightRadius: 2,
                  backgroundColor: rampColor(ramp, bar.ratio, t),
                }}
              />
            ))}
          </View>
          <View
            aria-hidden
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ flexDirection: "row", marginTop: 4 }}
          >
            {bars.map((bar) => (
              <View key={bar.hour} style={{ flex: 1, alignItems: "center" }}>
                <Text
                  {...typeCap("badgeSmall")}
                  style={{
                    color: t.fgSubtle,
                    fontSize: 9,
                    lineHeight: 12,
                    fontFamily: FONT.regular,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {AXIS_TICK_HOURS.has(bar.hour) ? bar.label : ""}
                </Text>
              </View>
            ))}
          </View>
          {/* The peak is marked by fill INTENSITY in the chart; state must
              never be colour-alone, so it is also stated in words. */}
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              marginTop: 4,
              fontFamily: FONT.regular,
              fontVariant: ["tabular-nums"],
            }}
          >
            Busiest hour {peak.label}:00 UTC · {plural(peak.count, "recipient")}
          </Text>
        </View>
      ) : null}

      {notices.map((notice) => (
        <Text
          key={notice.key}
          {...typeCap("caption")}
          accessibilityRole="alert"
          style={{
            color: noticeColor(notice.tone, t),
            ...typeStyle("caption"),
            fontFamily: FONT.medium,
          }}
        >
          {notice.message}
        </Text>
      ))}
    </View>
  );
}

/**
 * Position on the sequential ramp for a bar's share of the peak. Empty hours
 * fall back to the surface border so a zero column reads as "nothing here"
 * rather than as the palest step of a magnitude scale.
 */
function rampColor(
  ramp: readonly string[],
  ratio: number,
  t: ThemeTokens,
): string {
  if (ratio <= 0) return t.borderSubtle;
  const last = ramp.length - 1;
  if (last < 0) return t.accent;
  const index = Math.min(last, Math.max(0, Math.round(ratio * last)));
  return ramp[index] ?? t.accent;
}

function noticeColor(tone: BestTimeNoticeTone, t: ThemeTokens): string {
  if (tone === "danger") return t.danger;
  if (tone === "warning") return t.warning;
  return t.fgMuted;
}
