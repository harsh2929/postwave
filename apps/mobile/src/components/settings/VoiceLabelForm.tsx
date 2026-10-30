/**
 * VoiceLabelForm — the "record one tone label" half of VoiceLabelsSection.
 *
 * Split out so the section file stays a data-flow (queries, mutations, paging)
 * and this stays a layout. It is deliberately CONTROLLED: the section owns the
 * draft state so a queued-offline submit can clear it from the mutation's
 * onSuccess without this component knowing anything about the queue.
 *
 * RN ships no cross-platform slider, so strength is a numeric field plus
 * 0.0 / 0.5 / 1.0 quick-set chips. Validation lives in lib/voiceLabelForm.ts
 * (pure, node-tested) rather than inline here.
 */
import { useRef } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { VOICE_AXES, type VoiceAxis } from "@/api/voiceLabels";
import { Chip } from "@/components/Chip";
import { useDoneAccessory } from "@/components/settings/FormControls";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";
import { keyboardChain } from "@/lib/keyboardChain";

const VALUE_PRESETS: readonly { key: string; value: number; label: string }[] =
  [
    { key: "low", value: 0.0, label: "0.0" },
    { key: "mid", value: 0.5, label: "0.5" },
    { key: "high", value: 1.0, label: "1.0" },
  ];

export interface VoiceLabelFormProps {
  sample: string;
  onSample: (next: string) => void;
  axis: VoiceAxis;
  onAxis: (next: VoiceAxis) => void;
  value: string;
  onValue: (next: string) => void;
  onSubmit: () => void;
  submitting: boolean;
}

export function VoiceLabelForm({
  sample,
  onSample,
  axis,
  onAxis,
  value,
  onValue,
  onSubmit,
  submitting,
}: VoiceLabelFormProps) {
  const { t } = useTheme();
  // A decimal pad has no return key on iOS, and this form renders inside the
  // Voice-labels section's sheet — tapping outside to close the keyboard used
  // to dismiss the sheet and take the typed sample with it.
  const done = useDoneAccessory("decimal-pad");
  // Sample (multiline) → value → submit. A multiline field needs an explicit
  // submitBehavior or the return key is swallowed as a newline.
  const valueRef = useRef<TextInput>(null);
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 16,
        padding: 14,
        gap: 10,
      }}
    >
      <FieldLabel>Sample text</FieldLabel>
      <TextInput
        value={sample}
        onChangeText={onSample}
        placeholder="A short snippet that illustrates the tone you want to calibrate."
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="Sample text"
        accessibilityHint="Text used to preview or calibrate this voice-label axis."
        multiline
        {...keyboardChain({ next: valueRef, multiline: true })}
        {...typeCap("callout")}
        style={[inputStyle(t), { minHeight: 80, textAlignVertical: "top" }]}
      />

      <FieldLabel>Axis</FieldLabel>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {VOICE_AXES.map((a) => (
          <Chip key={a} label={a} active={axis === a} onPress={() => onAxis(a)} />
        ))}
      </View>

      <FieldLabel>Value (0 = absent, 1 = strong)</FieldLabel>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <TextInput
          ref={valueRef}
          value={value}
          onChangeText={(v) => onValue(v.replace(/[^0-9.]/g, ""))}
          keyboardType="decimal-pad"
          accessibilityLabel="Voice-label value"
          accessibilityHint="Enter a value from 0 to 1, where 0 means absent and 1 means strong."
          {...keyboardChain({ onSubmit, disabled: submitting })}
          {...typeCap("callout")}
          {...done.inputProps}
          style={[inputStyle(t), { width: 90 }]}
        />
        {done.accessory}
        <View style={{ flexDirection: "row", gap: 6 }}>
          {VALUE_PRESETS.map((p) => (
            <Chip
              key={p.key}
              label={p.label}
              active={Math.abs(parseFloat(value) - p.value) < 0.05}
              onPress={() => onValue(String(p.value))}
            />
          ))}
        </View>
      </View>

      <Pressable
        onPress={onSubmit}
        disabled={submitting}
        accessibilityRole="button"
        accessibilityLabel="Submit voice label"
        accessibilityState={{ disabled: submitting, busy: submitting }}
        style={{
          marginTop: 4,
          paddingVertical: 12,
          borderRadius: 10,
          backgroundColor: t.accent,
          alignItems: "center",
          opacity: submitting ? 0.6 : 1,
          minHeight: 44,
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.accentFg,
            ...typeStyle("callout"),
            fontWeight: "700",
            fontFamily: FONT.bold,
          }}
        >
          {submitting ? "Submitting…" : "Submit label"}
        </Text>
      </Pressable>
    </View>
  );
}

export function FieldLabel({ children }: { children: string }) {
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
      }}
    >
      {children}
    </Text>
  );
}

export function SectionMeta({ children }: { children: React.ReactNode }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.fgMuted,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
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
    paddingVertical: 9,
    // Size only — an explicit `lineHeight` on a TextInput mis-centres the
    // caret and clips descenders on Android (see lib/typeScale.fontSizeFor).
    fontSize: fontSizeFor("callout"),
    fontFamily: FONT.regular,
  } as const;
}
