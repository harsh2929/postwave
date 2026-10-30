/**
 * SmsBroadcastEditorSheet — create or edit one broadcast DRAFT.
 *
 * Fields mirror what a phone can honestly author: name, message body (with a
 * live segment estimate — the same `segmentInfo` the composer uses), and a
 * TAG audience. List/segment audiences are displayed but authored on desktop;
 * the one-audience-dimension rule is enforced before the request so the 422
 * never has to explain it.
 */
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { keyboardChain } from "@/lib/keyboardChain";
import {
  smsBroadcastAudienceLine,
  smsBroadcastBodyError,
  smsBroadcastNameError,
  type SmsBroadcast,
  type SmsBroadcastDraftInput,
} from "@/lib/smsBroadcastWire";
import { segmentInfo } from "@/lib/smsSegments";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export function SmsBroadcastEditorSheet({
  visible,
  broadcast,
  busy,
  onSave,
  onClose,
}: {
  visible: boolean;
  /** null → create a new draft. */
  broadcast: SmsBroadcast | null;
  busy: boolean;
  onSave: (draft: SmsBroadcastDraftInput) => void;
  onClose: () => void;
}) {
  const { t } = useTheme();
  const bodyRef = useRef<TextInput>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [tag, setTag] = useState("");
  const [error, setError] = useState<string | null>(null);
  const hasFixedAudience = Boolean(
    broadcast && (broadcast.listIds.length > 0 || broadcast.segmentId),
  );

  useEffect(() => {
    if (!visible) return;
    setName(broadcast?.name ?? "");
    setBody(broadcast?.body ?? "");
    setTag(broadcast?.tag ?? "");
    setError(null);
  }, [visible, broadcast]);

  const submit = () => {
    const invalid =
      smsBroadcastNameError(name) ?? smsBroadcastBodyError(body);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    onSave({
      name: name.trim(),
      body: body.trim(),
      ...(hasFixedAudience ? {} : { tag: tag.trim() }),
    });
  };

  const info = segmentInfo(body.trim());
  const inputStyle = {
    color: t.fg,
    borderColor: t.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontFamily: FONT.regular,
    fontSize: fontSizeFor("bodySmall"),
  } as const;
  const caption = (text: string, danger = false) => (
    <Text
      accessibilityLiveRegion={danger ? "polite" : "none"}
      {...typeCap("caption")}
      style={{
        color: danger ? t.danger : t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.medium,
      }}
    >
      {text}
    </Text>
  );

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel={broadcast ? "Edit broadcast" : "New broadcast"}
    >
      <View style={{ gap: 8 }}>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
          }}
        >
          {broadcast ? "Edit broadcast draft" : "New broadcast draft"}
        </Text>
        <TextInput
          // The input scales with the OS text size but its height does not.
          {...typeCap("bodySmall")}
          value={name}
          onChangeText={(next) => {
            setName(next);
            setError(null);
          }}
          placeholder="Broadcast name"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="Broadcast name"
          {...keyboardChain({ next: bodyRef })}
          style={{ ...inputStyle, minHeight: 40 }}
        />
        <TextInput
          {...typeCap("bodySmall")}
          ref={bodyRef}
          value={body}
          onChangeText={(next) => {
            setBody(next);
            setError(null);
          }}
          placeholder="Message (optional for a draft)"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="Broadcast message"
          multiline
          style={{ ...inputStyle, minHeight: 88, textAlignVertical: "top" }}
        />
        {body.trim()
          ? caption(
              `${num(Array.from(body.trim()).length)} characters · ${num(info.segments)} segment${info.segments === 1 ? "" : "s"}/message${info.unicode ? " · non-GSM characters shorten each segment to 70" : ""} · limit 10 segments`,
            )
          : null}
        {hasFixedAudience && broadcast ? (
          caption(
            `${smsBroadcastAudienceLine(broadcast)} — list and segment audiences are managed from desktop.`,
          )
        ) : (
          <>
            <TextInput
              // The input scales with the OS text size but its height does not.
              {...typeCap("bodySmall")}
              value={tag}
              onChangeText={(next) => {
                setTag(next);
                setError(null);
              }}
              placeholder="Audience tag (optional, e.g. vip)"
              placeholderTextColor={t.fgSubtle}
              accessibilityLabel="Audience tag"
              autoCapitalize="none"
              autoCorrect={false}
              {...keyboardChain({ onSubmit: submit, disabled: busy })}
              style={{ ...inputStyle, minHeight: 40 }}
            />
            {caption(
              "A broadcast targets at most one audience dimension: a tag here, or lists/segments from desktop.",
            )}
          </>
        )}
        {error ? caption(error, true) : null}
        <Pressable
          onPress={submit}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={
            broadcast ? "Save broadcast draft" : "Create broadcast draft"
          }
          accessibilityState={{ disabled: busy }}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: busy ? t.fgMuted : t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {busy ? "Saving…" : broadcast ? "Save draft" : "Create draft"}
          </Text>
        </Pressable>
      </View>
    </KeyboardFormSheet>
  );
}
