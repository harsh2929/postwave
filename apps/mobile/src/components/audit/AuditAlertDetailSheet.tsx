/**
 * AuditAlertDetailSheet — read the whole rule, see whether it is actually
 * delivering, then act on it: pause/resume, flip the Slack fan-out, or delete
 * it (typed confirm at the screen).
 *
 * A sheet rather than a route, for the same reason ReviewDetailSheet is: the
 * rhythm is open → judge → next, and it keeps this surface to ONE route file,
 * so it costs one tab-layout registration instead of two.
 *
 * IT FETCHES THE FIRE HISTORY ON OPEN. The list read carries `fired_count`,
 * `last_fired_at` and `last_error` — an aggregate — but not the individual
 * attempts. Only `GET /{id}/fires` has those, and "the last delivery failed" is
 * a very different claim from "the last four failed". Until that read lands the
 * sheet says it is checking, rather than rendering an empty list as "no
 * deliveries", which on a detection surface is the exact wrong reassurance.
 *
 * IT NEVER RENDERS `channel_config`. That map is where the Slack webhook URL,
 * the Jira api_token, the ServiceNow bearer/password and the PagerDuty routing
 * key live. `channelDestination` returns a host or an email address and nothing
 * else — see lib/auditAlertRules and its test.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { Pill } from "@/components/Pill";
import { SectionLabel } from "@/components/SectionLabel";
import { SettingsSwitchRow } from "@/components/settings/FormControls";
import { AuditAlertFireList } from "@/components/audit/AuditAlertFireList";
import { AuditAlertIncidentList } from "@/components/audit/AuditAlertIncidentList";
import type { AuditAlertIncident } from "@/lib/auditAlertIncidents";
import { AUDIT_ALERT_CONFIG_NOTICE, ruleAttention } from "@/lib/auditAlertPolicy";
import {
  channelDestination,
  channelLabel,
  healthPresentation,
  matchNarrowing,
  operatorSummary,
  ruleHealth,
  type AuditAlertFire,
  type AuditAlertRule,
} from "@/lib/auditAlertRules";
import { EMDASH, dateTime, num, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface AuditAlertDetailSheetProps {
  rule: AuditAlertRule | null;
  fires: readonly AuditAlertFire[];
  firesLoading: boolean;
  firesFailed: boolean;
  incidents: readonly AuditAlertIncident[];
  incidentsLoading: boolean;
  incidentsFailed: boolean;
  /** The server withheld older incidents — say so rather than imply totality. */
  incidentsTruncated: boolean;
  onClose: () => void;
  onToggle: (rule: AuditAlertRule) => void;
  toggling: boolean;
  /** False for non-admins and offline sessions; `toggleNotice` says which. */
  canToggle: boolean;
  toggleNotice: string | null;
  /** Flip the managed-Slack fan-out. Gated by the same verdict as the toggle. */
  onToggleSlack: (rule: AuditAlertRule, next: boolean) => void;
  slackToggling: boolean;
  /** Retire the rule for good. Confirmed (typed) by the screen, not here. */
  onDelete: (rule: AuditAlertRule) => void;
  deleting: boolean;
  now: number;
}

