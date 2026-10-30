/**
 * EqScoreCard — grade a draft's engagement-quality signals before it sends.
 *
 * Desktop's EqScoreLookupCard semantics: From + subject (+ optional HTML) go
 * to POST /deliverability/eq-score, and back come a 0-100 score, a grade and
 * three weighted pillars. Editor-scoped (it is a campaign-authoring tool), so
 * the card mounts from editor up. PRESS-DRIVEN — draft content travels per
 * explicit press and is never prefetched or cached.
 *
 * A pillar the server refused to score renders "not scored", never a fake 0 —
 * `skippedSubScores` is the server saying "I don't know", and a zero would be
 * saying "terrible".
 */
import { useState } from "react";
import { Text, View } from "react-native";

import {
  OpsAction,
  OpsCard,
  OpsCardBody,
  OpsCardTitle,
  OpsTextInput,
} from "@/components/deliverability/OpsCard";
import { Pill } from "@/components/Pill";
import { useEqScoreLookup } from "@/hooks/useDeliverabilityEvidence";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { eqPillarRows } from "@/lib/deliverabilityOpsView";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function EqScoreCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");
  const score = useEqScoreLookup();

  // POST /deliverability/eq-score is editor-floor; omit below that.
  if (!canAccessMinimumRole("editor", gate.effectiveRole)) return null;
  const offline = !gate.enabled;
  const submittable = from.trim().length > 0 && (subject.trim().length > 0 || html.trim().length > 0);

  const result = score.data;

  return (
    <OpsCard>
      <OpsCardTitle>EQ score</OpsCardTitle>
      <OpsCardBody>
        Grade a draft&apos;s engagement quality — content, authentication and
        reputation — before it sends.
      </OpsCardBody>
      {offline ? (
        <OpsCardBody>Scoring runs server-side and needs a connection.</OpsCardBody>
      ) : (
        <>
          <OpsTextInput
            value={from}
            onChangeText={setFrom}
            placeholder="From address"
            accessibilityLabel="From address of the draft"
            keyboardType="email-address"
          />
          <OpsTextInput
            value={subject}
            onChangeText={setSubject}
            placeholder="Subject line"
            accessibilityLabel="Subject line of the draft"
          />
          <OpsTextInput
            value={html}
            onChangeText={setHtml}
            placeholder="HTML body (optional)"
            accessibilityLabel="HTML body of the draft"
            multiline
          />
          <OpsAction
            label={score.isPending ? "Scoring…" : "Score draft"}
            onPress={() => {
              haptics.tap();
              score.mutate({ from: from.trim(), subject, html });
            }}
            disabled={!submittable || score.isPending}
          />
        </>
      )}
      {score.isError ? (
        <OpsCardBody role="alert">
          {errorPresentation(score.error).message || "The draft couldn't be scored."}
        </OpsCardBody>
      ) : null}
      {result ? (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              {...typeCap("numeric")}
              style={{
                color: t.fg,
                fontSize: 26,
                lineHeight: 31,
                fontFamily: FONT.bold,
                fontVariant: ["tabular-nums"],
              }}
            >
              {Math.round(result.score)}
            </Text>
            {result.grade ? (
              <Pill
                label={result.grade}
                tone={
                  result.score >= 80
                    ? "success"
                    : result.score >= 60
                      ? "warning"
                      : "danger"
                }
              />
            ) : null}
          </View>
          {eqPillarRows(result).map((pillar) => (
            <View key={pillar.key} style={{ gap: 2 }}>
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.medium,
                }}
              >
                {`${pillar.label}: ${pillar.score === null ? "not scored" : Math.round(pillar.score)}`}
              </Text>
              {pillar.reasons.slice(0, 3).map((reason) => (
                <Text
                  key={reason}
                  {...typeCap("caption")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {`· ${reason}`}
                </Text>
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </OpsCard>
  );
}
