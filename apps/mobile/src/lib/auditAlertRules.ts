/**
 * lib/auditAlertRules.ts — the WIRE + DESCRIBE layer for the audit-alert rules
 * surface: what the server sends, and how to say it in words. Expressed with no
 * react-native / expo import so it runs in the node vitest environment (the
 * pattern documented in lib/reviewQueue.ts).
 *
 * Its sibling `lib/auditAlertPolicy.ts` owns the DECISIONS over these rules —
 * roster order, who may pause one, confirm-sheet copy, failure copy. The two
 * were one file until it crossed the 450-line source budget; the seam is where
 * it is because adding a channel kind should touch this file only, and changing
 * who may pause a rule should touch only the other.
 *
 * WHAT AN AUDIT ALERT RULE IS. `apps/api/internal/audit_alerts` watches the
 * append-only audit log and fires when a rule matches: "tell me when someone
 * exports subscribers", "tell me when five failed logins land in five minutes".
 * A fire is delivered to ONE channel (email / Slack webhook / generic webhook /
 * ServiceNow / Jira / PagerDuty) and optionally fanned out to the workspace's
 * managed Slack integration as well (`notify_slack`).
 *
 * FIVE SERVER FACTS SHAPE THIS MODULE. Each was read off the Go source, not
 * off openapi.json:
 *
 *  1. THE LIST ENVELOPE IS `{"rules": [...]}` — `Deps.List` ends in
 *     `writeJSON(w, 200, map[string]any{"rules": out})` (audit_alerts.go:260).
 *     The fires envelope is `{"fires": [...]}` (audit_alerts.go:490). Both
 *     parsers also accept a bare array, because an envelope change that
 *     silently empties a governance screen is this repo's most-repeated mobile
 *     failure mode.
 *  2. THE TOGGLE IS `PATCH`, NOT `PUT`. `MountRoutes` registers
 *     `r.With(cfgGate).Patch("/api/v1/audit-alerts/{id}", d.Patch)` — there is
 *     no PUT handler at all, and the body is
 *     `{enabled?, name?, channel_config?, notify_slack?}`.
 *  3. `channel_config` CARRIES CREDENTIALS. A Slack `webhook_url` IS the
 *     credential; so are `bearer_token`, `api_token`, `password` and
 *     PagerDuty's `routing_key` (validateChannelConfig, audit_alerts.go:498).
 *     `channelDestination` therefore returns a host/address only, and never the
 *     raw config value — see the exhaustive test.
 *  4. A RULE CAN BE ENABLED AND STILL BROKEN. `last_error` is a separate column
 *     from `enabled`; an enabled rule whose last delivery failed is the single
 *     most important row on this screen, which is why `ruleHealth` has three
 *     states rather than a boolean.
 *  5. `operator_kind` CHANGES WHAT "MATCH" MEANS. A `glob` rule fires per
 *     matching row; `threshold_window` needs N inside a window; `rate_deviation`
 *     compares against a baseline; `outlier` runs a named detector. A screen
 *     that shows only `action_glob` describes a `threshold_window` rule
 *     incorrectly, so `operatorSummary` renders the operator's own terms.
 *
 * ABSENCE IS NOT ZERO. `firedCount` is `number | null`; a payload without a
 * usable `fired_count` yields null so the screen can render an em-dash instead
 * of claiming a rule has never fired.
 */

/** Channel kinds `validateChannelConfig` accepts (audit_alerts.go:150). */
export const AUDIT_ALERT_CHANNELS = [
  "email",
  "slack",
  "webhook",
  "servicenow",
  "jira",
  "pagerduty",
] as const;

/** Operator kinds `validateOperatorConfig` accepts (audit_alerts.go:161). */
export const AUDIT_ALERT_OPERATORS = [
  "glob",
  "threshold_window",
  "rate_deviation",
  "outlier",
] as const;

export interface AuditAlertRule {
  id: string;
  name: string;
  enabled: boolean;
  actionGlob: string;
  actorType: string;
  actorLabelGlob: string;
  resourceType: string;
  operatorKind: string;
  operatorConfig: Record<string, unknown>;
  channelKind: string;
  channelConfig: Record<string, unknown>;
  /** Fan-out to the managed Slack integration, on top of `channelKind`. */
  notifySlack: boolean;
  /** null = the payload carried no usable count, which is NOT zero. */
  firedCount: number | null;
  lastFiredAt: string | null;
  lastError: string;
  createdAt: string | null;
}

