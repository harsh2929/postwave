/**
 * InboundEndpointNameSheet — one field, two verbs: the CREATE form and the
 * RENAME form are the same sheet with different words, because they are the
 * same input with different consequences.
 *
 * Presentational on purpose: it validates and it says what will happen, and
 * the caller owns the mutation. That keeps the create path (which has to
 * catch a shown-once secret the moment it lands) and the rename path (which
 * has nothing to catch) out of each other's way.
 *
 * NativeWind v4 gotcha observed: static Pressable style objects only — a
 * function-style `style={({pressed}) => …}` silently drops layout here.
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

import {
  KeyboardFormSheet,
  type ReturnFocusRef,
} from "@/components/KeyboardFormSheet";
import { FONT } from "@/lib/fonts";
import {
  INBOUND_ENDPOINT_CREATE_NAME_MAX,
  INBOUND_ENDPOINT_RENAME_NAME_MAX,
  checkInboundEndpointName,
  isInboundRenameDirty,
} from "@/lib/inboundEndpointAdmin";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export type InboundNameSheetMode = "create" | "rename";

export interface InboundEndpointNameSheetProps {
  visible: boolean;
  mode: InboundNameSheetMode;
  /** Seeds the field on rename; ignored on create. */
  initialName?: string;
  /** What the sheet acts on, spoken in the rename subtitle. */
  endpointLabel?: string;
  submitting: boolean;
  /** No connection: submitting is refused, with the reason on screen. */
  offline: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
  returnFocusRef?: ReturnFocusRef | undefined;
}

export function InboundEndpointNameSheet({
  visible,
  mode,
  initialName = "",
  endpointLabel = "",
  submitting,
  offline,
  onClose,
  onSubmit,
  returnFocusRef,
}: InboundEndpointNameSheetProps) {
  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel={
        mode === "create" ? "New inbound endpoint" : "Rename endpoint"
      }
      contentContainerStyle={{ paddingTop: 12 }}
      returnFocusRef={returnFocusRef}
    >
      {/* Keyed so every open starts from the stored name, never from what was
          half-typed into the last endpoint's sheet. */}
      {visible ? (
        <NameForm
          key={`${mode}:${initialName}`}
          mode={mode}
          initialName={initialName}
          endpointLabel={endpointLabel}
          submitting={submitting}
          offline={offline}
          onClose={onClose}
          onSubmit={onSubmit}
        />
      ) : null}
    </KeyboardFormSheet>
  );
}

const COPY = {
  create: {
    heading: "New inbound endpoint",
    help: "Moosewave mints the public URL and a signing secret for it. The secret is shown once, on the screen behind this sheet, and cannot be retrieved later.",
    submit: "Create endpoint",
    offline:
      "You're offline. Creating an endpoint returns its signing secret in the response, so it cannot be queued for later — reconnect and try again.",
    placeholder: "Stripe live payments",
  },
  rename: {
    heading: "Rename endpoint",
    help: "Only the label changes. The public URL, the signing secret, retained events and trigger rules all stay exactly as they are.",
    submit: "Save name",
    offline: "You're offline. Reconnect to rename this endpoint.",
    placeholder: "Stripe live payments",
  },
} as const;

function NameForm({
  mode,
  initialName,
  endpointLabel,
  submitting,
  offline,
  onClose,
  onSubmit,
}: {
  mode: InboundNameSheetMode;
  initialName: string;
  endpointLabel: string;
  submitting: boolean;
  offline: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const { t } = useTheme();
  const [value, setValue] = useState(mode === "rename" ? initialName : "");
  const [attempted, setAttempted] = useState(false);
  const copy = COPY[mode];
  const max =
    mode === "create"
      ? INBOUND_ENDPOINT_CREATE_NAME_MAX
      : INBOUND_ENDPOINT_RENAME_NAME_MAX;
  const check = checkInboundEndpointName(value, max);
  // A rename that changes nothing is a write the server would still perform.
  const dirty = mode === "create" || isInboundRenameDirty(initialName, value);
  const blocked = submitting || offline || !dirty;

  const submit = () => {
    if (submitting) return;
    setAttempted(true);
    if (check.problem !== null || blocked) return;
    onSubmit(check.value);
  };

  return (
    <View style={{ paddingBottom: 8 }}>
      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{ color: t.fg, ...typeStyle("title"), fontFamily: FONT.display }}
      >
        {copy.heading}
      </Text>
      {mode === "rename" && endpointLabel ? (
        <Caption>{`Currently “${endpointLabel}”.`}</Caption>
      ) : null}
      <Caption>{copy.help}</Caption>

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.semibold,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          marginBottom: 6,
          marginTop: 16,
        }}
      >
        Endpoint name
      </Text>
      <TextInput
        {...typeCap("body")}
        value={value}
        onChangeText={setValue}
        accessibilityLabel="Endpoint name"
        placeholder={copy.placeholder}
        placeholderTextColor={t.fgSubtle}
        autoCapitalize="sentences"
        autoCorrect={false}
        // `maxLength` counts UTF-16 UNITS; the cap the operator is told about
        // counts CODE POINTS, so an astral character costs two here and one
        // there. Set to `max` this silently truncated a pasted emoji-bearing
        // name the validator would have accepted — a label losing its tail
        // with no message. Two units is the most any one code point can take,
        // so this ceiling can never cut a name `checkInboundEndpointName`
        // would pass, while still stopping a runaway paste. The message about
        // the real cap is the validator's to give.
        maxLength={max * 2}
        returnKeyType="done"
        onSubmitEditing={submit}
        editable={!submitting}
        style={{
          backgroundColor: t.surface,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 10,
          color: t.fg,
          fontFamily: FONT.regular,
        }}
      />
      {attempted && check.problem !== null ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("caption")}
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 6,
          }}
        >
          {check.problem}
        </Text>
      ) : null}
      {offline ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 8,
          }}
        >
          {copy.offline}
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", gap: 10, marginTop: 18 }}>
        <Pressable
          onPress={onClose}
          disabled={submitting}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          accessibilityState={{ disabled: submitting }}
          style={{
            flex: 1,
            borderColor: t.border,
            borderWidth: 1,
            borderRadius: 12,
            paddingVertical: 13,
            alignItems: "center",
            opacity: submitting ? 0.5 : 1,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{ color: t.fg, ...typeStyle("body"), fontFamily: FONT.medium }}
          >
            Cancel
          </Text>
        </Pressable>
        <Pressable
          onPress={submit}
          disabled={blocked}
          accessibilityRole="button"
          accessibilityLabel={copy.submit}
          accessibilityState={{ disabled: blocked }}
          style={{
            flex: 1,
            backgroundColor: blocked ? t.bgSubtle : t.accent,
            borderRadius: 12,
            paddingVertical: 13,
            alignItems: "center",
          }}
        >
          {submitting ? (
            <ActivityIndicator color={t.accentFg} />
          ) : (
            <Text
              {...typeCap("body")}
              style={{
                color: blocked ? t.fgMuted : t.accentFg,
                ...typeStyle("body"),
                fontFamily: FONT.semibold,
              }}
            >
              {copy.submit}
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function Caption({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
        marginTop: 6,
      }}
    >
      {children}
    </Text>
  );
}
