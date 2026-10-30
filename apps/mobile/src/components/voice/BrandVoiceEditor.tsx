/**
 * BrandVoiceEditor — admin-only sheet for the authored brand voice.
 *
 * One line per entry. A per-row add/remove list is the desktop gesture; on a
 * phone it costs a tap to add a row, a tap to focus it, and a tap to dismiss
 * the keyboard for every descriptor. A single multiline field lets an operator
 * type six descriptors in six lines without leaving the keyboard once, and the
 * parser drops blank lines so the round trip is idempotent.
 *
 * Sample snippets are deliberately NOT editable here — they run to 4096
 * characters each and belong to a desk. They are round-tripped verbatim by the
 * caller because PUT is a full replace; the sheet says so out loud so nobody
 * assumes an unedited field means an untouched one.
 */
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { plural } from "@/lib/format";
import {
  BRAND_VOICE_CAPS,
  brandVoiceDraftError,
  parseLineList,
  toLineList,
} from "@/lib/brandVoice";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export interface BrandVoiceEditorProps {
  visible: boolean;
  descriptors: string[];
  writingRules: string[];
  snippetCount: number;
  saving: boolean;
  onCancel: () => void;
  onSave: (draft: { descriptors: string[]; writingRules: string[] }) => void;
}

export function BrandVoiceEditor({
  visible,
  descriptors,
  writingRules,
  snippetCount,
  saving,
  onCancel,
  onSave,
}: BrandVoiceEditorProps) {
  const { t } = useTheme();
  const [descriptorText, setDescriptorText] = useState(() =>
    toLineList(descriptors),
  );
  const [ruleText, setRuleText] = useState(() => toLineList(writingRules));

  // Re-seed whenever the sheet opens, so a cancelled edit does not persist
  // into the next open and a server-side change is picked up.
  useEffect(() => {
    if (!visible) return;
    setDescriptorText(toLineList(descriptors));
    setRuleText(toLineList(writingRules));
  }, [visible, descriptors, writingRules]);

  const draft = useMemo(
    () => ({
      descriptors: parseLineList(descriptorText),
      writingRules: parseLineList(ruleText),
    }),
    [descriptorText, ruleText],
  );
  const error = useMemo(() => brandVoiceDraftError(draft), [draft]);
  const canSave = !saving && error === null;

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onCancel}
      accessibilityLabel="Edit authored brand voice"
      contentContainerStyle={{ gap: 16 }}
    >
      <Text
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        Authored brand voice
      </Text>

      <Field
        label="Descriptors"
        hint={`One per line. Up to ${BRAND_VOICE_CAPS.descriptors}, ${BRAND_VOICE_CAPS.descriptorChars} characters each.`}
        value={descriptorText}
        onChangeText={setDescriptorText}
        placeholder={"warm\nplain-spoken\nnever breathless"}
        count={draft.descriptors.length}
        max={BRAND_VOICE_CAPS.descriptors}
        noun="descriptor"
        minHeight={110}
      />

      <Field
        label="Writing rules"
        hint={`One per line. Up to ${BRAND_VOICE_CAPS.writingRules}, ${BRAND_VOICE_CAPS.ruleChars} characters each.`}
        value={ruleText}
        onChangeText={setRuleText}
        placeholder={
          "Never use exclamation marks.\nLead with the reader's problem."
        }
        count={draft.writingRules.length}
        max={BRAND_VOICE_CAPS.writingRules}
        noun="writing rule"
        minHeight={150}
      />

      {snippetCount > 0 ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {plural(snippetCount, "sample snippet")} stay as they are — they are
          edited on desktop and are re-sent unchanged when you save.
        </Text>
      ) : null}

      {error ? (
        <Text
          {...typeCap("bodySmall")}
          accessibilityRole="alert"
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {error}
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", gap: 10 }}>
        <SheetButton
          label="Cancel"
          onPress={onCancel}
          disabled={saving}
          tone="secondary"
        />
        <SheetButton
          label={saving ? "Saving…" : "Save"}
          onPress={() => {
            if (!canSave) return;
            haptics.tap();
            onSave(draft);
          }}
          disabled={!canSave}
          tone="primary"
        />
      </View>
    </KeyboardFormSheet>
  );
}

function Field({
  label,
  hint,
  value,
  onChangeText,
  placeholder,
  count,
  max,
  noun,
  minHeight,
}: {
  label: string;
  hint: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  count: number;
  max: number;
  noun: string;
  minHeight: number;
}) {
  const { t } = useTheme();
  const over = count > max;
  return (
    <View style={{ gap: 6 }}>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {hint}
      </Text>
      <TextInput
        multiline
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel={`${label}, one per line`}
        accessibilityHint={hint}
        autoCapitalize="none"
        autoCorrect={false}
        maxFontSizeMultiplier={typeCap("body").maxFontSizeMultiplier}
        style={{
          minHeight,
          color: t.fg,
          backgroundColor: t.surface,
          borderColor: over ? t.danger : t.border,
          borderWidth: 1,
          borderRadius: 12,
          padding: 12,
          textAlignVertical: "top",
          fontFamily: FONT.regular,
          // Size only: an explicit lineHeight on a TextInput mis-centres
          // the caret and clips descenders on Android.
          fontSize: fontSizeFor("body"),
        }}
      />
      {/* An exact spoken value beside the compacted "6 / 20" reading. */}
      <Text
        {...typeCap("label")}
        accessibilityLabel={`${plural(count, noun)} of ${max} used`}
        style={{
          color: over ? t.danger : t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {count} / {max}
      </Text>
    </View>
  );
}

function SheetButton({
  label,
  onPress,
  disabled,
  tone,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  tone: "primary" | "secondary";
}) {
  const { t } = useTheme();
  const primary = tone === "primary";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={{
        flex: 1,
        minHeight: 48,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 12,
        borderWidth: 1,
        borderColor: primary ? t.accent : t.border,
        backgroundColor: primary ? t.accent : t.surface,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        {...typeCap("body")}
        style={{
          color: primary ? t.accentFg : t.fg,
          ...typeStyle("body"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
