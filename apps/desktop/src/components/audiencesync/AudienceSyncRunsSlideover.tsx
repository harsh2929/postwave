/**
 * Verified run history and consequential actions for one audience sync.
 *
 * Receiver/provider errors are deliberately classified rather than rendered
 * verbatim: upstream text may echo credentials, URLs, payloads, or subscriber
 * data. Full run identifiers remain visible for support correlation.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type RemoteResourceController,
  useRemoteResource,
} from "../../hooks/useRemoteResource";
import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import {
  audienceSyncsApi,
  type AudienceSync,
  type AudienceSyncRun,
} from "../../lib/api-client";
import { saveFile } from "../../lib/file-transfer";
import { fmtDateTime, fmtRelative } from "../../lib/format-date";
import {
  isInitialRemoteLoad,
  remoteFailureFromError,
  type RemoteApiError,
} from "../../lib/remote-resource";
import { RemoteDataNotice } from "../RemoteDataNotice";
import { SlideoverShell } from "../SlideoverShell";
import { toast } from "../Toast";
import { SyncConsentPreviewPanel } from "../dataplatform/SyncConsentPreviewPanel";

import "../../styles-audience-sync-runs.css";

interface Props {
  sync: AudienceSync;
  /** Whether the operator may fire Run now (admin gate). */
  canRun: boolean;
  onClose: () => void;
  /** Fired after a run completes so the parent list refreshes last-run. */
  onRan: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function boundedString(value: unknown, max = 512): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function optionalBoundedString(value: unknown, max = 512): string | null {
  if (value == null || value === "") return "";
  return boundedString(value, max);
}

