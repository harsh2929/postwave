/**
 * CreateListSheet — make a list from the phone.
 *
 * The lists screen's empty state used to read "Create lists from the web
 * admin to organise your audience" — a dead end that told a new operator the
 * app they were holding could not do the one thing the screen is about. The
 * endpoint has been there the whole time: POST /api/v1/lists
 * (apps/api/internal/lists/lists.go MountIdempotentRoutes → `d.Create`),
 * whose body is `{name, type, optin, description}` and whose only REQUIRED
 * field is a non-empty name; type defaults to "private" and optin to
 * "single" server-side.
 *
 * AUTHORIZATION, read off the mount: the route is registered with
 * `apikeys.RequireScope(apikeys.ScopeWriteSubscribers)`. `write:subscribers`
 * IS in `editorWriteScopes` (apps/api/internal/apikeys/middleware.go), so
 * `sessionRoleAllowsScopes` admits owner|admin|editor — this is an EDITOR
 * action, not an admin one, and gating it on admin would hide a control an
 * editor is entitled to press.
 *
 * TYPE AND OPT-IN ARE VISIBLE, NOT ASSUMED. A list created "public" is
 * reachable from a hosted subscription page and "double" opt-in changes what
 * a subscriber has to do before they are mailable. Defaulting them silently
 * and never showing them is how an operator discovers days later that their
 * list is public.
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { SegmentedControl } from "@/components/SegmentedControl";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { keyboardChain } from "@/lib/keyboardChain";
import {
  LIST_OPTIN_OPTIONS,
  LIST_TYPE_OPTIONS,
  listNameProblem,
  type ListOptin,
  type ListType,
} from "@/lib/listCreate";

export function CreateListSheet({
  visible,
  submitting,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    type: ListType;
    optin: ListOptin;
  }) => void;
}) {
  const { t } = useTheme();
  const [name, setName] = useState("");
  const [type, setType] = useState<ListType>("private");
  const [optin, setOptin] = useState<ListOptin>("single");
  const [touched, setTouched] = useState(false);

  const problem = listNameProblem(name);
  const showError = touched && problem !== null;

  function close() {
    setName("");
    setType("private");
    setOptin("single");
    setTouched(false);
    onClose();
  }

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={close}
      accessibilityLabel="Create a list"
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
        New list
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          marginBottom: 20,
        }}
      >
        A list is a container you add subscribers to. Segments, which pick
        people by rule, live on the Segments screen.
      </Text>

      <SheetLabel>Name</SheetLabel>
      <TextInput
        value={name}
        onChangeText={setName}
        onBlur={() => setTouched(true)}
        accessibilityLabel="List name"
        placeholder="Newsletter"
        placeholderTextColor={t.fgSubtle}
        autoCapitalize="sentences"
        {...keyboardChain({
          onSubmit: () => onSubmit({ name: name.trim(), type, optin }),
          disabled: problem !== null || submitting,
        })}
        style={{
          backgroundColor: t.surface,
          borderColor: showError ? t.danger : t.border,
          borderWidth: 1,
          color: t.fg,
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
      {showError ? (
        <Text
          {...typeCap("label")}
          accessibilityLiveRegion="polite"
          style={{
            color: t.danger,
            ...typeStyle("label"),
            marginTop: 4,
            fontFamily: FONT.regular,
          }}
        >
          {problem}
        </Text>
      ) : null}

      <View style={{ height: 20 }} />
      <SheetLabel>Visibility</SheetLabel>
      <SegmentedControl
        options={LIST_TYPE_OPTIONS.map((o) => ({
          value: o.value,
          label: o.label,
        }))}
        value={type}
        onChange={setType}
        accessibilityLabel="List visibility"
      />
      <Hint>
        {LIST_TYPE_OPTIONS.find((o) => o.value === type)?.hint ?? ""}
      </Hint>

      <View style={{ height: 20 }} />
      <SheetLabel>Opt-in</SheetLabel>
      <SegmentedControl
        options={LIST_OPTIN_OPTIONS.map((o) => ({
          value: o.value,
          label: o.label,
        }))}
        value={optin}
        onChange={setOptin}
        accessibilityLabel="List opt-in"
      />
      <Hint>
        {LIST_OPTIN_OPTIONS.find((o) => o.value === optin)?.hint ?? ""}
      </Hint>

      <Pressable
        onPress={() => {
          setTouched(true);
          if (problem || submitting) return;
          onSubmit({ name: name.trim(), type, optin });
        }}
        disabled={problem !== null || submitting}
        accessibilityRole="button"
        accessibilityLabel="Create this list"
        accessibilityState={{
          disabled: problem !== null || submitting,
          busy: submitting,
        }}
        // Static style object: a function-style `style` on a Pressable
        // silently drops layout under NativeWind v4.
        style={{
          marginTop: 28,
          minHeight: 48,
          borderRadius: 12,
          backgroundColor: t.accent,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
          opacity: problem !== null || submitting ? 0.5 : 1,
        }}
      >
        {submitting ? (
          <ActivityIndicator size="small" color={t.accentFg} />
        ) : null}
        <Text
          {...typeCap("callout")}
          style={{
            color: t.accentFg,
            ...typeStyle("callout"),
            fontFamily: FONT.semibold,
          }}
        >
          {submitting ? "Creating…" : "Create list"}
        </Text>
      </Pressable>
    </KeyboardFormSheet>
  );
}

function SheetLabel({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        letterSpacing: 0.6,
        fontFamily: FONT.semibold,
        textTransform: "uppercase",
        marginBottom: 8,
      }}
    >
      {children}
    </Text>
  );
}

function Hint({ children }: { children: string }) {
  const { t } = useTheme();
  if (!children) return null;
  return (
    <Text
      {...typeCap("label")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("label"),
        marginTop: 6,
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}
