/**
 * Evidence workspace for AI regression replays.
 *
 * A policy outcome is a recorded evaluation only. Nothing returned by the
 * current API proves that a deployment was enforced, so this surface never
 * describes a model upgrade as allowed or prevented at release time.
 */
import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  api,
  type RegressionResult,
  type RegressionRun,
} from "../../lib/api-client";
import {
  advisoryEvidenceContext,
  evidenceStateLabel,
  evidenceStateTone,
  gateLabel,
  gateTone,
  parseFidelityBreakdown,
  regressionFreshnessReason,
  regressionEvidenceState,
  severityFromScore,
  summarizeRegressionReceipt,
  summarizeRegressionResults,
  surfaceReceiptIsCoherent,
  surfaceLabel,
  type RegressionEvidenceState,
} from "../../lib/regression-helpers";
import { Notice } from "../Notice";
import { PageHeader } from "../PageHeader";
import { Skeleton } from "../Skeleton";
import { DataTable, type DataTableColumn } from "../table/DataTable";
import "../../styles-ai-regression.css";

const RUN_LIMIT = 200;
const LIVE_POLL_MS = 5_000;
const FRESHNESS_WARNING_POLL_MS = 60_000;

function formatDate(value: string | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function badgeClass(tone: string): string {
  return tone === "neutral" ? "badge" : `badge ${tone}`;
}

function formatScore(score: number | null | undefined): string {
  return typeof score === "number" &&
    Number.isFinite(score) &&
    score >= 0 &&
    score <= 100
    ? `${Math.round(score)}/100`
    : "Unscored";
}

function resultSeverity(
  result: RegressionResult,
  warnThreshold: number,
): string {
  if (["ok", "warn", "critical", "error"].includes(result.severity)) {
    return result.severity;
  }
  if (
    typeof result.fidelity_score === "number" &&
    Number.isFinite(result.fidelity_score)
  ) {
    return severityFromScore(result.fidelity_score, warnThreshold);
  }
  return severityFromScore(result.fidelity_score, warnThreshold);
}

function hasDurableSnapshotProvenance(result: RegressionResult): boolean {
  return Boolean(
    result.example_id &&
    typeof result.brief === "string" &&
    typeof result.approved_output === "string" &&
    result.source_model_id &&
    result.source_created_at &&
    result.snapshotted_at &&
    typeof result.snapshot_ordinal === "number" &&
    Number.isInteger(result.snapshot_ordinal) &&
    result.snapshot_ordinal > 0,
  );
}

function runStateSummary(
  run: RegressionRun,
  state: RegressionEvidenceState,
  nowMs: number,
): string {
  const freshnessReason = regressionFreshnessReason(run, nowMs);
  const progress = summarizeRegressionReceipt(run);
  const remainingLabel = ["queued", "running", "stale"].includes(state)
    ? "remaining pending"
    : "unprocessed with no result receipt";
  const progressCopy = progress
    ? `${progress.processed.toLocaleString()} processed (${progress.scored.toLocaleString()} scored + ${progress.errored.toLocaleString()} persisted errors), ${progress.remaining.toLocaleString()} ${remainingLabel}`
    : "persisted progress counts are contradictory";
  switch (state) {
    case "queued":
      if (run.retry_not_before) {
        return `The server reports this replay as queued for retry no earlier than ${formatDate(run.retry_not_before)}. Receipt progress: ${progressCopy}.`;
      }
      if (run.stale_at) {
        return `The server requeued this replay after recording a stale lease at ${formatDate(run.stale_at)}. Receipt progress: ${progressCopy}.`;
      }
      return `The server reports this replay as queued. Receipt progress: ${progressCopy}.`;
    case "running":
      return `The server reports this replay as running. Receipt progress: ${progressCopy}. Its evidence is not final.`;
    case "stale":
      return freshnessReason === "server-lease-expired"
        ? `The server-recorded worker lease expired at ${formatDate(run.lease_expires_at)}. The run status remains ${run.status}; wait for a newer server receipt before drawing a terminal conclusion.`
        : "This in-flight replay has not received a newer timestamp within the UI freshness window. This is a client-age warning, not a server-authored worker state.";
    case "failed":
      return `The replay failed after ${run.attempt_count.toLocaleString()} of ${run.max_attempts.toLocaleString()} allowed attempts. Receipt progress: ${progressCopy}. Unprocessed snapshots are not error receipts.`;
    case "incomplete":
      return `The terminal summary is incomplete. Receipt progress: ${progressCopy}. It may also be missing a completion receipt, aggregate, or valid policy outcome.`;
    case "unscored":
      return `The server completed the replay with ${progressCopy}. No scored aggregate exists.`;
    case "completed":
      return `The terminal receipt records ${progressCopy}. ${run.passed_examples.toLocaleString()} of the scored examples were at or above the ${run.warn_threshold.toLocaleString()} warning threshold.`;
  }
}

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Bounded read-only
   evidence panes are intentionally focusable for keyboard scrolling. */
function SnapshotProvenance({
  result,
  rowIndex,
}: {
  result: RegressionResult;
  rowIndex: number;
}): ReactElement {
  const durableSnapshot = hasDurableSnapshotProvenance(result);
  return (
    <details className="ai-evidence-provenance">
      <summary
        aria-label={`Review ${durableSnapshot ? "frozen snapshot" : "legacy result"} provenance for result ${rowIndex + 1}`}
      >
        {durableSnapshot && typeof result.snapshot_ordinal === "number"
          ? `Snapshot ordinal ${result.snapshot_ordinal.toLocaleString()}`
          : "Review legacy provenance"}
      </summary>
      <p>
        {durableSnapshot
          ? "Immutable input captured for this replay. It does not describe the current mutable golden reference."
          : "This legacy result does not contain a complete frozen-input receipt. Missing fields are shown as unavailable and must not be inferred from the current golden reference."}
      </p>
      <dl>
        <div>
          <dt>Snapshot captured</dt>
          <dd>{formatDate(result.snapshotted_at ?? undefined)}</dd>
        </div>
        <div>
          <dt>Source created</dt>
          <dd>{formatDate(result.source_created_at ?? undefined)}</dd>
        </div>
        <div>
          <dt>Source model</dt>
          <dd>
            <bdi className="ai-regression-forensic">
              {result.source_model_id || "Not recorded"}
            </bdi>
          </dd>
        </div>
        <div>
          <dt>Voice profile version</dt>
          <dd>
            <bdi className="ai-regression-forensic">
              {result.voice_profile_version || "Not recorded"}
            </bdi>
          </dd>
        </div>
        <div>
          <dt>Approval receipt</dt>
          <dd>
            <bdi className="ai-regression-forensic">
              {result.approval_id || "Not recorded"}
            </bdi>
          </dd>
        </div>
        <div>
          <dt>Agent run</dt>
          <dd>
            <bdi className="ai-regression-forensic">
              {result.agent_run_id || "Not recorded"}
            </bdi>
          </dd>
        </div>
        <div className="ai-evidence-provenance__brief">
          <dt>{durableSnapshot ? "Frozen replay brief" : "Replay brief"}</dt>
          <dd>
            {typeof result.brief === "string" ? (
              <pre
                className="ai-regression-forensic-block"
                dir="auto"
                tabIndex={0}
              >
                {result.brief}
              </pre>
            ) : (
              "Not retained on this legacy result"
            )}
          </dd>
        </div>
      </dl>
    </details>
  );
}

function ScoreExplanation({
  result,
  rowIndex,
}: {
  result: RegressionResult;
  rowIndex: number;
}): ReactElement {
  const breakdown = parseFidelityBreakdown(
    result.breakdown,
    result.fidelity_score,
  );
  if (!breakdown) {
    return (
      <span className="muted">
        Score explanation unavailable for this legacy or malformed receipt.
      </span>
    );
  }
  const unit = (value: number): string =>
    `${Math.round(value * 100).toLocaleString()}%`;
  return (
    <details className="ai-evidence-score-explanation">
      <summary aria-label={`Explain fidelity score for result ${rowIndex + 1}`}>
        Explain score
      </summary>
      <p>
        Voice-profile fidelity diagnostics—not similarity to the frozen approved
        output. Receipt components use a 0–1 scale and are displayed as
        percentages; higher is closer. The historical stylistic_distance key
        already stores a positively weighted stylistic similarity, so it is not
        inverted again.
      </p>
      <dl>
        <div>
          <dt>Embedding similarity</dt>
          <dd>{unit(breakdown.embeddingSimilarity)}</dd>
        </div>
        <div>
          <dt>Stylistic match</dt>
          <dd>{unit(breakdown.stylisticMatch)}</dd>
        </div>
        <div>
          <dt>Vocabulary overlap</dt>
          <dd>{unit(breakdown.vocabularyOverlap)}</dd>
        </div>
        <div>
          <dt>Structural match</dt>
          <dd>{unit(breakdown.structuralMatch)}</dd>
        </div>
        <div>
          <dt>Combined</dt>
          <dd>{formatScore(breakdown.combined)}</dd>
        </div>
      </dl>
    </details>
  );
}

function EvidencePane({
  title,
  value,
  emptyMessage,
  kind,
}: {
  title: string;
  value: string | undefined;
  emptyMessage: string;
  kind: "approved" | "replayed" | "error";
}): ReactElement {
  return (
    <section data-evidence-kind={kind}>
      <h4>{title}</h4>
      {typeof value !== "string" ? (
        <p className="muted">{emptyMessage}</p>
      ) : value.length === 0 ? (
        <p className="muted">An empty value was recorded.</p>
      ) : (
        /* The bounded evidence pane must be keyboard-focusable so users can
           pan long approved or replayed text without relying on a pointer. */
        <pre className="ai-regression-forensic-block" dir="auto" tabIndex={0}>
          {value}
        </pre>
      )}
    </section>
  );
}
/* eslint-enable jsx-a11y/no-noninteractive-tabindex */

function OutputComparison({
  result,
  rowIndex,
}: {
  result: RegressionResult;
  rowIndex: number;
}): ReactElement {
  const hasErrorReceipt =
    result.severity === "error" ||
    typeof result.error_code === "string" ||
    typeof result.error_message === "string";
  const durableSnapshot = hasDurableSnapshotProvenance(result);
  return (
    <details className="ai-evidence-output">
      <summary
        aria-label={`Compare approved and replayed evidence for result ${rowIndex + 1}`}
      >
        Compare approved and replayed
      </summary>
      <p className="ai-evidence-comparison__context">
        {durableSnapshot
          ? "The approved side is the immutable snapshot used by this replay, not the current mutable golden reference."
          : "This legacy result has no complete frozen-input receipt. Any retained approved output is shown as legacy evidence, not asserted as the immutable replay input."}
      </p>
      <div className="ai-evidence-comparison">
        <EvidencePane
          title={
            durableSnapshot
              ? "Frozen approved output"
              : "Legacy approved output"
          }
          value={result.approved_output}
          emptyMessage="Approved output was not retained on this legacy result."
          kind="approved"
        />
        <EvidencePane
          title="Replayed output"
          value={result.replayed_output}
          emptyMessage={
            hasErrorReceipt
              ? "No replayed output was retained with this error receipt."
              : "No replayed output was recorded."
          }
          kind="replayed"
        />
      </div>
      {hasErrorReceipt ? (
        <section
          className="ai-evidence-comparison__error-receipt"
          aria-label="Persisted replay error receipt"
        >
          <h4>Persisted replay error receipt</h4>
          <dl>
            <div>
              <dt>Error code</dt>
              <dd>
                <bdi className="ai-regression-forensic">
                  {result.error_code || "Not recorded"}
                </bdi>
              </dd>
            </div>
            <div>
              <dt>Safe error detail</dt>
              <dd>
                <bdi className="ai-regression-forensic">
                  {result.error_message || "Not recorded"}
                </bdi>
              </dd>
            </div>
          </dl>
        </section>
      ) : null}
    </details>
  );
}

function SurfaceReceipts({
  run,
  showPolicyOutcome,
}: {
  run: RegressionRun;
  showPolicyOutcome: boolean;
}): ReactElement {
  const receipts = Object.entries(run.by_surface ?? {});
  if (receipts.length === 0) {
    return (
      <Notice tone="neutral" announcement="off">
        No per-surface terminal receipt was returned. Exact detail rows may be
        available below, but they are not substituted for that receipt.
      </Notice>
    );
  }
  return (
    <div
      className="ai-evidence-surfaces"
      aria-label="Server per-surface terminal receipts"
    >
      {receipts.map(([surfaceKind, surface]) => (
        <article
          className="ai-evidence-surface"
          data-coherent={surfaceReceiptIsCoherent(surface, run)}
          key={surfaceKind}
        >
          <strong>{surfaceLabel(surfaceKind)}</strong>
          <span>
            {formatScore(surface.scored > 0 ? surface.mean_score : undefined)}{" "}
            server mean
          </span>
          <span>
            {(surface.scored + surface.errors).toLocaleString()} of{" "}
            {surface.total.toLocaleString()} processed ·{" "}
            {Math.max(
              0,
              surface.total - surface.scored - surface.errors,
            ).toLocaleString()}{" "}
            unprocessed · no result receipt
          </span>
          <span>
            {surface.scored.toLocaleString()} scored ·{" "}
            {surface.errors.toLocaleString()} persisted errors
          </span>
          <span>
            {surface.passed.toLocaleString()} scored examples at or above
            warning threshold
          </span>
          <span>
            {showPolicyOutcome && surfaceReceiptIsCoherent(surface, run)
              ? gateLabel(surface.gate_result)
              : showPolicyOutcome
                ? "No coherent policy outcome"
                : "Overall receipt incomplete — policy outcome withheld"}
          </span>
          {surface.gate_result === "advisory" &&
          (surface.errors > 0 ||
            surface.scored + surface.errors < surface.total) ? (
            <span>
              Partial or error evidence is insufficient and non-authoritative.
            </span>
          ) : null}
          {!surfaceReceiptIsCoherent(surface, run) ? (
            <span>Incomplete per-surface receipt</span>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function RunResults({ run }: { run: RegressionRun }): ReactElement {
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState<RegressionResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const loadIdRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const loadId = ++loadIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await api.getRegressionRunResults(run.id);
      if (!mountedRef.current || loadId !== loadIdRef.current) return;
      if (response.error) {
        setError(response.error.message || "Could not load replay results.");
        return;
      }
      if (!response.data || !Array.isArray(response.data.items)) {
        setError("The server returned an invalid replay-results receipt.");
        return;
      }
      setResults(response.data.items);
    } catch {
      if (mountedRef.current && loadId === loadIdRef.current) {
        setError(
          "Could not load replay results. Check your connection and retry.",
        );
      }
    } finally {
      if (mountedRef.current && loadId === loadIdRef.current) setLoading(false);
    }
  }, [run.id]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      loadIdRef.current += 1;
    };
  }, [load]);

  const receipt = summarizeRegressionReceipt(run);

  if (loading && results.length === 0) {
    return (
      <div className="ai-evidence-results-loading" role="status">
        <span className="visually-hidden">Loading per-example evidence…</span>
        <Skeleton lines={4} aria-label="Loading per-example evidence" />
      </div>
    );
  }

  if (error && results.length === 0) {
    return (
      <Notice
        tone="danger"
        title="Replay evidence unavailable"
        action={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load()}
          >
            Retry
          </button>
        }
      >
        {error}
      </Notice>
    );
  }

  if (results.length === 0) {
    const noProcessedRows = receipt?.processed === 0;
    return (
      <Notice
        tone={noProcessedRows ? "neutral" : "warning"}
        title={
          noProcessedRows
            ? "No persisted result rows yet"
            : "Result detail is incomplete"
        }
        action={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load()}
          >
            Check again
          </button>
        }
      >
        The server receipt records{" "}
        {receipt?.processed.toLocaleString() ?? "an unknown number of"}{" "}
        processed rows: {run.scored_examples.toLocaleString()} scored and{" "}
        {run.error_examples.toLocaleString()} persisted errors. The remaining{" "}
        {receipt?.remaining.toLocaleString() ?? "unknown"} snapshots are
        unprocessed with no result receipt; they are not error receipts. The
        detail endpoint returned no rows and does not replace the receipt
        counts.
      </Notice>
    );
  }

  const coverage = summarizeRegressionResults(results);
  const expected = Math.max(0, run.total_examples);
  const detailMatchesReceipt = Boolean(
    receipt &&
    coverage.total === receipt.processed &&
    coverage.scored === receipt.scored &&
    coverage.errored === receipt.errored,
  );
  const columns: readonly DataTableColumn<RegressionResult>[] = [
    {
      id: "surface",
      header: "Surface",
      cell: (result) => surfaceLabel(result.surface_kind),
    },
    {
      id: "score",
      header: "Score",
      align: "end",
      cell: (result) => formatScore(result.fidelity_score),
    },
    {
      id: "severity",
      header: "Evaluation",
      cell: (result) => resultSeverity(result, run.warn_threshold),
    },
    {
      id: "score-explanation",
      header: "Score explanation",
      width: "min(24rem, 36vw)",
      cell: (result, rowIndex) => (
        <ScoreExplanation result={result} rowIndex={rowIndex} />
      ),
    },
    {
      id: "receipt-recorded",
      header: "Receipt recorded",
      cell: (result) => formatDate(result.scored_at),
    },
    {
      id: "snapshot-provenance",
      header: "Frozen snapshot",
      width: "min(22rem, 34vw)",
      cell: (result, rowIndex) => (
        <SnapshotProvenance result={result} rowIndex={rowIndex} />
      ),
    },
    {
      id: "replayed-output",
      header: "Approved vs replayed",
      width: "min(48rem, 64vw)",
      cell: (result, rowIndex) => (
        <OutputComparison result={result} rowIndex={rowIndex} />
      ),
    },
  ];

  return (
    <div className="ai-evidence-results">
      {error ? (
        <Notice
          tone="warning"
          title="Refresh failed; retained evidence shown"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void load()}
            >
              Retry
            </button>
          }
        >
          {error}
        </Notice>
      ) : null}

      <div
        className="ai-evidence-coverage"
        data-complete={detailMatchesReceipt}
      >
        <div>
          <span className="ai-evidence-coverage__value">
            {run.scored_examples.toLocaleString()} / {expected.toLocaleString()}
          </span>
          <span className="ai-evidence-coverage__label">
            scored · server receipt
          </span>
        </div>
        <div>
          <span className="ai-evidence-coverage__value">
            {run.error_examples.toLocaleString()}
          </span>
          <span className="ai-evidence-coverage__label">
            persisted errors · server receipt
          </span>
        </div>
        <div>
          <span className="ai-evidence-coverage__value">
            {receipt?.processed.toLocaleString() ?? "Invalid"} /{" "}
            {expected.toLocaleString()}
          </span>
          <span className="ai-evidence-coverage__label">
            processed · {receipt?.remaining.toLocaleString() ?? "?"}
            unprocessed · no result receipt
          </span>
        </div>
        <div>
          <span className="ai-evidence-coverage__value">
            {coverage.total.toLocaleString()} /{" "}
            {receipt?.processed.toLocaleString() ?? "?"}
          </span>
          <span className="ai-evidence-coverage__label">
            detail rows / processed receipts
          </span>
        </div>
      </div>

      {!detailMatchesReceipt ? (
        <Notice
          tone="warning"
          title="Detail rows disagree with terminal receipt"
          announcement="polite"
        >
          The terminal receipt records{" "}
          {receipt?.processed.toLocaleString() ?? "invalid"} processed:{" "}
          {run.scored_examples.toLocaleString()} scored and{" "}
          {run.error_examples.toLocaleString()} persisted errors, with{" "}
          {receipt?.remaining.toLocaleString() ?? "?"} unprocessed with no
          result receipt. The detail endpoint returned{" "}
          {coverage.total.toLocaleString()} rows with{" "}
          {coverage.scored.toLocaleString()} scored and{" "}
          {coverage.errored.toLocaleString()} errors. Treat the rows as a
          partial cross-check; they do not replace the terminal receipt.
        </Notice>
      ) : null}

      <DataTable
        caption="Per-example regression results"
        description={`Exact result rows returned for this replay, including frozen approved-vs-replayed comparison when snapshot evidence is available. Warning threshold: ${run.warn_threshold.toLocaleString()}/100.`}
        columns={columns}
        rows={results}
        getRowKey={(result) => String(result.id)}
        density="compact"
      />
    </div>
  );
}

