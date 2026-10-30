/**
 * SubjectLabScorePanel — "which of these subject lines will my list actually
 * open?", answered from the workspace's own last-180-days corpus rather than
 * from an industry blog post.
 *
 * The server side (apps/api/internal/subject_lab) buckets a candidate by its
 * extracted shape — length band, question, all-caps, emoji, merge tag — looks
 * up the mean open rate of the tenant's past sends in the same bucket, and
 * returns a Wilson-90% band around it. Everything interesting in that answer
 * is the UNCERTAINTY, so this panel leads with the band and the matched sample
 * size rather than with a single confident-looking number.
 *
 * ROLE-GATED BY THE HOST, not by this panel — it renders nothing
 * role-dependent itself. The measured floor at HEAD: POST
 * /api/v1/subject-lab/score mounts behind
 * `apikeys.RequireScope(apikeys.ScopeWriteCampaigns)` (subject_lab.go
 * MountRoutes) and routeauth/manifest.json carries
 * `"session_minimum_role": "editor"`. app/(tabs)/subject-lab.tsx gates the
 * composer half at exactly that floor — re-measure both gates before moving
 * it in either direction.
 */
import { useCallback, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { Card } from "@/components/Card";
import { ErrorState } from "@/components/ErrorState";
import { Pill } from "@/components/Pill";
import { SubjectLabBanditRow } from "@/components/voice/SubjectLabBanditRow";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { plural } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useScoreSubjects } from "@/hooks/useSubjectLab";
import {
  parseSubjectCandidates,
  rankSubjectScoreRows,
  subjectCandidateError,
  SUBJECT_LAB_MAX_CANDIDATES,
  type SubjectScoreRow,
} from "@/lib/subjectLab";

export interface SubjectLabScorePanelProps {
  /** Gate closed — the screen already says why, so the panel just refuses. */
  offline: boolean;
  /**
   * Candidates handed in from the generator above, one per line.
   *
   * A HANDOFF, not a controlled value: the box stays the person's to edit
   * after it lands, and a new object identity — not new text — is what
   * replaces it, so "Score these" twice on the same variants still refills a
   * box someone has since emptied. Undefined when nothing has been handed
   * over, which is the state a screen without a generator is always in.
   */
  handoff?: { candidates: string } | undefined;
  /**
   * Set when this screen was opened FROM a campaign (the `?campaignId` deep
   * link): arms the lab → bandit handoff under the ranked reading, which
   * creates an A/B test on that campaign's audience from the top variants.
   */
  banditCampaignId?: string | undefined;
}

const VERDICT_TONE = {
  above: "success",
  below: "danger",
  inline: "neutral",
  unknown: "neutral",
} as const;

const VERDICT_LABEL = {
  above: "Beats your baseline",
  below: "Below your baseline",
  inline: "In line with your baseline",
  unknown: "Not measurable",
} as const;

