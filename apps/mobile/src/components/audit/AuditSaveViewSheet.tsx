/**
 * AuditSaveViewSheet — name the filter set you are looking at.
 *
 * Deliberately shows the DESCRIPTION of what is about to be saved above the
 * name field. The single most annoying failure of a saved-view feature is
 * saving the wrong thing: the operator adjusts a chip, taps Save, and only
 * discovers on recall that the view has the previous window. Rendering the
 * sentence the view will produce makes that mistake visible before it is
 * committed rather than a week later during an incident.
 */
import { useEffect, useRef } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { FONT } from "@/lib/fonts";
import { AUDIT_VIEW_NAME_MAX } from "@/lib/auditViews";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export interface AuditSaveViewSheetProps {
  visible: boolean;
  name: string;
  onChangeName: (next: string) => void;
  /** Human sentence describing the filters this view will capture. */
  summary: string;
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}

export function AuditSaveViewSheet({
  visible,
  name,
  onChangeName,
  summary,
  error,
  busy,
  onCancel,
  onSubmit,
}: AuditSaveViewSheetProps) {
  const { t } = useTheme();
  const inputRef = useRef<TextInput | null>(null);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 250);
    return () => clearTimeout(timer);
  }, [visible]);

  const submitDisabled = busy || !name.trim();

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onCancel}
      accessibilityLabel="Save audit view"
      contentContainerStyle={{ gap: 14 }}
    >
      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontWeight: "700",
          fontFamily: FONT.display,
        }}
      >
        Save this view
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {`Captures: ${summary}. Saved views are shared with everyone in the workspace who can read the audit log, on every device.`}
      </Text>
      <TextInput
        ref={inputRef}
        value={name}
        onChangeText={onChangeName}
        placeholder="e.g. Break-glass logins"
        accessibilityLabel="Name for this saved view"
        placeholderTextColor={t.fgSubtle}
        maxLength={AUDIT_VIEW_NAME_MAX}
        autoCapitalize="sentences"
        returnKeyType="done"
        onSubmitEditing={submitDisabled ? undefined : onSubmit}
        style={{
          minHeight: 48,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: error ? t.danger : t.border,
          backgroundColor: t.surface,
          color: t.fg,
          paddingHorizontal: 12,
          fontSize: fontSizeFor("callout"),
          fontFamily: FONT.regular,
        }}
        {...typeCap("callout")}
      />
      {error ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("label")}
          style={{
            color: t.danger,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {error}
        </Text>
      ) : null}
      <View
        style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10 }}
      >
        <Pressable
          onPress={onCancel}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Cancel saving this view"
          accessibilityState={{ disabled: busy }}
          style={{
            minHeight: 44,
            justifyContent: "center",
            paddingHorizontal: 14,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.border,
            opacity: busy ? 0.6 : 1,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.fg,
              ...typeStyle("control"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Cancel
          </Text>
        </Pressable>
        <Pressable
          onPress={onSubmit}
          disabled={submitDisabled}
          accessibilityRole="button"
          accessibilityLabel="Save this audit view"
          accessibilityState={{ disabled: submitDisabled, busy }}
          style={{
            minHeight: 44,
            justifyContent: "center",
            paddingHorizontal: 16,
            borderRadius: 10,
            backgroundColor: t.accent,
            opacity: submitDisabled ? 0.55 : 1,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.accentFg,
              ...typeStyle("control"),
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            {busy ? "Saving…" : "Save view"}
          </Text>
        </Pressable>
      </View>
    </KeyboardFormSheet>
  );
}
