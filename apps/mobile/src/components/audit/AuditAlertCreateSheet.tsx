/**
 * AuditAlertCreateSheet — stand up a new watch condition from the phone.
 *
 * This ships the CREATE half the roster screen used to hold on desktop, and
 * the recorded objection it answers was about credentials, so the terms are
 * stated here:
 *
 *  - EVERY VALIDATOR IS MIRRORED CLIENT-SIDE (lib/auditAlertCreate, tested
 *    against the Go source), so a body the server would 400 never leaves the
 *    phone and the refusal reads as the exact rule, not a round-trip error.
 *  - CREDENTIAL FIELDS ARE `secureTextEntry` AND WRITE-ONLY. The server
 *    redacts `channel_config` on every read, so nothing typed here is ever
 *    rendered back — by this app or any other client.
 *  - ONLY THE CHOSEN CHANNEL'S FIELDS ARE SENT. A value typed under a
 *    previously selected kind is dropped by the body builder, never stored.
 *
 * The sheet owns the draft; the SCREEN owns the mutation, so the submit
 * plumbing (toast, invalidation, close-on-success) reads in one place there.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { ChipRow } from "@/components/ChipRow";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import {
  SettingsSwitchRow,
  SettingsTextInput,
} from "@/components/settings/FormControls";
import {
  AUDIT_ALERT_CHANNEL_FIELDS,
  AUDIT_ALERT_OUTLIER_KINDS,
  buildAuditAlertCreateBody,
  emptyAuditAlertDraft,
  validateAuditAlertDraft,
  type AuditAlertCreateBody,
  type AuditAlertChannelKind,
  type AuditAlertDraft,
  type AuditAlertOperatorKind,
  type AuditAlertOutlierKind,
} from "@/lib/auditAlertCreate";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { AuditAction } from "./AuditAction";
import { SheetHeader } from "./AuditSheetParts";

const OPERATOR_OPTIONS: readonly {
  value: AuditAlertOperatorKind;
  label: string;
  accessibilityLabel: string;
}[] = [
  {
    value: "glob",
    label: "Every match",
    accessibilityLabel: "Fire on every matching event",
  },
  {
    value: "threshold_window",
    label: "N in a window",
    accessibilityLabel: "Fire when N events match inside a time window",
  },
  {
    value: "rate_deviation",
    label: "Rate deviation",
    accessibilityLabel: "Fire when the match rate deviates from its baseline",
  },
  {
    value: "outlier",
    label: "Outlier",
    accessibilityLabel: "Fire on a named outlier detector",
  },
];

const CHANNEL_OPTIONS: readonly {
  value: AuditAlertChannelKind;
  label: string;
}[] = [
  { value: "email", label: "Email" },
  { value: "slack", label: "Slack webhook" },
  { value: "webhook", label: "Webhook" },
  { value: "servicenow", label: "ServiceNow" },
  { value: "jira", label: "Jira" },
  { value: "pagerduty", label: "PagerDuty" },
];

const OUTLIER_OPTIONS: readonly {
  value: AuditAlertOutlierKind;
  label: string;
}[] = [
  { value: "impossible_travel", label: "Impossible travel" },
  { value: "escalation_chain", label: "Escalation chain" },
  { value: "off_hours", label: "Off hours" },
];

export interface AuditAlertCreateSheetProps {
  visible: boolean;
  onClose: () => void;
  creating: boolean;
  /** Server-side refusal from the last submit, or null. */
  serverError: string | null;
  onSubmit: (body: AuditAlertCreateBody) => void;
}

