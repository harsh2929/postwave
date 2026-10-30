/**
 * CreateSubscriberSheet — add a contact from the device you carry to a
 * conference, a store counter, or a customer call.
 *
 * Mobile's documented stance used to be "look subscribers up rather than
 * create them (creation is web-admin)". That was the wrong call for the one
 * device that is actually present when a new address appears: the endpoint
 * exists, the scanner and share extension already deliver a validated email,
 * and the alternative is a note-to-self that never gets typed in.
 *
 * What it will NOT do is pretend the person is subscribed. The server accepts
 * a bare email only for an `unconfirmed` contact; making one sendable needs a
 * reviewed consent envelope (see src/lib/subscriberDraft.ts). The sheet states
 * that in place, and the receipt repeats it.
 *
 * PASTE MODE: the same sheet also takes a pasted block of addresses (the
 * handful collected at an event) and submits it to the bulk-paste endpoint —
 * same unconfirmed stance, per-address receipt inline when any fail. Rules in
 * src/lib/subscriberBulkPaste.ts.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

import { Chip } from "@/components/Chip";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { ModalHeader, SubActionButton } from "@/components/subscriber/SubActionButton";
import { FONT } from "@/lib/fonts";
import {
  bulkPasteFailedRows,
  bulkPasteProblem,
  parsePastedEmails,
  type BulkPasteResult,
} from "@/lib/subscriberBulkPaste";
import {
  addDraftTag,
  EMPTY_SUBSCRIBER_DRAFT,
  removeDraftTag,
  UNCONFIRMED_CREATE_NOTICE,
  validateSubscriberDraft,
  type SubscriberDraft,
} from "@/lib/subscriberDraft";
import { limitRunes } from "@/lib/tagInput";
import type { ThemeTokens } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  hint,
  hintTone,
  t,
  ...rest
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  hint?: string | null;
  hintTone?: "muted" | "danger";
  t: ThemeTokens;
} & Pick<
  React.ComponentProps<typeof TextInput>,
  | "keyboardType"
  | "textContentType"
  | "autoComplete"
  | "autoCapitalize"
  | "autoFocus"
  | "multiline"
>) {
  return (
    <View style={{ gap: 6 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
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
        {...rest}
        {...typeCap("body")}
        style={{
          color: t.fg,
          backgroundColor: t.surface,
          borderColor: hintTone === "danger" ? t.danger : t.border,
          borderWidth: 1,
          borderRadius: 12,
          paddingHorizontal: 12,
          paddingVertical: 12,
          minHeight: 44,
          fontFamily: FONT.regular,
          fontSize: fontSizeFor("body"),
        }}
      />
      {hint ? (
        <Text
          {...typeCap("label")}
          style={{
            color: hintTone === "danger" ? t.danger : t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/** The failures list after a bulk submit — every address named, capped. */
