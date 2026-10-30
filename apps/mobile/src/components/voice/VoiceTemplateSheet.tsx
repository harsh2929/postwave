/**
 * VoiceTemplateSheet — one shared template, in full, with the two verbs a
 * phone can honestly complete: copy the prompt, and (admin) delete it.
 *
 * A template is a SEQUENCE SKELETON. Showing only its name would hide the
 * emails that are the template, so every slot is rendered in position order
 * with its subject and body skeleton, followed by the {{variables}} the
 * generation engine still expects. "Copy prompt" hands over exactly that text
 * (lib/voiceTemplates.voiceTemplatePromptText) — the same bytes on screen.
 *
 * Delete is `admin` and destroys a row in the workspace-wide library, so it is
 * two-step: the button arms, the confirm commits. There is no edit here — see
 * api/voiceTemplates for why authoring stays desk-side.
 */
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  voiceTemplateEmailLines,
  voiceTemplateHasPrompt,
  voiceTemplatePromptText,
  voiceTemplateSummary,
  voiceTemplateTitle,
  voiceTemplateVariableLines,
  type VoiceTemplateWire,
} from "@/lib/voiceTemplates";

export function VoiceTemplateSheet({
  template,
  canDelete,
  deleting,
  onCopy,
  onDelete,
  onClose,
}: {
  template: VoiceTemplateWire | null;
  canDelete: boolean;
  deleting: boolean;
  onCopy: (text: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTheme();
  const [armed, setArmed] = useState(false);

  // A new template in the same sheet must never inherit the previous one's
  // armed delete.
  useEffect(() => {
    setArmed(false);
  }, [template]);

  if (!template) return null;
  const title = voiceTemplateTitle(template);
  const emails = voiceTemplateEmailLines(template);
  const vars = voiceTemplateVariableLines(template);
  const hasPrompt = voiceTemplateHasPrompt(template);
  const id = typeof template.id === "string" ? template.id : "";
  const description =
    typeof template.description === "string" ? template.description.trim() : "";

  return (
    <KeyboardFormSheet
      visible
      onClose={onClose}
      accessibilityLabel={`Template: ${title}`}
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
        {title}
      </Text>
      <View style={{ flexDirection: "row" }}>
        <Pill label={voiceTemplateSummary(template)} tone="neutral" />
      </View>
      {description ? (
        <Text
          {...typeCap("body")}
          style={{
            color: t.fgMuted,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
          }}
        >
          {description}
        </Text>
      ) : null}

      <ScrollView style={{ maxHeight: 300 }} contentContainerStyle={{ gap: 12 }}>
        {emails.map((email) => (
          <View key={email.position} style={{ gap: 3 }}>
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              {`Email ${email.position}`}
            </Text>
            {email.subject ? (
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.medium,
                }}
              >
                {email.subject}
              </Text>
            ) : null}
            {email.body ? (
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                }}
              >
                {email.body}
              </Text>
            ) : null}
          </View>
        ))}
        {vars.length > 0 ? (
          <View style={{ gap: 3 }}>
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              Fill in
            </Text>
            {vars.map((v) => (
              <Text
                key={v.key}
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                }}
              >
                {`{{${v.key}}} — ${v.label}${v.required ? " (required)" : ""}`}
              </Text>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <SheetAction
        label={hasPrompt ? "Copy prompt" : "Nothing to copy"}
        tone="accent"
        disabled={!hasPrompt}
        onPress={() => {
          haptics.tap();
          // Exactly the bytes rendered above — the copy and the read agree.
          onCopy(voiceTemplatePromptText(template));
        }}
      />

      {canDelete && id ? (
        armed ? (
          <SheetAction
            label={deleting ? "Deleting…" : "Confirm delete"}
            tone="danger"
            disabled={deleting}
            onPress={() => onDelete(id)}
          />
        ) : (
          <SheetAction
            label="Delete template"
            tone="danger"
            disabled={false}
            onPress={() => {
              haptics.tap();
              setArmed(true);
            }}
          />
        )
      ) : null}
    </KeyboardFormSheet>
  );
}

function SheetAction({
  label,
  tone,
  disabled,
  onPress,
}: {
  label: string;
  tone: "accent" | "danger";
  disabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  const color = tone === "danger" ? t.danger : t.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ minHeight: 44, justifyContent: "center" }}
    >
      <Text
        {...typeCap("body")}
        style={{
          color: disabled ? t.fgSubtle : color,
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