function optionalTimestamp(value: unknown): string | null {
  if (value == null || value === "") return "";
  return typeof value === "string" &&
    value.length <= 128 &&
    Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function normalizeRun(
  value: unknown,
  expectedSyncId: string,
): AudienceSyncRun | null {
  if (!isRecord(value)) return null;
  const id = boundedString(value.id);
  const syncId = boundedString(value.sync_id);
  const status = boundedString(value.status, 64);
  const rows = nonNegativeInteger(value.rows_exported);
  const batches = nonNegativeInteger(value.batches_sent);
  const startedAt = optionalTimestamp(value.started_at);
  const finishedAt = optionalTimestamp(value.finished_at);
  const pollAttempts =
    value.provider_poll_attempts == null
      ? 0
      : nonNegativeInteger(value.provider_poll_attempts);
  const excluded =
    value.excluded_count == null ? 0 : nonNegativeInteger(value.excluded_count);
  if (
    !id ||
    syncId !== expectedSyncId ||
    !status ||
    rows === null ||
    batches === null ||
    !startedAt ||
    finishedAt === null ||
    pollAttempts === null ||
    excluded === null
  ) {
    return null;
  }
  const optionalText = {
    error: optionalBoundedString(value.error, 4_096),
    external_job_id: optionalBoundedString(value.external_job_id),
    external_audience_id: optionalBoundedString(value.external_audience_id),
    provider_message: optionalBoundedString(value.provider_message, 4_096),
    provider_status: optionalBoundedString(value.provider_status, 128),
  };
  if (Object.values(optionalText).some((item) => item === null)) return null;
  const providerCheckedAt = optionalTimestamp(value.provider_checked_at);
  const providerNextCheckAt = optionalTimestamp(value.provider_next_check_at);
  if (providerCheckedAt === null || providerNextCheckAt === null) return null;
  return {
    id,
    sync_id: syncId,
    status,
    rows_exported: rows,
    batches_sent: batches,
    started_at: startedAt,
    ...(finishedAt ? { finished_at: finishedAt } : {}),
    ...(optionalText.error ? { error: optionalText.error } : {}),
    ...(optionalText.external_job_id
      ? { external_job_id: optionalText.external_job_id }
      : {}),
    ...(optionalText.external_audience_id
      ? { external_audience_id: optionalText.external_audience_id }
      : {}),
    ...(optionalText.provider_message
      ? { provider_message: optionalText.provider_message }
      : {}),
    ...(optionalText.provider_status
      ? { provider_status: optionalText.provider_status }
      : {}),
    ...(providerCheckedAt ? { provider_checked_at: providerCheckedAt } : {}),
    ...(providerNextCheckAt
      ? { provider_next_check_at: providerNextCheckAt }
      : {}),
    provider_poll_attempts: pollAttempts,
    excluded_count: excluded,
  };
}

async function loadRuns(syncId: string) {
  const result = await audienceSyncsApi.listRuns(syncId);
  if (result.error) return { error: result.error };
  if (!isRecord(result.data) || !Array.isArray(result.data.items)) {
    return invalidResponse("invalid_audience_sync_run_list");
  }
  const items = result.data.items.map((item) => normalizeRun(item, syncId));
  return items.some((item) => item === null)
    ? invalidResponse("invalid_audience_sync_run_record")
    : { data: items as AudienceSyncRun[] };
}

function invalidResponse(code: string): { error: RemoteApiError } {
  return { error: { kind: "parse", code } };
}

function safeReference(error: RemoteApiError): string {
  const failure = remoteFailureFromError(error);
  const reference = [failure.code, failure.requestId]
    .filter(Boolean)
    .join(" · ");
  return `${failure.message}${reference ? ` Reference: ${reference}.` : ""}`;
}

function statusLabel(status: string): string {
  switch (status.toLowerCase()) {
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
    default:
      return "Unknown state";
  }
}

function statusTone(status: string): string {
  switch (status.toLowerCase()) {
    case "succeeded":
      return " success";
    case "failed":
      return " danger";
    case "running":
      return " warning";
    default:
      return "";
  }
}

function classifiedFailure(run: AudienceSyncRun): string {
  const raw = `${run.error ?? ""} ${run.provider_message ?? ""} ${
    run.provider_status ?? ""
  }`.toLowerCase();
  if (/timeout|timed out|deadline/.test(raw)) {
    return "The receiver did not respond before the delivery deadline.";
  }
  if (/dns|resolve|no such host|name resolution/.test(raw)) {
    return "The receiver hostname could not be resolved.";
  }
  if (/\b(?:401|403)\b|unauthor|forbid|authentication/.test(raw)) {
    return "The receiver rejected the configured authentication.";
  }
  if (/\b429\b|rate.?limit|too many request/.test(raw)) {
    return "The receiver rate-limited this delivery.";
  }
  if (/\b4\d\d\b|bad request|unprocessable/.test(raw)) {
    return "The receiver rejected the request.";
  }
  if (/\b5\d\d\b|upstream|service unavailable/.test(raw)) {
    return "The receiver service could not complete the request.";
  }
  return "The receiver did not confirm this run.";
}

function safeIdentifier(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  return normalized &&
    normalized.length <= 256 &&
    /^[A-Za-z0-9._:@/-]+$/.test(normalized)
    ? normalized
    : "Not safely displayable";
}

function safeDestination(raw: string | null | undefined): string {
  const value = raw?.trim() ?? "";
  if (!value) return "Destination not recorded";
  try {
    const parsed = new URL(value);
    if (!["https:", "http:"].includes(parsed.protocol)) {
      return "Unsupported destination scheme";
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    const segments = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) =>
        segment.length <= 48 &&
        /^[A-Za-z0-9._~-]+$/.test(segment) &&
        !/(?:token|secret|password|api[-_]?key|bearer)/i.test(segment)
          ? segment
          : "[redacted]",
      );
    parsed.pathname = segments.length ? `/${segments.join("/")}` : "/";
    return parsed.toString();
  } catch {
    return "Destination URL could not be safely displayed";
  }
}