export interface AuditAlertFire {
  id: number;
  auditId: number | null;
  delivered: boolean;
  deliveryError: string;
  firedAt: string | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** ISO timestamp or null. Go's zero time serialises as "0001-01-01T…". */
export function auditAlertTimestamp(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  if (raw.startsWith("0001-01-01")) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

/** A count that is genuinely absent stays absent. Negatives are nonsense. */
export function auditAlertCount(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

export function parseAuditAlertRule(value: unknown): AuditAlertRule | null {
  const row = record(value);
  const id = str(row["id"]);
  if (!id) return null;
  return {
    id,
    // The server requires a name at create time, but a row written by an
    // earlier build can still be blank — never render an empty title.
    name: str(row["name"]) || "Untitled rule",
    enabled: row["enabled"] === true,
    actionGlob: str(row["action_glob"]),
    actorType: str(row["actor_type"]),
    actorLabelGlob: str(row["actor_label_glob"]),
    resourceType: str(row["resource_type"]),
    operatorKind: str(row["operator_kind"]) || "glob",
    operatorConfig: record(row["operator_config"]),
    channelKind: str(row["channel_kind"]),
    channelConfig: record(row["channel_config"]),
    notifySlack: row["notify_slack"] === true,
    firedCount: auditAlertCount(row["fired_count"]),
    lastFiredAt: auditAlertTimestamp(row["last_fired_at"]),
    lastError: str(row["last_error"]),
    createdAt: auditAlertTimestamp(row["created_at"]),
  };
}

export function parseAuditAlertRuleList(payload: unknown): AuditAlertRule[] {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(record(payload)["rules"])
      ? (record(payload)["rules"] as unknown[])
      : [];
  return source
    .map(parseAuditAlertRule)
    .filter((rule): rule is AuditAlertRule => rule !== null);
}

export function parseAuditAlertFire(value: unknown): AuditAlertFire | null {
  const row = record(value);
  const id = auditAlertCount(row["id"]);
  if (id === null) return null;
  return {
    id,
    auditId: auditAlertCount(row["audit_id"]),
    delivered: row["delivered"] === true,
    deliveryError: str(row["delivery_error"]),
    firedAt: auditAlertTimestamp(row["fired_at"]),
  };
}

export function parseAuditAlertFireList(payload: unknown): AuditAlertFire[] {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(record(payload)["fires"])
      ? (record(payload)["fires"] as unknown[])
      : [];
  return source
    .map(parseAuditAlertFire)
    .filter((fire): fire is AuditAlertFire => fire !== null);
}

/**
 * Three states, not a boolean. "Enabled" and "enabled but its last delivery
 * failed" are the same colour of green to a boolean and completely different
 * facts to whoever is on call.
 */
export type AuditAlertHealth = "failing" | "active" | "paused";

export function ruleHealth(rule: AuditAlertRule): AuditAlertHealth {
  if (!rule.enabled) return "paused";
  return rule.lastError ? "failing" : "active";
}

export interface AuditAlertHealthPresentation {
  /** The visible pill text. State is never colour-alone — this is the word. */
  label: string;
  tone: "success" | "warning" | "danger" | "neutral";
  /** The full sentence a screen reader gets in place of the compacted pill. */
  spoken: string;
}

export function healthPresentation(
  health: AuditAlertHealth,
): AuditAlertHealthPresentation {
  switch (health) {
    case "failing":
      return {
        label: "Delivery failing",
        tone: "danger",
        spoken:
          "Enabled, but the last delivery attempt failed. Alerts may not be reaching anyone.",
      };
    case "active":
      return { label: "Enabled", tone: "success", spoken: "Enabled." };
    default:
      return {
        label: "Paused",
        tone: "neutral",
        spoken: "Paused. This rule is not watching the audit log.",
      };
  }
}

const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  email: "Email",
  slack: "Slack webhook",
  webhook: "Webhook",
  servicenow: "ServiceNow",
  jira: "Jira",
  pagerduty: "PagerDuty",
};

/** An unknown kind is shown verbatim rather than as a reassuring default. */
export function channelLabel(kind: string): string {
  const key = kind.trim().toLowerCase();
  return CHANNEL_LABELS[key] ?? (kind.trim() || "No channel");
}

/** Host of an https URL, or null. Deliberately regex, not `new URL`. */
export function httpsHost(value: unknown): string | null {
  const raw = str(value);
  const match = /^https:\/\/([^/?#\s]+)/iu.exec(raw);
  return match?.[1] ? match[1] : null;
}

/**
 * A SAFE destination summary.
 *
 * `channel_config` is where the credential lives — a Slack incoming-webhook URL
 * and a PagerDuty routing key are both bearer secrets in a URL/field, and
 * ServiceNow/Jira carry `bearer_token` / `api_token` / `password`. Rendering the
 * config on a phone screen would put a credential on a lock screen, in a
 * screenshot and in a screen-recording. So: the email address (which is the
 * destination, not the secret), the host for the URL-shaped integrations, and
 * NOTHING for the two whose config is purely a secret.
 *
 * Returns null when there is nothing safe to say, so the caller can render an
 * em-dash rather than an empty string.
 */
export function channelDestination(rule: AuditAlertRule): string | null {
  const config = rule.channelConfig;
  switch (rule.channelKind.trim().toLowerCase()) {
    case "email":
      return str(config["to"]) || null;
    case "webhook":
      return httpsHost(config["url"]);
    case "servicenow":
      return httpsHost(config["instance_url"]);
    case "jira": {
      const host = httpsHost(config["site_url"]);
      const project = str(config["project_key"]);
      if (host && project) return `${host} · ${project}`;
      return host ?? (project || null);
    }
    // A Slack incoming-webhook URL and a PagerDuty routing key are the
    // credential itself. There is no non-secret half to show.
    default:
      return null;
  }
}

function asPositiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function asPositiveNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

const OUTLIER_LABELS: Readonly<Record<string, string>> = {
  impossible_travel: "Impossible travel between sessions",
  escalation_chain: "Privilege-escalation chain",
  off_hours: "Out-of-hours activity",
};

/**
 * What this rule actually watches for, in the operator's own terms.
 *
 * A misconfigured rule is reported as misconfigured rather than rendered with
 * zeroes: `evaluateOperator` returns `Fire:false` for an invalid
 * threshold_window (operators.go:50) and for an unknown operator_kind entirely,
 * so "0 matches in 0 minutes" would describe a rule that can never fire as if
 * it were merely quiet.
 */
export function operatorSummary(rule: AuditAlertRule): string {
  const glob = rule.actionGlob || "any action";
  const config = rule.operatorConfig;
  switch (rule.operatorKind.trim().toLowerCase()) {
    case "":
    case "glob":
      return `Every audit event matching ${glob}`;
    case "threshold_window": {
      const count = asPositiveInt(config["count"]);
      const windowMin = asPositiveInt(config["window_min"]);
      if (count === null || windowMin === null) {
        return "Threshold rule with an invalid window — it can never fire.";
      }
      const per =
        str(config["group_by"]) === "actor_label" ? " by the same actor" : "";
      const events = count === 1 ? "event" : "events";
      const minutes = windowMin === 1 ? "minute" : "minutes";
      return `${count} ${events} matching ${glob}${per} within ${windowMin} ${minutes}`;
    }
    case "rate_deviation": {
      const deviation = asPositiveNumber(config["deviation_pct"]);
      const baselineDays = asPositiveInt(config["baseline_days"]);
      if (deviation === null || baselineDays === null) {
        return "Rate rule with an invalid baseline — it can never fire.";
      }
      const days = baselineDays === 1 ? "day" : "days";
      return `${glob} running ${deviation}% above its ${baselineDays}-${days} baseline`;
    }
    case "outlier": {
      const kind = str(config["kind"]);
      const label = OUTLIER_LABELS[kind];
      if (!label) {
        return "Outlier rule with an unrecognised detector — it can never fire.";
      }
      return `${label}, on events matching ${glob}`;
    }
    default:
      // The worker drops unknown operators rather than guessing
      // (operators.go:33), so this rule is inert. Say so.
      return `Unrecognised rule type "${rule.operatorKind}" — this server build will not fire it.`;
  }
}

/** The extra AND-ed narrowing criteria, or null when the rule is unnarrowed. */
export function matchNarrowing(rule: AuditAlertRule): string | null {
  const parts: string[] = [];
  if (rule.actorType) parts.push(`actor type ${rule.actorType}`);
  if (rule.actorLabelGlob) parts.push(`actor ${rule.actorLabelGlob}`);
  if (rule.resourceType) parts.push(`resource ${rule.resourceType}`);
  return parts.length ? parts.join(" · ") : null;
}
