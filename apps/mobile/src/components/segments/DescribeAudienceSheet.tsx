/**
 * DescribeAudienceSheet — build an audience by describing it in words.
 *
 * This is the one place a phone genuinely beats a laptop. The backend has
 * shipped a deterministic text→AST compiler since the segments expansion
 * (POST /api/v1/segments/compile-from-text) and desktop's builder opens in
 * "describe" mode by default — but on a laptop "describe" means typing. On
 * iOS the dictation key sits in the keyboard of every TextInput, so an
 * operator can SAY "people who opened an email in the last 30 days and are
 * tagged vip" and get a live count. That is a capability inversion, not just
 * a parity gap being closed.
 *
 * Four things it refuses to do:
 *
 *  - It never escalates to the AI engine on its own. A 422 `unsupported_text`
 *    surfaces the server's own processing disclosure and needs a second,
 *    deliberate tap; the acknowledgement is per-request, exactly as the
 *    handler models it. The retry is offered only when the server ALSO says a
 *    provider is wired, so the button can never produce a guaranteed 503.
 *  - It never shows a rule without a size, or a size without the rule — the
 *    preview is chained onto a successful compile rather than being a second
 *    button.
 *  - It never renders a capped count as a number (see DescribeAudienceDraft).
 *  - It never shows a live Save button to someone who cannot save. Compiling
 *    and previewing are `read:subscribers` (every role); POST /api/v1/segments
 *    is `write:subscribers` (owner|admin|editor). The gate names the reason
 *    in text, not only as a dimmed control.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { DescribeAudienceDraft } from "@/components/segments/DescribeAudienceDraft";
import {
  AIRetry,
  FieldLabel,
  MicroLine,
  PrimaryButton,
} from "@/components/segments/DescribeAudiencePrimitives";
import { useDescribeAudience } from "@/hooks/useDescribeAudience";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  COMPILE_TEXT_SOFT_MAX,
  defaultSegmentName,
  disclosureLines,
  runeCount,
} from "@/lib/segmentCompile";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const EXAMPLES: readonly string[] = [
  "opened an email in the last 30 days",
  "joined in the last 7 days and is tagged vip",
  "has not opened an email in the last 90 days",
];

export function DescribeAudienceSheet({
  visible,
  onClose,
  canSave,
  saveDisabledReason,
  onSaved,
  seed,
}: {
  visible: boolean;
  onClose: () => void;
  /** write:subscribers — owner|admin|editor, online, session not stale. */
  canSave: boolean;
  saveDisabledReason?: string | undefined;
  onSaved: (result: { id?: string | undefined; name: string }) => void;
  /**
   * Pre-fills the description/name when the sheet opens from a starting
   * point (StartingPointsSection). The seed only SEEDS: the user still
   * compiles, previews, and saves through the same gates as a typed
   * description.
   */
  seed?: { text: string; name: string } | null | undefined;
}) {
  const { t } = useTheme();
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const describe = useDescribeAudience({ enabled: visible });
  const s = describe.state;

  // Apply the starting-point seed when the sheet opens with one. `close()`
  // wipes the fields, so a stale seed can never leak into the next open —
  // and a seeded NAME counts as "edited" so re-compiling doesn't overwrite
  // the name the starting point chose.
  useEffect(() => {
    if (visible && seed) {
      setText(seed.text);
      setName(seed.name);
      setNameEdited(Boolean(seed.name));
    }
  }, [visible, seed]);

  const chars = runeCount(text.trim());
  const overLength = chars > COMPILE_TEXT_SOFT_MAX;
  const busy = s.compiling || s.previewing;
  // The name field tracks the compiler's suggestion until the user types in
  // it, then stops — so re-compiling does not silently overwrite a name
  // somebody chose.
  const effectiveName = nameEdited
    ? name
    : s.draft
      ? defaultSegmentName(s.draft, text)
      : "";

  function close() {
    setText("");
    setName("");
    setNameEdited(false);
    setSaveError(null);
    describe.reset();
    onClose();
  }

  async function onSave() {
    if (!s.draft || !canSave) return;
    const finalName = effectiveName.trim();
    if (!finalName) {
      setSaveError("Give the segment a name.");
      return;
    }
    setSaveError(null);
    const result = await describe.save({
      name: finalName,
      description: text.trim(),
      queryAst: s.draft.ast,
    });
    if (!result.ok) {
      haptics.error();
      setSaveError(result.message);
      return;
    }
    haptics.success();
    const payload: { id?: string | undefined; name: string } = {
      name: finalName,
      ...(result.id ? { id: result.id } : {}),
    };
    close();
    onSaved(payload);
  }

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={close}
      accessibilityLabel="Describe an audience"
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
        Describe an audience
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          marginBottom: 16,
        }}
      >
        Say or type who you want to reach. Moosewave turns it into a rule you
        can check before you save it.
      </Text>

      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        accessibilityLabel="Audience description"
        accessibilityHint="Describe the people you want to reach. The dictation key on the keyboard works here."
        placeholder="people who opened an email in the last 30 days"
        placeholderTextColor={t.fgSubtle}
        autoCapitalize="none"
        autoCorrect
        style={{
          backgroundColor: t.surface,
          borderColor: overLength ? t.danger : t.border,
          borderWidth: 1,
          color: t.fg,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 12,
          minHeight: 96,
          textAlignVertical: "top",
          fontSize: 16,
          fontFamily: FONT.regular,
        }}
        {...typeCap("body")}
      />
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 6,
          gap: 12,
        }}
      >
        <View style={{ flexShrink: 1 }}>
          <MicroLine>Tap the microphone on the keyboard to dictate.</MicroLine>
        </View>
        <Text
          {...typeCap("label")}
          // The compacted counter gets an exact spoken value beside it.
          accessibilityLabel={`${chars} of ${COMPILE_TEXT_SOFT_MAX} characters used`}
          style={{
            color: overLength ? t.danger : t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {chars}/{COMPILE_TEXT_SOFT_MAX}
        </Text>
      </View>

      {!s.draft && !busy ? (
        <View style={{ marginTop: 14, gap: 6 }}>
          <FieldLabel>Try</FieldLabel>
          {EXAMPLES.map((example) => (
            <Pressable
              key={example}
              onPress={() => {
                haptics.tap();
                setText(example);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Use the example: ${example}`}
              style={{
                minHeight: 44,
                justifyContent: "center",
                borderRadius: 10,
                borderColor: t.borderSubtle,
                borderWidth: 1,
                paddingHorizontal: 12,
                backgroundColor: t.surface,
              }}
            >
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                }}
              >
                {`“${example}”`}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <PrimaryButton
        label={s.draft ? "Re-check" : "Check this audience"}
        busy={busy}
        disabled={busy || !text.trim() || overLength}
        onPress={() => void describe.compile(text, "rules")}
        accessibilityLabel="Compile this description into a rule and count it"
      />

      {s.error ? (
        <View style={{ marginTop: 14, gap: 10 }}>
          <Text
            accessibilityLiveRegion="polite"
            {...typeCap("bodySmall")}
            style={{
              color: t.danger,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {s.error}
          </Text>
          {s.canRetryWithAI ? (
            <AIRetry
              lines={disclosureLines(s.disclosure?.processing ?? null)}
              onRetry={() => void describe.compile(text, "ai", true)}
            />
          ) : null}
        </View>
      ) : null}

      {s.draft ? (
        <DescribeAudienceDraft
          draft={s.draft}
          preview={s.preview}
          previewing={s.previewing}
          previewError={s.previewError}
          name={effectiveName}
          onNameChange={(next) => {
            setNameEdited(true);
            setName(next);
          }}
          canSave={canSave}
          {...(saveDisabledReason ? { saveDisabledReason } : {})}
          saving={s.saving}
          saveError={saveError}
          onSave={() => void onSave()}
        />
      ) : null}
    </KeyboardFormSheet>
  );
}
