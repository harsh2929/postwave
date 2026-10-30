/**
 * SaveSegmentSheet — name the view on screen and keep it.
 *
 * The applied filters were already decided on the list behind the sheet, so
 * the sheet restates them (viewSummary) rather than re-collecting them, and
 * asks only for what a bookmark needs: a name, an optional note, and whether
 * the whole workspace should see it. Validation mirrors the server's text
 * rules via lib/subscriberSavedSegmentDraft.ts.
 */
import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";

import { Chip } from "@/components/Chip";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import {
  ModalHeader,
  SubActionButton,
} from "@/components/subscriber/SubActionButton";
import { FONT } from "@/lib/fonts";
import { savedSegmentTextProblem } from "@/lib/subscriberSavedSegmentDraft";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";
import { keyboardDismiss } from "@/lib/keyboardChain";

export interface SaveSegmentSubmit {
  name: string;
  description: string;
  visibilityScope: "personal" | "workspace";
}

function Input({
  label,
  value,
  onChangeText,
  placeholder,
  t,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  t: ThemeTokens;
}) {
  return (
    <View style={{ marginTop: 12 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginBottom: 6,
          fontFamily: FONT.medium,
        }}
      >
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel={label}
        autoCorrect={false}
        {...keyboardDismiss()}
        {...typeCap("body")}
        style={{
          color: t.fg,
          backgroundColor: t.surface,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 12,
          paddingHorizontal: 12,
          paddingVertical: 10,
          minHeight: 44,
          fontFamily: FONT.regular,
          fontSize: fontSizeFor("body"),
        }}
      />
    </View>
  );
}

export function SaveSegmentSheet({
  visible,
  viewSummary,
  busy,
  submitError,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  /** "Saves the current view: search “acme” and status unsubscribed." */
  viewSummary: string;
  busy: boolean;
  submitError?: string | undefined;
  onClose: () => void;
  onSubmit: (input: SaveSegmentSubmit) => void;
}) {
  const { t } = useTheme();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<"personal" | "workspace">("personal");
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (visible) {
      setName("");
      setDescription("");
      setScope("personal");
      setAttempted(false);
    }
  }, [visible]);

  const problem = savedSegmentTextProblem(name, description);
  const shownProblem = attempted ? problem : null;

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Save the current view as a segment"
    >
      <ModalHeader title="Save this view" onClose={onClose} t={t} />
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {viewSummary}
      </Text>

      <Input
        label="Name"
        value={name}
        onChangeText={setName}
        placeholder="e.g. Engaged EU"
        t={t}
      />
      <Input
        label="Description (optional)"
        value={description}
        onChangeText={setDescription}
        placeholder="What this view is for"
        t={t}
      />

      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginTop: 12,
          marginBottom: 6,
          fontFamily: FONT.medium,
        }}
      >
        Who can see it
      </Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Chip
          label="Just me"
          active={scope === "personal"}
          onPress={() => setScope("personal")}
          accessibilityLabel="Visible to just me"
        />
        <Chip
          label="Whole workspace"
          active={scope === "workspace"}
          onPress={() => setScope("workspace")}
          accessibilityLabel="Visible to the whole workspace"
        />
      </View>

      {shownProblem || submitError ? (
        <Text
          {...typeCap("bodySmall")}
          accessibilityLiveRegion="polite"
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            marginTop: 10,
            fontFamily: FONT.regular,
          }}
        >
          {shownProblem ?? submitError}
        </Text>
      ) : null}

      <View style={{ marginTop: 14 }}>
        <SubActionButton
          label={busy ? "Saving…" : "Save view"}
          onPress={() => {
            setAttempted(true);
            if (problem || busy) return;
            onSubmit({
              name: name.trim(),
              description: description.trim(),
              visibilityScope: scope,
            });
          }}
          disabled={busy}
          busy={busy}
          t={t}
        />
      </View>
    </KeyboardFormSheet>
  );
}
