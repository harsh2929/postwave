/**
 * SuppressionRowCard — one suppressed address.
 *
 * Three fixes are baked into this row.
 *
 *  - It is TAPPABLE and says so. The old row had `onLongPress` only, with the
 *    disclosure buried at the end of its accessibility label — visible to
 *    VoiceOver users and to nobody else — and tapping it did literally
 *    nothing. It now opens the detail screen and carries a chevron.
 *  - The label no longer promises a "copy" the handler never performed.
 *  - The timestamp is RELATIVE ("3h ago", not "6/24/2026, 2:41:07 PM"), capped
 *    for Dynamic Type, with the exact time kept in the accessibility label so
 *    a screen reader still gets the precise value.
 *
 * Memoised because the parent re-renders on every search keystroke.
 */
import { memo } from "react";
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { dateTime, relativeTime } from "@/lib/format";
import { reasonLabel, reasonTone } from "@/lib/suppressionSearch";
import type { ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { forwardChevron } from "@/lib/direction";

export interface SuppressionRowCardProps {
  email: string;
  reason: string | undefined;
  status: string | undefined;
  createdAt: string | undefined;
  onPress: () => void;
  t: ThemeTokens;
  /** Ticking clock so the relative timestamp does not freeze. */
  now: number;
  /**
   * Multi-select support. When `selectionActive` the row is a CHECKBOX, not a
   * door: `onPress` toggles instead of navigating, so the caller swaps the
   * handler. The two props are separate because a row can be unselected while
   * the mode is on, and the mode is what changes the row's ROLE — announcing
   * "button" while a tap toggles a checkbox is the wrong contract.
   */
  selectionActive?: boolean | undefined;
  selected?: boolean | undefined;
  /** Enters selection mode, seeded with this row (iOS Mail / Photos). */
  onLongPress?: (() => void) | undefined;
}

function SuppressionRowCardImpl({
  email,
  reason,
  status,
  createdAt,
  onPress,
  t,
  now,
  selectionActive = false,
  selected = false,
  onLongPress,
}: SuppressionRowCardProps) {
  const address = email.trim() || "(no address)";
  const label = reasonLabel(reason);
  const extraStatus =
    (status ?? "").trim() &&
    (status ?? "").trim().toLowerCase() !== (reason ?? "").trim().toLowerCase()
      ? (status ?? "").trim()
      : "";
  const relative = createdAt ? relativeTime(createdAt, { now }) : "";
  const absolute = createdAt ? dateTime(createdAt) : "";
  const a11y = rowAccessibility({
    address,
    label,
    extraStatus,
    absolute,
    selectionActive,
    selected,
    selectable: Boolean(onLongPress),
  });

  return (
    <Pressable
      onPress={onPress}
      {...(onLongPress ? { onLongPress } : {})}
      {...a11y}
      style={{
        backgroundColor: t.surface,
        // Selection is never colour-alone: the border thickens AND a
        // checkmark glyph appears AND accessibilityState carries it.
        borderColor: selected ? t.accent : t.borderSubtle,
        borderWidth: selected ? 2 : 1,
        borderRadius: 14,
        padding: 14,
        // A DECLARED tap-target floor. The row cleared 44pt only because
        // of the font sizes it happens to render today; shrink the content
        // to one short line, or drop Dynamic Type to its smallest step, and
        // it silently fell under the threshold with nothing enforcing it.
        minHeight: 64,
        marginBottom: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
      }}
    >
      {selectionActive ? (
        <SelectionGlyph selected={selected} t={t} />
      ) : null}
      <View style={{ flex: 1 }}>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {address}
        </Text>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            marginTop: 8,
            flexWrap: "wrap",
          }}
        >
          <Pill label={label} tone={reasonTone(reason)} />
          {extraStatus ? (
            <Pill
              label={extraStatus}
              tone={
                extraStatus.toLowerCase() === "blocklisted"
                  ? "warning"
                  : "neutral"
              }
            />
          ) : null}
          {relative ? (
            <Text
              {...typeCap("numeric")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("numeric"),
                fontVariant: ["tabular-nums"],
                fontFamily: FONT.regular,
              }}
            >
              {relative}
            </Text>
          ) : null}
        </View>
      </View>
      {/* Visible affordance: the row used to look inert. Hidden in selection
          mode, where a tap toggles rather than navigates — a chevron there
          would promise a drill-down the tap no longer performs. */}
      {/* Decorative chevron standing in for an icon — the row's own label
          already says it opens the detail, so this must not scale. */}
      {selectionActive ? null : (
        <Text
          allowFontScaling={false}
          importantForAccessibility="no"
          style={{ color: t.fgSubtle, fontSize: 18, fontFamily: FONT.regular }}
        >
          {forwardChevron()}
        </Text>
      )}
    </Pressable>
  );
}

export const SuppressionRowCard = memo(SuppressionRowCardImpl);

/**
 * The row's accessible contract, assembled in one place.
 *
 * Pulled out of the component because the row now has two ROLES — a button
 * that opens a detail, and a checkbox that toggles a selection — and the
 * branch that picks between them (plus the hint that teaches the long-press)
 * is the part most likely to be quietly broken by a later layout edit.
 */
function rowAccessibility(input: {
  address: string;
  label: string;
  extraStatus: string;
  absolute: string;
  selectionActive: boolean;
  selected: boolean;
  /** True when a long-press can enter selection mode from here. */
  selectable: boolean;
}) {
  const name =
    `${input.address}, suppressed: ${input.label}` +
    (input.extraStatus ? `, ${input.extraStatus}` : "") +
    (input.absolute ? `, ${input.absolute}` : "") +
    (input.selectionActive ? "." : ". Opens the suppression detail.");
  if (input.selectionActive) {
    return {
      accessibilityRole: "checkbox" as const,
      accessibilityLabel: name,
      accessibilityState: {
        selected: input.selected,
        checked: input.selected,
      },
    };
  }
  return {
    accessibilityRole: "button" as const,
    accessibilityLabel: name,
    ...(input.selectable
      ? { accessibilityHint: "Long press to select several addresses." }
      : {}),
  };
}

/**
 * The selection tick. A glyph as well as the accent border, because state is
 * never colour-alone — and non-scaling because it is decorative: the row's
 * accessibilityState already carries "selected".
 */
function SelectionGlyph({
  selected,
  t,
}: {
  selected: boolean;
  t: ThemeTokens;
}) {
  return (
    <Text
      allowFontScaling={false}
      importantForAccessibility="no"
      style={{
        color: selected ? t.accent : t.fgSubtle,
        fontSize: 18,
        width: 20,
        textAlign: "center",
        fontFamily: FONT.semibold,
      }}
    >
      {selected ? "✓" : "○"}
    </Text>
  );
}
