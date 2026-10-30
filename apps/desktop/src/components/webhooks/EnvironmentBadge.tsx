/**
 * EnvironmentBadge — small pill showing a webhook's environment
 * (production / staging / development). Refined Webhooks final batch.
 *
 * Two modes:
 *   • read-only (no onChange): renders a static badge
 *   • editable (onChange provided): renders a select that fires
 *     onChange immediately; parent persists via the API
 */

import { type ReactElement } from "react";

import { type WebhookEnvironment } from "../../lib/api-client";

const ENVS: WebhookEnvironment[] = ["production", "staging", "development"];

const TONE: Record<WebhookEnvironment, string> = {
  production: "var(--pw-accent)",
  staging: "var(--pw-warning)",
  development: "var(--pw-fg-subtle)",
};

interface Props {
  value: WebhookEnvironment;
  onChange?: (next: WebhookEnvironment) => void;
}

export function EnvironmentBadge({ value, onChange }: Props): ReactElement {
  if (!onChange) {
    return (
      <span
        className="wh-env-badge"
        style={{ color: TONE[value], borderColor: TONE[value] }}
        title={`Environment: ${value}`}
      >
        {value}
      </span>
    );
  }
  return (
    <select
      className="wh-env-badge wh-env-select"
      value={value}
      onChange={(e) => onChange(e.target.value as WebhookEnvironment)}
      style={{ color: TONE[value], borderColor: TONE[value] }}
      aria-label="Webhook environment"
    >
      {ENVS.map((e) => (
        <option key={e} value={e}>
          {e}
        </option>
      ))}
    </select>
  );
}
