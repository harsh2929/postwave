/**
 * InboundTriggerRuleRow — one rule: what it matches, what it does, whether it
 * is live, and the three verbs (pause/resume, edit, delete).
 *
 * The state is a WORD in a pill, never a colour alone, and the toggle offers
 * the ACTION ("Pause") rather than restating the state ("Active") — the same
 * rule the endpoint row's enable control follows, for the same reason: an
 * operator on a flooding endpoint taps in a hurry.
 *
 * `canWrite` false (a non-admin reading a stale role) renders the row with
 * no controls at all rather than disabled ones: a disabled-looking button on
 * a phone is a promise the server will refuse.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import {
  triggerActionLine,
  triggerConditionLine,
  triggerFiredLine,
  triggerToggleCopy,
  type InboundTriggerRule,
} from "@/lib/inboundTriggerRules";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface InboundTriggerRuleRowProps {
  rule: InboundTriggerRule;
  /** A write against THIS rule is in flight. */
  pending: boolean;
  /** Any write on the sheet is in flight — keeps two from racing. */
  busy: boolean;
  canWrite: boolean;
  onToggle: (rule: InboundTriggerRule) => void;
  onEdit: (rule: InboundTriggerRule) => void;
  onDelete: (rule: InboundTriggerRule) => void;
}

export function InboundTriggerRuleRow({
  rule,
  pending,
  busy,
  canWrite,
  onToggle,
  onEdit,
  onDelete,
}: InboundTriggerRuleRowProps) {
  const { t } = useTheme();
  const toggle = triggerToggleCopy(rule);
  return (
    <View
      accessible={!canWrite}
      style={{
        borderTopWidth: 1,
        borderTopColor: t.borderSubtle,
        paddingVertical: 12,
        gap: 4,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
            flex: 1,
          }}
          numberOfLines={2}
        >
          {rule.name}
        </Text>
        <Pill
          label={rule.active ? "Active" : "Paused"}
          tone={rule.active ? "success" : "warning"}
          accessibilityLabel={
            rule.active
              ? "Active: matching events run this rule."
              : "Paused: matching events skip this rule until it is resumed."
          }
        />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fg,
          ...typeStyle("caption"),
          // No monospace face ships with the app; medium weight sets the
          // condition apart from the muted lines under it.
          fontFamily: FONT.medium,
        }}
      >
        {triggerConditionLine(rule)}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {triggerActionLine(rule)}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: rule.firedCount === 0 ? t.fgSubtle : t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
      >
        {triggerFiredLine(rule)}
      </Text>

      {canWrite ? (
        <View
          style={{ flexDirection: "row", gap: 8, marginTop: 6, flexWrap: "wrap" }}
        >
          <RowButton
            label={pending ? "Saving…" : toggle.label}
            a11y={toggle.a11y}
            onPress={() => onToggle(rule)}
            disabled={busy}
            tone={rule.active ? "warning" : "accent"}
          />
          <RowButton
            label="Edit"
            a11y={`Edit the rule ${rule.name}`}
            onPress={() => onEdit(rule)}
            disabled={busy}
            tone="neutral"
          />
          <RowButton
            label="Delete"
            a11y={`Delete the rule ${rule.name}`}
            onPress={() => onDelete(rule)}
            disabled={busy}
            tone="danger"
          />
        </View>
      ) : null}
    </View>
  );
}

function RowButton({
  label,
  a11y,
  onPress,
  disabled,
  tone,
}: {
  label: string;
  a11y: string;
  onPress: () => void;
  disabled: boolean;
  tone: "neutral" | "accent" | "warning" | "danger";
}) {
  const { t } = useTheme();
  const color =
    tone === "warning"
      ? t.warning
      : tone === "accent"
        ? t.accent
        : tone === "danger"
          ? t.danger
          : t.fg;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
      style={{
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: tone === "neutral" ? t.border : color,
        backgroundColor: tone === "neutral" ? t.bgSubtle : "transparent",
        opacity: disabled ? 0.5 : 1,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
