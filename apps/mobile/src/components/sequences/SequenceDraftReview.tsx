/**
 * SequenceDraftReview — the review gate between a model's output and the
 * workspace's data.
 *
 * This screen is the reason AUTOMATION#15 is safe to ship on a phone. The
 * drafting endpoint PERSISTS NOTHING (services/voice/.../sequence_draft.go
 * returns the draft and never calls Save), so what the model wrote exists only
 * in this component's state until someone presses Save — and what gets saved is
 * a `draft`, because `createDraftSequence` refuses `active` outright. There is
 * no path from here to a send.
 *
 * THREE THINGS THIS SCREEN OWES THE OPERATOR
 *  - IT SAYS A MODEL WROTE IT, in the Article 50 words the Go gateway owns
 *    (@postwave/ai-disclosure), before the first email.
 *  - IT IS EDITABLE. Subject and body are inputs, not labels, and any email can
 *    be dropped. A review surface you cannot act on is a preview, and a preview
 *    is what the audit kept finding.
 *  - IT REFUSES WHAT THE SAVE WOULD REFUSE, per email, up front. The drafting
 *    endpoint keeps a step that has a body but NO SUBJECT, and the save
 *    endpoint rejects the whole sequence for it. Discovering that as one opaque
 *    400 after reading five emails is the failure this file exists to prevent.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { AI_DISCLOSURE_TEXT } from "@postwave/ai-disclosure";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import {
  DraftDisclosure,
  DraftErrorLine,
  DraftFieldLabel,
  DraftSheetButton,
} from "@/components/sequences/SequenceDraftChrome";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { keyboardDismiss } from "@/lib/keyboardChain";
import { SEQUENCE_NAME_MAX_RUNES } from "@/lib/sequenceCreate";
import {
  SEQUENCE_DRAFT_REVIEW_NOTE,
  formatDraftDelay,
  type SequenceDraftEmail,
  type SequenceDraftPlan,
} from "@/lib/sequenceDraft";
import {
  SEQUENCE_STEP_SUBJECT_MAX_RUNES,
  draftSaveProblems,
} from "@/lib/sequenceDraftSave";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface SequenceDraftReviewProps {
  visible: boolean;
  /** The decoded draft. Null until one has come back. */
  plan: SequenceDraftPlan | null;
  saving: boolean;
  error: string | null;
  onDiscard: () => void;
  onSave: (input: {
    name: string;
    emails: readonly SequenceDraftEmail[];
  }) => void;
}

export function SequenceDraftReview({
  visible,
  plan,
  saving,
  error,
  onDiscard,
  onSave,
}: SequenceDraftReviewProps) {
  const { t } = useTheme();
  const [name, setName] = useState("");
  const [emails, setEmails] = useState<readonly SequenceDraftEmail[]>([]);

  // Seed from the plan, and ONLY from a new plan. Re-seeding on every render
  // (or on `visible`) would throw away edits the moment a parent re-rendered,
  // which on this screen means losing rewritten copy with no way back.
  useEffect(() => {
    if (!plan) return;
    setName(plan.name);
    setEmails(plan.emails);
  }, [plan]);

  const problems = useMemo(
    () => draftSaveProblems({ name, emails }),
    [name, emails],
  );
  const blocked = problems.length > 0;
  const sequenceProblems = problems.filter((p) => p.id === "sequence");

  const editEmail = (id: string, patch: Partial<SequenceDraftEmail>): void => {
    setEmails((current) =>
      current.map((email) => (email.id === id ? { ...email, ...patch } : email)),
    );
  };
  const removeEmail = (id: string): void => {
    haptics.tap();
    setEmails((current) => current.filter((email) => email.id !== id));
  };

  const submit = (): void => {
    if (saving) return;
    if (blocked) {
      haptics.error();
      return;
    }
    haptics.tap();
    onSave({ name: name.trim(), emails });
  };

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onDiscard}
      accessibilityLabel="Review the AI-drafted sequence"
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
        Review the draft
      </Text>

      <DraftDisclosure
        disclosure={AI_DISCLOSURE_TEXT}
        note={SEQUENCE_DRAFT_REVIEW_NOTE}
      />

      {plan?.rationale ? (
        <View style={{ gap: 4 }}>
          <DraftFieldLabel text="Why the model chose this arc" />
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {plan.rationale}
          </Text>
        </View>
      ) : null}

      <View style={{ gap: 6 }}>
        <DraftFieldLabel text="Sequence name" />
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Winback series"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="Sequence name"
          autoCapitalize="sentences"
          autoCorrect
          editable={!saving}
          // The return key only closes the keyboard. There is no "next field"
          // to advance to that is not inside a card, and saving from here would
          // commit a draft the operator has not scrolled through yet.
          {...keyboardDismiss()}
          maxLength={SEQUENCE_NAME_MAX_RUNES * 2}
          maxFontSizeMultiplier={typeCap("body").maxFontSizeMultiplier}
          style={{
            minHeight: 48,
            color: t.fg,
            backgroundColor: t.surface,
            borderColor: sequenceProblems.length > 0 ? t.danger : t.border,
            borderWidth: 1,
            borderRadius: 12,
            paddingHorizontal: 12,
            paddingVertical: 12,
            fontFamily: FONT.regular,
            fontSize: typeStyle("body").fontSize,
          }}
        />
      </View>

      {emails.map((email, index) => (
        <DraftEmailCard
          key={email.id}
          email={email}
          index={index}
          saving={saving}
          problems={problems
            .filter((problem) => problem.id === email.id)
            .map((problem) => problem.message)}
          onChange={editEmail}
          onRemove={removeEmail}
        />
      ))}

      {sequenceProblems.map((problem) => (
        <DraftErrorLine key={problem.message} message={problem.message} />
      ))}
      {error ? <DraftErrorLine message={error} /> : null}

      <View style={{ flexDirection: "row", gap: 10 }}>
        <DraftSheetButton
          label="Discard"
          onPress={onDiscard}
          disabled={saving}
          primary={false}
          accessibilityHint="Throws this draft away. Nothing has been saved."
        />
        <DraftSheetButton
          label={saving ? "Saving…" : "Save as draft"}
          onPress={submit}
          disabled={saving || blocked}
          primary
          accessibilityHint="Saves these emails as a draft sequence. Nothing sends."
        />
      </View>
    </KeyboardFormSheet>
  );
}

