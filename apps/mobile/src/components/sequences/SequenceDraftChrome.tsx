/**
 * SequenceDraftChrome — the furniture shared by the two AI-drafting sheets.
 *
 * The brief sheet and the review sheet are two halves of one act, so their
 * buttons, field labels and error lines have to be the same objects rather
 * than two sets that drift. Extracted here for that reason and to keep both
 * screens inside their source budget.
 *
 * NativeWind v4 gotcha, and it is not theoretical on this surface: a
 * `style={({pressed}) => …}` on a Pressable silently drops LAYOUT, so every
 * pressable below takes a static style object and expresses its pressed state
 * through `opacity` on the disabled path only.
 */
import { Pressable, Text, View } from "react-native";

import { SequenceCreateAction } from "@/components/sequences/SequenceChrome";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * The sequences list header's right slot: nothing, one verb, or both.
 *
 * Composed here rather than inline in the route so the screen body does not
 * carry three more branches — `app/(tabs)/sequences/index.tsx` sits against the
 * cyclomatic ceiling in scripts/source-budgets.json, and "which buttons are on
 * the header" is presentation, not the screen's data flow.
 *
 * The two gates are genuinely different rules and are computed by the caller:
 * `canCreateSequence` has no `online` term (the blank create is offline-queued
 * and replayed), `canDraftSequenceWithAI` does (a metered generation cannot be).
 */
export function SequenceListActions({
  canCreate,
  canDraft,
  onCreate,
  onDraft,
}: {
  canCreate: boolean;
  canDraft: boolean;
  onCreate: () => void;
  onDraft: () => void;
}) {
  if (!canCreate && !canDraft) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {canDraft ? <SequenceDraftAction onPress={onDraft} /> : null}
      {canCreate ? <SequenceCreateAction onPress={onCreate} /> : null}
    </View>
  );
}

/**
 * Header action: draft a whole sequence from a brief.
 *
 * Sits beside "New" rather than replacing it, because the two are genuinely
 * different acts with different costs: "New" names an empty draft, spends no
 * AI quota and works offline; this one spends a metered request and needs the
 * network. Folding them into one control would have to pick a single hint, and
 * whichever it picked would be wrong for the other.
 *
 * A LABEL, not a sparkle glyph — the same reasoning as `SequenceCreateAction`:
 * at this end of the type scale an unlabelled icon is the control people report
 * as "I didn't know that did anything".
 */
export function SequenceDraftAction({ onPress }: { onPress: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel="Draft a sequence with AI"
      accessibilityHint="Describes a campaign to a model, which writes the emails. You review them before anything is saved."
      hitSlop={8}
      style={{
        minWidth: 44,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 10,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: t.accent,
          ...typeStyle("control"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        AI draft
      </Text>
    </Pressable>
  );
}

export function DraftSheetButton({
  label,
  onPress,
  disabled,
  primary,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  primary: boolean;
  accessibilityHint?: string | undefined;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      style={{
        flex: 1,
        minHeight: 48,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 12,
        borderWidth: 1,
        borderColor: primary ? t.accent : t.border,
        backgroundColor: primary ? t.accent : t.surface,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        {...typeCap("body")}
        style={{
          color: primary ? t.accentFg : t.fg,
          ...typeStyle("body"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A field caption. `label` is the visible role — this is chrome above an
 *  input, never a heading. */
export function DraftFieldLabel({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("label")}
      style={{
        color: t.fgMuted,
        ...typeStyle("label"),
        fontWeight: "600",
        fontFamily: FONT.semibold,
      }}
    >
      {text}
    </Text>
  );
}

/**
 * A failure line.
 *
 * `accessibilityRole="alert"` rather than plain text: these appear AFTER an
 * action, when focus is still on the control the operator pressed, and a
 * silent red sentence below the fold is the same as no message at all.
 */
export function DraftErrorLine({ message }: { message: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      accessibilityRole="alert"
      style={{
        color: t.danger,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
      }}
    >
      {message}
    </Text>
  );
}

/**
 * The "a model wrote this" panel.
 *
 * `AI_DISCLOSURE_TEXT` is the EU AI Act Article 50(1) notice, mirrored
 * byte-for-byte from the Go gateway by @postwave/ai-disclosure — it is a
 * compliance string and is rendered verbatim, never paraphrased. The second
 * sentence is ours and says the thing the compliance string cannot: what has
 * and has not happened to this content yet.
 */
export function DraftDisclosure({
  disclosure,
  note,
}: {
  disclosure: string;
  note: string;
}) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${disclosure} ${note}`}
      style={{
        padding: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.bgSubtle,
        gap: 4,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        {disclosure}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {note}
      </Text>
    </View>
  );
}
