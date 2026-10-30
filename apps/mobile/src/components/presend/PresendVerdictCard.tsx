/**
 * PresendVerdictCard — one verdict on the draft, asked at the send
 * confirmation.
 *
 * The send sheet used to run only the voice-drift leg of the pre-send check
 * (VoiceDriftCard) and let it escalate a critical drift. The EQ score and the
 * inbox-placement legs never reached the sheet's escalation ladder — the
 * composite verdict was rendered display-only, in a card that could not gate
 * anything. This card asks POST /api/v1/presend/verdict (EQ score + voice
 * drift + placement, composed server-side into ok | warn | critical |
 * incomplete) and hands the reading to the host, exactly the way the drift
 * card does, so the host can escalate on CRITICAL without owning the request.
 *
 * On-demand like every check in this sheet: the verdict is LLM-cost and a
 * three-service fan-out, not something to fire on every open.
 *
 * What it refuses to collapse: "not run", "ran and incomplete" (a leg was
 * unreachable — locally the voice sidecar is often absent), "ran and could
 * not be reached at all" (502 upstream_unavailable / 404 / 503). None of
 * those is a pass, none of them blocks the send, and each says which it is.
 *
 * Lives outside components/campaigns on purpose: the route-test config stubs
 * that directory to a null component, and a card whose entire value is its
 * composition inside the send sheet must render for real there.
 */
import { useCallback, useEffect, useRef } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";

import { requestDraftPresendVerdict } from "@/api/presendVerdictGate";
import { Pill } from "@/components/Pill";
import { ActionButton } from "@/components/campaigns/CampaignDetailControls";
import {
  readPresendVerdict,
  verdictHeadline,
  verdictTone,
  type PresendVerdictReading,
} from "@/lib/campaignVerdict";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  canRunPresendVerdict,
  presendFromAddress,
  presendVerdictBlocks,
  presendVerdictFailureNotice,
  presendVerdictPillLabel,
  presendVerdictSpoken,
  presendVerdictStandingNotice,
} from "@/lib/presendVerdictGate";
import { useTheme } from "@/lib/theme";
import { typeCap } from "@/lib/typeScale";

export interface PresendVerdictCardProps {
  subject?: string | undefined;
  /** Campaign body. Empty means there is nothing worth a verdict. */
  bodyHtml: string;
  /** What the From header will read; the bare address is extracted here. */
  fromLine?: string | undefined;
  /** Reading lifted to the host so it can gate the send. Null clears it. */
  onReading: (reading: PresendVerdictReading | null) => void;
  /** The host is mid-send; don't let a check race the queue call. */
  disabled?: boolean | undefined;
}

export function PresendVerdictCard({
  subject,
  bodyHtml,
  fromLine,
  onReading,
  disabled = false,
}: PresendVerdictCardProps) {
  const { t } = useTheme();
  const check = useMutation({
    mutationFn: async (): Promise<PresendVerdictReading> => {
      const res = await requestDraftPresendVerdict({
        subject: (subject ?? "").trim(),
        html: bodyHtml,
        from: presendFromAddress(fromLine),
      });
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
      const reading = readPresendVerdict(res.data);
      if (!reading) {
        throw new Error("The verdict service answered in an unexpected shape.");
      }
      return reading;
    },
    onSuccess: (reading) => {
      onReading(reading);
      if (presendVerdictBlocks(reading)) haptics.error();
    },
    onError: () => {
      // A failed check is not a pass — and not a block either. Clear any
      // previous verdict so the sheet cannot keep escalating (or keep showing
      // green) on a reading that belonged to a different answer.
      onReading(null);
      haptics.error();
    },
  });

  // A verdict belongs to the exact copy it judged. The sheet stays mounted
  // while the operator edits the subject, so without this a critical verdict
  // earned by the previous draft would keep escalating the new one.
  const resetRef = useRef(check.reset);
  resetRef.current = check.reset;
  useEffect(() => {
    resetRef.current();
    onReading(null);
  }, [subject, bodyHtml, fromLine, onReading]);

  const reading = check.data ?? null;
  const runnable = canRunPresendVerdict(bodyHtml);
  const tone = reading ? verdictTone(reading.verdict) : "neutral";
  const blocks = presendVerdictBlocks(reading);
  const standing = presendVerdictStandingNotice(reading);
  const failure = check.error ? presendVerdictFailureNotice(check.error) : null;
  const onRun = useCallback(() => {
    if (!runnable || check.isPending || disabled) return;
    haptics.tap();
    check.mutate();
  }, [check, disabled, runnable]);

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: blocks
          ? t.danger
          : tone === "warning"
            ? t.warning
            : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        marginBottom: 12,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
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
          AI pre-send verdict
        </Text>
        {reading ? (
          <Pill
            label={presendVerdictPillLabel(reading)}
            tone={tone}
            accessibilityLabel={presendVerdictSpoken(reading)}
          />
        ) : null}
        <ActionButton
          label={check.isPending ? "Checking…" : reading ? "Re-check" : "Run check"}
          onPress={onRun}
          disabled={check.isPending || disabled || !runnable}
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
        {!runnable
          ? "This campaign has no body text to check."
          : reading
            ? reading.summary || verdictHeadline(reading)
            : "Run EQ score, voice drift and inbox placement together and get one verdict before this goes out."}
      </Text>

      {failure ? (
        <Text
          {...typeCap("caption")}
          accessibilityRole="alert"
          style={{
            color: t.warning,
            fontSize: 11,
            lineHeight: 15,
            marginTop: 8,
            fontFamily: FONT.medium,
          }}
        >
          {failure.text}
        </Text>
      ) : null}

      {reading ? (
        <View style={{ marginTop: 10, gap: 4 }}>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: blocks ? t.danger : tone === "warning" ? t.warning : t.fg,
              fontSize: 13,
              fontFamily: FONT.semibold,
            }}
          >
            {verdictHeadline(reading)}
          </Text>
          {reading.components.map((row) => (
            <Text
              key={row.name}
              {...typeCap("caption")}
              style={{
                color: row.status === "critical" ? t.danger : t.fgMuted,
                fontSize: 11,
                lineHeight: 15,
                fontFamily: FONT.regular,
              }}
            >
              {row.label}
              {row.scoreLabel ? ` ${row.scoreLabel}` : ""}
              {row.status ? ` · ${row.status}` : ""}
              {row.message ? ` — ${row.message}` : ""}
            </Text>
          ))}
          {standing ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                fontSize: 11,
                lineHeight: 15,
                marginTop: 2,
                fontFamily: FONT.medium,
              }}
            >
              {standing}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
