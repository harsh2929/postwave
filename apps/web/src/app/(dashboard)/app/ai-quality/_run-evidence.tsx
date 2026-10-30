// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Evidence for the selected regression run: the detail read, per-result rows,
// and the frozen forensic texts. Loaded on demand by the control plane once a
// run is expanded, so the eager route chunk stays inside the bundle budget.

import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
} from "@/components/governance/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  AiRegressionResult,
  AiRegressionRun,
  AiRegressionSurface,
} from "@/lib/ai-regression-api";
import { apiErrorMessage } from "@/lib/api";
import { formatWireTimestamp } from "@/lib/go-zero-time";

import { gateVariant, surfaceLabel } from "./_ai-quality-helpers";

export function RunEvidence({
  summary,
  detail,
  detailLoading,
  detailError,
  results,
  resultsLoading,
  resultsError,
  refreshing,
  onRefresh,
}: {
  summary: AiRegressionRun;
  detail: AiRegressionRun | undefined;
  detailLoading: boolean;
  detailError: unknown;
  results: AiRegressionResult[] | undefined;
  resultsLoading: boolean;
  resultsError: unknown;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const run = detail ?? summary;
  return (
    <section
      className="mt-4 space-y-4 border-t pt-4"
      aria-label={`Evidence for run ${run.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-medium">Frozen run evidence</h4>
          <p className="text-xs text-muted-foreground">
            Active runs refresh every five seconds while expanded.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={refreshing}
          onClick={onRefresh}
        >
          {refreshing ? "Refreshing…" : "Refresh evidence"}
        </Button>
      </div>
      {detailLoading ? (
        <GovernanceLoading label="Loading exact run receipt…" rows={2} />
      ) : detailError ? (
        <GovernanceError
          message={apiErrorMessage(
            detailError,
            "Exact run detail could not be verified.",
          )}
          retrying={refreshing}
          onRetry={onRefresh}
        />
      ) : (
        <>
          <dl className="grid gap-3 rounded-lg bg-muted/25 p-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Replay policy</dt>
              <dd className="break-all">{run.promptVersionTag}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                Frozen thresholds
              </dt>
              <dd>
                warn {run.warnThreshold} ·{" "}
                {run.hardGateEnabled
                  ? `classification ${run.hardGateThreshold ?? "unavailable"}`
                  : "advisory only"}{" "}
                · min {run.minExamplesForGate}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Attempts</dt>
              <dd>
                {run.attemptCount} / {run.maxAttempts}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Snapshot frozen</dt>
              <dd>
                {formatWireTimestamp(run.snapshotFrozenAt, "Not reported")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Started</dt>
              <dd>{formatWireTimestamp(run.startedAt, "Not started")}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Completed</dt>
              <dd>{formatWireTimestamp(run.completedAt, "Not completed")}</dd>
            </div>
          </dl>
          {Object.entries(run.bySurface).length ? (
            <div>
              <h5 className="mb-2 font-medium">Per-surface aggregates</h5>
              <ul className="grid gap-2 sm:grid-cols-2">
                {Object.entries(run.bySurface).map(([surface, aggregate]) =>
                  aggregate ? (
                    <li key={surface} className="rounded-lg border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span>
                          {surfaceLabel(surface as AiRegressionSurface)}
                        </span>
                        <Badge variant={gateVariant(aggregate.gateResult)}>
                          {aggregate.gateResult}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {aggregate.scored}/{aggregate.total} scored ·{" "}
                        {aggregate.errors} errors · mean{" "}
                        {aggregate.meanScore ?? "unavailable"}
                      </p>
                    </li>
                  ) : null,
                )}
              </ul>
            </div>
          ) : null}
        </>
      )}

      <div>
        <h5 className="mb-2 font-medium">Per-reference receipts</h5>
        {resultsLoading ? (
          <GovernanceLoading label="Loading per-reference results…" rows={3} />
        ) : resultsError ? (
          <GovernanceError
            message={apiErrorMessage(
              resultsError,
              "Per-reference evidence could not be verified.",
            )}
            retrying={refreshing}
            onRetry={onRefresh}
          />
        ) : !results?.length ? (
          <GovernanceEmpty>
            {run.status === "pending" || run.status === "running"
              ? "No result receipts have landed yet."
              : "No per-reference receipts were returned."}
          </GovernanceEmpty>
        ) : (
          <ol className="space-y-3">
            {results.map((result) => (
              <RegressionResultRow key={result.id} result={result} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function RegressionResultRow({ result }: { result: AiRegressionResult }) {
  const variant =
    result.severity === "ok"
      ? "success"
      : result.severity === "error" || result.severity === "critical"
        ? "destructive"
        : "warning";
  return (
    <li className="rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={variant}>{result.severity}</Badge>
          <span>{surfaceLabel(result.surfaceKind)}</span>
          {result.snapshotOrdinal ? (
            <span className="text-xs text-muted-foreground">
              Snapshot #{result.snapshotOrdinal}
            </span>
          ) : null}
        </div>
        <span className="tabular-nums">
          {result.fidelityScore === null
            ? "No score"
            : `${result.fidelityScore.toFixed(1)} / 100`}
        </span>
      </div>
      {result.errorMessage ? (
        <p className="mt-2 break-words text-destructive" dir="auto">
          {result.errorCode ? `${result.errorCode}: ` : ""}
          {result.errorMessage}
        </p>
      ) : null}
      <details className="mt-3 rounded-md bg-muted/25 p-3">
        <summary className="cursor-pointer font-medium">
          Review immutable comparison
        </summary>
        <div className="mt-3 space-y-3">
          {result.brief ? (
            <ForensicText title="Frozen brief" text={result.brief} />
          ) : null}
          {result.approvedOutput ? (
            <ForensicText
              title="Human-approved output"
              text={result.approvedOutput}
            />
          ) : null}
          {result.replayedOutput ? (
            <ForensicText
              title="Replayed output"
              text={result.replayedOutput}
            />
          ) : null}
          {result.breakdown ? (
            <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {[
                ["Embedding", result.breakdown.embeddingSimilarity],
                ["Style", result.breakdown.stylisticDistance],
                ["Vocabulary", result.breakdown.vocabularyOverlap],
                ["Structure", result.breakdown.structuralMatch],
                ["Combined", result.breakdown.combined],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="tabular-nums">{Number(value).toFixed(2)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <p className="break-all text-xs text-muted-foreground">
            Result {result.id} · source model{" "}
            {result.sourceModelId ?? "not recorded"} · attempt{" "}
            {result.attemptCount} ·{" "}
            {formatWireTimestamp(result.scoredAt, "Date unavailable")}
          </p>
        </div>
      </details>
    </li>
  );
}

function ForensicText({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h6 className="text-xs font-medium uppercase text-muted-foreground">
        {title}
      </h6>
      <pre
        className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-3 font-sans text-sm"
        dir="auto"
        tabIndex={0}
      >
        {text}
      </pre>
    </div>
  );
}
