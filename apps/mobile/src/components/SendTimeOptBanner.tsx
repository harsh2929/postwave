/**
 * SendTimeOptBanner (mobile) — RN port of the desktop banner. Shown
 * above a campaign schedule picker. Calls the segment-aware send-time
 * endpoint and surfaces a single best-send recommendation
 * with a one-tap "Use this time" apply.
 *
 * Honest-fallback policy mirrors the desktop:
 *   - 404 insufficient data → muted "needs at least 30 days of send history".
 *   - Any other error → muted message + the underlying message.
 *   - NEVER fakes a recommendation.
 *
 * Skeleton during fetch (not a spinner).
 */
import { type ReactElement, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";

import {
  getSegmentBestSendTime,
  nextBestSendOccurrence,
  parseBestHourUTC,
  type SegmentBestSendTime,
} from "@/api/sendTime";
import { localEquivalentLabel } from "@/lib/campaignSchedule";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { typeCap } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

interface Props {
  /** Tenant-scoped segment id the campaign targets. Optional. */
  segmentId?: string | null;
  /** Campaign id for tenant-scoped predictions. Optional. */
  campaignId?: string | number | null;
  /**
   * Called when the user taps "Use this time". The argument is an
   * ISO-8601 timestamp. The banner does NOT mutate any form state on
   * its own — the parent owns the time picker.
   */
  onApply: (isoTimestamp: string) => void;
}

function formatLabel(rec: SegmentBestSendTime): string {
  const hour = parseBestHourUTC(rec.best_hour_utc);
  if (hour == null) return "Unknown";
  const h = hour;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${ampm} UTC`;
}

export function SendTimeOptBanner({
  segmentId,
  campaignId,
  onApply,
}: Props): ReactElement {
  const { t } = useTheme();
  const [loading, setLoading] = useState(true);
  const [rec, setRec] = useState<SegmentBestSendTime | null>(null);
  const [fallbackMsg, setFallbackMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRec(null);
    setFallbackMsg(null);

    void (async () => {
      const res = await getSegmentBestSendTime({
        segmentId: segmentId ?? null,
        campaignId: campaignId ?? null,
      });
      if (cancelled) return;
      setLoading(false);
      if (res.error) {
        const status = res.error.status;
        if (status === 404 || status === 405 || status === 501) {
          setFallbackMsg(
            "Send-time analysis unavailable yet — needs at least 30 subscribers with history.",
          );
        } else {
          setFallbackMsg(
            `Send-time analysis unavailable: ${res.error.message}`,
          );
        }
        return;
      }
      const data = res.data;
      if (!data || parseBestHourUTC(data.best_hour_utc) == null) {
        setFallbackMsg(
          "Send-time analysis unavailable yet — needs at least 30 subscribers with history.",
        );
        return;
      }
      setRec(data);
    })();

    return () => {
      cancelled = true;
    };
  }, [segmentId, campaignId]);

  const containerBase = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 10,
    backgroundColor: t.surface,
    borderColor: t.borderSubtle,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  };

  if (loading) {
    return (
      <View
        style={containerBase}
        accessibilityRole="progressbar"
        accessibilityLabel="Loading best send time"
      >
        <View
          style={{
            width: 16,
            height: 16,
            borderRadius: 4,
            backgroundColor: t.surfaceElevated,
          }}
        />
        <View style={{ flex: 1, gap: 6 }}>
          <View
            style={{
              height: 12,
              width: "60%",
              borderRadius: 4,
              backgroundColor: t.surfaceElevated,
            }}
          />
          <View
            style={{
              height: 10,
              width: "40%",
              borderRadius: 4,
              backgroundColor: t.surfaceElevated,
            }}
          />
        </View>
      </View>
    );
  }

  if (fallbackMsg) {
    return (
      <View style={containerBase} accessibilityRole="alert">
        <Text
          {...typeCap("callout")}
          style={{ color: t.fgMuted, fontSize: 14, fontFamily: FONT.regular }}
          aria-hidden
        >
          {"◐"}
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            fontSize: 12,
            flex: 1,
            fontFamily: FONT.regular,
          }}
        >
          {fallbackMsg}
        </Text>
      </View>
    );
  }

  if (!rec) return <View />;

  const label = formatLabel(rec);
  const conf =
    typeof rec.confidence === "number"
      ? Math.round(Math.max(0, Math.min(1, rec.confidence)) * 100)
      : null;
  const iso = nextBestSendOccurrence(rec);
  // The recommendation is quoted in UTC but the picker below works in device
  // time. Saying only one of the two left an operator outside UTC unable to
  // tell which "9:00" they were about to schedule.
  const localLabel = localEquivalentLabel(iso);

  return (
    <View style={containerBase}>
      <Text
        {...typeCap("callout")}
        style={{ color: t.accent, fontSize: 14, fontFamily: FONT.regular }}
        aria-hidden
      >
        {"✦"}
      </Text>
      <View style={{ flex: 1 }}>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            fontSize: 13,
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          Best send time:{" "}
          {/* Nested `Text` inherits its parent's multiplier when it declares
              none, but inheritance is invisible at the call site: move the
              parent to another role and these silently follow. Both carry the
              same role explicitly — they are inline continuations of the same
              sentence, so they must not diverge from it. */}
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.accent,
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            {label}
          </Text>
          {conf != null ? (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                fontWeight: "500",
                fontFamily: FONT.medium,
              }}
            >
              {"  "}
              {conf}% confidence
            </Text>
          ) : null}
        </Text>
        {localLabel ? (
          <Text
            {...typeCap("badgeSmall")}
            style={{
              color: t.fgMuted,
              fontSize: 11,
              marginTop: 2,
              fontFamily: FONT.regular,
              fontVariant: ["tabular-nums"],
            }}
          >
            That is {localLabel} on this device.
          </Text>
        ) : null}
        {typeof rec.sample_size === "number" && rec.sample_size > 0 ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              fontSize: 11,
              marginTop: 2,
              fontFamily: FONT.regular,
            }}
          >
            Based on {num(rec.sample_size)} engagement events.
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={() => {
          if (iso) onApply(iso);
        }}
        disabled={!iso}
        accessibilityRole="button"
        accessibilityLabel="Use this send time"
        style={{
          backgroundColor: !iso ? t.surfaceElevated : t.accent,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 8,
          opacity: !iso ? 0.6 : 1,
        }}
      >
        <Text
          {...typeCap("label")}
          style={{
            color: !iso ? t.fgSubtle : t.accentFg,
            fontSize: 12,
            fontWeight: "700",
            fontFamily: FONT.bold,
          }}
        >
          Use this time
        </Text>
      </Pressable>
    </View>
  );
}