function BulkPasteFailures({
  result,
  t,
}: {
  result: BulkPasteResult;
  t: ThemeTokens;
}) {
  const failures = bulkPasteFailedRows(result);
  if (failures.length === 0) return null;
  const shown = failures.slice(0, 5);
  return (
    <View style={{ gap: 4 }} accessibilityLabel="Addresses that failed">
      {shown.map((row) => (
        <Text
          key={row.email}
          {...typeCap("label")}
          style={{
            color: t.danger,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {row.email} — {row.error || "not accepted"}
        </Text>
      ))}
      {failures.length > shown.length ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.danger,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          …and {failures.length - shown.length} more failed.
        </Text>
      ) : null}
    </View>
  );
}

export function CreateSubscriberSheet({
  visible,
  submitting,
  initialEmail = "",
  online = true,
  bulkSubmitting = false,
  bulkResult = null,
  onClose,
  onSubmit,
  onSubmitBulk,
  t,
}: {
  visible: boolean;
  submitting: boolean;
  /** Seeded by a QR scan / share hand-off / the current search term. */
  initialEmail?: string;
  /** Paste mode refuses to submit offline (the receipt is the point). */
  online?: boolean;
  bulkSubmitting?: boolean;
  /** The last paste's per-address receipt; the sheet stays open on failures. */
  bulkResult?: BulkPasteResult | null;
  onClose: () => void;
  onSubmit: (draft: SubscriberDraft) => void;
  /** Absent → the paste mode is not offered (caller lacks the verb). */
  onSubmitBulk?: ((input: { emails: string; tags: string[] }) => void) | undefined;
  t: ThemeTokens;
}) {
  const [draft, setDraft] = useState<SubscriberDraft>(EMPTY_SUBSCRIBER_DRAFT);
  const [tagDraft, setTagDraft] = useState("");
  const [mode, setMode] = useState<"single" | "paste">("single");
  const [pasteRaw, setPasteRaw] = useState("");

  useEffect(() => {
    if (visible) {
      setDraft({ ...EMPTY_SUBSCRIBER_DRAFT, email: initialEmail });
      setTagDraft("");
      setMode("single");
      setPasteRaw("");
    }
  }, [visible, initialEmail]);

  const validation = validateSubscriberDraft(draft);
  const pasteCount = parsePastedEmails(pasteRaw).length;
  const pasteProblem = bulkPasteProblem(pasteRaw, online);

  function commitTag() {
    const next = addDraftTag(draft, tagDraft);
    setDraft(next);
    setTagDraft("");
  }

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Add a subscriber"
    >
      <ModalHeader title="Add subscriber" onClose={onClose} t={t} />

      <View style={{ gap: 16 }}>
        {onSubmitBulk ? (
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Chip
              label="One contact"
              active={mode === "single"}
              onPress={() => setMode("single")}
              accessibilityLabel="Add one contact"
            />
            <Chip
              label="Paste several"
              active={mode === "paste"}
              onPress={() => setMode("paste")}
              accessibilityLabel={`Paste several addresses at once, up to 100`}
            />
          </View>
        ) : null}

        {mode === "paste" ? (
          <View style={{ gap: 8 }}>
            <Field
              label="Pasted addresses"
              value={pasteRaw}
              onChangeText={setPasteRaw}
              placeholder="One per line, or comma-separated"
              autoCapitalize="none"
              keyboardType="email-address"
              multiline
              hint={
                pasteCount > 0
                  ? `${pasteCount} address${pasteCount === 1 ? "" : "es"} detected.`
                  : null
              }
              t={t}
            />
            {bulkResult ? <BulkPasteFailures result={bulkResult} t={t} /> : null}
          </View>
        ) : (
          <>
        <Field
          label="Email address"
          value={draft.email}
          onChangeText={(email) => setDraft((d) => ({ ...d, email }))}
          placeholder="name@example.com"
          keyboardType="email-address"
          textContentType="emailAddress"
          autoComplete="email"
          autoCapitalize="none"
          autoFocus={!initialEmail}
          hint={validation.emailHint}
          hintTone="danger"
          t={t}
        />
        <View style={{ flexDirection: "row", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Field
              label="First name"
              value={draft.firstName}
              onChangeText={(firstName) => setDraft((d) => ({ ...d, firstName }))}
              placeholder="Optional"
              autoCapitalize="words"
              textContentType="givenName"
              t={t}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field
              label="Last name"
              value={draft.lastName}
              onChangeText={(lastName) => setDraft((d) => ({ ...d, lastName }))}
              placeholder="Optional"
              autoCapitalize="words"
              textContentType="familyName"
              t={t}
            />
          </View>
        </View>
          </>
        )}

        <View style={{ gap: 8 }}>
          <Field
            label="Tags"
            value={tagDraft}
            onChangeText={(next) => setTagDraft(limitRunes(next))}
            placeholder="Add a tag, then return"
            autoCapitalize="none"
            t={t}
          />
          <Pressable
            onPress={commitTag}
            disabled={!tagDraft.trim()}
            accessibilityRole="button"
            accessibilityLabel="Add tag"
            accessibilityState={{ disabled: !tagDraft.trim() }}
            hitSlop={8}
            style={{
              alignSelf: "flex-start",
              minHeight: 44,
              justifyContent: "center",
              opacity: tagDraft.trim() ? 1 : 0.4,
            }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.accent,
                ...typeStyle("callout"),
                fontFamily: FONT.semibold,
              }}
            >
              + Add tag
            </Text>
          </Pressable>
          {draft.tags.length > 0 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {/* Tapping a draft chip REMOVES it — stated in the spoken
                  label, because "remove" is not the default reading of a
                  chip and there is no × glyph at this size. */}
              {draft.tags.map((tag) => (
                <Chip
                  key={tag}
                  label={tag}
                  active
                  accessibilityLabel={`Tag ${tag}. Double tap to remove it`}
                  onPress={() => setDraft((d) => removeDraftTag(d, tag))}
                />
              ))}
            </View>
          ) : null}
        </View>

        {/* The honesty clause. It is above the button, not in the receipt
            only, so the decision is informed rather than explained after. */}
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {UNCONFIRMED_CREATE_NOTICE}
        </Text>

        {mode === "paste" && onSubmitBulk ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <SubActionButton
              label={
                pasteCount > 1
                  ? `Add ${pasteCount} subscribers`
                  : "Add subscribers"
              }
              onPress={() =>
                onSubmitBulk({ emails: pasteRaw, tags: [...draft.tags] })
              }
              disabled={pasteProblem !== null}
              busy={bulkSubmitting}
              {...(pasteProblem === null
                ? {}
                : { disabledReason: pasteProblem })}
              t={t}
            />
            {bulkSubmitting ? <ActivityIndicator color={t.fgMuted} /> : null}
          </View>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <SubActionButton
              label="Add subscriber"
              onPress={() => onSubmit(draft)}
              disabled={!validation.canSubmit}
              busy={submitting}
              {...(validation.canSubmit
                ? {}
                : { disabledReason: "Enter a valid email address first." })}
              t={t}
            />
            {submitting ? <ActivityIndicator color={t.fgMuted} /> : null}
          </View>
        )}
      </View>
    </KeyboardFormSheet>
  );
}
