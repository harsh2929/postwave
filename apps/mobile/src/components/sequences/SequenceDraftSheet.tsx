/**
 * SequenceDraftSheet — describe a campaign, get a whole sequence back.
 *
 * The first half of AUTOMATION#15. It collects the three fields
 * `POST /api/v1/voice/sequences/draft` accepts — `brief`, `step_count`, `tone`
 * — and nothing else, because the handler decodes with strict bounds and every
 * extra field is a guaranteed 400.
 *
 * WHY IT SAYS WHAT IT COSTS BEFORE IT SPENDS ANYTHING. The handler consumes a
 * quota unit (kind `sequence_draft`) BEFORE it calls the model, so a request
 * costs the workspace whether or not the operator likes the result. Every
 * other form in this app can be retried for free; this one cannot, and
 * `SEQUENCE_DRAFT_BRIEF_NOTE` is the sentence that makes that true on screen
 * rather than only in the handler.
 *
 * ONLINE ONLY, and unlike the blank-create sheet that is not an omission. A
 * generation cannot be queued: `lib/offlineQueueSafety` would have to replay a
 * request that spends money at an unpredictable later moment, and the operator
 * would be looking at a different screen when the emails arrived. The blank
 * "New sequence" path stays available offline for exactly the reason this one
 * does not.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useEffect, useMemo, useState } from "react";
import { Text, TextInput, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { SegmentedControl } from "@/components/SegmentedControl";
import {
  DraftErrorLine,
  DraftFieldLabel,
  DraftSheetButton,
} from "@/components/sequences/SequenceDraftChrome";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { keyboardChain } from "@/lib/keyboardChain";
import {
  SEQUENCE_DRAFT_BRIEF_MAX_RUNES,
  SEQUENCE_DRAFT_BRIEF_NOTE,
  SEQUENCE_DRAFT_STEP_COUNT_DEFAULT,
  SEQUENCE_DRAFT_STEP_COUNT_MAX,
  SEQUENCE_DRAFT_STEP_COUNT_MIN,
  SEQUENCE_DRAFT_TONE_MAX_RUNES,
  clampDraftStepCount,
  validateSequenceBrief,
  validateSequenceDraftTone,
} from "@/lib/sequenceDraft";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface SequenceDraftSheetProps {
  visible: boolean;
  onClose: () => void;
  /** True while the draft request is in flight. */
  busy: boolean;
  /** The last failure, already turned into a sentence by the caller. */
  error: string | null;
  onGenerate: (input: {
    brief: string;
    stepCount: number;
    tone: string;
  }) => void;
}

/**
 * 1..10, because `generation.DraftStepCountMax` is 10 and `<= 0` means "use
 * the default" server-side. Rendered as chips rather than a free number field:
 * the range is short, and a stepper cannot produce a value the handler would
 * reject.
 */
const STEP_COUNT_OPTIONS = Array.from(
  { length: SEQUENCE_DRAFT_STEP_COUNT_MAX - SEQUENCE_DRAFT_STEP_COUNT_MIN + 1 },
  (_, index) => {
    const count = SEQUENCE_DRAFT_STEP_COUNT_MIN + index;
    return { value: String(count), label: String(count) };
  },
);