/**
 * One drafted email, as an editable card.
 *
 * The wait is a LABEL, not a control: `delay_hours` is the arc the model
 * proposed, and there is no authoring canvas on this phone to re-time it
 * against. Saying what it is, and saying honestly when the model gave nothing
 * (`formatDraftDelay(null)`), is the whole of what this surface can claim.
 */
function DraftEmailCard({
  email,
  index,
  saving,
  problems,
  onChange,
  onRemove,
}: {
  email: SequenceDraftEmail;
  index: number;
  saving: boolean;
  problems: readonly string[];
  onChange: (id: string, patch: Partial<SequenceDraftEmail>) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTheme();
  const position = index + 1;
  return (
    <View
      style={{
        padding: 12,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: problems.length > 0 ? t.danger : t.border,
        backgroundColor: t.surface,
        gap: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text
            {...typeCap("callout")}
            accessibilityRole="header"
            style={{
              color: t.fg,
              ...typeStyle("callout"),
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            Email {position}
          </Text>
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {formatDraftDelay(email.delayHours)}
          </Text>
        </View>
        <Pressable
          onPress={() => onRemove(email.id)}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel={`Remove email ${position}`}
          accessibilityHint="Drops this email from the draft before it is saved."
          accessibilityState={{ disabled: saving }}
          hitSlop={8}
          style={{
            minWidth: 44,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            opacity: saving ? 0.5 : 1,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.danger,
              ...typeStyle("control"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Remove
          </Text>
        </Pressable>
      </View>

      <TextInput
        value={email.subject}
        onChangeText={(next) => onChange(email.id, { subject: next })}
        placeholder="Subject line"
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel={`Subject line for email ${position}`}
        autoCapitalize="sentences"
        autoCorrect
        editable={!saving}
        // Dismiss, not submit: the field below is the multiline body, whose
        // own return key is a newline, and Save lives at the end of the sheet.
        {...keyboardDismiss()}
        maxLength={SEQUENCE_STEP_SUBJECT_MAX_RUNES * 2}
        maxFontSizeMultiplier={typeCap("body").maxFontSizeMultiplier}
        style={{
          minHeight: 48,
          color: t.fg,
          backgroundColor: t.bg,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 10,
          paddingHorizontal: 10,
          paddingVertical: 10,
          fontFamily: FONT.regular,
          fontSize: typeStyle("body").fontSize,
        }}
      />

      <TextInput
        value={email.body}
        onChangeText={(next) => onChange(email.id, { body: next })}
        placeholder="Email body"
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel={`Body of email ${position}`}
        multiline
        autoCapitalize="sentences"
        autoCorrect
        editable={!saving}
        maxFontSizeMultiplier={typeCap("body").maxFontSizeMultiplier}
        style={{
          minHeight: 148,
          textAlignVertical: "top",
          color: t.fg,
          backgroundColor: t.bg,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 10,
          paddingHorizontal: 10,
          paddingVertical: 10,
          fontFamily: FONT.regular,
          fontSize: typeStyle("body").fontSize,
        }}
      />

      {problems.map((problem) => (
        <DraftErrorLine key={problem} message={problem} />
      ))}
    </View>
  );
}
