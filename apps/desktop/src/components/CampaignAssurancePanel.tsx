// SPDX-License-Identifier: AGPL-3.0-only

import { type ReactElement, useState } from "react";

import {
  applyCampaignAssuranceFinding,
  ASSURANCE_SOURCE_LABELS,
  type CampaignAssuranceEvidence,
  type CampaignAssuranceFinding,
  type CampaignAssuranceLatest,
  type CampaignAssuranceOverride,
  type CampaignAssuranceSourceClass,
  factContractSummary,
  overrideCampaignAssuranceFinding,
  remediationSummary,
  startCurrentCampaignAssurance,
} from "../lib/api/campaign-assurance";
import { Modal, ModalFooter } from "./Modal";
import { toast } from "./Toast";
import { useCampaignAssurance } from "./campaigns/useCampaignAssurance";

const SOURCE_ORDER: CampaignAssuranceSourceClass[] = [
  "deterministic",
  "modeled",
  "controlled_observation",
];

const TERMINAL_STATES = new Set([
  "complete",
  "incomplete",
  "failed",
  "cancelled",
  "stale",
]);

export function CampaignAssurancePanel({
  campaignId,
  canAdmin,
  canEdit,
  canApply,
  campaignETag,
  onCampaignChanged,
}: {
  campaignId: string | number;
  canAdmin: boolean;
  /** Editor-or-higher authorization; viewers never receive an apply control. */
  canEdit: boolean;
  /** False while local edits make the captured server ETag inapplicable. */
  canApply: boolean;
  campaignETag: string | null;
  onCampaignChanged: () => void;
}): ReactElement {
  const id = String(campaignId);
  const { state, refresh, loadMore, loadingMore } = useCampaignAssurance(id);
  const [starting, setStarting] = useState(false);

  const startCurrentRun = async (): Promise<void> => {
    if (starting || !canEdit || !canApply) return;
    setStarting(true);
    const result = await startCurrentCampaignAssurance(id);
    setStarting(false);
    if (result.error) {
      toast.error(`Couldn't start Campaign Assurance: ${result.error.message}`);
      return;
    }
    toast.success(
      `Campaign Assurance accepted ${result.data.data.required_scenario_count} frozen scenario${result.data.data.required_scenario_count === 1 ? "" : "s"}.`,
    );
    refresh();
  };

  if (state.status === "loading") {
    return (
      <section className="card" style={cardStyle} aria-busy="true">
        <strong>Predicted Agent Comprehension</strong>
        <p className="muted" role="status">
          Loading the exact assurance receipt…
        </p>
      </section>
    );
  }
  if (state.status === "missing" || state.status === "error") {
    return (
      <section className="card" style={cardStyle}>
        <strong>Predicted Agent Comprehension</strong>
        <p className="muted" style={{ margin: "6px 0" }}>
          {state.status === "missing"
            ? "No Campaign Assurance receipt exists for this campaign yet."
            : state.message}
        </p>
        <p className="muted" style={smallStyle}>
          Starting assurance freezes the current draft and asks the server to
          compile every required semantic scenario into one immutable plan.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {state.status === "missing" && canEdit ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={starting || !canApply}
              onClick={() => void startCurrentRun()}
            >
              {starting
                ? "Preparing exact plan…"
                : canApply
                  ? "Run full assurance"
                  : "Save or discard local edits first"}
            </button>
          ) : null}
          <button type="button" className="btn btn-sm" onClick={refresh}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const latest = state.latest.data;
  const run = latest.detail.run;
  const evidence = state.evidence;
  const verdict = assuranceVerdict(latest);
  const contract = factContractSummary(state.revision?.fact_contract);
  const findings = evidence?.findings.items ?? [];
  const overrides = evidence?.overrides.items ?? [];
  const unavailableExtractions =
    evidence?.extractions.items.filter((item) => item.status !== "complete") ??
    [];
  const missingSources = state.latest.measurement.source_classes.filter(
    (source) => !source.present,
  );

  return (
    <section
      className="card"
      style={cardStyle}
      aria-labelledby="campaign-assurance-title"
      data-testid="campaign-assurance-panel"
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div>
          <strong id="campaign-assurance-title">
            Predicted Agent Comprehension
          </strong>
          <p className="muted" style={{ ...smallStyle, margin: "4px 0 0" }}>
            {state.latest.measurement.interpretation}
          </p>
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
          }}
        >
          {canEdit && TERMINAL_STATES.has(run.state) ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={starting || !canApply}
              onClick={() => void startCurrentRun()}
            >
              {starting
                ? "Preparing…"
                : canApply
                  ? "Rerun full assurance"
                  : "Save local edits before rerun"}
            </button>
          ) : null}
          <span className={`badge ${verdict.badge}`}>{verdict.label}</span>
        </div>
      </div>

      <SourceBadges
        sources={state.latest.measurement.source_classes}
        unavailable={
          missingSources.length > 0 || unavailableExtractions.length > 0
        }
      />

      <div
        className="notice"
        role={verdict.alert ? "alert" : "status"}
        style={{ marginTop: 10 }}
      >
        <strong>{verdict.detail}</strong>
        <div className="muted" style={{ ...smallStyle, marginTop: 4 }}>
          {latest.applicability.basis} The queue endpoint revalidates this exact
          receipt; this panel never becomes a second send authority.
        </div>
      </div>

      <h4 style={sectionTitleStyle}>Immutable receipt</h4>
      <dl style={gridStyle}>
        <Field label="Run" value={`#${run.run_no} · ${run.id}`} mono />
        <Field label="Frozen revision" value={run.content_revision_id} mono />
        <Field label="Send plan" value={run.send_plan_id} mono />
        <Field label="Freshness" value={latest.applicability.freshness} />
        <Field label="Source hash" value={run.source_hash} mono />
        <Field label="Plan hash" value={run.plan_hash} mono />
        <Field label="Artifact-set hash" value={run.artifact_set_hash} mono />
        <Field
          label="Coverage manifest hash"
          value={run.coverage_manifest_hash ?? "Unavailable from receipt"}
          mono
        />
        <Field
          label="Configuration manifest hash"
          value={run.configuration_manifest_hash ?? "Unavailable from receipt"}
          mono
        />
        <Field
          label="Target manifest hash"
          value={run.target_manifest_hash ?? "Unavailable from receipt"}
          mono
        />
        <Field
          label="Extraction coverage"
          value={`${run.successful_extraction_count}/${run.required_extraction_count} successful · ${run.extraction_error_count} error(s)`}
        />
        <Field
          label="Predicted score"
          value={
            run.overall_score == null
              ? "Unavailable"
              : `${run.overall_score.toFixed(1)} (${run.score_min ?? "—"}–${run.score_max ?? "—"})`
          }
        />
      </dl>

      <h4 style={sectionTitleStyle}>Message Contract</h4>
      {state.revisionError ? (
        <p className="muted" style={smallStyle}>
          The frozen Fact Contract could not be loaded: {state.revisionError}
        </p>
      ) : !contract.available ? (
        <div className="notice" role="status" style={smallStyle}>
          This frozen revision has no valid Fact Contract. Do not infer a
          trustworthy overall score from structural checks alone.
        </div>
      ) : (
        <dl style={gridStyle}>
          <Field label="Primary intent" value={contract.intent} />
          <Field label="Core claim" value={contract.claim} />
          <Field label="Primary action" value={contract.action} />
          <Field
            label="Required facts"
            value={contract.facts.join("; ") || "None declared"}
          />
        </dl>
      )}

      <h4 style={sectionTitleStyle}>Findings and remediation</h4>
      {state.evidenceError ? (
        <div className="notice" role="alert" style={smallStyle}>
          Immutable finding receipts are unavailable: {state.evidenceError}
        </div>
      ) : null}
      {findings.length === 0 && !state.evidenceError ? (
        <p className="muted" style={smallStyle}>
          No findings were recorded.
        </p>
      ) : findings.length > 0 ? (
        SOURCE_ORDER.map((source) => {
          const rows = findings.filter(
            (finding) => finding.source_class === source,
          );
          if (!rows.length) return null;
          return (
            <div key={source} style={{ marginTop: 10 }}>
              <div className="muted" style={sourceHeadingStyle}>
                {ASSURANCE_SOURCE_LABELS[source]}
              </div>
              {rows.map((finding) => (
                <FindingCard
                  key={finding.id}
                  campaignId={id}
                  runId={run.id}
                  finding={finding}
                  override={latestOverride(overrides, finding.id)}
                  canAdmin={canAdmin}
                  canEdit={canEdit}
                  canApply={canApply}
                  campaignETag={campaignETag}
                  onCampaignChanged={onCampaignChanged}
                  onChanged={refresh}
                />
              ))}
            </div>
          );
        })
      ) : null}

      {evidence && nextEvidenceOffset(evidence) !== undefined ? (
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginTop: 10 }}
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "Loading…" : "Load more immutable evidence"}
        </button>
      ) : null}

      {missingSources.length || unavailableExtractions.length ? (
        <div className="notice" style={{ marginTop: 12 }}>
          <strong>Unavailable evidence</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {missingSources.map((source) => (
              <li key={source.class} className="muted" style={smallStyle}>
                {ASSURANCE_SOURCE_LABELS[source.class]}: {source.meaning}
              </li>
            ))}
            {unavailableExtractions.map((extraction) => (
              <li key={extraction.id} className="muted" style={smallStyle}>
                {ASSURANCE_SOURCE_LABELS[extraction.source_class]} extraction:{" "}
                {extraction.error_message ||
                  extraction.error_code ||
                  "unavailable"}
              </li>
            ))}
          </ul>
          <p className="muted" style={{ ...smallStyle, marginBottom: 0 }}>
            Unavailable modeled evidence never becomes a green result.
          </p>
        </div>
      ) : null}

      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
          Analyzer and artifact provenance
        </summary>
        <dl style={{ ...gridStyle, marginTop: 8 }}>
          <Field label="Renderer" value={run.renderer_version} />
          <Field label="Compiler" value={run.compiler_version} />
          <Field label="Analyzer suite" value={run.analyzer_suite_version} />
          <Field label="Model suite" value={run.model_suite_version} />
          <Field label="Prompt suite" value={run.prompt_suite_version} />
          <Field label="Scoring" value={run.scoring_version} />
          <Field label="Gate policy" value={run.gate_policy_version} />
          <Field label="Methodology" value={run.methodology_version} />
          <Field
            label="Modeled cost (µ-units)"
            value={
              run.cost_microunits == null
                ? "Unavailable for this run"
                : run.cost_microunits.toLocaleString()
            }
          />
          <Field
            label="Frozen cost ceiling (µ-units)"
            value={
              run.max_modeled_cost_microunits == null
                ? "Unavailable for this run"
                : run.max_modeled_cost_microunits.toLocaleString()
            }
          />
        </dl>
        <p className="muted" style={smallStyle}>
          {latest.detail.manifest.artifacts.length} frozen artifact(s),{" "}
          {latest.detail.manifest.configurations.length} analyzer
          configuration(s), and {latest.detail.manifest.targets.length} exact
          target(s).
        </p>
        {evidence?.extractions.items.map((extraction) => (
          <div key={extraction.id} style={subCardStyle}>
            <strong>{ASSURANCE_SOURCE_LABELS[extraction.source_class]}</strong>
            {extraction.source_class === "modeled" ? (
              <span className="muted">
                {" "}
                · {extraction.model_provider || "provider unavailable"} /{" "}
                {extraction.model_id || "model unavailable"} /{" "}
                {extraction.model_version || "version unavailable"} ·{" "}
                {extraction.execution_kind === "cache_reuse"
                  ? "exact-cache reuse"
                  : extraction.execution_kind === "invoked"
                    ? "provider invocation"
                    : "execution lineage unavailable"}
              </span>
            ) : null}
            <div
              className="mono"
              title={extraction.receipt_hash}
              style={hashStyle}
            >
              Receipt {extraction.receipt_hash}
            </div>
            {extraction.execution_kind === "cache_reuse" &&
            extraction.reused_from_receipt_hash ? (
              <div
                className="mono"
                title={extraction.reused_from_receipt_hash}
                style={hashStyle}
              >
                Invoked-origin receipt {extraction.reused_from_receipt_hash}
              </div>
            ) : null}
          </div>
        ))}
      </details>
    </section>
  );
}

