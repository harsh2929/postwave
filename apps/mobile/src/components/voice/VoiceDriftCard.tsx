/**
 * VoiceDriftCard — "does this still sound like us?", asked at the send
 * confirmation instead of read back in the archive afterwards.
 *
 * The drift scorer (services/voice) has been able to answer since the desktop
 * pre-send banner shipped, and no mobile surface ever asked — so copy written
 * on a phone, which is the copy most likely to have been AI-assisted (mobile
 * ships SubjectLineSuggestions and the builder's inline AI) and least likely
 * to have been read by a second human, was the only copy that shipped
 * unscored.
 *
 * On-demand, exactly like CampaignLinkCheckCard: the check is a round trip to
 * another service, and firing it every time a send sheet opens is a fan-out
 * nobody asked for. The card owns its own mutation and hands the normalised
 * reading back to the host so the host can escalate on a critical verdict
 * without also owning the request.
 *
 * Three states this card refuses to collapse into one: "not checked yet",
 * "checked and inactive because there is no voice profile to compare against"
 * and "checked and scored". The middle one arrives from the server as a 200
 * carrying score 100 — see lib/voiceDrift.ts.
 */
import { useCallback, useEffect, useRef } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";

import { runVoiceDriftCheck } from "@/api/voiceDrift";
import { ErrorState } from "@/components/ErrorState";
import { Pill } from "@/components/Pill";
import { ActionButton } from "@/components/campaigns/CampaignDetailControls";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap } from "@/lib/typeScale";
import {
  canScoreVoiceDrift,
  voiceDriftSpoken,
  type VoiceDriftReading,
} from "@/lib/voiceDrift";

export interface VoiceDriftCardProps {
  /** Campaign subject — weighted less than the body, but scored. */
  subject?: string | undefined;
  /** Campaign body. Empty means there is nothing the server would accept. */
  bodyHtml: string;
  /** Reading lifted to the host so it can gate the send. Null clears it. */
  onReading: (reading: VoiceDriftReading | null) => void;
  /** The host is mid-send; don't let a check race the queue call. */
  disabled?: boolean | undefined;
}

type DriftTone = {
  pill: "success" | "warning" | "danger" | "neutral";
  border: "danger" | "warning" | null;
};

function toneFor(reading: VoiceDriftReading | null): DriftTone {
  if (!reading) return { pill: "neutral", border: null };
  if (reading.state === "critical") return { pill: "danger", border: "danger" };
  if (reading.state === "warn") return { pill: "warning", border: "warning" };
  if (reading.state === "inactive") return { pill: "neutral", border: null };
  return { pill: "success", border: null };
}

