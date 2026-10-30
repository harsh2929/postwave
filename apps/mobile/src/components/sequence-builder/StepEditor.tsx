/**
 * StepEditor — sheet-style modal that edits a single CanvasStep.
 *
 * The form is type-dispatched: email shows subject + body, delay shows
 * a value + unit picker, condition shows type + value, tag steps show
 * a tag name, exit shows just a confirmation note.
 *
 * Pattern: the modal holds a draft copy of the step, only commits on
 * "Save" tap. This matches the rest of the mobile app where modal
 * sheets persist on close-with-save and discard on cancel.
 */
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { SafeAreaView } from "react-native-safe-area-context";

import { Chip } from "@/components/Chip";
import { StepEditorFooter } from "./StepEditorFooter";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

import { type CanvasStep, type ConditionType, stepTypeLabel } from "./types";
import { keyboardChain, keyboardDismiss } from "@/lib/keyboardChain";

interface StepEditorProps {
  visible: boolean;
  step: CanvasStep | null;
  onCancel: () => void;
  onSave: (next: CanvasStep) => void;
}

const DELAY_UNITS: readonly ("minutes" | "hours" | "days")[] = [
  "minutes",
  "hours",
  "days",
];

const CONDITION_TYPES: readonly { key: ConditionType; label: string }[] = [
  { key: "opened", label: "Opened" },
  { key: "clicked", label: "Clicked" },
  { key: "tagged", label: "Tagged" },
  { key: "custom_property", label: "Property" },
  { key: "product_event", label: "Product event" },
];

/**
 * Validate a draft step before it can be saved. Returns an error message
 * for the first invalid field, or null when the step is savable. Prevents
 * empty/no-op steps (empty email, blank tag, zero-length delay) from being
 * persisted — the parent screen's onSaveEdit does no validation of its own.
 */
function validateStep(s: CanvasStep): string | null {
  switch (s.type) {
    case "email":
      if (!s.subject?.trim() && !s.body?.trim()) {
        return "Add a subject or body before saving this email step.";
      }
      return null;
    case "delay":
      if (!s.delay_value || s.delay_value < 1) {
        return "Set a wait of at least 1 before saving this delay step.";
      }
      return null;
    case "tag_add":
    case "tag_remove":
      if (!s.tag?.trim()) {
        return "Enter a tag name before saving this step.";
      }
      return null;
    default:
      return null;
  }
}

