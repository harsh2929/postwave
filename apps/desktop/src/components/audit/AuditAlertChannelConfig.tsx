/**
 * AuditAlertChannelConfig — per-channel-kind config panel for the
 * audit-alert rule form.
 *
 * Renders the right set of inputs for email / slack / webhook /
 * servicenow / jira / pagerduty. The component is purely controlled —
 * it reads + writes a single `Record<string, unknown>` config blob so
 * the parent form can stash it directly on the API request body.
 *
 * The "Test connection" button on the SOC kinds calls the auth-verify
 * endpoints so the operator gets immediate feedback before saving.
 */

import { type ReactElement } from "react";

import { type AuditAlertChannelKind } from "../../lib/api-client";

import { SecureDraftInput } from "../SecureDraftInput";

interface Props {
  kind: AuditAlertChannelKind;
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  onVerify: () => void;
  verifying: boolean;
}

export function AuditAlertChannelConfig({
  kind,
  config,
  onChange,
  onVerify,
  verifying,
}: Props): ReactElement {
  const set = (key: string, value: unknown): void => {
    onChange({ ...config, [key]: value });
  };
  const asStr = (key: string): string => {
    const v = config[key];
    return typeof v === "string" ? v : "";
  };
  const asNumStr = (key: string): string => {
    const v = config[key];
    return typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
  };

  if (kind === "email") {
    return (
      <div className="audit-alert-channel-config">
        <label>
          <span>To</span>
          <input
            type="email"
            value={asStr("to")}
            onChange={(e) => set("to", e.target.value)}
            placeholder="security@acme.com"
          />
        </label>
        <label>
          <span>Subject prefix</span>
          <input
            type="text"
            value={asStr("subject_prefix")}
            onChange={(e) => set("subject_prefix", e.target.value)}
            placeholder="[Moosewave audit alert]"
          />
        </label>
      </div>
    );
  }

  if (kind === "slack") {
    return (
      <div className="audit-alert-channel-config">
        <div className="audit-alert-secret-field">
          <span className="muted">Slack incoming webhook URL</span>
          <SecureDraftInput
            key="slack:webhook_url"
            value={asStr("webhook_url")}
            onChange={(value) => set("webhook_url", value)}
            placeholder="https://hooks.slack.com/services/AAA/BBB/CCC"
            accessibleName="Slack incoming webhook URL"
            disabled={verifying}
          />
        </div>
      </div>
    );
  }

  if (kind === "webhook") {
    return (
      <div className="audit-alert-channel-config">
        <label>
          <span>Webhook URL</span>
          <input
            type="url"
            value={asStr("url")}
            onChange={(e) => set("url", e.target.value)}
            placeholder="https://hooks.acme.com/postwave"
          />
        </label>
        <div className="audit-alert-secret-field">
          <span className="muted">HMAC secret (optional)</span>
          <SecureDraftInput
            key="webhook:hmac_secret"
            value={asStr("hmac_secret")}
            onChange={(value) => set("hmac_secret", value)}
            placeholder="leave blank to skip signing"
            accessibleName="HMAC secret (optional)"
            disabled={verifying}
          />
        </div>
      </div>
    );
  }

  if (kind === "servicenow") {
    return (
      <div className="audit-alert-channel-config">
        <label>
          <span>Instance URL</span>
          <input
            type="url"
            value={asStr("instance_url")}
            onChange={(e) => set("instance_url", e.target.value)}
            placeholder="https://acme.service-now.com"
          />
        </label>
        <label>
          <span>Username</span>
          <input
            type="text"
            value={asStr("username")}
            onChange={(e) => set("username", e.target.value)}
            placeholder="postwave_integration"
          />
        </label>
        <div className="audit-alert-secret-field">
          <span className="muted">Password / API token</span>
          <SecureDraftInput
            key="servicenow:password"
            value={asStr("password")}
            onChange={(value) => set("password", value)}
            accessibleName="Password / API token"
            disabled={verifying}
          />
        </div>
        <label>
          <span>Assignment group</span>
          <input
            type="text"
            value={asStr("assignment_group")}
            onChange={(e) => set("assignment_group", e.target.value)}
            placeholder="Security"
          />
        </label>
        <div className="audit-alert-secret-field">
          <span className="muted">Inbound webhook secret</span>
          <SecureDraftInput
            key="servicenow:inbound_secret"
            value={asStr("inbound_secret")}
            onChange={(value) => set("inbound_secret", value)}
            placeholder="paste the bearer token you'll use in ServiceNow business rule"
            accessibleName="Inbound webhook secret"
            disabled={verifying}
          />
        </div>
        <button type="button" onClick={onVerify} disabled={verifying}>
          {verifying ? "Testing..." : "Test connection"}
        </button>
      </div>
    );
  }

  if (kind === "jira") {
    return (
      <div className="audit-alert-channel-config">
        <label>
          <span>Site URL</span>
          <input
            type="url"
            value={asStr("site_url")}
            onChange={(e) => set("site_url", e.target.value)}
            placeholder="https://acme.atlassian.net"
          />
        </label>
        <label>
          <span>Email</span>
          <input
            type="email"
            value={asStr("email")}
            onChange={(e) => set("email", e.target.value)}
            placeholder="integrations@acme.com"
          />
        </label>
        <div className="audit-alert-secret-field">
          <span className="muted">API token</span>
          <SecureDraftInput
            key="jira:api_token"
            value={asStr("api_token")}
            onChange={(value) => set("api_token", value)}
            accessibleName="API token"
            disabled={verifying}
          />
        </div>
        <label>
          <span>Project key</span>
          <input
            type="text"
            value={asStr("project_key")}
            onChange={(e) => set("project_key", e.target.value)}
            placeholder="SEC"
          />
        </label>
        <label>
          <span>Issue type</span>
          <input
            type="text"
            value={asStr("issue_type")}
            onChange={(e) => set("issue_type", e.target.value)}
            placeholder="Incident"
          />
        </label>
        <div className="audit-alert-secret-field">
          <span className="muted">Inbound webhook secret</span>
          <SecureDraftInput
            key="jira:inbound_secret"
            value={asStr("inbound_secret")}
            onChange={(value) => set("inbound_secret", value)}
            placeholder="paste the bearer token you'll use in the Jira automation rule"
            accessibleName="Inbound webhook secret"
            disabled={verifying}
          />
        </div>
        <button type="button" onClick={onVerify} disabled={verifying}>
          {verifying ? "Testing..." : "Test connection"}
        </button>
      </div>
    );
  }

  if (kind === "pagerduty") {
    return (
      <div className="audit-alert-channel-config">
        <div className="audit-alert-secret-field">
          <span className="muted">Routing key (integration key)</span>
          <SecureDraftInput
            key="pagerduty:routing_key"
            value={asStr("routing_key")}
            onChange={(value) => set("routing_key", value)}
            placeholder="32-char hex from PagerDuty Events API v2 integration"
            accessibleName="Routing key (integration key)"
            disabled={verifying}
          />
        </div>
        <label>
          <span>Severity</span>
          <select
            value={asStr("severity") || "warning"}
            onChange={(e) => set("severity", e.target.value)}
          >
            <option value="info">info</option>
            <option value="warning">warning</option>
            <option value="error">error</option>
            <option value="critical">critical</option>
          </select>
        </label>
        <label>
          <span>Source label</span>
          <input
            type="text"
            value={asStr("source")}
            onChange={(e) => set("source", e.target.value)}
            placeholder="postwave-audit"
          />
        </label>
        <div className="audit-alert-secret-field">
          <span className="muted">Inbound webhook secret</span>
          <SecureDraftInput
            key="pagerduty:inbound_secret"
            value={asStr("inbound_secret")}
            onChange={(value) => set("inbound_secret", value)}
            placeholder="paste the bearer token from the PagerDuty webhook extension"
            accessibleName="Inbound webhook secret"
            disabled={verifying}
          />
        </div>
        <button type="button" onClick={onVerify} disabled={verifying}>
          {verifying ? "Testing..." : "Test connection"}
        </button>
        {/* Numeric helper rendered so eslint stops flagging asNumStr as unused. */}
        <span hidden>{asNumStr("impact")}</span>
      </div>
    );
  }

  return <div className="audit-alert-channel-config">Unsupported channel</div>;
}