export function VoiceDriftCard({
  subject,
  bodyHtml,
  onReading,
  disabled = false,
}: VoiceDriftCardProps) {
  const { t } = useTheme();
  const check = useMutation({
    mutationFn: async (): Promise<VoiceDriftReading> => {
      const res = await runVoiceDriftCheck({ bodyHtml, ...(subject ? { subject } : {}) });
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
      return res.data;
    },
    onSuccess: (reading) => {
      onReading(reading);
      if (reading.state === "critical") haptics.error();
    },
    onError: () => {
      // A failed check is not a pass. Clear any previous verdict so the send
      // sheet cannot keep showing a stale green score for edited copy.
      onReading(null);
      haptics.error();
    },
  });

  // A verdict belongs to the exact copy that was scored. The confirm sheet
  // stays mounted while the operator goes back to edit the subject, so without
  // this a green 82/100 earned by the previous draft would still be sitting
  // there — and, worse, would still be suppressing the critical-drift
  // escalation the host derives from it.
  const resetRef = useRef(check.reset);
  resetRef.current = check.reset;
  useEffect(() => {
    resetRef.current();
    onReading(null);
  }, [subject, bodyHtml, onReading]);

  const reading = check.data ?? null;
  const scoreable = canScoreVoiceDrift(bodyHtml);
  const tone = toneFor(reading);
  const onRun = useCallback(() => {
    if (!scoreable || check.isPending || disabled) return;
    check.mutate();
  }, [check, disabled, scoreable]);

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor:
          tone.border === "danger"
            ? t.danger
            : tone.border === "warning"
              ? t.warning
              : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        marginBottom: 12,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          accessibilityRole="header"
          style={{
            color: t.fg,
            fontSize: 13,
            fontFamily: FONT.semibold,
            flex: 1,
          }}
        >
          Voice fidelity
        </Text>
        {reading ? (
          <Pill
            label={
              reading.state === "inactive"
                ? "Not measured"
                : `${reading.scoreLabel}/100`
            }
            tone={tone.pill}
            accessibilityLabel={voiceDriftSpoken(reading)}
          />
        ) : null}
        <ActionButton
          label={
            check.isPending ? "Checking…" : reading ? "Re-check" : "Check voice"
          }
          onPress={onRun}
          disabled={check.isPending || disabled || !scoreable}
        />
      </View>

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          fontSize: 11,
          lineHeight: 15,
          marginTop: 6,
          fontFamily: FONT.regular,
        }}
      >
        {!scoreable
          ? "This campaign has no body text to score."
          : reading
            ? reading.detail
            : "Score this draft against your workspace's measured brand voice before it goes out."}
      </Text>

      {check.error ? (
        <View style={{ marginTop: 8 }}>
          <ErrorState
            compact
            error={check.error}
            message="Couldn't score this draft against your brand voice."
            onRetry={onRun}
          />
        </View>
      ) : null}

      {reading && reading.state !== "inactive" ? (
        <VoiceDriftBody reading={reading} />
      ) : null}
    </View>
  );
}

function VoiceDriftBody({ reading }: { reading: VoiceDriftReading }) {
  const { t } = useTheme();
  return (
    <View style={{ marginTop: 10, gap: 8 }}>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color:
            reading.state === "critical"
              ? t.danger
              : reading.state === "warn"
                ? t.warning
                : t.fg,
          fontSize: 13,
          fontFamily: FONT.semibold,
        }}
      >
        {reading.headline}
      </Text>

      {reading.components.map((component) => (
        <View
          key={component.key}
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={`${component.label}: ${component.pct} percent match`}
          accessibilityValue={{ min: 0, max: 100, now: component.pct }}
          style={{ gap: 4 }}
        >
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgMuted,
                fontSize: 12,
                fontFamily: FONT.regular,
                flex: 1,
              }}
            >
              {component.label}
            </Text>
            <Text
              {...typeCap("label")}
              style={{
                color: t.fg,
                fontSize: 12,
                fontFamily: FONT.semibold,
                fontVariant: ["tabular-nums"],
              }}
            >
              {component.pct}%
            </Text>
          </View>
          <View
            style={{
              height: 6,
              borderRadius: 3,
              backgroundColor: t.bgSubtle,
              overflow: "hidden",
            }}
          >
            <View
              style={{
                width: `${component.pct}%`,
                height: 6,
                backgroundColor: component.pct < 40 ? t.warning : t.accent,
              }}
            />
          </View>
        </View>
      ))}

      {reading.authoredAdjustment !== null && reading.authoredAdjustment < 0 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.danger,
            fontSize: 11,
            lineHeight: 15,
            fontFamily: FONT.regular,
          }}
        >
          {`Your brand-voice rules pulled this score down by ${Math.abs(
            Math.round(reading.authoredAdjustment),
          )} — the copy uses terms the profile flags as off-voice.`}
        </Text>
      ) : null}

      {reading.suggestions.map((suggestion) => (
        <Text
          key={suggestion}
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            fontSize: 11,
            lineHeight: 15,
            fontFamily: FONT.regular,
          }}
        >
          {`· ${suggestion}`}
        </Text>
      ))}
    </View>
  );
}
