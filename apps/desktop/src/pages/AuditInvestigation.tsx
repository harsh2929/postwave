/**
 * AuditInvestigation — UI for the ai-investigation-agent feature
 * (audit-2026 AI/Anomaly, P1).
 *
 * Layout:
 *   - Page header: confidence meter + MITRE tag row + lifecycle badge.
 *   - Left column: AuditInvestigationTimeline rendering every cited
 *     audit_log row in chronological order.
 *   - Right column: numbered hypothesis cards, each with its evidence
 *     cards (AuditInvestigationEvidenceCard) and detector reasons.
 *   - Bottom: proposed-action list with whole-plan Approve / Reject
 *     controls. Approval records review; Reject collects a reason.
 *
 * SSE: subscribes to /investigations/{id}/stream to flip the status
 * badge live without polling.
 *
 * Routing: this page is mounted via Section "auditInvestigation" and
 * reads ?id=… off the URL so investigators can share a deep-link to
 * a specific investigation.
 */

import { type ReactElement, useCallback, useEffect, useState } from "react";

import { Modal, ModalFooter } from "../components/Modal";
import { ConfirmModal } from "../components/ConfirmModal";
import { ExternalLink } from "../components/ExternalLink";
import { SectionHeader } from "../components/SectionHeader";
import { toast } from "../components/Toast";
import { AuditInvestigationEvidenceCard } from "../components/audit/AuditInvestigationEvidenceCard";
import { AuditInvestigationTimeline } from "../components/audit/AuditInvestigationTimeline";
import { useDraftLifecycleController } from "../hooks/useDraftLifecycleController";
import { lifecycleOperationError } from "../hooks/useSettingsDraftLifecycle";
import {
  type AuditInvestigation as AuditInvestigationType,
  api,
} from "../lib/api-client";
import { navigateDesktopRoute, useDesktopRoute } from "../lib/desktop-router";
import { setSection } from "../lib/store";
import "../styles-audit.css";

function bucketForConfidence(c: number): "low" | "med" | "high" {
  if (c >= 0.75) return "high";
  if (c >= 0.5) return "med";
  return "low";
}

function bucketColor(b: "low" | "med" | "high"): string {
  switch (b) {
    case "high":
      return "var(--pw-danger)";
    case "med":
      return "var(--pw-warning)";
    case "low":
      return "var(--pw-success)";
  }
}

interface InvestigationStreamEvent {
  type: string;
  status?: string;
  message?: string;
  ts: string;
}