export function SequenceDraftSheet({
  visible,
  onClose,
  busy,
  error,
  onGenerate,
}: SequenceDraftSheetProps) {
  const { t } = useTheme();
  const [brief, setBrief] = useState("");
  const [tone, setTone] = useState("");
  const [stepCount, setStepCount] = useState(SEQUENCE_DRAFT_STEP_COUNT_DEFAULT);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setSubmitted(false);
  }, [visible]);

  const briefCheck = useMemo(() => validateSequenceBrief(brief), [brief]);
  const toneCheck = useMemo(() => validateSequenceDraftTone(tone), [tone]);
  // Only complain once the operator has tried: an error under an untouched
  // field is noise, not help.
  const fieldError = submitted
    ? !briefCheck.ok
      ? briefCheck.error
      : !toneCheck.ok
        ? toneCheck.error
        : null
    : null;

  const submit = (): void => {
    setSubmitted(true);
    if (busy) return;
    if (!briefCheck.ok || !toneCheck.ok) {
      haptics.error();
      return;
    }
    haptics.tap();
    onGenerate({
      brief: briefCheck.value,
      stepCount: clampDraftStepCount(stepCount),
      tone: toneCheck.value,
    });
  };

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Draft a sequence with AI"
      contentContainerStyle={{ gap: 14 }}
    >
      <Text
        {...typeCap("title")}
        accessibilityRole="header"
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        Draft with AI
      </Text>

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {SEQUENCE_DRAFT_BRIEF_NOTE}
      </Text>

      <View style={{ gap: 6 }}>
        <DraftFieldLabel text="What is this sequence for?" />
        <TextInput
          value={brief}
          onChangeText={setBrief}
          placeholder="Win back customers who haven't ordered in 90 days. We sell single-origin coffee; offer 15% off their usual roast."
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="Campaign brief"
          accessibilityHint="Describe the audience, the offer, and anything the emails must not invent."
          multiline
          autoCapitalize="sentences"
          autoCorrect
          autoFocus
          editable={!busy}
          // The server counts RUNES and `maxLength` counts UTF-16 units, so
          // this is generous and `validateSequenceBrief` is the real gate — a
          // tight ceiling here would truncate an emoji brief the server would
          // have accepted.
          maxLength={SEQUENCE_DRAFT_BRIEF_MAX_RUNES * 2}
          maxFontSizeMultiplier={typeCap("body").maxFontSizeMultiplier}
          style={{
            minHeight: 132,
            textAlignVertical: "top",
            color: t.fg,
            backgroundColor: t.surface,
            borderColor: fieldError && !briefCheck.ok ? t.danger : t.border,
            borderWidth: 1,
            borderRadius: 12,
            paddingHorizontal: 12,
            paddingVertical: 12,
            fontFamily: FONT.regular,
            fontSize: typeStyle("body").fontSize,
          }}
        />
      </View>

      <View style={{ gap: 6 }}>
        <DraftFieldLabel text="How many emails?" />
        <SegmentedControl<string>
          options={STEP_COUNT_OPTIONS}
          value={String(stepCount)}
          onChange={(next) => {
            haptics.tap();
            setStepCount(clampDraftStepCount(Number(next)));
          }}
          accessibilityLabel="Number of emails to draft"
          scrollable
        />
      </View>

      <View style={{ gap: 6 }}>
        <DraftFieldLabel text="Tone (optional)" />
        <TextInput
          value={tone}
          onChangeText={setTone}
          placeholder="Warm and direct"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="Tone"
          accessibilityHint="Left empty, the model infers a tone from your brief."
          autoCapitalize="sentences"
          autoCorrect
          // Terminal field of this form, so the return key IS the submit —
          // `keyboardChain` also sets the submitBehavior without which the
          // handler would never fire.
          {...keyboardChain({ onSubmit: submit, returnKeyType: "done" })}
          editable={!busy}
          maxLength={SEQUENCE_DRAFT_TONE_MAX_RUNES * 2}
          maxFontSizeMultiplier={typeCap("body").maxFontSizeMultiplier}
          style={{
            minHeight: 48,
            color: t.fg,
            backgroundColor: t.surface,
            borderColor: fieldError && !toneCheck.ok ? t.danger : t.border,
            borderWidth: 1,
            borderRadius: 12,
            paddingHorizontal: 12,
            paddingVertical: 12,
            fontFamily: FONT.regular,
            fontSize: typeStyle("body").fontSize,
          }}
        />
      </View>

      {fieldError ? <DraftErrorLine message={fieldError} /> : null}
      {error ? <DraftErrorLine message={error} /> : null}

      {busy ? (
        <Text
          {...typeCap("bodySmall")}
          accessibilityRole="progressbar"
          accessibilityLabel="Drafting your sequence"
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          Drafting {stepCount} email{stepCount === 1 ? "" : "s"}… this takes a
          few seconds. Leaving this sheet cancels it.
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", gap: 10 }}>
        <DraftSheetButton
          label="Cancel"
          onPress={onClose}
          disabled={false}
          primary={false}
        />
        <DraftSheetButton
          label={busy ? "Drafting…" : "Draft emails"}
          onPress={submit}
          disabled={busy}
          primary
          accessibilityHint="Spends one AI request. You review the emails before anything is saved."
        />
      </View>
    </KeyboardFormSheet>
  );
}
