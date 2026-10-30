/**
 * ScimMappingCard — one IdP-group → Moosewave-role rule, and its two verbs.
 *
 * A11Y-7. Edit and Delete used to be bare 13pt `<Text onPress>` with no
 * target, no slop and 16pt between them, on a Card that was itself
 * `accessible` — which makes the whole card ONE VoiceOver element, so the
 * verbs inside it could be seen but never focused. The spoken summary now
 * lives on the summary row alone, and every verb is a Pressable at the app's
 * 44pt floor (MIN_TOUCH_TARGET).
 */
import { Pressable, Text, View } from "react-native";

import type { MobileScimRoleMapping } from "@/api/ops";
import { Card } from "@/components/Card";
import { Pill, type PillTone } from "@/components/Pill";
import { MIN_TOUCH_TARGET } from "@/lib/displayPreferences";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

// A static object, never a function of `pressed`: NativeWind v4 silently
// drops layout from a function-style Pressable style, which would take the
// 44pt floor with it.
const TEXT_ACTION_STYLE = {
  minHeight: MIN_TOUCH_TARGET,
  justifyContent: "center",
  paddingHorizontal: 4,
} as const;

/** A text-weight verb (no border, no fill) that still meets the touch floor. */
export function ScimTextAction({
  label,
  accessibilityLabel,
  accessibilityHint,
  tone = "accent",
  strong = false,
  disabled = false,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  accessibilityHint?: string;
  tone?: "accent" | "danger";
  /** Semibold for a section-level verb; medium for a per-row one. */
  strong?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={TEXT_ACTION_STYLE}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: disabled
            ? t.fgSubtle
            : tone === "danger"
              ? t.danger
              : t.accent,
          ...typeStyle("bodySmall"),
          fontFamily: strong ? FONT.semibold : FONT.medium,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ScimMappingCard({
  mapping,
  canAct,
  onEdit,
  onDelete,
}: {
  mapping: MobileScimRoleMapping;
  /** Offline (or a delete in flight) keeps the verbs visible but inert. */
  canAct: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTheme();
  const groupName = (mapping.group_name ?? "").trim();
  const isCatchAll = groupName === "*";
  const groupLabel = groupName || "(unnamed group)";
  const spokenGroup = isCatchAll ? "the catch-all group" : groupLabel;
  return (
    <Card style={{ marginBottom: 8 }}>
      <View
        accessible
        accessibilityLabel={`${isCatchAll ? "Catch-all group" : groupLabel}, role ${mapping.role}, precedence ${mapping.precedence}.`}
        style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
      >
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
          >
            {groupLabel}
          </Text>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              marginTop: 2,
              fontFamily: FONT.regular,
            }}
          >
            {isCatchAll ? "Catch-all - " : ""}Precedence{" "}
            {num(mapping.precedence)}
          </Text>
        </View>
        <Pill label={mapping.role} tone={roleTone(mapping.role)} />
      </View>
      {/* 8pt slop each side of a 16pt gap: the two targets meet, never overlap. */}
      <View style={{ flexDirection: "row", gap: 16, marginTop: 8 }}>
        <ScimTextAction
          label="Edit"
          accessibilityLabel={`Edit the mapping for ${spokenGroup}`}
          disabled={!canAct}
          onPress={onEdit}
        />
        <ScimTextAction
          label="Delete"
          accessibilityLabel={`Delete the mapping for ${spokenGroup}`}
          accessibilityHint="Opens a confirmation"
          tone="danger"
          disabled={!canAct}
          onPress={onDelete}
        />
      </View>
    </Card>
  );
}

function roleTone(role: MobileScimRoleMapping["role"]): PillTone {
  if (role === "owner" || role === "admin") return "accent";
  if (role === "editor") return "info";
  return "neutral";
}
