/**
 * VoiceTemplateGenerateSheet — write a new on-brand template from a brief.
 *
 * POST /api/v1/voice/templates/generate is `write:campaigns` (editor), makes
 * ONE synchronous LLM call conditioned on the tenant's brand voice, and
 * PERSISTS NOTHING (services/voice/internal/handlers/template_generate.go).
 * The sheet says both things out loud: the result is a draft to copy, and the
 * press spends a unit of the workspace's daily AI budget — so the button is
 * pressed deliberately, never fired on mount.
 *
 * Client-side validation mirrors the handler's own caps
 * (lib/voiceTemplates.buildTemplateGenerateBody) so a rejected brief names the
 * field instead of costing a round trip and a quota unit. The server stays the
 * authority; its message is rendered verbatim when it disagrees.
 */
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { keyboardChain } from "@/lib/keyboardChain";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  TEMPLATE_GEN_KINDS,
  buildTemplateGenerateBody,
  generatedTemplatePromptText,
  type GeneratedTemplate,
  type TemplateGenerateBody,
} from "@/lib/voiceTemplates";

export function VoiceTemplateGenerateSheet({
  visible,
  generating,
  result,
  serverError,
  onGenerate,
  onCopy,
  onClose,
}: {
  visible: boolean;
  generating: boolean;
  result: GeneratedTemplate | null;
  serverError: string | null;
  onGenerate: (body: TemplateGenerateBody) => void;
  onCopy: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useTheme();
  const [brief, setBrief] = useState("");
  const [kind, setKind] = useState<string>("newsletter");
  const [tone, setTone] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setBrief("");
    setKind("newsletter");
    setTone("");
    setSubmitted(false);
  }, [visible]);

  if (!visible) return null;
  const built = buildTemplateGenerateBody(brief, kind, tone);
  // Only complain once the operator has tried.
  const localError = submitted ? built.error : null;

  const submit = () => {
    if (generating) return;
    setSubmitted(true);
    if (!built.ok) return;
    haptics.tap();
    onGenerate(built.body);
  };

  return (
    <KeyboardFormSheet
      visible
      onClose={onClose}
      accessibilityLabel="Generate a template from a brief"
      contentContainerStyle={{ gap: 12 }}
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
        Generate a template
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        One draft, written in your measured voice. It is not saved to the shared
        library, and it spends a unit of this workspace&apos;s daily AI budget.
      </Text>

      <TextInput
        // The input scales with the OS text size but its height does not.
        {...typeCap("body")}
        accessibilityLabel="Brief"
        placeholder="What should this template say?"
        placeholderTextColor={t.fgSubtle}
        value={brief}
        onChangeText={setBrief}
        multiline
        editable={!generating}
        style={{
          color: t.fg,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
          minHeight: 88,
          fontFamily: FONT.regular,
        }}
      />

      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {TEMPLATE_GEN_KINDS.map((k) => (
          <Pressable
            key={k}
            accessibilityRole="button"
            accessibilityLabel={`Kind: ${k}`}
            accessibilityState={{ selected: kind === k }}
            disabled={generating}
            onPress={() => {
              haptics.tap();
              setKind(k);
            }}
            style={{
              minHeight: 44,
              justifyContent: "center",
              paddingHorizontal: 12,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: kind === k ? t.accent : t.border,
            }}
          >
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: kind === k ? t.accent : t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              {k}
            </Text>
          </Pressable>
        ))}
      </View>

      <TextInput
        // The input scales with the OS text size but its height does not.
        {...typeCap("body")}
        accessibilityLabel="Tone (optional)"
        placeholder="Tone (optional)"
        placeholderTextColor={t.fgSubtle}
        value={tone}
        onChangeText={setTone}
        editable={!generating}
        {...keyboardChain({ onSubmit: submit, disabled: generating })}
        style={{
          color: t.fg,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
          minHeight: 44,
          fontFamily: FONT.regular,
        }}
      />

      {localError || serverError ? (
        <Text
          {...typeCap("bodySmall")}
          accessibilityLiveRegion="polite"
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {localError ?? serverError}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Generate template"
        accessibilityState={{ disabled: generating }}
        disabled={generating}
        onPress={submit}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: generating ? t.fgSubtle : t.accent,
            ...typeStyle("body"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {generating ? "Writing…" : "Generate"}
        </Text>
      </Pressable>

      {result ? (
        <View style={{ gap: 8 }}>
          <ScrollView
            style={{ maxHeight: 200 }}
            contentContainerStyle={{ gap: 6 }}
          >
            {result.name ? (
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.medium,
                }}
              >
                {result.name}
              </Text>
            ) : null}
            {result.subject ? (
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                }}
              >
                {`Subject: ${result.subject}`}
              </Text>
            ) : null}
            {result.bodyHtml ? (
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                }}
              >
                {result.bodyHtml}
              </Text>
            ) : null}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy generated template"
            onPress={() => {
              haptics.tap();
              onCopy(generatedTemplatePromptText(result));
            }}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("body")}
              style={{
                color: t.accent,
                ...typeStyle("body"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              Copy draft
            </Text>
          </Pressable>
        </View>
      ) : null}
    </KeyboardFormSheet>
  );
}
