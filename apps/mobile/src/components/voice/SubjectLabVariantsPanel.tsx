/**
 * SubjectLabVariantsPanel — "write me some, then tell me which one wins".
 *
 * The Subject Lab shipped able to GRADE a subject line and unable to WRITE
 * one, which made the screen a marking scheme with no exam: every candidate
 * had to be invented somewhere else and pasted in. Mobile does generate
 * subject lines elsewhere — SubjectLineSuggestions, inside the campaign
 * subject sheet — but that generator paraphrases a draft. This one is the
 * different thing desktop and web both reach: POST /api/v1/subject-lab/variants,
 * conditioned on an AXIS, so the results differ along the dimension you asked
 * about instead of being five rewordings of one shape.
 *
 * THE POINT IS THE HANDOFF. Generating and scoring on the same screen is only
 * worth building if the output of one is the input of the other, so "Score
 * these" hands the seed AND the variants to the scoring panel with the seed
 * first — the question is "is any of these better than what I already wrote",
 * and a ranking that drops the incumbent cannot answer it.
 *
 * WHAT IS NOT PRE-JUDGED. `/variants` sits behind a per-tenant `subject_lab`
 * feature flag that is off by default, and there is no probe for it. The
 * control is therefore offered and the server's refusal is RENDERED —
 * ErrorState reads the entitlement envelope through lib/errorCopy and prints
 * the flag sentence with no Retry button, because retrying a disabled feature
 * cannot work. Hiding the panel in advance would tell a workspace that has the
 * flag that the feature does not exist.
 *
 * NativeWind v4 house rule, as everywhere in this app: every Pressable `style`
 * is a STATIC object. The `({ pressed }) => …` form silently drops layout.
 */