export function AuditInvestigation(): ReactElement {
  const desktopRoute = useDesktopRoute();
  const [id, setId] = useState<string | null>(() => {
    return desktopRoute.section === "auditInvestigation"
      ? (desktopRoute.resourceId ?? null)
      : null;
  });
  const [inv, setInv] = useState<AuditInvestigationType | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  // D13-governance-privacy#7: a failed detail fetch used to leave inv=null
  // with loading=false, so the render gate showed an eternal spinner. Track
  // the error so we can render a retryable error card instead.
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [streamEvents, setStreamEvents] = useState<InvestigationStreamEvent[]>(
    [],
  );
  const [rejectOpen, setRejectOpen] = useState<boolean>(false);
  const [rejectReason, setRejectReason] = useState<string>("");

  useEffect(() => {
    if (desktopRoute.section !== "auditInvestigation") return;
    setId(desktopRoute.resourceId ?? null);
  }, [desktopRoute.resourceId, desktopRoute.section]);

  const reload = useCallback(async (): Promise<void> => {
    if (!id) return;
    setLoading(true);
    setLoadErr(null);
    const res = await api.getAuditInvestigation(id);
    if (res.error) {
      const msg = res.error.message ?? "Failed to load investigation.";
      toast.error(msg);
      setLoadErr(msg);
    } else if (res.data) {
      setInv(res.data);
      setLoadErr(null);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // SSE subscription: live status updates while the investigation
  // is in flight or after its review status changes.
  //
  // The URL is built via auditInvestigationStreamUrlAuthed so it is
  // absolute (against the configured API host, not tauri://localhost)
  // and carries a short-lived stream_token — a bare relative URL +
  // cookies never connects in the packaged app.
  useEffect(() => {
    if (!id) return;
    let es: EventSource | null = null;
    let cancelled = false;
    const handle = (ev: MessageEvent): void => {
      try {
        const parsed = JSON.parse(ev.data) as InvestigationStreamEvent;
        setStreamEvents((prev) => [...prev.slice(-19), parsed]);
        if (parsed.status) {
          // Refresh on status transitions so the badge + actions
          // reflect the current persisted state.
          void reload();
        }
      } catch {
        // ignore malformed event
      }
    };
    void (async () => {
      const url = await api.auditInvestigationStreamUrlAuthed(id);
      if (cancelled) return;
      es = new EventSource(url, { withCredentials: true });
      es.addEventListener("status", handle as EventListener);
      es.addEventListener("complete", handle as EventListener);
      es.addEventListener("finding", handle as EventListener);
    })();
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [id, reload]);

  const onApprove = async (): Promise<void> => {
    if (!id) return;
    const targetId = id;
    const request = decisionLifecycle.runOperation(async () => {
      try {
        const res = await api.approveAuditInvestigation(targetId);
        if (res.error) {
          toast.error(res.error.message ?? "Approval failed.");
          return;
        }
        toast.success("Investigation approved.");
        void reload();
      } catch (error) {
        toast.error(
          lifecycleOperationError(error, "The approval request failed."),
        );
      }
    });
    if (request) await request;
  };

  const onReject = async (): Promise<boolean> => {
    if (!id) return false;
    if (rejectReason.trim() === "") {
      toast.error("Reason is required to reject.");
      return false;
    }
    const res = await api.rejectAuditInvestigation(id, rejectReason.trim());
    if (res.error) {
      toast.error(res.error.message ?? "Reject failed.");
      return false;
    }
    toast.success("Investigation rejected.");
    setRejectOpen(false);
    setRejectReason("");
    void reload();
    return true;
  };

  const decisionLifecycle = useDraftLifecycleController({
    ownerId: `audit-investigation-decision-${id ?? "none"}`,
    label: "Audit investigation decision",
    mode: "action",
    enabled: id !== null && rejectOpen,
    dirty: Boolean(rejectReason.trim()),
    save: onReject,
    discard: () => setRejectReason(""),
    close: () => setRejectOpen(false),
    detail:
      "This investigation rejection reason has not been submitted. Return to it or explicitly discard it.",
    operationDetail:
      "Wait for the investigation decision request to finish before leaving Moosewave.",
    onError: (error) =>
      toast.error(
        lifecycleOperationError(error, "The investigation decision failed."),
      ),
  });

  if (!id) {
    return (
      <div style={{ padding: 24 }}>
        <SectionHeader
          title="Audit Investigation"
          description="Pick an investigation from the list below."
        />
        <InvestigationListInline
          onPick={(picked) => {
            navigateDesktopRoute({
              section: "auditInvestigation",
              resourceId: picked,
            });
          }}
        />
      </div>
    );
  }

  if (loading || (!inv && !loadErr)) {
    return (
      <div style={{ padding: 24 }} className="muted">
        Loading investigation…
      </div>
    );
  }
  if (!inv) {
    // D13-governance-privacy#7: deep-linked investigation 404/500 — show
    // a retryable error card instead of an eternal spinner.
    return (
      <div style={{ padding: 24 }}>
        <div className="notice">
          <span>{loadErr ?? "Couldn't load this investigation."}</span>
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: 8 }}
            onClick={() => void reload()}
            disabled={loading}
          >
            {loading ? "Retrying…" : "Retry"}
          </button>
        </div>
        <div style={{ marginTop: 24 }}>
          <button className="btn btn-ghost" onClick={() => setSection("audit")}>
            ← Back to Audit
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 1240 }}>
      <SectionHeader
        title={`Investigation · seed #${inv.seed_audit_id}`}
        description={`Created ${new Date(inv.created_at).toLocaleString()} · ${inv.findings.length} hypothesis${inv.findings.length === 1 ? "" : "es"} · ${inv.proposed_actions.length} proposed action${inv.proposed_actions.length === 1 ? "" : "s"}`}
      />

      <InvestigationSummary investigation={inv} />

      <InvestigationFindings investigation={inv} />

      <ProposedActionsSection
        investigation={inv}
        busy={decisionLifecycle.active}
        onReject={() => setRejectOpen(true)}
        onApprove={() => void onApprove()}
      />

      {/* SSE log ------------------------------------------------------- */}
      {streamEvents.length > 0 ? (
        <section style={{ marginTop: 32 }}>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>Live status</h3>
          <pre
            className="mono"
            style={{
              fontSize: 11,
              background: "var(--pw-bg-elev)",
              padding: 8,
              borderRadius: 4,
              maxHeight: 200,
              overflow: "auto",
            }}
          >
            {streamEvents
              .map((e) => `[${e.ts}] ${e.type}: ${e.message ?? e.status ?? ""}`)
              .join("\n")}
          </pre>
        </section>
      ) : null}

      <InvestigationRejectModal
        open={rejectOpen}
        reason={rejectReason}
        busy={decisionLifecycle.active}
        onReasonChange={setRejectReason}
        onClose={decisionLifecycle.requestClose}
        onSubmit={() => void decisionLifecycle.submit()}
      />

      <ConfirmModal
        open={decisionLifecycle.discardConfirmOpen}
        title="Discard rejection reason?"
        description="The investigation decision has not been submitted."
        confirmLabel="Discard reason"
        danger
        busy={decisionLifecycle.active}
        onConfirm={decisionLifecycle.discardAndClose}
        onClose={decisionLifecycle.keepEditing}
      />

      <div style={{ marginTop: 24 }}>
        <button className="btn btn-ghost" onClick={() => setSection("audit")}>
          ← Back to Audit
        </button>
      </div>
    </div>
  );
}

function InvestigationFindings({
  investigation,
}: {
  investigation: AuditInvestigationType;
}): ReactElement {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(260px, 1fr) 2fr",
        gap: 24,
      }}
    >
      <section>
        <h3 style={{ fontSize: 14, marginBottom: 8 }}>Timeline</h3>
        <AuditInvestigationTimeline
          evidenceAuditIds={investigation.evidence_audit_ids}
          seedAuditId={investigation.seed_audit_id}
        />
      </section>

      <section>
        <h3 style={{ fontSize: 14, marginBottom: 8 }}>Hypotheses</h3>
        {investigation.findings.map((finding) => (
          <div
            key={finding.num}
            className="card"
            style={{ padding: 16, marginBottom: 12 }}
            data-testid="audit-investigation-finding"
          >
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div style={{ fontWeight: 700 }}>
                #{finding.num} · {finding.hypothesis}
              </div>
              <span className="mono" style={{ fontSize: 11, opacity: 0.7 }}>
                {Math.round(finding.confidence * 100)}%
              </span>
            </div>
            {finding.mitre_techniques.length > 0 ? (
              <div
                className="row"
                style={{
                  gap: 4,
                  flexWrap: "wrap",
                  marginTop: 6,
                  marginBottom: 6,
                }}
              >
                {finding.mitre_techniques.map((technique) => (
                  <span
                    key={technique}
                    className="mono"
                    style={{
                      padding: "1px 5px",
                      background: "var(--pw-bg-elev)",
                      fontSize: 10,
                      borderRadius: 3,
                    }}
                  >
                    {technique}
                  </span>
                ))}
              </div>
            ) : null}
            {finding.detector_reasons?.length ? (
              <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                Detector reasons: {finding.detector_reasons.join(", ")}
              </div>
            ) : null}
            <div style={{ marginTop: 8 }}>
              <div className="label">
                Evidence ({finding.evidence_audit_ids.length})
              </div>
              {finding.evidence_audit_ids.slice(0, 8).map((auditId) => (
                <AuditInvestigationEvidenceCard
                  key={auditId}
                  auditId={auditId}
                />
              ))}
              {finding.evidence_audit_ids.length > 8 ? (
                <div className="muted" style={{ fontSize: 11 }}>
                  +{finding.evidence_audit_ids.length - 8} more rows omitted —
                  see Timeline for the full set.
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function ProposedActionsSection({
  investigation,
  busy,
  onReject,
  onApprove,
}: {
  investigation: AuditInvestigationType;
  busy: boolean;
  onReject: () => void;
  onApprove: () => void;
}): ReactElement {
  return (
    <section style={{ marginTop: 32 }}>
      <h3 style={{ fontSize: 14, marginBottom: 8 }}>
        Proposed remediation actions
      </h3>
      <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        Every action requires human review. Approval records acceptance of the
        complete remediation plan, but Moosewave does not apply identity, key,
        token, MFA, or IP changes. Carry out approved actions through your
        external operations workflow. Rejecting records the dismissal with the
        supplied reason.
      </p>
      {investigation.proposed_actions.length === 0 ? (
        <div className="muted">No actions proposed.</div>
      ) : (
        <table className="table" style={{ width: "100%", fontSize: 13 }}>
          <thead>
            <tr>
              <th>Action</th>
              <th>Target</th>
              <th>Severity</th>
              <th>Rationale</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {investigation.proposed_actions.map((action) => (
              <tr key={action.id} data-testid="audit-investigation-action-row">
                <td className="mono">{action.action}</td>
                <td className="mono">{action.target_id || "—"}</td>
                <td>{action.severity}</td>
                <td>{action.rationale}</td>
                <td style={{ textAlign: "right" }}>
                  <span className="muted">
                    {investigation.status === "draft"
                      ? "Included in plan"
                      : investigation.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {investigation.status === "draft" ? (
        <div
          className="row"
          style={{ gap: 8, marginTop: 16, justifyContent: "flex-end" }}
        >
          <button
            className="btn btn-sm btn-ghost"
            disabled={busy}
            onClick={onReject}
          >
            Reject
          </button>
          <button
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={onApprove}
          >
            {busy ? "Working…" : "Approve remediation plan"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function InvestigationSummary({
  investigation,
}: {
  investigation: AuditInvestigationType;
}): ReactElement {
  const bucket = bucketForConfidence(investigation.confidence);
  const color = bucketColor(bucket);
  const statusColor =
    investigation.status === "executed"
      ? "var(--pw-success)"
      : investigation.status === "approved"
        ? "var(--pw-info)"
        : investigation.status === "rejected"
          ? "var(--pw-fg-muted)"
          : "var(--pw-warning)";
  return (
    <div
      className="row"
      style={{
        gap: 16,
        alignItems: "center",
        flexWrap: "wrap",
        marginBottom: 20,
      }}
    >
      <div style={{ minWidth: 240 }}>
        <div className="label">Confidence</div>
        <div
          style={{
            height: 8,
            borderRadius: 4,
            background: "var(--pw-bg-elev)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.round(investigation.confidence * 100)}%`,
              height: "100%",
              background: color,
            }}
            data-testid="audit-investigation-confidence-meter"
          />
        </div>
        <div style={{ fontSize: 12, marginTop: 2 }}>
          {Math.round(investigation.confidence * 100)}% · {bucket}
        </div>
      </div>
      <div>
        <div className="label">Status</div>
        <span
          className={`audit-severity-badge is-${investigation.status}`}
          style={{
            padding: "4px 10px",
            borderRadius: 4,
            fontSize: 12,
            fontWeight: 600,
            background: statusColor,
            color: "white",
          }}
          data-testid="audit-investigation-status"
        >
          {investigation.status}
        </span>
      </div>
      <div>
        <div className="label">MITRE ATT&CK</div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap", fontSize: 11 }}>
          {investigation.mitre_techniques.length === 0 ? (
            <span className="muted">None tagged.</span>
          ) : (
            investigation.mitre_techniques.map((technique) => (
              <ExternalLink
                key={technique}
                href={`https://attack.mitre.org/techniques/${technique}/`}
                className="mono"
                style={{
                  padding: "2px 6px",
                  background: "var(--pw-bg-elev)",
                  borderRadius: 3,
                  textDecoration: "none",
                }}
              >
                {technique}
              </ExternalLink>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function InvestigationRejectModal({
  open,
  reason,
  busy,
  onReasonChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  reason: string;
  busy: boolean;
  onReasonChange: (reason: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}): ReactElement | null {
  if (!open) return null;
  return (
    <Modal
      open
      onClose={onClose}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeDisabled={busy}
      title="Reject investigation"
    >
      <p style={{ fontSize: 13 }}>
        Provide a reason so the dismissal is captured in the audit trail. The
        reason is visible to anyone with audit:read.
      </p>
      <textarea
        value={reason}
        onChange={(event) => onReasonChange(event.target.value)}
        rows={4}
        style={{ width: "100%", fontSize: 13, padding: 8 }}
        placeholder="e.g. confirmed false positive — actor reset their own password from a new device"
        disabled={busy}
      />
      <ModalFooter>
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={onSubmit} disabled={busy}>
          {busy ? "Rejecting…" : "Reject investigation"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

interface ListProps {
  onPick: (id: string) => void;
}

function InvestigationListInline({ onPick }: ListProps): ReactElement {
  const [items, setItems] = useState<AuditInvestigationType[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  // D13-governance-privacy#7: distinguish a real API failure from a
  // healthy empty tenant — previously a 500 rendered as "No investigations
  // yet", hiding outages on a security-response surface.
  const [listErr, setListErr] = useState<string | null>(null);
  const loadList = useCallback(async (): Promise<void> => {
    setLoading(true);
    setListErr(null);
    const res = await api.listAuditInvestigations({ limit: 50 });
    if (res.error) {
      setListErr(res.error.message ?? "Failed to load investigations.");
    } else {
      setItems(res.data?.investigations ?? []);
    }
    setLoading(false);
  }, []);
  useEffect(() => {
    void loadList();
  }, [loadList]);
  if (loading) {
    return <div className="muted">Loading…</div>;
  }
  if (listErr) {
    return (
      <div className="notice">
        <span>{listErr}</span>
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginLeft: 8 }}
          onClick={() => void loadList()}
        >
          Retry
        </button>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 13 }}>
        No investigations yet. Trigger one from the Audit page by opening an
        event slideover and clicking "Investigate".
      </div>
    );
  }
  return (
    <table className="table" style={{ width: "100%", fontSize: 13 }}>
      <thead>
        <tr>
          <th>Seed</th>
          <th>Status</th>
          <th>Confidence</th>
          <th>Findings</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it) => (
          <tr key={it.id}>
            <td className="mono">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => onPick(it.id)}
                aria-label={`Open investigation for audit event ${it.seed_audit_id}`}
              >
                #{it.seed_audit_id}
              </button>
            </td>
            <td>{it.status}</td>
            <td>{Math.round(it.confidence * 100)}%</td>
            <td>{it.findings.length}</td>
            <td>{new Date(it.created_at).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
