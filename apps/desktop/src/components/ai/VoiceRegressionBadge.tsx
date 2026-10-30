/**
 * Compact regression evidence shown in the AI trust panel.
 *
 * This is intentionally an evidence receipt, not a release-control badge: the
 * API exposes a recorded policy evaluation but no deployment enforcement
 * receipt.
 */
import { type ReactElement, useEffect, useRef, useState } from "react";

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
  regressionFreshnessReason,
  regressionEvidenceState,
  summarizeRegressionReceipt,
  summarizeRegressionResults,
  surfaceReceiptIsCoherent,
  surfaceLabel,
  type RegressionEvidenceState,
} from "../../lib/regression-helpers";
import { ConfidenceNote, SampleSize } from "../common/Provenance";
import { Notice } from "../Notice";
import { Skeleton } from "../Skeleton";
import "../../styles-ai-regression.css";

const LEGACY_LOW_SAMPLE_FALLBACK = 5;
const REGRESSION_POLL_MS = 5_000;
const FRESHNESS_WARNING_POLL_MS = 60_000;
const TERMINAL_POLL_MS = 60_000;

function badgeClass(tone: string): string {
  return tone === "neutral" ? "badge" : `badge ${tone}`;
}

function formatDate(value: string | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatScore(value: number | null | undefined): string {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? `${Math.round(value)}/100`
    : "Unscored";
}

function LoadingBadge(): ReactElement {
  return (
    <div
      className="ai-regression-badge ai-regression-badge--loading"
      data-testid="voice-regression-badge-loading"
      role="status"
    >
      <Skeleton lines={2} aria-label="Checking regression evidence" />
    </div>
  );
}

function ErrorBadge({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <Notice
      tone="warning"
      title="Regression evidence unavailable"
      data-testid="voice-regression-badge-error"
      action={
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      }
    >
      {error}
    </Notice>
  );
}

function EmptyBadge(): ReactElement {
  return (
    <div
      className="ai-regression-badge ai-regression-badge--empty"
      data-testid="voice-regression-badge-empty"
    >
      <strong>No regression evidence yet</strong>
      <span>
        Approve known-good outputs to build a golden set, then ask an
        administrator to request a replay.
      </span>
    </div>
  );
}

function InFlightBadge({
  run,
  state,
  refreshing,
  error,
  onRetry,
}: {
  run: RegressionRun;
  state: Extract<RegressionEvidenceState, "queued" | "running" | "stale">;
  refreshing: boolean;
  error: string | null;
  onRetry: () => void;
}): ReactElement {
  const freshnessReason = regressionFreshnessReason(run);
  const progress = summarizeRegressionReceipt(run);
  return (
    <div
      className="ai-regression-badge"
      data-testid={
        state === "stale"
          ? "voice-regression-badge-stale"
          : "voice-regression-badge-pending"
      }
      data-status={run.status}
      data-evidence-state={state}
    >
      <div className="ai-regression-badge__heading">
        <strong>{evidenceStateLabel(state)}</strong>
        <span className={badgeClass(evidenceStateTone(state))}>
          {run.status === "pending" ? "Server: pending" : "Server: running"}
        </span>
      </div>
      <span
        className="sr-only ai-regression-badge__live-progress"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {evidenceStateLabel(state)}.{" "}
        {progress
          ? `${progress.processed.toLocaleString()} of ${Math.max(0, run.total_examples).toLocaleString()} processed.`
          : "Progress receipt is contradictory."}
      </span>
      <span>
        {state === "stale"
          ? freshnessReason === "server-lease-expired"
            ? `The server-recorded lease expired at ${formatDate(run.lease_expires_at)}. The run remains ${run.status} until a newer server receipt arrives.`
            : "The latest timestamp is older than the UI freshness window. This client-age fallback does not prove the worker stopped."
          : "A score and policy outcome are not available yet."}
      </span>
      {progress ? (
        <span>
          {progress.processed.toLocaleString()} processed (
          {progress.scored.toLocaleString()} scored +{" "}
          {progress.errored.toLocaleString()} persisted errors) ·{" "}
          {progress.remaining.toLocaleString()} remaining pending
        </span>
      ) : (
        <span>Persisted progress counts are contradictory.</span>
      )}
      <span className="muted">
        Operator correlation label:{" "}
        <bdi className="ai-regression-forensic">
          {run.model_version_tag || "not recorded"}
        </bdi>{" "}
        · Server-attested provider:{" "}
        <bdi className="ai-regression-forensic">
          {run.runtime_provider || "not recorded"}
        </bdi>{" "}
        · Server-attested model ID:{" "}
        <bdi className="ai-regression-forensic">
          {run.model_id || "not recorded"}
        </bdi>{" "}
        · Server-attested prompt policy:{" "}
        <bdi className="ai-regression-forensic">
          {run.prompt_version_tag || "not recorded"}
        </bdi>
      </span>
      {refreshing ? <span>Checking for a newer receipt…</span> : null}
      {error ? (
        <Notice
          tone="warning"
          title="Refresh failed; retained status shown"
          action={
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Retry
            </button>
          }
        >
          {error}
        </Notice>
      ) : null}
    </div>
  );
}

function FailedBadge({
  run,
  refreshing,
  error,
  onRetry,
}: {
  run: RegressionRun;
  refreshing: boolean;
  error: string | null;
  onRetry: () => void;
}): ReactElement {
  const receipt = summarizeRegressionReceipt(run);
  return (
    <div
      className="ai-regression-badge ai-regression-badge--danger"
      data-testid="voice-regression-badge-failed"
      role="alert"
    >
      <strong>Regression replay failed</strong>
      <span className="ai-regression-forensic-block" dir="auto">
        {run.error_message || "The server did not record a failure detail."}
      </span>
      <span className="muted">
        {receipt
          ? `${receipt.processed.toLocaleString()} processed (${receipt.scored.toLocaleString()} scored + ${receipt.errored.toLocaleString()} persisted errors); ${receipt.remaining.toLocaleString()} unprocessed with no result receipt.`
          : "Persisted progress counts are contradictory."}
      </span>
      <span className="muted">No continuity conclusion is available.</span>
      {refreshing ? <span role="status">Checking for a newer run…</span> : null}
      {error ? (
        <Notice
          tone="warning"
          title="Refresh failed; retained failure shown"
          action={
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Retry
            </button>
          }
        >
          {error}
        </Notice>
      ) : null}
    </div>
  );
}

function TerminalBadge({
  run,
  state,
  results,
  resultsLoading,
  resultsError,
  refreshing,
  error,
  onRetry,
}: {
  run: RegressionRun;
  state: Extract<
    RegressionEvidenceState,
    "incomplete" | "unscored" | "completed"
  >;
  results: RegressionResult[] | null;
  resultsLoading: boolean;
  resultsError: string | null;
  refreshing: boolean;
  error: string | null;
  onRetry: () => void;
}): ReactElement {
  const receipt = summarizeRegressionReceipt(run);
  const detailCoverage = results ? summarizeRegressionResults(results) : null;
  const expected = Math.max(0, run.total_examples);
  const detailMatchesReceipt = Boolean(
    detailCoverage &&
    receipt &&
    detailCoverage.total === receipt.processed &&
    detailCoverage.scored === receipt.scored &&
    detailCoverage.errored === receipt.errored,
  );
  const lowSampleThreshold =
    Number.isInteger(run.min_examples_for_gate) &&
    run.min_examples_for_gate >= 1
      ? run.min_examples_for_gate
      : LEGACY_LOW_SAMPLE_FALLBACK;
  const advisoryContext = advisoryEvidenceContext(run);
  const displayedGate =
    state === "completed" || state === "unscored" ? run.gate_result : undefined;
  const policyTone = gateTone(displayedGate);
  const surfaceReceipts = Object.entries(run.by_surface ?? {});
  const headline =
    state === "incomplete"
      ? "Regression summary is incomplete"
      : state === "unscored"
        ? "Regression replay is unscored"
        : "Recorded policy evaluation";

  return (
    <div
      className="ai-regression-badge"
      data-testid="voice-regression-badge"
      data-gate={displayedGate}
      data-evidence-state={state}
      data-detail-aligned={results ? detailMatchesReceipt : undefined}
    >
      <div className="ai-regression-badge__heading">
        <strong>{headline}</strong>
        <span className={badgeClass(evidenceStateTone(state))}>
          {evidenceStateLabel(state)}
        </span>
        {displayedGate ? (
          <span className={badgeClass(policyTone)}>
            {gateLabel(displayedGate)}
          </span>
        ) : null}
      </div>

      <div className="ai-regression-badge__identity">
        <span>
          Operator correlation label:{" "}
          <bdi className="ai-regression-forensic">
            {run.model_version_tag || "not recorded"}
          </bdi>
        </span>
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
        <span>{formatDate(run.completed_at ?? run.created_at)}</span>
      </div>

      {refreshing ? (
        <span role="status">Refreshing the latest evidence…</span>
      ) : null}
      {error ? (
        <Notice tone="warning" title="Refresh failed; retained evidence shown">
          {error}
        </Notice>
      ) : null}

      <div className="ai-regression-badge__metrics">
        <span>
          <strong>
            {formatScore(
              state === "unscored" ? undefined : run.fidelity_score_mean,
            )}
          </strong>{" "}
          server aggregate
        </span>
        <span>
          <strong>
            {receipt?.processed.toLocaleString() ?? "Invalid"} /{" "}
            {expected.toLocaleString()}
          </strong>{" "}
          processed · {receipt?.remaining.toLocaleString() ?? "?"} unprocessed ·
          no result receipt
        </span>
        <span>
          <strong>{run.scored_examples.toLocaleString()} scored</strong>{" "}
          {run.error_examples.toLocaleString()} persisted errors
        </span>
      </div>
      <SampleSize n={run.scored_examples} noun="scored golden examples" />
      {run.scored_examples > 0 && run.scored_examples < lowSampleThreshold ? (
        <ConfidenceNote level="low" />
      ) : null}

      {resultsLoading && !detailCoverage ? (
        <div role="status" className="ai-regression-badge__coverage-loading">
          <Skeleton lines={2} aria-label="Loading per-example detail" />
        </div>
      ) : resultsError ? (
        <Notice
          tone="warning"
          title="Per-example detail unavailable"
          action={
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Retry evidence
            </button>
          }
        >
          {resultsError} The server-scored denominator above remains available;
          the saved policy label is not presented as continuity proof.
        </Notice>
      ) : detailCoverage && !detailMatchesReceipt ? (
        <Notice
          tone="warning"
          title="Detail rows disagree with terminal receipt"
          announcement="off"
        >
          The detail endpoint returned {detailCoverage.total.toLocaleString()}{" "}
          rows with {detailCoverage.scored.toLocaleString()} scored and{" "}
          {detailCoverage.errored.toLocaleString()} persisted errors. The server
          receipt expects {receipt?.processed.toLocaleString() ?? "invalid"}{" "}
          processed rows; the detail rows do not replace it.
        </Notice>
      ) : null}

      {surfaceReceipts.length > 0 ? (
        <ul
          className="ai-regression-badge__surfaces"
          aria-label="Server per-surface terminal receipts"
        >
          {surfaceReceipts.map(([surfaceKind, surface]) => (
            <li
              key={surfaceKind}
              data-coherent={surfaceReceiptIsCoherent(surface, run)}
            >
              <strong>{surfaceLabel(surfaceKind)}</strong>:{" "}
              {formatScore(surface.scored > 0 ? surface.mean_score : undefined)}{" "}
              server mean · {(surface.scored + surface.errors).toLocaleString()}
              /{surface.total.toLocaleString()} processed ·{" "}
              {Math.max(
                0,
                surface.total - surface.scored - surface.errors,
              ).toLocaleString()}{" "}
              unprocessed · no result receipt ·{" "}
              {surface.scored.toLocaleString()} scored ·{" "}
              {surface.errors.toLocaleString()} persisted errors ·{" "}
              {(state === "completed" || state === "unscored") &&
              surfaceReceiptIsCoherent(surface, run)
                ? gateLabel(surface.gate_result)
                : state === "completed" || state === "unscored"
                  ? "No coherent policy outcome"
                  : "Overall receipt incomplete — policy outcome withheld"}
              {!surfaceReceiptIsCoherent(surface, run)
                ? " · Incomplete receipt"
                : ""}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="ai-regression-badge__disclaimer">
        {advisoryContext
          ? `${advisoryContext} No deployment-authority receipt is connected.`
          : "This recorded evaluation has no connected deployment-authority receipt."}
      </p>
    </div>
  );
}

export function VoiceRegressionBadge(): ReactElement {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [run, setRun] = useState<RegressionRun | null>(null);
  const [results, setResults] = useState<RegressionResult[] | null>(null);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultsError, setResultsError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const activeRunIdRef = useRef<string | null>(null);
  const latestRunRef = useRef<RegressionRun | null>(null);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | undefined;
    let requestActive = false;

    const schedule = (delay: number): void => {
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(() => {
        if (document.hidden) schedule(delay);
        else void load(false, false);
      }, delay);
    };

    const pollDelayFor = (latest: RegressionRun | null): number => {
      if (!latest) return TERMINAL_POLL_MS;
      const state = regressionEvidenceState(latest);
      if (state === "queued" || state === "running") {
        return REGRESSION_POLL_MS;
      }
      return state === "stale" ? FRESHNESS_WARNING_POLL_MS : TERMINAL_POLL_MS;
    };

    const loadResults = async (latest: RegressionRun): Promise<void> => {
      if (!cancelled) setResultsLoading(true);
      try {
        const response = await api.getRegressionRunResults(latest.id);
        if (cancelled || activeRunIdRef.current !== latest.id) return;
        if (response.error) {
          setResultsError(
            response.error.message || "Could not load per-example details.",
          );
          return;
        }
        if (!response.data || !Array.isArray(response.data.items)) {
          setResultsError(
            "The server returned an invalid per-example detail receipt.",
          );
          return;
        }
        setResults(response.data.items);
        setResultsError(null);
      } catch {
        if (!cancelled && activeRunIdRef.current === latest.id) {
          setResultsError(
            "Could not load per-example details. Check your connection and retry.",
          );
        }
      } finally {
        if (!cancelled && activeRunIdRef.current === latest.id) {
          setResultsLoading(false);
        }
      }
    };

    const load = async (
      initial: boolean,
      announceRefresh = true,
    ): Promise<void> => {
      if (requestActive) return;
      requestActive = true;
      if (initial) setLoading(true);
      else if (announceRefresh) setRefreshing(true);
      try {
        const response = await api.getLatestRegressionRun();
        if (cancelled) return;
        if (response.error) {
          const status = response.error.status;
          setError(
            status === 404 || status === 501 || status === 503
              ? "Regression evidence is currently unavailable."
              : response.error.message || "Could not load regression evidence.",
          );
          schedule(pollDelayFor(latestRunRef.current));
          return;
        }
        if (
          !response.data ||
          !Object.prototype.hasOwnProperty.call(response.data, "run")
        ) {
          setError("The server returned an invalid latest-run receipt.");
          schedule(pollDelayFor(latestRunRef.current));
          return;
        }
        const latest = response.data.run;
        const identityChanged = latest?.id !== activeRunIdRef.current;
        if (identityChanged) {
          activeRunIdRef.current = latest?.id ?? null;
          setResults(null);
          setResultsError(null);
          setResultsLoading(false);
        }
        latestRunRef.current = latest;
        setRun(latest);
        setError(null);
        if (!latest) {
          schedule(TERMINAL_POLL_MS);
          return;
        }

        const state = regressionEvidenceState(latest);
        if (state === "queued" || state === "running" || state === "stale") {
          schedule(pollDelayFor(latest));
          return;
        }
        await loadResults(latest);
        schedule(TERMINAL_POLL_MS);
      } catch {
        if (!cancelled) {
          setError(
            "Could not load regression evidence. Check your connection and retry.",
          );
          schedule(pollDelayFor(latestRunRef.current));
        }
      } finally {
        requestActive = false;
        if (!cancelled) {
          setLoading(false);
          if (announceRefresh) setRefreshing(false);
        }
      }
    };

    void load(true);
    return () => {
      cancelled = true;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    };
  }, [retryKey]);

  if (loading && !run) {
    return <LoadingBadge />;
  }

  if (error && !run) {
    return (
      <ErrorBadge
        error={error}
        onRetry={() => setRetryKey((current) => current + 1)}
      />
    );
  }

  if (!run) {
    return <EmptyBadge />;
  }

  const state = regressionEvidenceState(run);
  if (state === "queued" || state === "running" || state === "stale") {
    return (
      <InFlightBadge
        run={run}
        state={state}
        refreshing={refreshing}
        error={error}
        onRetry={() => setRetryKey((current) => current + 1)}
      />
    );
  }

  if (state === "failed") {
    return (
      <FailedBadge
        run={run}
        refreshing={refreshing}
        error={error}
        onRetry={() => setRetryKey((current) => current + 1)}
      />
    );
  }

  return (
    <TerminalBadge
      run={run}
      state={state}
      results={results}
      resultsLoading={resultsLoading}
      resultsError={resultsError}
      refreshing={refreshing}
      error={error}
      onRetry={() => setRetryKey((current) => current + 1)}
    />
  );
}