export function CampaignAssuranceSendStatus({
  campaignId,
}: {
  campaignId: string;
}): ReactElement {
  const { state } = useCampaignAssurance(campaignId, { withDetails: false });
  if (state.status === "loading") {
    return (
      <div className="notice" role="status">
        Checking the exact Campaign Assurance receipt…
      </div>
    );
  }
  if (state.status !== "ready") {
    return (
      <div className="notice" role="status" style={smallStyle}>
        {state.status === "missing"
          ? "No Campaign Assurance receipt is available."
          : "Campaign Assurance could not be loaded."}{" "}
        The server queue gate remains authoritative and rechecks before queueing
        recipients.
      </div>
    );
  }
  const latest = state.latest.data;
  const verdict = assuranceVerdict(latest);
  return (
    <div
      className="notice"
      role={verdict.alert ? "alert" : "status"}
      style={smallStyle}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <strong>Predicted Agent Comprehension</strong>
        <span className={`badge ${verdict.badge}`}>{verdict.label}</span>
      </div>
      <div className="muted" style={{ marginTop: 4 }}>
        {verdict.detail}
      </div>
      <div className="mono muted" style={{ ...hashStyle, marginTop: 6 }}>
        Source {shortHash(latest.detail.run.source_hash)} · Plan{" "}
        {shortHash(latest.detail.run.plan_hash)} · Artifacts{" "}
        {shortHash(latest.detail.run.artifact_set_hash)}
      </div>
      <div className="muted" style={{ marginTop: 5 }}>
        The queue endpoint validates these exact identities again; this preview
        never bypasses the gate.
      </div>
    </div>
  );
}