export function AudienceSyncRunsSlideover({
  sync,
  canRun,
  onClose,
  onRan,
}: Props): ReactElement {
  const actionHelpId = useId();
  const mountedRef = useRef(true);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const [excludedCount, setExcludedCount] = useState<number | null>(null);
  const [receiptRunId, setReceiptRunId] = useState<string | null>(null);
  const runs = useRemoteResource(() => loadRuns(sync.id), {
    identity: `audience-sync-runs:${sync.id}`,
  });
  const runOperation = useSingleFlightOperation({
    ownerId: `audience-sync-run:${sync.id}`,
    label: "Audience sync execution",
    detail:
      "Wait for the audience sync request and verified history refresh to finish before leaving Moosewave.",
  });
  const receiptOperation = useSingleFlightOperation({
    ownerId: `audience-sync-receipt:${sync.id}`,
    label: "Audience sync exclusion receipt",
    detail:
      "Wait for the confidential exclusion receipt transfer to finish before leaving Moosewave.",
  });

  useEffect(() => {
    mountedRef.current = true;
    setExcludedCount(null);
    setReceiptRunId(null);
    return () => {
      mountedRef.current = false;
    };
  }, [sync.id]);

  const refreshRuns = useCallback(
    async (afterMutation = false): Promise<void> => {
      if (refreshPromiseRef.current) {
        await refreshPromiseRef.current;
        if (!afterMutation) return;
      }
      let tracked: Promise<void>;
      tracked = runs.reload().finally(() => {
        if (refreshPromiseRef.current === tracked)
          refreshPromiseRef.current = null;
      });
      refreshPromiseRef.current = tracked;
      await tracked;
    },
    [runs.reload],
  );

  async function runNow(): Promise<void> {
    if (!canRun || !sync.enabled) return;
    if (runOperation.promiseRef.current) {
      await runOperation.wait();
      return;
    }
    const request = runOperation.run(async (): Promise<void> => {
      let result;
      try {
        result = await audienceSyncsApi.run(sync.id);
      } catch {
        result = { error: { kind: "network" as const } };
      }
      if (result.error) {
        if (mountedRef.current) {
          toast.error({
            message: "The audience sync could not be started.",
            detail: `${safeReference(result.error)} No run was confirmed.`,
          });
        }
        return;
      }
      const run = normalizeRun(result.data, sync.id);
      if (!run) {
        if (mountedRef.current) {
          toast.error({
            message: "The audience sync response could not be verified.",
            detail:
              "No success state is being assumed. Refresh history before retrying.",
          });
        }
        return;
      }
      onRan();
      if (!mountedRef.current) return;
      const normalizedStatus = run.status.toLowerCase();
      if (normalizedStatus === "succeeded") {
        toast.success({
          message: "Audience sync run succeeded.",
          detail: `Run ${run.id} exported ${run.rows_exported.toLocaleString()} rows in ${run.batches_sent.toLocaleString()} batch${run.batches_sent === 1 ? "" : "es"}.`,
        });
      } else if (normalizedStatus === "failed") {
        toast.error({
          message: "The audience sync run failed.",
          detail: `${classifiedFailure(run)} Support reference: run ${run.id}.`,
        });
      } else {
        toast.error({
          message: "The audience sync returned without a closed status.",
          detail: `Run ${run.id} is reported as ${statusLabel(run.status).toLowerCase()}. Refresh history before taking another action.`,
        });
      }
      await refreshRuns(true);
    });
    if (request) await request;
  }

  async function downloadReceipt(runId: string): Promise<void> {
    if (receiptOperation.promiseRef.current) {
      await receiptOperation.wait();
      return;
    }
    setReceiptRunId(runId);
    const request = receiptOperation.run(async (): Promise<void> => {
      try {
        const result = await audienceSyncsApi.downloadExclusionReceipt(runId);
        if (result.error) {
          if (mountedRef.current) {
            toast.error({
              message: "The exclusion receipt could not be downloaded.",
              detail: `${safeReference(result.error)} No local file was confirmed.`,
            });
          }
          return;
        }
        if (
          !result.data ||
          !(result.data.blob instanceof Blob) ||
          typeof result.data.filename !== "string"
        ) {
          if (mountedRef.current) {
            toast.error({
              message: "The exclusion receipt response was invalid.",
              detail: "No local file was written. Retry from the run record.",
            });
          }
          return;
        }
        const saved = await saveFile({
          data: result.data.blob,
          suggestedName: result.data.filename,
          label: "Audience sync exclusion receipt",
          privacy: "confidential",
          mimeType: "text/csv;charset=utf-8",
        });
        if (mountedRef.current) {
          if (saved.ok) {
            toast.success({
              message: "Exclusion receipt saved.",
              detail: `Run ${runId} was exported through the confidential transfer flow.`,
            });
          } else {
            toast.error({
              message: "The exclusion receipt was not saved.",
              detail:
                "The transfer did not confirm a local file. Retry when ready.",
            });
          }
        }
      } catch {
        if (mountedRef.current) {
          toast.error({
            message: "The exclusion receipt could not be downloaded.",
            detail:
              "The transfer service could not be reached. No local file was confirmed.",
          });
        }
      } finally {
        if (mountedRef.current) setReceiptRunId(null);
      }
    });
    if (request) await request;
  }

  const running =
    runOperation.active || runOperation.promiseRef.current !== null;
  const downloading =
    receiptOperation.active || receiptOperation.promiseRef.current !== null;
  const runUnavailable = !canRun || !sync.enabled || running;
  const sourceLabel = sync.source?.segment_id
    ? `Segment ${sync.source.segment_id}`
    : sync.source?.list_id
      ? `List ${sync.source.list_id}`
      : "Source not recorded";
  const destination = safeDestination(sync.destination?.url);

  return (
    <SlideoverShell
      open
      onClose={onClose}
      size="lg"
      eyebrow="Audience sync"
      title={sync.name || "Unnamed audience sync"}
      subtitle={
        <span className="audience-sync-run-subtitle">
          <span>
            <strong>Source:</strong> {sourceLabel}
          </span>
          <span>
            <strong>Destination:</strong> <code>{destination}</code>
          </span>
          <span>
            <strong>Sync ID:</strong> <code>{sync.id}</code>
          </span>
          <span className="muted">
            Credentials, query values, fragments, and unsafe path segments are
            never displayed.
          </span>
        </span>
      }
      headerActions={
        <button
          type="button"
          className="btn btn-sm btn-primary pw-discoverable-unavailable"
          aria-disabled={runUnavailable || undefined}
          aria-busy={running ? "true" : undefined}
          aria-describedby={actionHelpId}
          onClick={() => {
            if (!runUnavailable) void runNow();
          }}
        >
          {running
            ? "Running…"
            : excludedCount != null && excludedCount > 0
              ? `Run now (−${excludedCount.toLocaleString()} excluded)`
              : "Run now"}
        </button>
      }
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <p id={actionHelpId} className="pw-action-status">
        {!canRun
          ? "An administrator role is required to run this sync. Verified history remains available."
          : !sync.enabled
            ? "Enable this sync from its configuration before running it."
            : running
              ? "Moosewave is resolving consent, applying exclusions, and delivering signed batches. This can take up to 60 seconds."
              : excludedCount == null
                ? "The server enforces consent and suppression exclusions even when the advisory preview is unavailable."
                : `The server will withhold ${excludedCount.toLocaleString()} ineligible recipient${excludedCount === 1 ? "" : "s"} before delivery.`}
      </p>

      <SyncConsentPreviewPanel
        syncId={sync.id}
        sourceLabel={sourceLabel}
        destinationType={sync.destination?.type}
        onExcludedCountChange={setExcludedCount}
      />

      <RunHistory
        sync={sync}
        canRun={canRun}
        runs={runs}
        downloading={downloading}
        receiptRunId={receiptRunId}
        onRefresh={refreshRuns}
        onDownloadReceipt={downloadReceipt}
      />

      <p className="audience-sync-run-provenance muted">
        Each batch uses <code>X-Postwave-Event: audience.sync.batch</code> and
        an HMAC-SHA256 <code>X-Postwave-Signature</code>. A run can export at
        most 50,000 rows; the exact exported and excluded counts above remain
        authoritative for that run.
      </p>
    </SlideoverShell>
  );
}

