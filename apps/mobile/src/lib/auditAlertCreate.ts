/**
 * lib/auditAlertCreate.ts — the draft → wire-body layer for creating an audit
 * alert rule from the phone.
 *
 * Every rule here MIRRORS a server validator in
 * `apps/api/internal/audit_alerts/audit_alerts.go` (Create, at :104's mount):
 * `validateChannelConfig` (:586) and `validateOperatorConfig` (:640). The
 * point of the mirror is that a body the server would 400 is refused before it
 * leaves the phone, with the same sentence the server would have used — a
 * round trip to learn "window_min must be in (0, 1440]" is a wasted one.
 *
 * CHANNEL SECRETS ARE TYPED HERE AND SENT ONCE. The server redacts
 * `channel_config` on every read (redactChannelConfigForRead), so nothing this
 * module builds is ever displayed back; the create sheet marks the credential
 * fields `secure` and the draft lives only in component state.
 *
 * Import-free of react-native; asserted under node vitest.
 */
import {
  AUDIT_ALERT_CHANNELS,
  AUDIT_ALERT_OPERATORS,
} from "./auditAlertRules";

export type AuditAlertChannelKind = (typeof AUDIT_ALERT_CHANNELS)[number];
export type AuditAlertOperatorKind = (typeof AUDIT_ALERT_OPERATORS)[number];

export const AUDIT_ALERT_OUTLIER_KINDS = [
  "impossible_travel",
  "escalation_chain",
  "off_hours",
] as const;
export type AuditAlertOutlierKind = (typeof AUDIT_ALERT_OUTLIER_KINDS)[number];

/** One text field of a channel's config, described for the form. */
export interface AuditAlertChannelField {
  key: string;
  label: string;
  placeholder: string;
  /** A credential — render with secureTextEntry, never echo elsewhere. */
  secure: boolean;
  /** Required by the server validator. (servicenow's or-group is special.) */
  required: boolean;
}

/**
 * The fields `validateChannelConfig` actually checks, per kind. ServiceNow's
 * credential is an OR-group (bearer_token, or username+password) — all three
 * are listed non-required and `validateAuditAlertDraft` enforces the OR.
 */
export const AUDIT_ALERT_CHANNEL_FIELDS: Record<
  AuditAlertChannelKind,
  readonly AuditAlertChannelField[]
> = {
  email: [
    {
      key: "to",
      label: "Deliver to",
      placeholder: "soc@example.com",
      secure: false,
      required: true,
    },
  ],
  slack: [
    {
      key: "webhook_url",
      label: "Slack webhook URL",
      placeholder: "https://hooks.slack.com/services/…",
      secure: true,
      required: true,
    },
  ],
  webhook: [
    {
      key: "url",
      label: "Webhook URL",
      placeholder: "https://…",
      secure: true,
      required: true,
    },
  ],
  servicenow: [
    {
      key: "instance_url",
      label: "Instance URL",
      placeholder: "https://acme.service-now.com",
      secure: false,
      required: true,
    },
    {
      key: "bearer_token",
      label: "Bearer token (or username + password below)",
      placeholder: "token",
      secure: true,
      required: false,
    },
    {
      key: "username",
      label: "Username",
      placeholder: "integration user",
      secure: false,
      required: false,
    },
    {
      key: "password",
      label: "Password",
      placeholder: "password",
      secure: true,
      required: false,
    },
  ],
  jira: [
    {
      key: "site_url",
      label: "Site URL",
      placeholder: "https://acme.atlassian.net",
      secure: false,
      required: true,
    },
    {
      key: "project_key",
      label: "Project key",
      placeholder: "SEC",
      secure: false,
      required: true,
    },
    {
      key: "email",
      label: "Account email",
      placeholder: "bot@example.com",
      secure: false,
      required: true,
    },
    {
      key: "api_token",
      label: "API token",
      placeholder: "token",
      secure: true,
      required: true,
    },
  ],
  pagerduty: [
    {
      key: "routing_key",
      label: "Routing key",
      placeholder: "Events API v2 routing key",
      secure: true,
      required: true,
    },
  ],
};

export interface AuditAlertDraft {
  name: string;
  actionGlob: string;
  actorType: string;
  actorLabelGlob: string;
  resourceType: string;
  operatorKind: AuditAlertOperatorKind;
  /** threshold_window params, as typed. */
  thresholdCount: string;
  windowMin: string;
  groupByActorLabel: boolean;
  /** rate_deviation params, as typed. */
  deviationPct: string;
  baselineDays: string;
  outlierKind: AuditAlertOutlierKind;
  channelKind: AuditAlertChannelKind;
  /** Channel field values keyed by the wire key, as typed. */
  channel: Record<string, string>;
  notifySlack: boolean;
}

export function emptyAuditAlertDraft(): AuditAlertDraft {
  return {
    name: "",
    actionGlob: "",
    actorType: "",
    actorLabelGlob: "",
    resourceType: "",
    operatorKind: "glob",
    thresholdCount: "",
    windowMin: "",
    groupByActorLabel: false,
    deviationPct: "",
    baselineDays: "",
    outlierKind: "impossible_travel",
    channelKind: "email",
    channel: {},
    notifySlack: false,
  };
}

function field(draft: AuditAlertDraft, key: string): string {
  return (draft.channel[key] ?? "").trim();
}

