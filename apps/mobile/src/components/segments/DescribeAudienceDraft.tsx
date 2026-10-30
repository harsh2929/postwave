/**
 * DescribeAudienceDraft — everything that appears AFTER a description
 * compiles: the rule, its provenance, its size, the name, and Save.
 *
 * Three honesty rules live here rather than in the sheet:
 *
 *  - The rule tree is rendered through the same bounded, non-throwing walk
 *    the segment detail screen uses (lib/segmentAst), because part of this
 *    tree can be model-authored and an unbounded recurse over untrusted JSON
 *    is how a malformed tree becomes a blank screen.
 *  - A CAPPED count is never printed as a number. The server answers HTTP 200
 *    with `{count: 0, capped: true}` when its 10s deadline trips
 *    (preview_count.go:185-192); "0 people" there would be a fabrication.
 *  - A failed count does not invalidate the rule. The draft stays saveable and
 *    says so, instead of the screen implying the audience is empty.
 */
import { useMemo } from "react";
import { Text, TextInput, View } from "react-native";

import {
  FieldLabel,
  MicroLine,
  PrimaryButton,
} from "@/components/segments/DescribeAudiencePrimitives";
import { FONT } from "@/lib/fonts";
import { describeSegmentAst } from "@/lib/segmentAst";
import {
  disclosureLines,
  previewCountLabel,
  type CompiledSegmentDraft,
  type PreviewCountResult,
} from "@/lib/segmentCompile";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { keyboardDismiss } from "@/lib/keyboardChain";

export function DescribeAudienceDraft({
  draft,
  preview,
  previewing,
  previewError,
  name,
  onNameChange,
  canSave,
  saveDisabledReason,
  saving,
  saveError,
  onSave,
}: {
  draft: CompiledSegmentDraft;
  preview: PreviewCountResult | null;
  previewing: boolean;
  previewError: string | null;
  name: string;
  onNameChange: (next: string) => void;
  canSave: boolean;
  saveDisabledReason?: string | undefined;
  saving: boolean;
  saveError: string | null;
  onSave: () => void;
}) {
  const { t } = useTheme();
  const lines = useMemo(() => describeSegmentAst(draft.ast), [draft.ast]);
  const provenance = useMemo(
    () => disclosureLines(draft.aiProcessing),
    [draft.aiProcessing],
  );

  return (
    <View style={{ marginTop: 20, gap: 8 }}>
      <FieldLabel>Rule</FieldLabel>
      <View
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 12,
          padding: 12,
          gap: 2,
        }}
      >
        {lines.map((line, i) => (
          <Text
            key={`${line.depth}-${i}-${line.text}`}
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              marginStart: line.depth * 14,
            }}
          >
            {line.text}
          </Text>
        ))}
      </View>

      {draft.rationale ? (
        <MicroLine tone="muted">{draft.rationale}</MicroLine>
      ) : null}

      {/* Provenance travels with model output or the output is not
          reviewable. */}
      {draft.engineUsed === "ai" ? (
        <View style={{ gap: 2, marginTop: 2 }}>
          <MicroLine tone="strong">
            Derived by the AI compiler — check the rule above before saving.
          </MicroLine>
          {provenance.map((line) => (
            <MicroLine
              key={line.label}
            >{`${line.label}: ${line.value}`}</MicroLine>
          ))}
        </View>
      ) : null}

      <View style={{ marginTop: 6 }}>
        <FieldLabel>Size</FieldLabel>
        <SizeLine
          previewing={previewing}
          previewError={previewError}
          preview={preview}
        />
      </View>

      <View style={{ marginTop: 10 }}>
        <FieldLabel>Name</FieldLabel>
        <TextInput
          value={name}
          onChangeText={onNameChange}
          accessibilityLabel="Segment name"
          placeholder="Name this segment"
          placeholderTextColor={t.fgSubtle}
          editable={canSave}
          {...keyboardDismiss()}
          style={{
            backgroundColor: t.surface,
            borderColor: t.border,
            borderWidth: 1,
            color: canSave ? t.fg : t.fgMuted,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 12,
            // 16pt on an input is deliberate — a smaller field reads as
            // disabled — but the ceiling still comes from the scale.
            fontSize: 16,
            fontFamily: FONT.regular,
          }}
          {...typeCap("body")}
        />
      </View>

      {saveError ? (
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("label")}
          style={{
            color: t.danger,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {saveError}
        </Text>
      ) : null}

      <PrimaryButton
        label="Save segment"
        busy={saving}
        disabled={!canSave || saving || !name.trim()}
        onPress={onSave}
        accessibilityLabel="Save this as a segment"
        {...(!canSave && saveDisabledReason
          ? { disabledReason: saveDisabledReason }
          : {})}
      />
      {!canSave && saveDisabledReason ? (
        <MicroLine tone="muted">{saveDisabledReason}</MicroLine>
      ) : null}
    </View>
  );
}

function SizeLine({
  previewing,
  previewError,
  preview,
}: {
  previewing: boolean;
  previewError: string | null;
  preview: PreviewCountResult | null;
}) {
  const { t } = useTheme();
  if (previewing) {
    return (
      <Text
        {...typeCap("bodySmall")}
        accessibilityLiveRegion="polite"
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        Counting…
      </Text>
    );
  }
  if (previewError) {
    return (
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.warning,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {/* Absence is not zero: the rule compiled, the count did not arrive. */}
        {`${previewError} The rule is still valid and can be saved.`}
      </Text>
    );
  }
  return (
    <Text
      {...typeCap("body")}
      accessibilityLiveRegion="polite"
      style={{
        color: t.fg,
        ...typeStyle("body"),
        fontFamily: FONT.medium,
      }}
    >
      {previewCountLabel(preview)}
    </Text>
  );
}
