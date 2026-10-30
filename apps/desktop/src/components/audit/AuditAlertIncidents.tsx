/**
 * AuditAlertIncidents — table of external SOC incidents linked to a
 * rule. One row per (rule, external_system, external_incident_id);
 * status badge reflects whatever the SOC system last told us via
 * inbound webhook.
 *
 * The status is intentionally "soft" — the inbound webhook handler
 * accepts any string, and we just colour-band the known ones.
 */

import { type ReactElement, useEffect, useState } from "react";

import { type AuditAlertIncident, api } from "../../lib/api-client";
import { ExternalLink } from "../ExternalLink";

interface Props {
  ruleId: string;
}

export function AuditAlertIncidents({ ruleId }: Props): ReactElement {
  const [incidents, setIncidents] = useState<AuditAlertIncident[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void api.auditAlertIncidents(ruleId).then((res) => {
      if (!alive) return;
      if (!res.error && res.data) {
        setIncidents(res.data.incidents);
        setError("");
      } else {
        setError(res.error?.message ?? "failed to load");
      }
      setLoading(false);
    });
    return (): void => {
      alive = false;
    };
  }, [ruleId]);

  if (loading) {
    return <div className="audit-alert-incidents-empty">Loading...</div>;
  }
  if (error) {
    return (
      <div className="audit-alert-incidents-empty audit-alert-incidents-error">
        {error}
      </div>
    );
  }
  if (incidents.length === 0) {
    return (
      <div className="audit-alert-incidents-empty">
        No linked incidents yet — fire this rule once to create one.
      </div>
    );
  }
  return (
    <table className="audit-alert-incidents-table">
      <thead>
        <tr>
          <th>System</th>
          <th>Incident</th>
          <th>Status</th>
          <th>Last synced</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {incidents.map((inc) => (
          <tr key={inc.id}>
            <td>{inc.external_system}</td>
            <td>
              {inc.incident_url ? (
                <ExternalLink href={inc.incident_url}>
                  {inc.external_incident_id}
                </ExternalLink>
              ) : (
                inc.external_incident_id
              )}
            </td>
            <td>
              <StatusBadge status={inc.incident_status ?? ""} />
            </td>
            <td>{inc.last_synced_at ?? "—"}</td>
            <td>{inc.created_at}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusBadge({ status }: { status: string }): ReactElement {
  const norm = status.toLowerCase();
  let className = "audit-alert-status";
  if (norm === "open") className += " audit-alert-status-open";
  else if (norm === "in_progress") className += " audit-alert-status-progress";
  else if (norm === "resolved") className += " audit-alert-status-resolved";
  else if (norm === "closed") className += " audit-alert-status-closed";
  return <span className={className}>{status || "—"}</span>;
}