export function SubjectLabScorePanel({
  offline,
  handoff,
  banditCampaignId,
}: SubjectLabScorePanelProps) {
  const { t } = useTheme();
  const [draft, setDraft] = useState("");
  const score = useScoreSubjects();

  // Seeding during render rather than from an effect: an effect would paint
  // the old text for one frame and then replace it, which on a handoff from
  // the panel directly above reads as the box flickering.
  const [seededFrom, setSeededFrom] = useState<{ candidates: string } | null>(
    null,
  );
  if (handoff && handoff !== seededFrom) {
    setSeededFrom(handoff);
    setDraft(handoff.candidates);
  }

  const candidates = parseSubjectCandidates(draft);
  const inputError = subjectCandidateError(candidates);
  const reading = score.data ?? null;

  const onScore = useCallback(() => {
    if (offline || score.isPending) return;
    if (subjectCandidateError(candidates) !== null) return;
    haptics.tap();
    score.mutate(candidates);
  }, [candidates, offline, score]);

  return (
    <Card style={{ gap: 10 }}>
      <Text
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontWeight: "500",
          fontFamily: FONT.medium,
        }}
      >
        Score a subject line
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {`One per line, up to ${SUBJECT_LAB_MAX_CANDIDATES}. Each is matched against your own sent campaigns with the same shape — length, question, emoji, caps, merge tag.`}
      </Text>

      <TextInput
        {...typeCap("body")}
        value={draft}
        onChangeText={setDraft}
        multiline
        editable={!offline && !score.isPending}
        placeholder={"Your April report is ready\nDon't miss this"}
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="Subject lines to score, one per line"
        style={{
          color: t.fg,
          backgroundColor: t.bgSubtle,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
          minHeight: 96,
          fontSize: 15,
          lineHeight: 21,
          fontFamily: FONT.regular,
          textAlignVertical: "top",
        }}
      />

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            flex: 1,
          }}
        >
          {candidates.length === 0
            ? "Nothing to score yet."
            : `${plural(candidates.length, "candidate")} ready.`}
        </Text>
        <ScoreButton
          label={score.isPending ? "Scoring…" : "Score"}
          onPress={onScore}
          disabled={offline || score.isPending || inputError !== null}
        />
      </View>

      {inputError && candidates.length > SUBJECT_LAB_MAX_CANDIDATES ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {inputError}
        </Text>
      ) : null}

      {score.error ? (
        <ErrorState
          compact
          error={score.error}
          message="Couldn't score these subject lines."
          onRetry={onScore}
        />
      ) : null}

      {reading ? (
        reading.insufficient ? (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            You have no sent campaigns with open data in the last{" "}
            {reading.windowDays ?? 180} days, so there is nothing to compare
            these against yet. Send a few campaigns and this becomes a real
            measurement.
          </Text>
        ) : (
          <View style={{ gap: 10 }}>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {`Your baseline open rate is ${reading.baselineLabel} over the last ${
                reading.windowDays ?? 180
              } days.`}
            </Text>
            {rankSubjectScoreRows(reading.rows).map((row) => (
              <ScoreRow key={row.key} row={row} />
            ))}
            {banditCampaignId && !offline ? (
              <SubjectLabBanditRow
                campaignId={banditCampaignId}
                rows={reading.rows}
              />
            ) : null}
          </View>
        )
      ) : null}
    </Card>
  );
}

function ScoreRow({ row }: { row: SubjectScoreRow }) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${row.text}. ${VERDICT_LABEL[row.verdict]}. Predicted open rate ${
        row.predictedLabel
      }, range ${row.bandLabel}.${row.caveat ? ` ${row.caveat}` : ""}`}
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingTop: 10,
        gap: 6,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
        }}
      >
        {row.text}
      </Text>
      <View
        style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
      >
        <Text
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            fontFamily: FONT.semibold,
            fontVariant: ["tabular-nums"],
          }}
        >
          {row.predictedLabel}
        </Text>
        <Pill label={VERDICT_LABEL[row.verdict]} tone={VERDICT_TONE[row.verdict]} />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
      >
        {[
          `Range ${row.bandLabel}`,
          row.deltaLabel,
          row.matchedN > 0
            ? `${plural(row.matchedN, "matching send")}`
            : "no matching sends",
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      {row.caveat ? (
        <Text
          {...typeCap("caption")}
            style={{
            color: t.warning,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {row.caveat}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Local button rather than the campaigns cluster's ActionButton: importing
 * across cluster boundaries for one control drags the whole campaign detail
 * module graph into a screen that has nothing to do with a campaign.
 *
 * NativeWind v4 house rule: the style is a STATIC object. A
 * `style={({pressed}) => ...}` on a Pressable silently drops layout here.
 */
function ScoreButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={{
        backgroundColor: disabled ? t.bgSubtle : t.accent,
        borderColor: disabled ? t.border : t.accent,
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: 16,
        paddingVertical: 10,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: disabled ? t.fgSubtle : t.accentFg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
