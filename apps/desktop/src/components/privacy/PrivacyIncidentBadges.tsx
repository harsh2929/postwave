import type { ReactElement } from "react";

import type {
  PrivacyIncidentSeverity,
  PrivacyIncidentState,
} from "../../lib/api-client";

const SEVERITY_LABEL: Record<PrivacyIncidentSeverity, string> = {
  investigating: "Investigating",
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

const STATE_LABEL: Record<PrivacyIncidentState, string> = {
  open: "Open",
  contained: "Contained",
  notifications_pending: "Notifying",
  closed: "Closed",
};

function severityColor(severity: PrivacyIncidentSeverity): string {
  switch (severity) {
    case "critical":
    case "high":
      return "var(--pw-danger)";
    case "medium":
      return "var(--pw-warning)";
    default:
      return "var(--pw-fg-muted)";
  }
}

export function PrivacyIncidentSeverityIndicator({
  severity = "investigating",
}: {
  severity: PrivacyIncidentSeverity | undefined;
}): ReactElement {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: 999,
          background: severityColor(severity),
          flexShrink: 0,
        }}
      />
      <span>{SEVERITY_LABEL[severity]}</span>
    </span>
  );
}

export function PrivacyIncidentStatePill({
  state,
}: {
  state: PrivacyIncidentState | string;
}): ReactElement {
  const tone =
    state === "closed"
      ? "success"
      : state === "open" || state === "notifications_pending"
        ? "warning"
        : "";
  return (
    <span className={`badge${tone ? ` ${tone}` : ""}`}>
      {STATE_LABEL[state as PrivacyIncidentState] ?? state}
    </span>
  );
}
