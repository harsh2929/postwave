/**
 * SunsetPolicyForm — the create/edit form for a sunset policy definition
 * (extracted sibling of SunsetPoliciesSheet.tsx; see that file's header for
 * the surface's semantics — notably that every save stays paused).
 */
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

import { SegmentedControl } from "@/components/SegmentedControl";
import { FONT } from "@/lib/fonts";
import { keyboardChain } from "@/lib/keyboardChain";
import {
  parseExcludedTagsInput,
  SUNSET_ACTION_OPTIONS,
  sunsetPolicyProblem,
  type SunsetAction,
  type SunsetPolicy,
  type SunsetPolicyDraft,
} from "@/lib/listHygiene";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function Caption({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
        marginTop: 4,
      }}
    >
      {children}
    </Text>
  );
}

/** Create/edit form. Submits a draft; `enabled:false` is forced downstream. */
export function SunsetPolicyForm({
  initial,
  submitting,
  onCancel,
  onSubmit,
}: {
  initial: SunsetPolicy | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (draft: SunsetPolicyDraft) => void;
}) {
  const { t } = useTheme();
  const [name, setName] = useState(initial?.name ?? "");
  const [daysText, setDaysText] = useState(
    initial ? String(initial.inactiveDays) : "180",
  );
  const [action, setAction] = useState<SunsetAction>(
    SUNSET_ACTION_OPTIONS.some((o) => o.value === initial?.action)
      ? (initial?.action as SunsetAction)
      : "suppress",
  );
  const [tagsText, setTagsText] = useState(
    initial ? initial.excludedTags.join(", ") : "",
  );

  const draft: SunsetPolicyDraft = {
    name,
    inactiveDays: Number(daysText.trim()),
    action,
    excludedTags: parseExcludedTagsInput(tagsText),
  };
  const problem = sunsetPolicyProblem(draft);

  // One submit, reached from both the Save button and the last field's return
  // key, so the two can never disagree about when a save is allowed.
  const submit = () => {
    if (submitting || problem) return;
    onSubmit(draft);
  };

  // The return key walks Name → Inactive days → Excluded tags → Save. The
  // action segment between them is not a text field, so the chain skips it.
  const nameRef = useRef<TextInput>(null);
  const daysRef = useRef<TextInput>(null);
  const tagsRef = useRef<TextInput>(null);

  const inputStyle = {
    backgroundColor: t.surface,
    borderColor: t.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: t.fg,
    fontFamily: FONT.regular,
    marginTop: 6,
  } as const;

  const fieldLabel = (text: string) => (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.semibold,
        textTransform: "uppercase",
        letterSpacing: 0.6,
        marginTop: 12,
      }}
    >
      {text}
    </Text>
  );

  return (
    <View
      style={{
        borderColor: t.border,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        marginTop: 12,
      }}
    >
      <Text
        {...typeCap("label")}
        style={{ color: t.fg, ...typeStyle("label"), fontFamily: FONT.semibold }}
      >
        {initial ? "Edit policy" : "New policy"}
      </Text>

      {fieldLabel("Name")}
      <TextInput
        ref={nameRef}
        value={name}
        onChangeText={setName}
        accessibilityLabel="Policy name"
        placeholder="Sunset after 180 days"
        placeholderTextColor={t.fgSubtle}
        autoCapitalize="sentences"
        // A TextInput scales with the OS text setting exactly like a Text
        // while its padding does not, so an uncapped field clips its caret at
        // accessibility sizes.
        {...typeCap("body")}
        {...keyboardChain({ next: daysRef })}
        style={inputStyle}
      />

      {fieldLabel("Inactive days (30–730)")}
      <TextInput
        ref={daysRef}
        value={daysText}
        onChangeText={setDaysText}
        accessibilityLabel="Inactive days"
        keyboardType="number-pad"
        placeholder="180"
        placeholderTextColor={t.fgSubtle}
        {...typeCap("body")}
        {...keyboardChain({ next: tagsRef })}
        style={inputStyle}
      />

      {fieldLabel("Action on match")}
      <View style={{ marginTop: 6 }}>
        <SegmentedControl
          accessibilityLabel="Action on match"
          options={SUNSET_ACTION_OPTIONS.map((o) => ({
            value: o.value,
            label: o.label,
          }))}
          value={action}
          onChange={setAction}
        />
      </View>
      <Caption>
        {SUNSET_ACTION_OPTIONS.find((o) => o.value === action)?.hint ?? ""}
      </Caption>

      {fieldLabel("Excluded tags (comma-separated)")}
      <TextInput
        ref={tagsRef}
        value={tagsText}
        onChangeText={setTagsText}
        accessibilityLabel="Excluded tags"
        placeholder="vip, partner"
        placeholderTextColor={t.fgSubtle}
        autoCapitalize="none"
        {...typeCap("body")}
        {...keyboardChain({
          onSubmit: submit,
          disabled: submitting || problem !== null,
        })}
        style={inputStyle}
      />

      {problem ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 8,
          }}
        >
          {problem}
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
        <Pressable
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel policy edit"
          style={{
            flex: 1,
            borderColor: t.border,
            borderWidth: 1,
            borderRadius: 10,
            paddingVertical: 11,
            alignItems: "center",
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
          disabled={submitting || problem !== null}
          accessibilityRole="button"
          accessibilityLabel="Save policy (stays paused)"
          accessibilityState={{ disabled: submitting || problem !== null }}
          style={{
            flex: 1,
            backgroundColor: problem ? t.bgSubtle : t.accent,
            borderRadius: 10,
            paddingVertical: 11,
            alignItems: "center",
          }}
        >
          {submitting ? (
            <ActivityIndicator color={t.accentFg} />
          ) : (
            <Text
              {...typeCap("body")}
              style={{
                color: problem ? t.fgMuted : t.accentFg,
                ...typeStyle("body"),
                fontFamily: FONT.semibold,
              }}
            >
              Save (stays paused)
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

