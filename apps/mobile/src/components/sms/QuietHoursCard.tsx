/**
 * QuietHoursCard — stored-policy evaluation without a live-delivery claim.
 *
 * An empty-country stored active window defers an otherwise eligible send at
 * the internal policy gate. Provider dispatch and callbacks remain release-held, so
 * this card leads with a local rule-evaluation sentence and never diagnoses a
 * live broadcast or delivery outcome.
 *
 * THE VERDICT IS NEVER COLOUR-ALONE, and never a green "not holding" the
 * device cannot actually justify: `quietHoursSummary` returns `null` when a
 * rule's IANA zone is unresolvable here, and that renders as an explicit
 * "unknown" sentence rather than a reassuring pill.
 *
 * The only write is the enable switch, and it is admin-gated because
 * PATCH /api/v1/sms/quiet-hours/{id} carries the exact-tenant admin boundary —
 * a viewer must never be shown a control whose only possible outcome is a 403.
 */
import { Switch, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import {
  daysLabel,
  quietRuleActive,
  windowLabel,
  type SmsQuietHoursRule,
} from "@/lib/smsPolicies";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface QuietHoursCardProps {
  rules: readonly SmsQuietHoursRule[];
  /** The folded sentence + tone from `quietHoursSummary`. */
  summary: { sentence: string; tone: "success" | "warning" | "neutral" };
  /** Non-null when the read failed or could not run — never an implied "none". */
  unavailableReason: string | null;
  loading: boolean;
  canEdit: boolean;
  /** Id currently being written, so only that row's switch goes busy. */
  pendingId: string | null;
  onToggle: (rule: SmsQuietHoursRule, enabled: boolean) => void;
  now: number;
}

export function QuietHoursCard({
  rules,
  summary,
  unavailableReason,
  loading,
  canEdit,
  pendingId,
  onToggle,
  now,
}: QuietHoursCardProps) {
  const { t } = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 10,
        gap: 10,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.bold,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        Quiet hours
      </Text>

      <Text
        accessibilityRole="summary"
        {...typeCap("bodySmall")}
        style={{
          color: unavailableReason ? t.fgMuted : t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {unavailableReason ??
          (loading ? "Reading quiet-hours windows…" : summary.sentence)}
      </Text>

      {unavailableReason || loading
        ? null
        : rules.map((rule) => (
            <QuietHoursRow
              key={rule.id}
              rule={rule}
              canEdit={canEdit}
              busy={pendingId === rule.id}
              onToggle={onToggle}
              now={now}
            />
          ))}
    </View>
  );
}

function QuietHoursRow({
  rule,
  canEdit,
  busy,
  onToggle,
  now,
}: {
  rule: SmsQuietHoursRule;
  canEdit: boolean;
  busy: boolean;
  onToggle: (rule: SmsQuietHoursRule, enabled: boolean) => void;
  now: number;
}) {
  const { t } = useTheme();
  const active = quietRuleActive(rule, now);
  const name = rule.label.trim() || windowLabel(rule);
  const zone = rule.timezone.trim() || "an unset timezone";
  // "Rule active" / "Rule inactive" / "Off" are stored-policy facts; a fourth,
  // "unknown", exists — so the pill carries a word, never a colour alone.
  const state: { label: string; tone: "warning" | "success" | "neutral" } =
    !rule.enabled
      ? { label: "Off", tone: "neutral" }
      : active === true
        ? { label: "Rule active", tone: "warning" }
        : active === false
          ? { label: "Rule inactive", tone: "success" }
          : { label: "Unknown", tone: "neutral" };

  const detail = `${windowLabel(rule)} · ${daysLabel(rule.days)} · ${zone}${
    rule.countryCode ? ` · unsupported historical ${rule.countryCode} scope` : " · tenant-global"
  }`;

  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingTop: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
      }}
    >
      <View
        accessible
        accessibilityLabel={`${name}. ${detail}. ${
          !rule.enabled
            ? "Switched off."
            : active === true
              ? "Stored rule is active at this evaluation time; no live-delivery claim."
              : active === false
                ? "Stored rule is inactive at this evaluation time; no live-delivery claim."
                : rule.countryCode
                  ? "Historical country scope is unsupported and an enabled row is gate-invalid and fail-closed; no recipient-country outcome can be inferred."
                  : "This device can't safely evaluate this rule; no live hold or delivery outcome can be inferred."
        }`}
        style={{ flex: 1, gap: 4 }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
              flexShrink: 1,
            }}
            numberOfLines={1}
          >
            {name}
          </Text>
          <Pill label={state.label} tone={state.tone} />
        </View>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {detail}
        </Text>
      </View>
      {canEdit ? (
        <Switch
          value={rule.enabled}
          disabled={busy}
          onValueChange={(next) => void onToggle(rule, next)}
          accessibilityRole="switch"
          accessibilityLabel={`${name} quiet-hours window`}
          accessibilityHint={
            rule.enabled
              ? rule.countryCode
                ? "Switches this stored rule off and retires unsupported historical country metadata"
                : "Switches this stored rule off; this does not prove any live send"
              : rule.countryCode
                ? "This historical country-scoped rule must be repaired before it can be enabled"
                : "Switches this tenant-global stored rule on at the internal gate"
          }
          accessibilityState={{ checked: rule.enabled, disabled: busy }}
          trackColor={{ false: t.border, true: t.accent }}
        />
      ) : null}
    </View>
  );
}
