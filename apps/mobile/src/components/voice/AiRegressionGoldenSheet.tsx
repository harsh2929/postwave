/**
 * AiRegressionGoldenSheet — save an approved AI output as a reference.
 *
 * A golden example is what the harness replays. Without at least one, the
 * trigger refuses with 422 `no_golden_examples`, so this is the verb that
 * unblocks the other two.
 *
 * request_id IS PART OF THE BODY, and the handler rejects anything that is not
 * a lowercase canonical UUID *before* it validates the rest
 * (422 `invalid_golden_request_id`). One id is minted when the sheet opens and
 * reused for the life of the draft, so a retry after a network wobble carries
 * the same reference rather than a second one. If the platform cannot mint one
 * the form refuses locally and submits NOTHING — the same posture desktop
 * takes (CAPTURE_ID_UNAVAILABLE), because a fabricated id would be recorded as
 * provenance.
 *
 * The capture is deliberately provenance-neutral: the server overwrites
 * model_id with "manual_reference" and clears approval/run/profile lineage, so
 * the sheet never suggests this reference carries an approval receipt.
 */
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  LOWERCASE_UUID,
  REGRESSION_SURFACE_KINDS,
  buildGoldenExampleBody,
  surfaceKindLabel,
  type GoldenExampleBody,
} from "@/lib/aiRegressionAdmin";

/**
 * Empty string when the platform has no UUID source; the build then refuses
 * and nothing is submitted.
 *
 * Two sources, both VALIDATED rather than trusted: expo-crypto's native module
 * can be absent (or answer undefined) in an environment where the JS bundle
 * still loads, and a silent undefined here would become an empty request_id
 * and an opaque 422. The platform's own `crypto.randomUUID` is the fallback,
 * and the shape check in lib/aiRegressionAdmin is the final gate either way.
 */
function mintRequestId(): string {
  const sources: Array<() => unknown> = [
    () => Crypto.randomUUID(),
    () => globalThis.crypto?.randomUUID?.(),
  ];
  for (const source of sources) {
    try {
      const value = source();
      if (typeof value === "string" && LOWERCASE_UUID.test(value.toLowerCase())) {
        return value.toLowerCase();
      }
    } catch {
      // Try the next source; an unavailable generator is not an error here.
    }
  }
  return "";
}

export function AiRegressionGoldenSheet({
  visible,
  saving,
  serverError,
  onSubmit,
  onClose,
}: {
  visible: boolean;
  saving: boolean;
  serverError: string | null;
  onSubmit: (body: GoldenExampleBody) => void;
  onClose: () => void;
}) {
  const { t } = useTheme();
  const [surface, setSurface] = useState<string>("campaign_draft");
  const [brief, setBrief] = useState("");
  const [output, setOutput] = useState("");
  const [requestId, setRequestId] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setSurface("campaign_draft");
    setBrief("");
    setOutput("");
    setTouched(false);
    setRequestId(mintRequestId());
  }, [visible]);

  if (!visible) return null;

  const built = buildGoldenExampleBody({
    surfaceKind: surface,
    brief,
    approvedOutput: output,
    requestId,
  });
  const localError = touched && !built.ok ? built.error : null;

  return (
    <KeyboardFormSheet
      visible
      onClose={onClose}
      accessibilityLabel="Save a golden reference"
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
        Save a reference
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        The harness replays these against the current model. Saved manually,
        this reference carries no approval lineage.
      </Text>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8 }}
      >
        {REGRESSION_SURFACE_KINDS.map((kind) => (
          <Pressable
            key={kind}
            accessibilityRole="button"
            accessibilityLabel={surfaceKindLabel(kind)}
            accessibilityState={{ selected: surface === kind }}
            disabled={saving}
            onPress={() => {
              haptics.tap();
              setSurface(kind);
            }}
            style={{
              minHeight: 44,
              justifyContent: "center",
              paddingHorizontal: 12,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: surface === kind ? t.accent : t.border,
            }}
          >
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: surface === kind ? t.accent : t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              {surfaceKindLabel(kind)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <TextInput
        accessibilityLabel="Brief"
        placeholder="What was asked for"
        placeholderTextColor={t.fgSubtle}
        value={brief}
        onChangeText={setBrief}
        multiline
        editable={!saving}
        {...typeCap("body")}
        style={{
          color: t.fg,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
          minHeight: 72,
          fontFamily: FONT.regular,
        }}
      />
      <TextInput
        accessibilityLabel="Approved output"
        placeholder="The output you approved"
        placeholderTextColor={t.fgSubtle}
        value={output}
        onChangeText={setOutput}
        multiline
        editable={!saving}
        {...typeCap("body")}
        style={{
          color: t.fg,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
          minHeight: 96,
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
        accessibilityLabel="Save reference"
        accessibilityState={{ disabled: saving }}
        disabled={saving}
        onPress={() => {
          setTouched(true);
          if (!built.ok) return;
          haptics.tap();
          onSubmit(built.body);
        }}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: saving ? t.fgSubtle : t.accent,
            ...typeStyle("body"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {saving ? "Saving…" : "Save reference"}
        </Text>
      </Pressable>
    </KeyboardFormSheet>
  );
}
