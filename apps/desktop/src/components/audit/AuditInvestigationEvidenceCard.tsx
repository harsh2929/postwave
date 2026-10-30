/**
 * AuditInvestigationEvidenceCard — one cited audit_log row inside
 * an investigation finding.
 *
 * ai-investigation-agent (audit-2026 AI/Anomaly, P1). The hard rule
 * is that every finding cites at least one audit_log id; this card
 * is how the auditor drills from the hypothesis to the source row.
 */

import { type ReactElement, useEffect, useState } from "react";

import { type AuditRow, api } from "../../lib/api-client";

interface Props {
  auditId: number;
  /** When set, clicking the card calls back so the parent can deep-link
   *  to the existing audit slideover. When omitted, the card is read-only. */
  onOpen?: (row: AuditRow) => void;
}

export function AuditInvestigationEvidenceCard({
  auditId,
  onOpen,
}: Props): ReactElement {
  const [row, setRow] = useState<AuditRow | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // D13-governance-privacy#9: fetch via the dedicated batch endpoint
      // (GET /audit/events?ids=), mirroring AuditInvestigationTimeline.
      // The former listAudit cursor hack went through the List query,
      // which hides meta-audit rows by default (SQL: action NOT LIKE
      // 'audit.read.%'). Evidence rows that ARE meta reads — exactly the
      // audit.read.export/list rows exfiltration investigations cite —
      // therefore came back as the PREVIOUS row and the card falsely
      // reported 'audit row #N not found'. The batch endpoint has no
      // such exclusion.
      const res = await api.getAuditEventsByIds([auditId]);
      if (cancelled) return;
      if (res.error) {
        setErr(res.error.message ?? "Unable to load evidence row.");
        return;
      }
      const found = (res.data?.items ?? []).find(
        (r) => Number(r.id) === auditId,
      );
      if (found) setRow(found);
      else setErr(`audit row #${auditId} not found`);
    })();
    return () => {
      cancelled = true;
    };
  }, [auditId]);

  return (
    <div
      className="card"
      style={{
        padding: 12,
        marginBottom: 8,
        cursor: onOpen ? "pointer" : "default",
        borderLeft: "3px solid var(--pw-accent)",
      }}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={() => row && onOpen?.(row)}
      onKeyDown={(e) => {
        if (onOpen && row && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen(row);
        }
      }}
      data-testid="audit-investigation-evidence-card"
    >
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: 4 }}
      >
        <span className="mono" style={{ fontSize: 11, opacity: 0.7 }}>
          #{auditId}
        </span>
        {row?.at ? (
          <span className="muted" style={{ fontSize: 11 }}>
            {new Date(row.at).toLocaleString()}
          </span>
        ) : null}
      </div>
      {err ? (
        <div className="muted" style={{ fontSize: 12 }}>
          {err}
        </div>
      ) : row ? (
        <>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{row.action}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {row.actorLabel ?? "—"} · {row.actorType}
            {row.resourceId ? ` · resource ${row.resourceId}` : ""}
          </div>
          {row.ip ? (
            <div className="mono muted" style={{ fontSize: 11, marginTop: 2 }}>
              ip {row.ip}
            </div>
          ) : null}
        </>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          Loading audit row…
        </div>
      )}
    </div>
  );
}