export function AuditAlertDetailSheet(props: AuditAlertDetailSheetProps) {
  const { t } = useTheme();
  const rule = props.rule;
  return (
    <ReducedMotionModal
      visible={rule !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        {rule === null ? null : (
          <View style={{ flex: 1 }}>
            <SheetHeader title={rule.name} onClose={props.onClose} />
            <ScrollView
              contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
            >
              <RuleBody rule={rule} now={props.now} />
              <SectionLabel>Recent deliveries</SectionLabel>
              <AuditAlertFireList
                fires={props.fires}
                loading={props.firesLoading}
                failed={props.firesFailed}
                now={props.now}
              />
              <SectionLabel>Linked incidents</SectionLabel>
              <AuditAlertIncidentList
                incidents={props.incidents}
                loading={props.incidentsLoading}
                failed={props.incidentsFailed}
                truncated={props.incidentsTruncated}
                now={props.now}
              />
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                  marginTop: 14,
                }}
              >
                {AUDIT_ALERT_CONFIG_NOTICE}
              </Text>
            </ScrollView>
            <SheetFooter
              rule={rule}
              onToggle={props.onToggle}
              toggling={props.toggling}
              canToggle={props.canToggle}
              notice={props.toggleNotice}
              onToggleSlack={props.onToggleSlack}
              slackToggling={props.slackToggling}
              onDelete={props.onDelete}
              deleting={props.deleting}
            />
          </View>
        )}
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function RuleBody({ rule, now }: { rule: AuditAlertRule; now: number }) {
  const { t } = useTheme();
  const health = healthPresentation(ruleHealth(rule));
  const destination = channelDestination(rule);
  const narrowing = matchNarrowing(rule);
  // "Enabled and delivering" says nothing about whether the detection is
  // connected to reality; a rule nothing has ever matched is the case this
  // screen exists to make visible.
  const attention = ruleAttention(rule, now);
  return (
    <View style={{ gap: 12 }}>
      <View
        accessible
        accessibilityLabel={health.spoken}
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}
      >
        <Pill label={health.label} tone={health.tone} size="md" />
        <Pill label={channelLabel(rule.channelKind)} tone="neutral" size="md" />
        {rule.notifySlack ? (
          <Pill
            label="+ Slack"
            tone="info"
            size="md"
            accessibilityLabel="Also fanned out to the workspace Slack integration"
          />
        ) : null}
      </View>

      {attention ? (
        <Text
          accessibilityRole="alert"
          accessibilityLabel={attention.spoken}
          {...typeCap("bodySmall")}
          style={{
            color: attention.tone === "warning" ? t.warning : t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {attention.spoken}
        </Text>
      ) : null}

      <Field label="Watches for" value={operatorSummary(rule)} />
      {narrowing ? <Field label="Only when" value={narrowing} /> : null}
      <Field
        label="Delivers to"
        value={destination ?? `${channelLabel(rule.channelKind)} (configured on desktop)`}
      />
      {/* Absence is not zero: a payload with no usable count renders a dash. */}
      <Field
        label="Fired"
        value={
          rule.firedCount === null
            ? EMDASH
            : `${num(rule.firedCount)} ${rule.firedCount === 1 ? "time" : "times"}`
        }
        spoken={
          rule.firedCount === null
            ? "Fire count unavailable"
            : `Fired ${rule.firedCount} ${rule.firedCount === 1 ? "time" : "times"}`
        }
      />
      <Field
        label="Last fired"
        value={
          rule.lastFiredAt
            ? `${relativeTime(rule.lastFiredAt, { now })} · ${dateTime(rule.lastFiredAt)}`
            : "Never"
        }
      />
      <Field label="Created" value={rule.createdAt ? dateTime(rule.createdAt) : EMDASH} />
      {rule.lastError ? (
        <Field label="Last error" value={rule.lastError} tone="danger" />
      ) : null}
    </View>
  );
}

function Field({
  label,
  value,
  spoken,
  tone,
}: {
  label: string;
  value: string;
  spoken?: string | undefined;
  tone?: "danger" | undefined;
}) {
  const { t } = useTheme();
  return (
    <View accessible accessibilityLabel={`${label}: ${spoken ?? value}`}>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.semibold,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("body")}
        style={{
          color: tone === "danger" ? t.danger : t.fg,
          ...typeStyle("body"),
          fontFamily: FONT.regular,
          marginTop: 2,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function SheetHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomColor: t.borderSubtle,
        borderBottomWidth: 1,
        gap: 12,
      }}
    >
      <Text
        numberOfLines={maxLinesAtScale(1, fontScale)}
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontFamily: FONT.display,
          flexShrink: 1,
        }}
      >
        {title}
      </Text>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close alert rule"
        style={{
          paddingHorizontal: 8,
          paddingVertical: 6,
          minHeight: 44,
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{ color: t.accent, ...typeStyle("callout"), fontFamily: FONT.semibold }}
        >
          Done
        </Text>
      </Pressable>
    </View>
  );
}

function SheetFooter({
  rule,
  onToggle,
  toggling,
  canToggle,
  notice,
  onToggleSlack,
  slackToggling,
  onDelete,
  deleting,
}: {
  rule: AuditAlertRule;
  onToggle: (rule: AuditAlertRule) => void;
  toggling: boolean;
  canToggle: boolean;
  notice: string | null;
  onToggleSlack: (rule: AuditAlertRule, next: boolean) => void;
  slackToggling: boolean;
  onDelete: (rule: AuditAlertRule) => void;
  deleting: boolean;
}) {
  const { t } = useTheme();
  const label = rule.enabled ? "Pause rule" : "Resume rule";
  const busy = toggling || slackToggling || deleting;
  const disabled = !canToggle || busy;
  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: 12,
        gap: 8,
      }}
    >
      {notice ? (
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {notice}
        </Text>
      ) : null}
      {/* The second PATCH field this sheet controls (notify_slack). Withheld
          entirely — not disabled — from a reader the server would refuse,
          matching the house 403-reads-as-a-rule discipline; `notice` above
          already says why. */}
      {canToggle ? (
        <SettingsSwitchRow
          label="Also notify the workspace Slack"
          hint="Fans each fire out to the managed Slack integration on top of the rule's own channel."
          value={rule.notifySlack}
          onValueChange={(next) => onToggleSlack(rule, next)}
          disabled={busy}
        />
      ) : null}
      <Pressable
        onPress={() => onToggle(rule)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={toggling ? `${label}, working` : label}
        accessibilityState={{ disabled, busy: toggling }}
        style={{
          minHeight: 44,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 12,
          borderWidth: 1,
          borderColor: rule.enabled ? t.danger : t.accent,
          backgroundColor: t.surface,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: rule.enabled ? t.danger : t.accent,
            ...typeStyle("callout"),
            fontFamily: FONT.semibold,
          }}
        >
          {toggling ? "Working…" : label}
        </Text>
      </Pressable>
      {canToggle ? (
        <Pressable
          onPress={() => onDelete(rule)}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={deleting ? "Delete rule, working" : "Delete rule"}
          accessibilityHint="Removes this rule permanently. Its channel credentials cannot be read back from any client."
          accessibilityState={{ disabled: busy, busy: deleting }}
          style={{
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            opacity: busy ? 0.5 : 1,
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.danger,
              ...typeStyle("callout"),
              fontFamily: FONT.semibold,
            }}
          >
            {deleting ? "Deleting…" : "Delete rule"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
