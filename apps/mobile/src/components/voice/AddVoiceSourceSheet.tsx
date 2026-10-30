/**
 * AddVoiceSourceSheet — pick a source type, give it what it needs.
 *
 * Only the three types a phone can actually complete are offered
 * (lib/voiceSources.MOBILE_VOICE_SOURCE_OPTIONS): a feed URL, pasted writing,
 * and the workspace's own sent campaigns. The other three server types need an
 * uploaded export file or a long transcript, and a picker whose options mostly
 * dead-end is worse than a shorter honest one.
 *
 * Validation runs client-side first so a rejected URL says which field is
 * wrong instead of costing a round trip and losing the sheet's contents. The
 * server remains the authority — its 400 text is shown verbatim, because for
 * these routes that text IS the validation reason.
 */
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  MOBILE_VOICE_SOURCE_OPTIONS,
  buildVoiceSourceBody,
  type VoiceSourceParamsWire,
  type VoiceSourceType,
} from "@/lib/voiceSources";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export function AddVoiceSourceSheet({
  visible,
  saving,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (body: {
    type: VoiceSourceType;
    params: VoiceSourceParamsWire;
  }) => void;
}) {
  const { t } = useTheme();
  const [type, setType] = useState<VoiceSourceType>("blog_rss");
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setType("blog_rss");
    setValue("");
    setSubmitted(false);
  }, [visible]);

  const option = useMemo(
    () => MOBILE_VOICE_SOURCE_OPTIONS.find((o) => o.type === type),
    [type],
  );
  const built = useMemo(() => buildVoiceSourceBody(type, value), [type, value]);
  // Only complain once the operator has tried — an error under an untouched
  // field is noise, not help.
  const error = submitted ? built.error : null;

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onCancel}
      accessibilityLabel="Add a voice source"
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
        Add a voice source
      </Text>

      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Source type"
        style={{ gap: 8 }}
      >
        {MOBILE_VOICE_SOURCE_OPTIONS.map((o) => (
          <Pressable
            key={o.type}
            onPress={() => {
              haptics.tap();
              setType(o.type);
              setValue("");
              setSubmitted(false);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: type === o.type }}
            accessibilityLabel={`${o.label}. ${o.description}`}
            style={{
              minHeight: 44,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: type === o.type ? t.accent : t.border,
              backgroundColor: type === o.type ? t.surfaceElevated : t.surface,
              padding: 12,
              gap: 2,
            }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.fg,
                ...typeStyle("callout"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              {o.label}
            </Text>
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgMuted,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              {o.description}
            </Text>
          </Pressable>
        ))}
      </View>

      {option && option.input !== "none" ? (
        <TextInput
          value={value}
          onChangeText={setValue}
          multiline={option.input === "text"}
          placeholder={option.placeholder ?? ""}
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel={
            option.input === "url" ? "Feed URL" : "Writing sample"
          }
          autoCapitalize="none"
          autoCorrect={option.input === "text"}
          keyboardType={option.input === "url" ? "url" : "default"}
          maxFontSizeMultiplier={typeCap("body").maxFontSizeMultiplier}
          style={{
            minHeight: option.input === "text" ? 160 : 48,
            color: t.fg,
            backgroundColor: t.surface,
            borderColor: error ? t.danger : t.border,
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
          primary={false}
        />
        <SheetButton
          label={saving ? "Adding…" : "Add source"}
          onPress={() => {
            setSubmitted(true);
            if (saving || !built.body) return;
            haptics.tap();
            onSubmit(built.body);
          }}
          disabled={saving}
          primary
        />
      </View>
    </KeyboardFormSheet>
  );
}

function SheetButton({
  label,
  onPress,
  disabled,
  primary,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  primary: boolean;
}) {
  const { t } = useTheme();
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