function intOf(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

function floatOf(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function channelErrors(draft: AuditAlertDraft): string[] {
  switch (draft.channelKind) {
    case "email":
      return field(draft, "to") ? [] : ["Email delivery needs an address."];
    case "slack":
      return field(draft, "webhook_url").startsWith("https://hooks.slack.com/")
        ? []
        : ["The Slack webhook URL must start with https://hooks.slack.com/."];
    case "webhook":
      return field(draft, "url").startsWith("https://")
        ? []
        : ["The webhook URL must start with https://."];
    case "servicenow": {
      const errors: string[] = [];
      if (!field(draft, "instance_url").startsWith("https://")) {
        errors.push("The ServiceNow instance URL must start with https://.");
      }
      const hasBearer = field(draft, "bearer_token") !== "";
      const hasPair =
        field(draft, "username") !== "" && field(draft, "password") !== "";
      if (!hasBearer && !hasPair) {
        errors.push(
          "ServiceNow needs either a bearer token or a username and password.",
        );
      }
      return errors;
    }
    case "jira": {
      const errors: string[] = [];
      if (!field(draft, "site_url").startsWith("https://")) {
        errors.push("The Jira site URL must start with https://.");
      }
      if (!field(draft, "project_key")) errors.push("Jira needs a project key.");
      if (!field(draft, "email") || !field(draft, "api_token")) {
        errors.push("Jira needs an account email and an API token.");
      }
      return errors;
    }
    case "pagerduty":
      return field(draft, "routing_key")
        ? []
        : ["PagerDuty needs a routing key."];
  }
}

function operatorErrors(draft: AuditAlertDraft): string[] {
  switch (draft.operatorKind) {
    case "glob":
      return [];
    case "threshold_window": {
      const errors: string[] = [];
      const count = intOf(draft.thresholdCount);
      const windowMin = intOf(draft.windowMin);
      if (count === null || count <= 0) {
        errors.push("The threshold count must be a whole number above zero.");
      }
      if (windowMin === null || windowMin <= 0 || windowMin > 1440) {
        errors.push("The window must be 1–1440 minutes.");
      }
      return errors;
    }
    case "rate_deviation": {
      const errors: string[] = [];
      const dev = floatOf(draft.deviationPct);
      const days = intOf(draft.baselineDays);
      if (dev === null || dev <= 0) {
        errors.push("The deviation percentage must be above zero.");
      }
      if (days === null || days <= 0 || days > 90) {
        errors.push("The baseline must be 1–90 days.");
      }
      return errors;
    }
    case "outlier":
      return (AUDIT_ALERT_OUTLIER_KINDS as readonly string[]).includes(
        draft.outlierKind,
      )
        ? []
        : ["Pick which outlier detector to run."];
  }
}

/**
 * Every reason the server would refuse this draft, in the order the form shows
 * its sections. Empty means `buildAuditAlertCreateBody` will produce a body
 * the Go validators accept.
 */
export function validateAuditAlertDraft(draft: AuditAlertDraft): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push("Name the rule.");
  if (!draft.actionGlob.trim()) {
    errors.push("Say which actions to watch (e.g. subscribers.export*).");
  }
  errors.push(...operatorErrors(draft));
  errors.push(...channelErrors(draft));
  return errors;
}

export interface AuditAlertCreateBody {
  name: string;
  action_glob: string;
  actor_type?: string;
  actor_label_glob?: string;
  resource_type?: string;
  operator_kind: string;
  operator_config?: Record<string, unknown>;
  channel_kind: string;
  channel_config: Record<string, unknown>;
  notify_slack?: boolean;
}

function operatorConfigOf(
  draft: AuditAlertDraft,
): Record<string, unknown> | undefined {
  switch (draft.operatorKind) {
    case "glob":
      return undefined;
    case "threshold_window":
      return {
        count: intOf(draft.thresholdCount) ?? 0,
        window_min: intOf(draft.windowMin) ?? 0,
        ...(draft.groupByActorLabel ? { group_by: "actor_label" } : {}),
      };
    case "rate_deviation":
      return {
        deviation_pct: floatOf(draft.deviationPct) ?? 0,
        baseline_days: intOf(draft.baselineDays) ?? 0,
      };
    case "outlier":
      return { kind: draft.outlierKind };
  }
}

/**
 * The wire body, or null for a draft `validateAuditAlertDraft` refuses —
 * callers must never send around the validator.
 *
 * Only the fields the server's validator READS are sent for the chosen
 * channel: a stray value typed under a previously selected kind must not ride
 * along into a stored credential blob.
 */
export function buildAuditAlertCreateBody(
  draft: AuditAlertDraft,
): AuditAlertCreateBody | null {
  if (validateAuditAlertDraft(draft).length > 0) return null;
  const channelConfig: Record<string, unknown> = {};
  for (const spec of AUDIT_ALERT_CHANNEL_FIELDS[draft.channelKind]) {
    const value = field(draft, spec.key);
    if (value) channelConfig[spec.key] = value;
  }
  const operatorConfig = operatorConfigOf(draft);
  return {
    name: draft.name.trim(),
    action_glob: draft.actionGlob.trim(),
    ...(draft.actorType.trim() ? { actor_type: draft.actorType.trim() } : {}),
    ...(draft.actorLabelGlob.trim()
      ? { actor_label_glob: draft.actorLabelGlob.trim() }
      : {}),
    ...(draft.resourceType.trim()
      ? { resource_type: draft.resourceType.trim() }
      : {}),
    operator_kind: draft.operatorKind,
    ...(operatorConfig ? { operator_config: operatorConfig } : {}),
    channel_kind: draft.channelKind,
    channel_config: channelConfig,
    ...(draft.notifySlack ? { notify_slack: true } : {}),
  };
}