function SourceBadges({
  sources,
  unavailable,
}: {
  sources: Array<{
    class: CampaignAssuranceSourceClass;
    present: boolean;
    meaning: string;
  }>;
  unavailable: boolean;
}): ReactElement {
  return (
    <div
      style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 9 }}
      aria-label="Evidence source classes"
    >
      {SOURCE_ORDER.map((sourceClass) => {
        const source = sources.find((item) => item.class === sourceClass);
        return (
          <span
            key={sourceClass}
            className={`badge ${source?.present ? "" : "warning"}`}
            title={source?.meaning}
          >
            {ASSURANCE_SOURCE_LABELS[sourceClass]} ·{" "}
            {source?.present ? "present" : "unavailable"}
          </span>
        );
      })}
      <span className={`badge ${unavailable ? "warning" : ""}`}>
        {ASSURANCE_SOURCE_LABELS.unavailable} ·{" "}
        {unavailable ? "present" : "none"}
      </span>
    </div>
  );
}

function FindingCard({
  campaignId,
  runId,
  finding,
  override,
  canAdmin,
  canEdit,
  canApply,
  campaignETag,
  onCampaignChanged,
  onChanged,
}: {
  campaignId: string;
  runId: string;
  finding: CampaignAssuranceFinding;
  override?: CampaignAssuranceOverride;
  canAdmin: boolean;
  canEdit: boolean;
  canApply: boolean;
  campaignETag: string | null;
  onCampaignChanged: () => void;
  onChanged: () => void;
}): ReactElement {
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [appliedRevision, setAppliedRevision] = useState<string | null>(null);
  const hasDeterministicPatch =
    finding.source_class === "deterministic" &&
    finding.typed_patch !== undefined;
  return (
    <div
      style={{
        ...subCardStyle,
        borderColor: finding.blocking ? "var(--pw-danger)" : undefined,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <strong>{finding.code}</strong>
        <span className={`badge ${finding.blocking ? "danger" : ""}`}>
          {finding.blocking ? "Blocks" : "Advisory"}
        </span>
      </div>
      <div className="muted" style={smallStyle}>
        {finding.dimension} · {finding.severity}
      </div>
      <p style={{ margin: "7px 0" }}>{finding.explanation}</p>
      <p className="muted" style={smallStyle}>
        Remediation: {remediationSummary(finding.remediation)} Any content
        change creates a new revision and requires a fresh assurance run.
      </p>
      {hasDeterministicPatch ? (
        <p className="muted" style={smallStyle}>
          A deterministic typed repair is recorded. The server accepts only a
          validated heading-level TypedPatchV1 and creates a different immutable
          revision; it never edits this receipt in place.
        </p>
      ) : finding.typed_patch !== undefined ? (
        <p className="muted" style={smallStyle}>
          A typed proposal is recorded, but automatic application is limited to
          deterministic heading-level repairs. No content was changed.
        </p>
      ) : null}
      <div
        className="mono muted"
        title={finding.receipt_hash}
        style={hashStyle}
      >
        Finding receipt {finding.receipt_hash}
      </div>
      {override ? (
        <div className="notice" style={{ marginTop: 8, ...smallStyle }}>
          Governed {override.decision === "allow_send" ? "waiver" : "rejection"}
          : {override.reason}
        </div>
      ) : finding.overridable && canAdmin ? (
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginTop: 8 }}
          onClick={() => setOverrideOpen(true)}
        >
          Record governed decision
        </button>
      ) : finding.overridable ? (
        <p className="muted" style={smallStyle}>
          An owner or admin may record a governed decision.
        </p>
      ) : null}
      {appliedRevision ? (
        <div className="notice" style={{ marginTop: 8, ...smallStyle }}>
          Applied into revision <span className="mono">{appliedRevision}</span>.
          The originating run and plan are stale; freeze the next plan and rerun
          Campaign Assurance before sending.
        </div>
      ) : hasDeterministicPatch && canEdit ? (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!canApply || !campaignETag}
            onClick={() => setApplyOpen(true)}
          >
            Apply deterministic repair
          </button>
          {!canApply ? (
            <p className="muted" style={smallStyle}>
              Finish or discard local edits before applying this repair.
            </p>
          ) : !campaignETag ? (
            <p className="muted" style={smallStyle}>
              Reload the campaign to capture its authoritative ETag before
              applying.
            </p>
          ) : null}
        </div>
      ) : hasDeterministicPatch ? (
        <p className="muted" style={smallStyle}>
          An editor, admin, or owner may apply this stored deterministic repair.
        </p>
      ) : null}
      <OverrideModal
        open={overrideOpen}
        onClose={() => setOverrideOpen(false)}
        campaignId={campaignId}
        runId={runId}
        finding={finding}
        onChanged={onChanged}
      />
      {hasDeterministicPatch && canEdit && campaignETag ? (
        <ApplyPatchModal
          open={applyOpen}
          onClose={() => setApplyOpen(false)}
          campaignId={campaignId}
          runId={runId}
          finding={finding}
          campaignETag={campaignETag}
          onApplied={(revisionId) => {
            if (revisionId) setAppliedRevision(revisionId);
            onChanged();
            onCampaignChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function ApplyPatchModal({
  open,
  onClose,
  campaignId,
  runId,
  finding,
  campaignETag,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  campaignId: string;
  runId: string;
  finding: CampaignAssuranceFinding;
  campaignETag: string;
  onApplied: (revisionId: string) => void;
}): ReactElement | null {
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    setBusy(true);
    const result = await applyCampaignAssuranceFinding(
      campaignId,
      runId,
      finding.id,
      campaignETag,
    );
    setBusy(false);
    if (result.error) {
      if (result.error.status === 412) {
        onApplied("");
        onClose();
        toast.error(
          "The campaign changed. It was refreshed; review the finding before trying again.",
        );
      } else if (
        result.error.code === "campaign_assurance_apply_provenance_invalid"
      ) {
        onApplied("");
        onClose();
        toast.error(
          "The repair acknowledgement was incomplete. The campaign was refreshed before another repair can be attempted.",
        );
      } else if (
        result.error.kind === "network" ||
        result.error.kind === "timeout" ||
        result.error.kind === "parse" ||
        (result.error.status ?? 0) >= 500
      ) {
        onApplied("");
        onClose();
        toast.error(
          "The repair result could not be confirmed. The campaign was refreshed before another repair can be attempted.",
        );
      } else {
        toast.error(
          `Couldn't apply the deterministic repair: ${result.error.message}`,
        );
      }
      return;
    }
    const applied = result.data.data;
    if (
      applied.originating_run_state !== "stale" ||
      applied.rerun_required !== true ||
      !applied.revision?.id ||
      !result.serverVersion ||
      result.serverVersion !== applied.campaign_etag ||
      !result.responseLocation
    ) {
      toast.error(
        "The repair response did not include a matching campaign ETag and stale-run rerun receipt.",
      );
      return;
    }
    toast.success(
      "Repair applied to a new revision. A new plan and assurance run are required.",
    );
    onClose();
    onApplied(applied.revision.id);
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={busy}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      title="Apply deterministic repair?"
      description={`This submits finding ${finding.code} against the exact campaign ETag. The server accepts only a deterministic heading-level TypedPatchV1, creates or reuses a different immutable revision, and makes the old run and plan stale. It does not rerun assurance automatically.`}
    >
      <ModalFooter>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? "Applying…" : "Create repaired revision"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function OverrideModal({
  open,
  onClose,
  campaignId,
  runId,
  finding,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  campaignId: string;
  runId: string;
  finding: CampaignAssuranceFinding;
  onChanged: () => void;
}): ReactElement | null {
  const [decision, setDecision] = useState<"allow_send" | "reject">(
    "allow_send",
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    const rationale = reason.trim();
    if (rationale.length < 10) {
      toast.error("Give a specific rationale of at least 10 characters.");
      return;
    }
    setBusy(true);
    const result = await overrideCampaignAssuranceFinding(
      campaignId,
      runId,
      finding.id,
      { decision, reason: rationale },
    );
    setBusy(false);
    if (result.error) {
      toast.error(
        `Couldn't record the governed decision: ${result.error.message}`,
      );
      return;
    }
    toast.success("Governed decision recorded against the immutable finding.");
    setReason("");
    onClose();
    onChanged();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={busy}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      title={`Govern finding ${finding.code}`}
      description="This writes an immutable, finding-scoped decision. It does not edit the email or erase the finding."
    >
      <label className="field">
        <span>Decision</span>
        <select
          className="input"
          value={decision}
          disabled={busy}
          onChange={(event) =>
            setDecision(event.target.value as "allow_send" | "reject")
          }
        >
          <option value="allow_send">Allow this exact frozen send</option>
          <option value="reject">Reject this finding appeal</option>
        </select>
      </label>
      <label className="field">
        <span>Rationale</span>
        <textarea
          className="input"
          rows={5}
          maxLength={2000}
          value={reason}
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Explain why this exact finding is acceptable or must remain blocked."
        />
        <span className="muted" style={smallStyle}>
          {reason.trim().length}/2000 · minimum 10
        </span>
      </label>
      <ModalFooter>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || reason.trim().length < 10}
          onClick={() => void submit()}
        >
          {busy ? "Recording…" : "Record decision"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): ReactElement {
  return (
    <div style={{ minWidth: 0 }}>
      <dt className="muted" style={smallStyle}>
        {label}
      </dt>
      <dd
        className={mono ? "mono" : undefined}
        title={value}
        style={{
          margin: 0,
          overflowWrap: "anywhere",
          fontSize: mono ? 10 : 12,
        }}
      >
        {value || "—"}
      </dd>
    </div>
  );
}

export function assuranceVerdict(latest: CampaignAssuranceLatest): {
  label: string;
  detail: string;
  badge: string;
  alert: boolean;
} {
  const run = latest.detail.run;
  if (
    !latest.applicability.applicable_to_frozen_snapshot ||
    latest.applicability.freshness !== "frozen_snapshot_current" ||
    run.state === "stale" ||
    run.state === "cancelled"
  ) {
    return {
      label: "Stale",
      detail:
        "This receipt is not applicable to the current frozen snapshot. Create a new revision/plan as needed and rerun.",
      badge: "warning",
      alert: true,
    };
  }
  if (
    run.state === "queued" ||
    run.state === "running" ||
    run.gate_decision === "pending"
  ) {
    return {
      label: "Running",
      detail: `${run.terminal_extraction_count}/${run.required_extraction_count} required extractions are terminal.`,
      badge: "warning",
      alert: false,
    };
  }
  if (run.state !== "complete" || run.gate_decision === "unavailable") {
    return {
      label: "Incomplete",
      detail:
        "Required evidence is incomplete or unavailable; this is not a passing receipt.",
      badge: "warning",
      alert: true,
    };
  }
  if (run.gate_decision === "block") {
    return {
      label: "Blocked",
      detail: `${run.blocking_finding_count} blocking finding(s) remain on this exact artifact set.`,
      badge: "danger",
      alert: true,
    };
  }
  if (run.gate_decision === "warn") {
    return {
      label: "Warnings",
      detail:
        "The receipt is current and complete, with advisory findings for review.",
      badge: "warning",
      alert: false,
    };
  }
  if (run.gate_decision === "pass") {
    return {
      label: "Current receipt",
      detail:
        "The receipt is complete and current for this exact frozen revision, plan, and artifact set.",
      badge: "success",
      alert: false,
    };
  }
  return {
    label: "Unavailable",
    detail:
      "The receipt has an unrecognized decision and cannot be treated as passing.",
    badge: "warning",
    alert: true,
  };
}

function latestOverride(
  overrides: CampaignAssuranceEvidence["overrides"]["items"],
  findingId: string,
): CampaignAssuranceOverride | undefined {
  return overrides
    .filter((item) => item.finding_id === findingId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

function shortHash(value: string): string {
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-7)}` : value;
}

function nextEvidenceOffset(
  evidence: CampaignAssuranceEvidence,
): number | undefined {
  return [
    evidence.extractions.next_offset,
    evidence.findings.next_offset,
    evidence.overrides.next_offset,
  ]
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b)[0];
}

const cardStyle = { marginTop: 12, padding: 14 } as const;
const smallStyle = { fontSize: 11, lineHeight: 1.45 } as const;
const hashStyle = { fontSize: 9, overflowWrap: "anywhere" } as const;
const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
  margin: 0,
} as const;
const sectionTitleStyle = { fontSize: 12, margin: "14px 0 8px" } as const;
const sourceHeadingStyle = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: ".06em",
  textTransform: "uppercase",
} as const;
const subCardStyle = {
  border: "1px solid var(--pw-border)",
  borderRadius: 8,
  padding: 9,
  marginTop: 6,
  fontSize: 12,
} as const;
