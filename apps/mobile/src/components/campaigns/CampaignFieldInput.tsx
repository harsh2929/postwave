/**
 * CampaignFieldInput — one labelled, validated, counted text field.
 *
 * Extracted because the create sheet needs five of them and the subject sheet
 * needs one; without it each would grow its own slightly-different version of
 * the label / counter / error triple (which is exactly how the cluster ended
 * up with three divergent copies of every formatter).
 *
 * KEYBOARD SUBMIT AND FIELD-TO-FIELD CHAINING. Every field in this cluster
 * previously rendered a bare "return" key that did nothing (or, on the
 * multiline ones, inserted a newline into a SUBJECT LINE — a string the wire
 * format cannot carry a newline in). Filling the create sheet therefore meant
 * dismissing the keyboard and hunting for the next field five times.
 *
 * `next`/`onSubmitEditing` are declared here rather than in each sheet so the
 * chain is described once, at the call site, as a list of refs — see
 * CampaignCreateModal. Two details that are easy to get wrong:
 *
 *   - `submitBehavior="submit"` is REQUIRED on a multiline field for
 *     onSubmitEditing to fire at all; the default ("newline") swallows the
 *     return key. The old `blurOnSubmit` name is deprecated in this RN.
 *   - `blurOnSubmit`-style blurring must NOT happen when we are handing focus
 *     to a sibling, or iOS dismisses and re-raises the keyboard between the
 *     two fields. "submit" keeps it up.
 */
import type { RefObject } from "react";
import { Text, TextInput, View } from "react-native";
import type {
  KeyboardTypeOptions,
  ReturnKeyTypeOptions,
  SubmitBehavior,
} from "react-native";

import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface CampaignFieldInputProps {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  /** Rendered under the field in danger tone; also drives the border colour. */
  error?: string | undefined;
  /** Muted helper line shown when there is no error. */
  hint?: string | undefined;
  /** When set, a live "n/max" counter renders next to the label. */
  maxLength?: number | undefined;
  multiline?: boolean;
  autoCapitalize?: "none" | "sentences" | "words";
  keyboardType?: KeyboardTypeOptions;
  autoCorrect?: boolean;
  editable?: boolean;
  /** Attach so a previous field's return key can move focus here. */
  inputRef?: RefObject<TextInput | null> | undefined;
  /**
   * The field the return key should move to. Renders a "next" return key and
   * focuses this ref on submit. Takes precedence over `onSubmitEditing`.
   */
  nextRef?: RefObject<TextInput | null> | undefined;
  /**
   * Terminal action for the last field in a chain — renders a "done"/"go" key
   * and runs this instead of moving focus.
   */
  onSubmitEditing?: (() => void) | undefined;
  /** Override the key cap when neither default reads right. */
  returnKeyType?: ReturnKeyTypeOptions | undefined;
}

export function CampaignFieldInput({
  label,
  value,
  onChangeText,
  placeholder,
  error,
  hint,
  maxLength,
  multiline = false,
  autoCapitalize = "sentences",
  keyboardType,
  autoCorrect = true,
  editable = true,
  inputRef,
  nextRef,
  onSubmitEditing,
  returnKeyType,
}: CampaignFieldInputProps) {
  const { t } = useTheme();
  const length = value.trim().length;
  const over = maxLength != null && length > maxLength;

  const submit = nextRef
    ? () => nextRef.current?.focus()
    : onSubmitEditing
      ? () => onSubmitEditing()
      : undefined;
  const keyCap: ReturnKeyTypeOptions | undefined =
    returnKeyType ?? (nextRef ? "next" : onSubmitEditing ? "done" : undefined);
  // Without this a multiline field never emits onSubmitEditing — RN's default
  // for multiline is "newline". Single-line fields keep "submit" too so the
  // keyboard stays up while focus moves to the sibling.
  const submitBehavior: SubmitBehavior | undefined = submit
    ? "submit"
    : undefined;

  return (
    <View style={{ marginBottom: 14 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <Text
          {...typeCap("label")}
          style={{ color: t.fgMuted, fontSize: 12, fontFamily: FONT.regular }}
        >
          {label}
        </Text>
        {maxLength != null ? (
          <Text
            {...typeCap("badgeSmall")}
            style={{
              color: over ? t.danger : t.fgSubtle,
              fontSize: 11,
              fontFamily: FONT.regular,
              fontVariant: ["tabular-nums"],
            }}
          >
            {length}/{maxLength}
          </Text>
        ) : null}
      </View>
      <TextInput
        // Inputs scale with the OS text size but their height does not — cap it.
        {...typeCap("body")}
        {...(inputRef ? { ref: inputRef } : {})}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder ?? ""}
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel={label}
        {...(error ? { accessibilityHint: error } : {})}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        editable={editable}
        multiline={multiline}
        {...(keyboardType ? { keyboardType } : {})}
        {...(keyCap ? { returnKeyType: keyCap } : {})}
        {...(submitBehavior ? { submitBehavior } : {})}
        {...(submit ? { onSubmitEditing: submit } : {})}
        style={{
          color: t.fg,
          fontSize: 15,
          fontFamily: FONT.regular,
          borderColor: error || over ? t.danger : t.border,
          borderWidth: 1,
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 10,
          backgroundColor: t.surface,
          // 44pt minimum touch target, taller for multiline.
          minHeight: multiline ? 68 : 44,
          opacity: editable ? 1 : 0.6,
        }}
      />
      {error ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.danger,
            fontSize: 11,
            marginTop: 6,
            lineHeight: 15,
            fontFamily: FONT.regular,
          }}
        >
          {error}
        </Text>
      ) : hint ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontSize: 11,
            marginTop: 6,
            lineHeight: 15,
            fontFamily: FONT.regular,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
