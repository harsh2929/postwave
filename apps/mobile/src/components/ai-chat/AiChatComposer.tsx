/**
 * AiChatComposer — tone chips, a multiline field, and ONE button.
 *
 * The button is Send until a turn is in flight and Stop while it is: the
 * reply arrives whole, so the only thing a person can do mid-turn is give up
 * waiting. Sending while a turn is pending is not queued — the reducer
 * ignores it, and the button says so by being Stop.
 *
 * Multiline on purpose. A chat prompt is prose with paragraphs; the return
 * key inserts a newline (React Native's default for multiline, which the
 * keyboard-chain guard exempts) and the button sends.
 */
import { useRef } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import {
  AI_CHAT_PROMPT_MAX_CHARS,
  AI_CHAT_TONES,
  type AiChatTone,
} from "@/lib/aiChat";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export interface AiChatComposerProps {
  value: string;
  onChangeText: (value: string) => void;
  tone: AiChatTone;
  onToneChange: (tone: AiChatTone) => void;
  pending: boolean;
  /** False when the screen cannot take a turn; `disabledReason` says why. */
  enabled: boolean;
  disabledReason: string | null;
  onSend: () => void;
  onStop: () => void;
}

export function AiChatComposer({
  value,
  onChangeText,
  tone,
  onToneChange,
  pending,
  enabled,
  disabledReason,
  onSend,
  onStop,
}: AiChatComposerProps) {
  const { t } = useTheme();
  const inputRef = useRef<TextInput>(null);
  const trimmed = value.trim();
  const canSend = enabled && !pending && trimmed.length > 0;
  const nearCeiling = value.length > AI_CHAT_PROMPT_MAX_CHARS * 0.9;

  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: t.borderSubtle,
        backgroundColor: t.bg,
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 10,
        gap: 8,
      }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: 6 }}
        accessibilityRole="radiogroup"
        accessibilityLabel="Tone"
      >
        {AI_CHAT_TONES.map((option) => {
          const selected = option.value === tone;
          return (
            <Pressable
              key={option.value || "auto"}
              accessibilityRole="radio"
              accessibilityLabel={`${option.label} tone`}
              accessibilityHint={option.hint}
              accessibilityState={{ selected, disabled: !enabled }}
              disabled={!enabled}
              onPress={() => {
                haptics.tap();
                onToneChange(option.value);
              }}
              style={{
                minHeight: 32,
                paddingHorizontal: 12,
                justifyContent: "center",
                borderRadius: 16,
                borderWidth: 1,
                borderColor: selected ? t.accent : t.border,
                backgroundColor: selected ? t.accent : t.surface,
                opacity: enabled ? 1 : 0.6,
              }}
            >
              <Text
                {...typeCap("caption")}
                style={{
                  color: selected ? t.accentFg : t.fg,
                  ...typeStyle("caption"),
                  fontFamily: FONT.medium,
                }}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
        <TextInput
          ref={inputRef}
          {...typeCap("body")}
          value={value}
          onChangeText={onChangeText}
          editable={enabled}
          multiline
          maxLength={AI_CHAT_PROMPT_MAX_CHARS}
          placeholder={
            enabled
              ? "Ask for a draft, a subject line or a summary…"
              : "Chat is not available right now"
          }
          placeholderTextColor={t.fgSubtle}
          autoCapitalize="sentences"
          autoCorrect
          accessibilityLabel="Message to Moosewave AI"
          accessibilityHint="The whole reply arrives once the server has finished"
          style={{
            flex: 1,
            minHeight: 44,
            maxHeight: 140,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.surface,
            paddingHorizontal: 12,
            paddingVertical: 10,
            color: t.fg,
            fontFamily: FONT.regular,
            fontSize: fontSizeFor("body"),
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={pending ? "Stop waiting" : "Send"}
          accessibilityState={{ disabled: pending ? false : !canSend, busy: pending }}
          disabled={pending ? false : !canSend}
          onPress={() => {
            haptics.tap();
            if (pending) onStop();
            else onSend();
          }}
          style={{
            minHeight: 44,
            minWidth: 72,
            paddingHorizontal: 14,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 12,
            backgroundColor: pending
              ? t.bgSubtle
              : canSend
                ? t.accent
                : t.bgSubtle,
            borderWidth: pending ? 1 : 0,
            borderColor: t.border,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: pending ? t.fg : canSend ? t.accentFg : t.fgSubtle,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {pending ? "Stop" : "Send"}
          </Text>
        </Pressable>
      </View>

      {!enabled && disabledReason ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {disabledReason}
        </Text>
      ) : nearCeiling ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {`${value.length} of ${AI_CHAT_PROMPT_MAX_CHARS} characters`}
        </Text>
      ) : null}
    </View>
  );
}