function RunHistory({
  sync,
  canRun,
  runs,
  downloading,
  receiptRunId,
  onRefresh,
  onDownloadReceipt,
}: {
  sync: AudienceSync;
  canRun: boolean;
  runs: RemoteResourceController<AudienceSyncRun[]>;
  downloading: boolean;
  receiptRunId: string | null;
  onRefresh: (afterMutation?: boolean) => Promise<void>;
  onDownloadReceipt: (runId: string) => Promise<void>;
}): ReactElement {
  const headingId = useId();
  const history = runs.data;
  return (
    <section className="audience-sync-run-history" aria-labelledby={headingId}>
      <div className="audience-sync-run-history-header">
        <div>
          <h3 id={headingId}>Verified run history</h3>
          <p className="muted">
            Up to 25 recent runs. Receiver text is classified locally and never
            rendered verbatim.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost pw-discoverable-unavailable"
          aria-disabled={runs.transport === "loading" || undefined}
          onClick={() => {
            if (runs.transport !== "loading") void onRefresh();
          }}
        >
          {runs.transport === "loading" ? "Refreshing…" : "Refresh history"}
        </button>
      </div>

      <RemoteDataNotice
        resource={runs}
        label="audience-sync run history"
        onRetry={() => void onRefresh()}
      />

      {isInitialRemoteLoad(runs) ? (
        <div
          className="audience-sync-run-loading"
          role="status"
          aria-busy="true"
        >
          <span>Verifying run history…</span>
          {[0, 1, 2].map((index) => (
            <div key={index} className="skel-row" />
          ))}
        </div>
      ) : history === null ? null : history.length === 0 ? (
        <div className="audience-sync-run-empty" role="status">
          <h4>No verified runs yet</h4>
          <p>
            {canRun
              ? "Run the sync when the consent preview and destination are ready."
              : "An administrator can start the first run."}
          </p>
        </div>
      ) : (
        <div className="audience-sync-run-table-wrap">
          <table className="audience-sync-run-table">
            <caption className="visually-hidden">
              Verified run history for {sync.name || sync.id}
            </caption>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Outcome and evidence</th>
                <th scope="col">Rows</th>
                <th scope="col">Batches</th>
                <th scope="col">Timing and actions</th>
              </tr>
            </thead>
            <tbody>
              {history.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  downloading={downloading}
                  receiptRunId={receiptRunId}
                  onDownloadReceipt={onDownloadReceipt}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {runs.lastVerifiedAt ? (
        <p className="audience-sync-run-verified muted">
          History last verified{" "}
          <time dateTime={new Date(runs.lastVerifiedAt).toISOString()}>
            {new Date(runs.lastVerifiedAt).toLocaleString()}
          </time>
          .
        </p>
      ) : null}
    </section>
  );
}

function RunRow({
  run,
  downloading,
  receiptRunId,
  onDownloadReceipt,
}: {
  run: AudienceSyncRun;
  downloading: boolean;
  receiptRunId: string | null;
  onDownloadReceipt: (runId: string) => Promise<void>;
}): ReactElement {
  const failed = run.status.toLowerCase() === "failed";
  const running = run.status.toLowerCase() === "running";
  const excluded = run.excluded_count ?? 0;
  const receiptBusy = downloading && receiptRunId === run.id;
  const receiptUnavailable = downloading;
  const providerStatus = safeIdentifier(run.provider_status);
  const externalJob = safeIdentifier(run.external_job_id);
  const externalAudience = safeIdentifier(run.external_audience_id);
  return (
    <tr>
      <td>
        <span className={`badge${statusTone(run.status)}`}>
          {statusLabel(run.status)}
        </span>
      </td>
      <td>
        <strong>
          {failed
            ? classifiedFailure(run)
            : running
              ? "The provider has not closed this run yet."
              : "The receiver confirmed this run."}
        </strong>
        <details className="audience-sync-run-evidence">
          <summary>View run evidence</summary>
          <dl>
            <div>
              <dt>Run ID</dt>
              <dd>
                <code>{run.id}</code>
              </dd>
            </div>
            <div>
              <dt>Sync ID</dt>
              <dd>
                <code>{run.sync_id}</code>
              </dd>
            </div>
            <div>
              <dt>Provider status</dt>
              <dd>
                <code>{providerStatus}</code>
              </dd>
            </div>
            <div>
              <dt>External job ID</dt>
              <dd>
                <code>{externalJob}</code>
              </dd>
            </div>
            <div>
              <dt>External audience ID</dt>
              <dd>
                <code>{externalAudience}</code>
              </dd>
            </div>
            <div>
              <dt>Poll attempts</dt>
              <dd className="tabular">
                {(run.provider_poll_attempts ?? 0).toLocaleString()}
              </dd>
            </div>
            <div>
              <dt>Provider checked</dt>
              <dd>
                <RunTime value={run.provider_checked_at} />
              </dd>
            </div>
            <div>
              <dt>Next provider check</dt>
              <dd>
                <RunTime value={run.provider_next_check_at} />
              </dd>
            </div>
            <div>
              <dt>Excluded</dt>
              <dd className="tabular">{excluded.toLocaleString()}</dd>
            </div>
          </dl>
        </details>
      </td>
      <td className="tabular">{run.rows_exported.toLocaleString()}</td>
      <td className="tabular">{run.batches_sent.toLocaleString()}</td>
      <td>
        <span>
          <strong>Started:</strong> <RunTime value={run.started_at} />
        </span>
        <span>
          <strong>Finished:</strong> <RunTime value={run.finished_at} />
        </span>
        {excluded > 0 ? (
          <>
            <button
              type="button"
              className="btn btn-sm btn-ghost pw-discoverable-unavailable"
              aria-disabled={receiptUnavailable || undefined}
              aria-busy={receiptBusy ? "true" : undefined}
              aria-label={`Download exclusion receipt for run ${run.id}`}
              onClick={() => {
                if (!receiptUnavailable) void onDownloadReceipt(run.id);
              }}
            >
              {receiptBusy ? "Downloading receipt…" : "Download receipt"}
            </button>
            <small className="pw-action-status">
              {receiptBusy
                ? "The confidential CSV transfer is in progress."
                : receiptUnavailable
                  ? "Another exclusion receipt transfer is already in progress."
                  : `The signed CSV records the ${excluded.toLocaleString()} withheld recipient${excluded === 1 ? "" : "s"} and reasons.`}
            </small>
          </>
        ) : null}
      </td>
    </tr>
  );
}

function RunTime({
  value,
}: {
  value: string | null | undefined;
}): ReactElement {
  if (!value) return <span className="muted">Not recorded</span>;
  return (
    <time dateTime={value}>
      {fmtDateTime(value)} <span className="muted">({fmtRelative(value)})</span>
    </time>
  );
}