import { useCallback, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { Card } from "@/components/Card";
import { ErrorState } from "@/components/ErrorState";
import { SegmentedControl } from "@/components/SegmentedControl";
import { useGenerateSubjectVariants } from "@/hooks/useSubjectLabVariants";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { plural } from "@/lib/format";
import {
  canGenerateFromSeed,
  scorableFrom,
  subjectSeedHint,
  SUBJECT_LAB_AXES,
  SUBJECT_LAB_VARIANT_DEFAULT,
  type SubjectLabAxis,
} from "@/lib/subjectLabVariants";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface SubjectLabVariantsPanelProps {
  /** Gate closed — the screen already says why, so the panel just refuses. */
  offline: boolean;
  /** Hand the seed + variants to the scorer, one per line. */
  onScoreThese: (candidates: string) => void;
  /**
   * A seed arriving from a CAMPAIGN (the `?seed` deep link the subject sheet
   * pushes). A handoff object, not a string, for the same identity reason the
   * score panel documents: re-opening the link with the same subject must
   * refill a box the person has since edited. Undefined when the screen was
   * opened directly.
   */
  seedHandoff?: { seed: string } | undefined;
}

const AXIS_OPTIONS = SUBJECT_LAB_AXES.map((axis) => ({
  value: axis.value,
  label: axis.label,
}));

export function SubjectLabVariantsPanel({
  offline,
  onScoreThese,
  seedHandoff,
}: SubjectLabVariantsPanelProps) {
  const { t } = useTheme();
  const [seed, setSeed] = useState("");
  const [axis, setAxis] = useState<SubjectLabAxis>("length");
  const generate = useGenerateSubjectVariants();

  // Seeding during render, not from an effect — the score panel documents
  // why: an effect paints the old text for a frame, which reads as flicker.
  const [seededFrom, setSeededFrom] = useState<{ seed: string } | null>(null);
  if (seedHandoff && seedHandoff !== seededFrom) {
    setSeededFrom(seedHandoff);
    if (seedHandoff.seed.trim()) setSeed(seedHandoff.seed);
  }

  const seedHint = subjectSeedHint(seed);
  const ready = canGenerateFromSeed(seed);
  // `Array.isArray`, not `?? []` (src/lib/nullishArrayGuard.test.ts): `??`
  // substitutes only for null/undefined, so any truthy non-array would go
  // straight into the map below and throw.
  const variants = Array.isArray(generate.data?.variants)
    ? generate.data.variants
    : [];
  const axisHint =
    SUBJECT_LAB_AXES.find((entry) => entry.value === axis)?.hint ?? "";

  const onGenerate = useCallback(() => {
    if (offline || generate.isPending || !canGenerateFromSeed(seed)) return;
    haptics.tap();
    // NO `voiceProfileId`. This route does not resolve the field — it prints
    // it. `subject_lab.go` passes it through as `ComposeVariantsInput.ProfileID`
    // and aicompose's `profileBindingExtra` (aicompose.go:441-447) turns a
    // non-empty id into the literal context line "Bound brand voice profile:
    // <id>", so the "active" sentinel every CHAT surface sends would put a
    // profile id that does not exist into the prompt and into the auditable
    // context_text. The workspace's real voice arrives anyway and by a
    // different door: `ContextText` calls `loadBrandVoice(ctx, tenantID, tone)`
    // (aicompose.go:420-422), which reads the tenant's profile and emits its
    // OWN "Brand voice profile: <real id>" line with no id from the client. So
    // omitting the field costs nothing and stops the two lines contradicting
    // each other. See lib/aiVoiceProfile.ts — the sentinel is a chat-route
    // contract, not a global one.
    generate.mutate({
      seedSubject: seed,
      axis,
      count: SUBJECT_LAB_VARIANT_DEFAULT,
    });
  }, [axis, generate, offline, seed]);

  const onHandoff = useCallback(() => {
    if (variants.length === 0) return;
    haptics.tap();
    onScoreThese(scorableFrom(seed, variants));
  }, [onScoreThese, seed, variants]);

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
        Write some options
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        Start from the subject you have and pick what should vary. The results
        come back in your workspace&apos;s brand voice, and you can send them
        straight to the scorer below.
      </Text>

      <TextInput
        {...typeCap("body")}
        value={seed}
        onChangeText={setSeed}
        multiline
        editable={!offline && !generate.isPending}
        placeholder="Your April report is ready"
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="Subject line to generate variants from"
        style={{
          color: t.fg,
          backgroundColor: t.bgSubtle,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
          minHeight: 64,
          fontSize: 15,
          lineHeight: 21,
          fontFamily: FONT.regular,
          textAlignVertical: "top",
        }}
      />

      {seedHint ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {seedHint}
        </Text>
      ) : null}

      <SegmentedControl
        options={AXIS_OPTIONS}
        value={axis}
        onChange={setAxis}
        accessibilityLabel="What should vary"
        scrollable
      />
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {axisHint}
      </Text>

      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <LabButton
          label={generate.isPending ? "Writing…" : "Generate"}
          onPress={onGenerate}
          disabled={offline || generate.isPending || !ready}
          primary
        />
      </View>

      {generate.error ? (
        <ErrorState
          compact
          error={generate.error}
          message="Couldn't write any variants."
          onRetry={onGenerate}
        />
      ) : null}

      {generate.isSuccess && variants.length === 0 && !generate.error ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          The model returned nothing usable this time. Try again, or vary a
          different attribute.
        </Text>
      ) : null}

      {variants.length > 0 ? (
        <View style={{ gap: 8 }}>
          {variants.map((variant) => (
            <Text
              key={variant}
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
                borderTopColor: t.borderSubtle,
                borderTopWidth: 1,
                paddingTop: 8,
              }}
            >
              {variant}
            </Text>
          ))}
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
              {`${plural(variants.length, "option")} plus your original.`}
            </Text>
            <LabButton
              label="Score these"
              onPress={onHandoff}
              disabled={offline}
            />
          </View>
        </View>
      ) : null}
    </Card>
  );
}

/**
 * Local button for the same reason SubjectLabScorePanel has one: importing the
 * campaigns cluster's ActionButton would drag the whole campaign-detail module
 * graph into a screen that has nothing to do with a campaign.
 */
function LabButton({
  label,
  onPress,
  disabled,
  primary = false,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  primary?: boolean;
}) {
  const { t } = useTheme();
  const background = disabled ? t.bgSubtle : primary ? t.accent : t.surface;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={{
        backgroundColor: background,
        borderColor: disabled ? t.border : primary ? t.accent : t.border,
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
          color: disabled ? t.fgSubtle : primary ? t.accentFg : t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