export function AuditAlertCreateSheet(props: AuditAlertCreateSheetProps) {
  const { t } = useTheme();
  const [draft, setDraft] = useState<AuditAlertDraft>(emptyAuditAlertDraft);
  // Validation copy appears after a refused submit, not while typing — a form
  // that scolds on the first keystroke teaches people to ignore red text.
  const [errors, setErrors] = useState<string[]>([]);

  const patch = (next: Partial<AuditAlertDraft>) => {
    setErrors([]);
    setDraft((cur) => ({ ...cur, ...next }));
  };
  const patchChannel = (key: string, value: string) => {
    setErrors([]);
    setDraft((cur) => ({ ...cur, channel: { ...cur.channel, [key]: value } }));
  };

  const submit = () => {
    const found = validateAuditAlertDraft(draft);
    if (found.length > 0) {
      setErrors(found);
      return;
    }
    const body = buildAuditAlertCreateBody(draft);
    if (body) props.onSubmit(body);
  };

  return (
    <KeyboardFormSheet
      visible={props.visible}
      onClose={props.onClose}
      accessibilityLabel="New audit alert rule"
      contentContainerStyle={{ padding: 0, paddingBottom: 32 }}
    >
      <SheetHeader title="New alert rule" onClose={props.onClose} />
      <View style={{ padding: 20, gap: 16 }}>
        <SettingsTextInput
          label="Name"
          placeholder="Subscriber exports"
          value={draft.name}
          onChangeText={(name) => patch({ name })}
          autoCapitalize="sentences"
        />
        <SettingsTextInput
          label="Watch actions matching"
          hint="A glob over audit action keys — subscribers.export* fires on every export."
          placeholder="subscribers.export*"
          value={draft.actionGlob}
          onChangeText={(actionGlob) => patch({ actionGlob })}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <SectionTitle text="When to fire" />
        <ChipRow
          options={OPERATOR_OPTIONS}
          value={draft.operatorKind}
          onChange={(operatorKind) => patch({ operatorKind })}
          accessibilityLabel="When the rule fires"
          paddingHorizontal={0}
        />
        <OperatorParams draft={draft} patch={patch} />

        <SectionTitle text="Deliver to" />
        <ChipRow
          options={CHANNEL_OPTIONS}
          value={draft.channelKind}
          onChange={(channelKind) => patch({ channelKind })}
          accessibilityLabel="Delivery channel"
          paddingHorizontal={0}
        />
        {AUDIT_ALERT_CHANNEL_FIELDS[draft.channelKind].map((spec) => (
          <SettingsTextInput
            key={`${draft.channelKind}-${spec.key}`}
            label={spec.label}
            placeholder={spec.placeholder}
            value={draft.channel[spec.key] ?? ""}
            onChangeText={(value) => patchChannel(spec.key, value)}
            autoCapitalize="none"
            autoCorrect={false}
            // A credential is typed once and sent once: the server redacts
            // channel_config on every read, so it can never be shown back.
            secureTextEntry={spec.secure}
            {...(spec.secure ? { textContentType: "password" as const } : {})}
          />
        ))}
        <SettingsSwitchRow
          label="Also notify the workspace Slack"
          hint="Fans each fire out to the managed Slack integration on top of the channel above."
          value={draft.notifySlack}
          onValueChange={(notifySlack) => patch({ notifySlack })}
        />

        <SectionTitle text="Narrow the match (optional)" />
        <SettingsTextInput
          label="Actor type"
          hint="Exact wire value, e.g. user or api_key. Leave blank for any actor."
          placeholder="any"
          value={draft.actorType}
          onChangeText={(actorType) => patch({ actorType })}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <SettingsTextInput
          label="Actor label glob"
          placeholder="*@example.com"
          value={draft.actorLabelGlob}
          onChangeText={(actorLabelGlob) => patch({ actorLabelGlob })}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <SettingsTextInput
          label="Resource type"
          placeholder="subscriber"
          value={draft.resourceType}
          onChangeText={(resourceType) => patch({ resourceType })}
          autoCapitalize="none"
          autoCorrect={false}
        />

        {errors.map((error) => (
          <Text
            key={error}
            accessibilityRole="alert"
            {...typeCap("bodySmall")}
            style={{
              color: t.danger,
              fontFamily: FONT.regular,
              ...typeStyle("bodySmall"),
            }}
          >
            {error}
          </Text>
        ))}
        {props.serverError ? (
          <Text
            accessibilityRole="alert"
            {...typeCap("bodySmall")}
            style={{
              color: t.danger,
              fontFamily: FONT.regular,
              ...typeStyle("bodySmall"),
            }}
          >
            {props.serverError}
          </Text>
        ) : null}

        <View style={{ flexDirection: "row" }}>
          <AuditAction
            label={props.creating ? "Creating…" : "Create rule"}
            hint="Creates the rule. It starts watching new audit events immediately — never retroactively."
            emphasis
            disabled={props.creating}
            onPress={submit}
          />
        </View>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            ...typeStyle("caption"),
          }}
        >
          The rule starts from the newest audit event — it never fires
          retroactively. Credentials typed here are sent once and can never be
          read back from any client.
        </Text>
      </View>
    </KeyboardFormSheet>
  );
}

function OperatorParams({
  draft,
  patch,
}: {
  draft: AuditAlertDraft;
  patch: (next: Partial<AuditAlertDraft>) => void;
}) {
  if (draft.operatorKind === "threshold_window") {
    return (
      <View style={{ gap: 12 }}>
        <SettingsTextInput
          label="Fire after this many matches"
          placeholder="5"
          value={draft.thresholdCount}
          onChangeText={(thresholdCount) => patch({ thresholdCount })}
          keyboardType="number-pad"
        />
        <SettingsTextInput
          label="Within (minutes, up to 1440)"
          placeholder="10"
          value={draft.windowMin}
          onChangeText={(windowMin) => patch({ windowMin })}
          keyboardType="number-pad"
        />
        <SettingsSwitchRow
          label="Count per actor"
          hint="Each actor label gets its own window, so one noisy account cannot hide another."
          value={draft.groupByActorLabel}
          onValueChange={(groupByActorLabel) => patch({ groupByActorLabel })}
        />
      </View>
    );
  }
  if (draft.operatorKind === "rate_deviation") {
    return (
      <View style={{ gap: 12 }}>
        <SettingsTextInput
          label="Deviation from baseline (%)"
          placeholder="50"
          value={draft.deviationPct}
          onChangeText={(deviationPct) => patch({ deviationPct })}
          keyboardType="decimal-pad"
        />
        <SettingsTextInput
          label="Baseline (days, up to 90)"
          placeholder="14"
          value={draft.baselineDays}
          onChangeText={(baselineDays) => patch({ baselineDays })}
          keyboardType="number-pad"
        />
      </View>
    );
  }
  if (draft.operatorKind === "outlier") {
    return (
      <ChipRow
        options={OUTLIER_OPTIONS}
        value={draft.outlierKind}
        onChange={(outlierKind) => patch({ outlierKind })}
        accessibilityLabel="Which outlier detector to run"
        paddingHorizontal={0}
      />
    );
  }
  return null;
}

function SectionTitle({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("callout")}
      accessibilityRole="header"
      style={{
        color: t.fg,
        fontWeight: "700",
        fontFamily: FONT.bold,
        ...typeStyle("callout"),
        marginTop: 4,
      }}
    >
      {text}
    </Text>
  );
}
