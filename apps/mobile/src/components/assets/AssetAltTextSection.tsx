/**
 * AssetAltTextSection — read the image's description; write it where allowed.
 *
 * WHY THIS EXISTS ON A PHONE. The upload flow this library champions is the
 * phone one — the photo is already in a pocket, or about to be taken. Every
 * image that arrives that way shipped UNDESCRIBED until someone opened a
 * laptop, which is exactly backwards: the person who just took the picture is
 * the one who knows what it shows. It is one sentence in one text field.
 * (This replaces the surface's earlier recorded omission — "writing
 * accessibility copy is a keyboard job" — which was honest about effort and
 * wrong about who has the context.)
 *
 * EDIT IS A MODE, NOT A LIVE FIELD. The sheet shows the stored sentence and
 * an explicit "Edit" affordance; typing happens against a local draft and
 * nothing is sent until Save. A field that PATCHes as you type would race the
 * 1024-rune bound and turn every keystroke into a network write.
 *
 * The bound is enforced BEFORE the request: lib/assetLibrary.altTextBlockReason
 * mirrors the handler's rune count, so Save is refused with the reason under
 * the field rather than after a round trip. Clearing to "" is a real save —
 * the server accepts it — not a validation failure.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { altTextBlockReason } from "@/lib/assetLibrary";
import { FONT } from "@/lib/fonts";
import { EMDASH } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AssetAltTextSectionProps {
  /** The stored sentence — "" when the image has none yet. */
  altText: string;
  /** Role + connectivity, already evaluated by the screen. */
  canEdit: boolean;
  saving: boolean;
  /**
   * Resolves true when the PATCH landed — the section then leaves edit mode.
   * On false (the screen has already toasted the failure) the draft stays on
   * screen, because losing a typed sentence to a failed request is the exact
   * defect the draft exists to prevent.
   */
  onSave: (next: string) => Promise<boolean>;
}

export function AssetAltTextSection(props: AssetAltTextSectionProps) {
  const { t } = useTheme();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const blockReason = editing ? altTextBlockReason(draft) : null;

  if (!editing) {
    return (
      <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            width: 104,
          }}
        >
          Alt text
        </Text>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
            flex: 1,
          }}
        >
          {props.altText || EMDASH}
        </Text>
        {props.canEdit ? (
          <Pressable
            onPress={() => {
              setDraft(props.altText);
              setEditing(true);
            }}
            accessibilityRole="button"
            accessibilityLabel={
              props.altText ? "Edit alt text" : "Add alt text"
            }
            accessibilityHint="Describes this image for screen readers wherever it is embedded"
            hitSlop={8}
            style={{ minHeight: 24, justifyContent: "center" }}
          >
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.accent,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.semibold,
              }}
            >
              {props.altText ? "Edit" : "Add"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={{ gap: 8 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        Alt text
      </Text>
      <TextInput
        {...typeCap("bodySmall")}
        value={draft}
        onChangeText={setDraft}
        multiline
        autoFocus
        editable={!props.saving}
        placeholder="What does this image show?"
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="Alt text for this image"
        style={{
          minHeight: 72,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
          color: t.fg,
          paddingHorizontal: 12,
          paddingVertical: 10,
          textAlignVertical: "top",
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      />
      {blockReason ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("caption")}
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {blockReason}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Pressable
          onPress={() => {
            void (async () => {
              const ok = await props.onSave(draft.trim());
              if (ok) setEditing(false);
            })();
          }}
          disabled={props.saving || blockReason !== null}
          accessibilityRole="button"
          accessibilityLabel="Save alt text"
          accessibilityState={{
            disabled: props.saving || blockReason !== null,
            busy: props.saving,
          }}
          style={{
            minHeight: 40,
            borderRadius: 10,
            paddingHorizontal: 16,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: t.accent,
            opacity: props.saving || blockReason !== null ? 0.45 : 1,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.accentFg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.semibold,
            }}
          >
            {props.saving ? "Saving…" : "Save"}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setEditing(false)}
          disabled={props.saving}
          accessibilityRole="button"
          accessibilityLabel="Cancel editing alt text"
          accessibilityState={{ disabled: props.saving }}
          style={{
            minHeight: 40,
            borderRadius: 10,
            paddingHorizontal: 16,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 1,
            borderColor: t.border,
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
            Cancel
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
