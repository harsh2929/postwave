/**
 * NoteComposerSheet — "jot what just happened" on a subscriber.
 *
 * Same KeyboardFormSheet pattern as TagsModal (keyboard avoidance already
 * solved there), with a tall multiline box because the input is prose, not
 * a token. Autocorrect and sentence capitalisation are ON — the opposite of
 * the tag box — because this IS free text written in a hurry.
 *
 * @-mentions and attachments are deliberately out of scope for the phone
 * composer: the server stores `@[Name](user:id)` tokens that need a people
 * picker to produce, and typing the raw token by hand would file a broken
 * mention. Plain prose round-trips correctly through markdown_body.
 */
import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { FONT } from "@/lib/fonts";
import { NOTE_BODY_MAX, validateNoteDraft } from "@/lib/subscriberNotes";
import type { ThemeTokens } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

import { ModalHeader, SubActionButton } from "./SubActionButton";

export function NoteComposerSheet({
  visible,
  onClose,
  onSave,
  email,
  busy,
  t,
}: {
  visible: boolean;
  onClose: () => void;
  /** Receives the trimmed body; the sheet closes on the caller's success. */
  onSave: (body: string) => void;
  email: string;
  busy: boolean;
  t: ThemeTokens;
}) {
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (visible) setDraft("");
  }, [visible]);

  const validation = validateNoteDraft(draft);
  const canSave = validation.canSave && !busy;

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Add a note"
    >
      <ModalHeader title="Add a note" onClose={onClose} t={t} />

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          marginBottom: 16,
          fontFamily: FONT.regular,
        }}
      >
        Internal context on {email}. Notes are never shown to the subscriber
        and can&apos;t be edited once filed — add a new one instead.
      </Text>

      <TextInput
        value={draft}
        onChangeText={setDraft}
        multiline
        // The server's own ceiling, so a pasted document is trimmed here
        // rather than round-tripping to a raw 400.
        maxLength={NOTE_BODY_MAX}
        placeholder="Met at SaaStr — wants enterprise pricing, follow up Tuesday."
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="Note"
        {...(validation.hint ? { accessibilityHint: validation.hint } : {})}
        autoCapitalize="sentences"
        autoCorrect
        textAlignVertical="top"
        // `fontSizeFor`, not `typeStyle`: an explicit lineHeight on a
        // TextInput mis-centres the caret and clips descenders on Android.
        maxFontSizeMultiplier={typeCap("body").maxFontSizeMultiplier}
        style={{
          color: t.fg,
          fontSize: fontSizeFor("body"),
          fontFamily: FONT.regular,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 12,
          minHeight: 160,
          backgroundColor: t.surface,
        }}
      />

      {validation.hint ? (
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {validation.hint}
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", marginTop: 16 }}>
        <SubActionButton
          label={busy ? "Saving…" : "Save note"}
          onPress={() => {
            if (!canSave) return;
            onSave(draft.trim());
          }}
          disabled={!canSave}
          busy={busy}
          {...(validation.hint ? { disabledReason: validation.hint } : {})}
          t={t}
        />
      </View>
    </KeyboardFormSheet>
  );
}
