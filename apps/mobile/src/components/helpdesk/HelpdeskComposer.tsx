/** Internal-note composer. It has no outbound-delivery request path. */
import { Pressable, Text, TextInput, View } from "react-native";

import {
  HELPDESK_INTERNAL_NOTE_LIFECYCLE_NOTE,
  HELPDESK_INTERNAL_NOTE_MAX_BYTES,
  helpdeskUtf8Bytes,
} from "@/lib/helpdesk";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export interface HelpdeskComposerProps {
  value: string;
  onChangeText: (next: string) => void;
  onSave: () => void;
  saving: boolean;
  enabled: boolean;
  disabledNotice: string | null;
}

export function HelpdeskComposer(props: HelpdeskComposerProps) {
  const { t } = useTheme();
  const tooLong =
    helpdeskUtf8Bytes(props.value.trim()) > HELPDESK_INTERNAL_NOTE_MAX_BYTES;
  const canSave =
    props.enabled && !props.saving && props.value.trim().length > 0 && !tooLong;

  if (!props.enabled && props.disabledNotice) {
    return (
      <View
        style={{
          borderTopColor: t.borderSubtle,
          borderTopWidth: 1,
          backgroundColor: t.bg,
          paddingHorizontal: 16,
          paddingVertical: 14,
        }}
      >
        <Text
          accessibilityRole="alert"
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {props.disabledNotice}
        </Text>
      </View>
    );
  }

  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        backgroundColor: t.bg,
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: 12,
        gap: 8,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        Private workspace note · never delivered to the customer.{" "}
        {HELPDESK_INTERNAL_NOTE_LIFECYCLE_NOTE}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
        <TextInput
          value={props.value}
          onChangeText={props.onChangeText}
          editable={props.enabled && !props.saving}
          placeholder="Add a private internal note…"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="Internal note"
          multiline
          maxLength={HELPDESK_INTERNAL_NOTE_MAX_BYTES}
          style={{
            flex: 1,
            minHeight: 44,
            maxHeight: 140,
            backgroundColor: t.surface,
            borderColor: t.border,
            borderWidth: 1,
            borderRadius: 20,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 12,
            color: t.fg,
            fontSize: fontSizeFor("body"),
            fontFamily: FONT.regular,
          }}
          {...typeCap("body")}
        />
        <Pressable
          onPress={props.onSave}
          disabled={!canSave}
          accessibilityRole="button"
          accessibilityLabel={
            props.saving ? "Recording internal note" : "Record internal note"
          }
          accessibilityState={{ disabled: !canSave, busy: props.saving }}
          style={{
            minWidth: 76,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 22,
            paddingHorizontal: 16,
            backgroundColor: canSave ? t.accent : t.surfaceElevated,
            opacity: canSave ? 1 : 0.6,
          }}
        >
          <Text
            {...typeCap("control")}
            importantForAccessibility="no"
            style={{
              color: canSave ? t.accentFg : t.fgSubtle,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {props.saving ? "…" : "Add note"}
          </Text>
        </Pressable>
      </View>
      {tooLong ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("caption")}
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            fontFamily: FONT.medium,
          }}
        >
          This note exceeds the 16 KiB server limit. Shorten it before
          recording.
        </Text>
      ) : null}
    </View>
  );
}