export function StepEditor({
  visible,
  step,
  onCancel,
  onSave,
}: StepEditorProps) {
  const { t } = useTheme();
  const [draft, setDraft] = useState<CanvasStep | null>(step);
  // Subject → body is the one real chain here; every other step type shows a
  // single field, whose return key dismisses rather than promising a save.
  const bodyRef = useRef<TextInput>(null);
  // Inline validation message shown when the user tries to save an
  // empty/no-op step (cleared on field edits via update()).
  const [saveError, setSaveError] = useState<string | null>(null);

  // Re-seed the draft when the parent opens us with a fresh step.
  useEffect(() => {
    setDraft(step);
    setSaveError(null);
  }, [step]);

  const update = <K extends keyof CanvasStep>(key: K, value: CanvasStep[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setSaveError(null);
  };


  if (!draft) {
    return (
      <ReducedMotionModal
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={onCancel}
      >
        <SafeAreaView
          style={{ flex: 1, backgroundColor: t.bg }}
          edges={["top", "bottom"]}
          accessibilityViewIsModal
          accessibilityLabel="Edit sequence step"
        >
          <View style={{ padding: 20 }}>
            <Text
              {...typeCap("body")}
              style={{
                color: t.fgMuted,
                ...typeStyle("body"),
                fontFamily: FONT.regular,
              }}
            >
              No step selected.
            </Text>
          </View>
        </SafeAreaView>
      </ReducedMotionModal>
    );
  }

  return (
    <ReducedMotionModal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onCancel}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
        accessibilityViewIsModal
        accessibilityLabel="Edit sequence step"
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView
            contentContainerStyle={{ padding: 20, paddingBottom: 32 }}
            keyboardShouldPersistTaps="handled"
          >
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              <Text
                {...typeCap("title")}
                accessibilityRole="header"
                style={{
                  color: t.fg,
                  ...typeStyle("title"),
                  fontWeight: "700",
                  fontFamily: FONT.display,
                }}
              >
                {stepTypeLabel(draft.type)} step
              </Text>
              <Pressable
                onPress={onCancel}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text
                  {...typeCap("callout")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("callout"),
                    fontFamily: FONT.regular,
                  }}
                >
                  Cancel
                </Text>
              </Pressable>
            </View>

            {draft.type === "email" ? (
              <>
                <FieldLabel>Subject</FieldLabel>
                <TextInput
                  // Inputs scale with the OS text size but their height does not — cap it.
                  {...typeCap("body")}
                  value={draft.subject ?? ""}
                  onChangeText={(v) => update("subject", v)}
                  placeholder="A clear, specific subject"
                  placeholderTextColor={t.fgSubtle}
                  accessibilityLabel="Email step subject"
                  accessibilityHint="Subject line for this sequence email step."
                  {...keyboardChain({ next: bodyRef })}
                  style={inputStyle(t)}
                />
                <FieldLabel style={{ marginTop: 12 }}>Body</FieldLabel>
                <TextInput
                  // Inputs scale with the OS text size but their height does not — cap it.
                  {...typeCap("body")}
                  ref={bodyRef}
                  value={draft.body ?? ""}
                  onChangeText={(v) => update("body", v)}
                  placeholder="Plain text body — Moosewave wraps it in the workspace template on send."
                  placeholderTextColor={t.fgSubtle}
                  accessibilityLabel="Email step body"
                  accessibilityHint="Plain text body for this sequence email step."
                  multiline
                  style={[
                    inputStyle(t),
                    { minHeight: 120, textAlignVertical: "top" },
                  ]}
                />
              </>
            ) : null}

            {draft.type === "delay" ? (
              <>
                <FieldLabel>Wait for</FieldLabel>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <TextInput
                    // Inputs scale with the OS text size but their height does not — cap it.
                    {...typeCap("body")}
                    value={String(draft.delay_value ?? 1)}
                    onChangeText={(v) => {
                      const n = parseInt(v.replace(/[^0-9]/g, ""), 10);
                      update("delay_value", Number.isFinite(n) ? n : 0);
                    }}
                    keyboardType="number-pad"
                    accessibilityLabel="Wait duration"
                    accessibilityHint="Number of minutes, hours, or days before the next step."
                    {...keyboardDismiss()}
                    style={[inputStyle(t), { flex: 1 }]}
                  />
                </View>
                <FieldLabel style={{ marginTop: 12 }}>Unit</FieldLabel>
                <View
                  style={{
                    flexDirection: "row",
                    flexWrap: "wrap",
                    gap: 6,
                  }}
                >
                  {DELAY_UNITS.map((u) => (
                    <Chip
                      key={u}
                      label={u}
                      active={(draft.delay_unit ?? "days") === u}
                      onPress={() => update("delay_unit", u)}
                    />
                  ))}
                </View>
              </>
            ) : null}

            {draft.type === "condition" ? (
              <>
                <FieldLabel>Condition type</FieldLabel>
                <View
                  style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}
                >
                  {CONDITION_TYPES.map((c) => (
                    <Chip
                      key={c.key}
                      label={c.label}
                      active={(draft.condition_type ?? "opened") === c.key}
                      onPress={() => update("condition_type", c.key)}
                    />
                  ))}
                </View>
                <FieldLabel style={{ marginTop: 12 }}>Value</FieldLabel>
                <TextInput
                  // Inputs scale with the OS text size but their height does not — cap it.
                  {...typeCap("body")}
                  value={draft.condition_value ?? ""}
                  onChangeText={(v) => update("condition_value", v)}
                  placeholder="e.g. previous email"
                  placeholderTextColor={t.fgSubtle}
                  accessibilityLabel="Condition value"
                  accessibilityHint="Optional value used by this sequence condition."
                  {...keyboardDismiss()}
                  style={inputStyle(t)}
                />
              </>
            ) : null}

            {draft.type === "tag_add" || draft.type === "tag_remove" ? (
              <>
                <FieldLabel>Tag</FieldLabel>
                <TextInput
                  // Inputs scale with the OS text size but their height does not — cap it.
                  {...typeCap("body")}
                  value={draft.tag ?? ""}
                  onChangeText={(v) => update("tag", v)}
                  placeholder="warm-lead"
                  placeholderTextColor={t.fgSubtle}
                  accessibilityLabel="Tag name"
                  accessibilityHint="Tag to add or remove when this sequence step runs."
                  autoCapitalize="none"
                  {...keyboardDismiss()}
                  style={inputStyle(t)}
                />
              </>
            ) : null}

            {draft.type === "exit" ? (
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                }}
              >
                When the run reaches this step the subscriber is removed from
                the sequence. Any downstream steps after Exit are ignored.
              </Text>
            ) : null}

            {/* Validate the draft before committing: empty email steps,
                blank tags, and zero-length delays are no-ops the parent
                screen would otherwise persist verbatim. The footer takes that
                decision ONCE and drives both the message and the disabled
                state from it. */}
            <StepEditorFooter
              invalid={validateStep(draft) !== null}
              saveError={saveError}
              onCancel={onCancel}
              onSave={() => {
                const err = validateStep(draft);
                if (err) {
                  setSaveError(err);
                  return;
                }
                onSave(draft);
              }}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function FieldLabel({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: { marginTop?: number };
}) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        letterSpacing: 0.5,
        fontWeight: "600",
        fontFamily: FONT.semibold,
        textTransform: "uppercase",
        marginBottom: 4,
        marginTop: style?.marginTop ?? 0,
      }}
    >
      {children}
    </Text>
  );
}

function inputStyle(t: ReturnType<typeof useTheme>["t"]) {
  return {
    backgroundColor: t.bgSubtle,
    borderColor: t.border,
    borderWidth: 1,
    color: t.fg,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    // `fontSizeFor`, not `typeStyle`: an explicit lineHeight on a TextInput
    // mis-centres the caret and clips descenders on Android.
    fontSize: fontSizeFor("body"),
  } as const;
}