function RunRow({
  run,
  nowMs,
}: {
  run: RegressionRun;
  nowMs: number;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const disclosureId = `${useId()}-run-evidence`;
  const state = regressionEvidenceState(run, nowMs);
  const stateTone = evidenceStateTone(state);
  const terminal =
    state !== "queued" && state !== "running" && state !== "stale";
  const gate =
    state === "completed" || state === "unscored" ? run.gate_result : undefined;
  const advisoryContext = advisoryEvidenceContext(run);
  const receivedAt = run.completed_at ?? run.started_at ?? run.created_at;

  return (
    <article
      className="ai-evidence-run"
      data-testid="model-changelog-run"
      data-evidence-state={state}
    >
      <div className="ai-evidence-run__header">
        <div className="ai-evidence-run__identity">
          <div className="ai-evidence-run__title-row">
            <strong>
              Operator correlation label:{" "}
              <bdi className="ai-regression-forensic">
                {run.model_version_tag || "Not recorded"}
              </bdi>
            </strong>
            <span className={badgeClass(stateTone)}>
              {evidenceStateLabel(state)}
            </span>
            {gate ? (
              <span className={badgeClass(gateTone(gate))}>
                {gateLabel(gate)}
              </span>
            ) : null}
          </div>
          <div className="ai-evidence-run__tags">
            <span>
              Server-attested provider:{" "}
              <bdi className="ai-regression-forensic">
                {run.runtime_provider || "not recorded"}
              </bdi>
            </span>
            <span>
              Server-attested model ID:{" "}
              <bdi className="ai-regression-forensic">
                {run.model_id || "not recorded"}
              </bdi>
            </span>
            <span>
              Server-attested prompt policy:{" "}
              <bdi className="ai-regression-forensic">
                {run.prompt_version_tag || "not recorded"}
              </bdi>
            </span>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost ai-evidence-run__toggle"
          aria-expanded={open}
          aria-controls={disclosureId}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Hide evidence" : "Review evidence"}
        </button>
      </div>

      <div className="ai-evidence-run__summary">
        <span>{runStateSummary(run, state, nowMs)}</span>
        {advisoryContext ? <span>{advisoryContext}</span> : null}
        <span>
          Latest run timestamp:{" "}
          <time dateTime={receivedAt}>{formatDate(receivedAt)}</time>
        </span>
        {state !== "unscored" &&
        typeof run.fidelity_score_mean === "number" &&
        Number.isFinite(run.fidelity_score_mean) ? (
          <span>Server aggregate: {formatScore(run.fidelity_score_mean)}</span>
        ) : null}
      </div>

      {run.status === "failed" && run.error_message ? (
        <div
          className="ai-evidence-run__error ai-regression-forensic-block"
          dir="auto"
        >
          {run.error_message}
        </div>
      ) : null}

      {open ? (
        <div
          id={disclosureId}
          className="ai-evidence-run__region"
          role="region"
          aria-label={`Evidence for operator correlation label ${run.model_version_tag || "not recorded"}`}
        >
          <dl className="ai-evidence-run__metadata">
            <div>
              <dt>Server-attested provider</dt>
              <dd>
                <bdi className="ai-regression-forensic">
                  {run.runtime_provider || "Not recorded"}
                </bdi>
              </dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatDate(run.created_at)}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{formatDate(run.started_at)}</dd>
            </div>
            <div>
              <dt>Completed</dt>
              <dd>{formatDate(run.completed_at)}</dd>
            </div>
            <div>
              <dt>Last server update</dt>
              <dd>{formatDate(run.updated_at)}</dd>
            </div>
            <div>
              <dt>Heartbeat</dt>
              <dd>{formatDate(run.heartbeat_at)}</dd>
            </div>
            <div>
              <dt>Lease expires</dt>
              <dd>{formatDate(run.lease_expires_at)}</dd>
            </div>
            <div>
              <dt>Retry eligible</dt>
              <dd>{formatDate(run.retry_not_before)}</dd>
            </div>
            <div>
              <dt>Stale lease recorded</dt>
              <dd>{formatDate(run.stale_at)}</dd>
            </div>
            <div>
              <dt>Snapshot frozen</dt>
              <dd>{formatDate(run.snapshot_frozen_at)}</dd>
            </div>
            <div>
              <dt>Attempts</dt>
              <dd>
                {run.attempt_count.toLocaleString()} /{" "}
                {run.max_attempts.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt>Warning threshold</dt>
              <dd>{run.warn_threshold.toLocaleString()}/100</dd>
            </div>
            <div>
              <dt>Frozen policy mode</dt>
              <dd>
                {run.hard_gate_enabled
                  ? "Threshold-outcome mode enabled"
                  : "Advisory mode"}
              </dd>
            </div>
            <div>
              <dt>Hard threshold</dt>
              <dd>
                {run.hard_gate_enabled
                  ? typeof run.hard_gate_threshold === "number" &&
                    Number.isFinite(run.hard_gate_threshold)
                    ? formatScore(run.hard_gate_threshold)
                    : "Not recorded"
                  : "Not applicable in advisory mode"}
              </dd>
            </div>
            <div>
              <dt>Minimum scored examples</dt>
              <dd>{run.min_examples_for_gate.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Mean fidelity score</dt>
              <dd>
                {typeof run.fidelity_score_mean === "number" &&
                Number.isFinite(run.fidelity_score_mean)
                  ? formatScore(run.fidelity_score_mean)
                  : "Not recorded"}
              </dd>
            </div>
            <div>
              <dt>Lower-quartile score (p25)</dt>
              <dd>
                {typeof run.fidelity_score_p25 === "number" &&
                Number.isFinite(run.fidelity_score_p25)
                  ? formatScore(run.fidelity_score_p25)
                  : "Not recorded"}
              </dd>
            </div>
            <div>
              <dt>Evaluation basis</dt>
              <dd>Mean-based; p25 is context and is not consumed by policy</dd>
            </div>
            <div>
              <dt>Failure code</dt>
              <dd>
                <bdi className="ai-regression-forensic">
                  {run.error_code || "Not recorded"}
                </bdi>
              </dd>
            </div>
          </dl>
          {terminal ? (
            <>
              <SurfaceReceipts
                run={run}
                showPolicyOutcome={
                  state === "completed" || state === "unscored"
                }
              />
              <RunResults run={run} />
            </>
          ) : (
            <Notice tone={state === "stale" ? "warning" : "info"}>
              Per-example results are not requested while this run remains
              in-flight. Refreshing will retain the current snapshot.
            </Notice>
          )}
        </div>
      ) : null}
    </article>
  );
}

export function ModelChangelogPanel(): ReactElement {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [runs, setRuns] = useState<RegressionRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const mountedRef = useRef(false);
  const runsRequestPromiseRef = useRef<Promise<void> | null>(null);
  const runsRef = useRef<RegressionRun[]>([]);

  const loadRuns = useCallback(
    (initial = false, announceRefresh = true): Promise<void> => {
      if (runsRequestPromiseRef.current) {
        return runsRequestPromiseRef.current;
      }
      if (initial && runsRef.current.length === 0) setLoading(true);
      else if (announceRefresh) setRefreshing(true);

      let request!: Promise<void>;
      request = Promise.resolve().then(async () => {
        try {
          const response = await api.listRegressionRuns({ limit: RUN_LIMIT });
          if (!mountedRef.current) return;
          if (response.error) {
            const status = response.error.status;
            const message =
              status === 404 || status === 501 || status === 503
                ? "AI regression evidence is currently unavailable."
                : response.error.message ||
                  "Could not load AI regression evidence.";
            if (runsRef.current.length === 0) setError(message);
            else setRefreshError(message);
            return;
          }
          if (!response.data || !Array.isArray(response.data.items)) {
            const message =
              "The server returned an invalid regression-run receipt.";
            if (runsRef.current.length === 0) setError(message);
            else setRefreshError(message);
            return;
          }
          const nextRuns = response.data.items;
          runsRef.current = nextRuns;
          setRuns(nextRuns);
          setError(null);
          setRefreshError(null);
          setLastUpdatedAt(new Date());
          setNowMs(Date.now());
        } catch {
          if (!mountedRef.current) return;
          const message =
            "Could not load AI regression evidence. Check your connection and retry.";
          if (runsRef.current.length === 0) setError(message);
          else setRefreshError(message);
        } finally {
          if (runsRequestPromiseRef.current === request) {
            runsRequestPromiseRef.current = null;
          }
          if (mountedRef.current) {
            setLoading(false);
            if (announceRefresh) setRefreshing(false);
          }
        }
      });
      runsRequestPromiseRef.current = request;
      return request;
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    void loadRuns(true);
    return () => {
      mountedRef.current = false;
    };
  }, [loadRuns]);

  const runStates = useMemo(
    () => runs.map((run) => regressionEvidenceState(run, nowMs)),
    [nowMs, runs],
  );
  const hasFreshInFlight = runStates.some(
    (state) => state === "queued" || state === "running",
  );
  const hasFreshnessWarning = runStates.includes("stale");

  useEffect(() => {
    if (!hasFreshInFlight && !hasFreshnessWarning) return;
    const interval = window.setInterval(
      () => {
        setNowMs(Date.now());
        if (!document.hidden) void loadRuns(false, false);
      },
      hasFreshInFlight ? LIVE_POLL_MS : FRESHNESS_WARNING_POLL_MS,
    );
    return () => window.clearInterval(interval);
  }, [hasFreshInFlight, hasFreshnessWarning, loadRuns]);

  const counts = useMemo(() => {
    const count = (wanted: RegressionEvidenceState[]): number =>
      runStates.filter((state) => wanted.includes(state)).length;
    return {
      active: count(["queued", "running"]),
      freshness: count(["stale"]),
      issues: count(["failed", "incomplete", "unscored"]),
    };
  }, [runStates]);

  return (
    <section
      className="ai-evidence-workspace"
      data-testid="model-changelog-panel"
    >
      <PageHeader
        eyebrow="AI evidence"
        title="AI Changelog"
        subtitle="Inspect operator-labelled replay evidence alongside server-attested model and prompt identity, coverage, freshness, and per-surface results."
        meta={
          lastUpdatedAt
            ? `Snapshot received ${lastUpdatedAt.toLocaleString()}`
            : "No snapshot received"
        }
        actions={[
          {
            label: refreshing ? "Refreshing…" : "Refresh evidence",
            onClick: () => void loadRuns(),
            disabled: loading || refreshing,
          },
        ]}
      />

      <Notice
        tone="info"
        title="Recorded evidence, not release control"
        announcement="off"
      >
        Pass, concern, and advisory labels are saved policy evaluations. No
        deployment-authority receipt is connected here, so these outcomes do not
        prove that an upgrade was allowed or prevented.
      </Notice>

      {runs.length > 0 ? (
        <div
          className="ai-evidence-overview"
          aria-label="Regression evidence overview"
        >
          <article>
            <span>Runs in view</span>
            <strong>{runs.length.toLocaleString()}</strong>
            <small>Latest {RUN_LIMIT.toLocaleString()} requested</small>
          </article>
          <article>
            <span>Awaiting results</span>
            <strong>{counts.active.toLocaleString()}</strong>
            <small>Server-reported queued or running</small>
          </article>
          <article>
            <span>Freshness warnings</span>
            <strong>{counts.freshness.toLocaleString()}</strong>
            <small>Server lease expiry or client-age fallback</small>
          </article>
          <article>
            <span>Evidence issues</span>
            <strong>{counts.issues.toLocaleString()}</strong>
            <small>Failed, incomplete, or unscored</small>
          </article>
        </div>
      ) : null}

      {refreshing && runs.length > 0 ? (
        <div
          className="ai-evidence-refresh-status"
          role="status"
          aria-live="polite"
        >
          Refreshing evidence; the current snapshot remains visible.
        </div>
      ) : null}
      {refreshError ? (
        <Notice
          tone="warning"
          title="Refresh failed; retained snapshot shown"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void loadRuns()}
            >
              Retry
            </button>
          }
        >
          {refreshError}
        </Notice>
      ) : null}

      {loading && runs.length === 0 ? (
        <div className="ai-evidence-initial-loading" role="status">
          <Skeleton
            variant="card"
            aria-label="Loading AI regression evidence"
          />
          <Skeleton variant="card" />
          <Skeleton variant="card" />
        </div>
      ) : error && runs.length === 0 ? (
        <Notice
          tone="danger"
          title="AI regression evidence unavailable"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void loadRuns(true)}
            >
              Retry
            </button>
          }
        >
          {error}
        </Notice>
      ) : runs.length === 0 ? (
        <Notice
          tone="neutral"
          title="No regression runs yet"
          announcement="off"
        >
          Golden references can be reviewed in Settings. An administrator can
          request a replay when a change is ready to evaluate and attach an
          operator correlation label for cross-system lookup.
        </Notice>
      ) : (
        <div className="ai-evidence-runs" aria-label="Regression runs">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} nowMs={nowMs} />
          ))}
        </div>
      )}
    </section>
  );
}
