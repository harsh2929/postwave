/**
 * EditListSheet — fix a list's name, description, type or opt-in mode from
 * the phone (desktop anchor: components/lists/tabs/SettingsTab.tsx).
 *
 * The sheet mirrors CreateListSheet's layout so the two read as one form,
 * but it SUBMITS A DIFF, not a document: lib/listSettingsForm.listSettingsPatch
 * sends only the changed fields, and "nothing changed" closes without a
 * request (the server 400s an empty body).
 *
 * TYPE AND OPT-IN STAY VISIBLE for the same reason they are on create: a
 * list flipped "public" becomes joinable from hosted pages, and "double"
 * changes what a subscriber must do to become mailable. Both switches show
 * their consequence next to the control.
 */
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { SegmentedControl } from "@/components/SegmentedControl";
import { FONT } from "@/lib/fonts";
import {
  LIST_OPTIN_OPTIONS,
  LIST_TYPE_OPTIONS,
  type ListOptin,
  type ListType,
} from "@/lib/listCreate";
import {
  listSettingsNameProblem,
  listSettingsPatch,
  type ListSettingsOriginal,
  type ListSettingsPatch,
} from "@/lib/listSettingsForm";
import { keyboardChain } from "@/lib/keyboardChain";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function EditListSheet({
  visible,
  original,
  submitting,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  original: ListSettingsOriginal;
  submitting: boolean;
  onClose: () => void;
  /** Called with the DIFF only; never called when nothing changed. */
  onSubmit: (patch: ListSettingsPatch) => void;
}) {
  const { t } = useTheme();
  const [name, setName] = useState(original.name);
  const [description, setDescription] = useState(original.description ?? "");
  const [type, setType] = useState<ListType>(
    original.type === "public" ? "public" : "private",
  );
  const [optin, setOptin] = useState<ListOptin>(
    original.optin === "double" ? "double" : "single",
  );

  // The name field's return key advances into the description.
  const descriptionRef = useRef<TextInput>(null);

  // Re-seed the form each time the sheet OPENS, so stale edits from a
  // cancelled session never leak into the next one.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      setName(original.name);
      setDescription(original.description ?? "");
      setType(original.type === "public" ? "public" : "private");
      setOptin(original.optin === "double" ? "double" : "single");
    }
    wasVisible.current = visible;
  }, [visible, original]);

  const problem = listSettingsNameProblem(name);
  const patch = problem
    ? null
    : listSettingsPatch(original, { name, description, type, optin });
  const submit = () => {
    if (submitting) return;
    if (!patch) {
      onClose();
      return;
    }
    onSubmit(patch);
  };

  const label = (text: string) => (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.semibold,
        textTransform: "uppercase",
        letterSpacing: 0.6,
        marginBottom: 6,
        marginTop: 14,
      }}
    >
      {text}
    </Text>
  );

  const inputStyle = {
    backgroundColor: t.surface,
    borderColor: t.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: t.fg,
    fontFamily: FONT.regular,
  } as const;

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Edit list settings"
    >
      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontFamily: FONT.bold,
          marginBottom: 4,
        }}
      >
        List settings
      </Text>

      {label("Name")}
      <TextInput
        {...typeCap("body")}
        value={name}
        onChangeText={setName}
        accessibilityLabel="List name"
        placeholder={original.name}
        placeholderTextColor={t.fgSubtle}
        autoCapitalize="sentences"
        {...keyboardChain({ next: descriptionRef })}
        style={inputStyle}
      />
      {problem ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 4,
          }}
        >
          {problem}
        </Text>
      ) : null}

      {label("Description")}
      <TextInput
        {...typeCap("body")}
        ref={descriptionRef}
        value={description}
        onChangeText={setDescription}
        accessibilityLabel="List description"
        placeholder="What this list is for"
        placeholderTextColor={t.fgSubtle}
        multiline
        style={[inputStyle, { minHeight: 64 }]}
      />

      {label("Type")}
      <SegmentedControl
        accessibilityLabel="List type"
        options={LIST_TYPE_OPTIONS.map((o) => ({
          value: o.value,
          label: o.label,
        }))}
        value={type}
        onChange={setType}
      />
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 4,
        }}
      >
        {LIST_TYPE_OPTIONS.find((o) => o.value === type)?.hint}
      </Text>

      {label("Opt-in")}
      <SegmentedControl
        accessibilityLabel="Opt-in mode"
        options={LIST_OPTIN_OPTIONS.map((o) => ({
          value: o.value,
          label: o.label,
        }))}
        value={optin}
        onChange={setOptin}
      />
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 4,
        }}
      >
        {LIST_OPTIN_OPTIONS.find((o) => o.value === optin)?.hint}
      </Text>

      <Pressable
        onPress={submit}
        disabled={submitting || problem !== null}
        accessibilityRole="button"
        accessibilityLabel={patch ? "Save list settings" : "Close, nothing changed"}
        accessibilityState={{ disabled: submitting || problem !== null }}
        style={{
          marginTop: 20,
          backgroundColor: problem ? t.bgSubtle : t.accent,
          borderRadius: 12,
          paddingVertical: 13,
          alignItems: "center",
        }}
      >
        {submitting ? (
          <ActivityIndicator color={t.accentFg} />
        ) : (
          <Text
            {...typeCap("body")}
            style={{
              color: problem ? t.fgMuted : t.accentFg,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
            }}
          >
            {patch ? "Save changes" : "Done"}
          </Text>
        )}
      </Pressable>
    </KeyboardFormSheet>
  );
}
