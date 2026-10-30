import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { verificationApi } from "../../lib/api-client";
import type {
  CreateVerificationJobInput,
  EmailHealthRecommendation,
  JobSource,
  JobStatus,
  VerificationStatus,
} from "../../lib/api/verification";
import { useCanAdmin, useRoleStatus } from "../../lib/store";
import { Notice, type NoticeTone } from "../Notice";
import {
  DataTable,
  DataTableLoadMore,
  type DataTableColumn,
} from "../table/DataTable";
import {
  parseVerificationJobDetail,
  parseVerificationJobs,
  parseVerificationResults,
  type VerificationJobDetailView,
  type VerificationJobView,
  type VerificationResultView,
} from "./verification-response-contract";

import "../../styles-deliverability-controls.css";

const NUM = new Intl.NumberFormat();
const JOB_HISTORY_LIMIT = 50;
const RESULT_PAGE_SIZE = 100;
const RESULT_REQUEST_LIMIT = RESULT_PAGE_SIZE + 1;
const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_FAILURES = 3;
const BULK_PASTE_LIMIT = 10_000;
const BULK_DRAFT_CHAR_LIMIT = 1_000_000;

const STATUS_LABEL: Record<VerificationStatus, string> = {
  valid: "Valid",
  invalid: "Invalid",
  catch_all: "Catch-all",
  spamtrap: "Spam trap",
  abuse: "Abuse",
  do_not_mail: "Do not mail",
  unknown: "Unknown",
};

const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};

const STATUS_ORDER: readonly VerificationStatus[] = [
  "spamtrap",
  "abuse",
  "invalid",
  "do_not_mail",
  "catch_all",
  "unknown",
  "valid",
];

const RESULT_COLUMNS: readonly DataTableColumn<VerificationResultView>[] = [
  {
    id: "address",
    header: "Masked address",
    cell: (row) => row.masked_email,
  },
  {
    id: "verdict",
    header: "Verdict",
    cell: (row) =>
      row.processed
        ? STATUS_LABEL[row.status]
        : row.attempt_state === "ambiguous"
          ? "Outcome uncertain"
          : "Not processed",
  },
  {
    id: "health",
    header: "Health",
    cell: (row) =>
      row.health
        ? `Grade ${row.health.grade} · ${
            row.health.evidence_complete
              ? recommendationLabel(row.health.recommendation)
              : "evidence unavailable"
          }`
        : "—",
  },
  {
    id: "resolution",
    header: "Resolution",
    cell: (row) => {
      if (!row.processed) {
        return row.attempt_state === "ambiguous"
          ? "Provider outcome uncertain"
          : "Not processed";
      }
      if (row.cached) return "Cache";
      return row.billable ? "Provider credit" : "Local check";
    },
  },
  {
    id: "suggestion",
    header: "Masked suggestion",
    cell: (row) => (row.processed ? (row.masked_suggestion ?? "—") : "—"),
  },
  {
    id: "checked",
    header: "Checked",
    cell: (row) =>
      row.processed && row.checked_at ? (
        <time dateTime={row.checked_at}>{formatTimestamp(row.checked_at)}</time>
      ) : (
        "—"
      ),
  },
] as const;

type PollState = "healthy" | "retrying" | "paused";
type ResultsState = "idle" | "loading" | "ready" | "error";
type CreationState = "idle" | "submitting" | "accepted" | "error";

interface CancellationFeedback {
  tone: NoticeTone;
  title: string;
  body: string;
}

export function VerificationBulkPanel(): ReactElement {
  const canAdmin = useCanAdmin();
  const roleStatus = useRoleStatus();
  const hasAdminAuthority = roleStatus === "resolved" && canAdmin;

  const [jobs, setJobs] = useState<VerificationJobView[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsError, setJobsError] = useState(false);
  const [jobsLimitReached, setJobsLimitReached] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VerificationJobDetailView | null>(null);
  const [pollState, setPollState] = useState<PollState>("healthy");
  const [results, setResults] = useState<VerificationResultView[]>([]);
  const [resultsState, setResultsState] = useState<ResultsState>("idle");
  const [hasMoreResults, setHasMoreResults] = useState(false);
  const [filter, setFilter] = useState<VerificationStatus | "">("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelConfirming, setCancelConfirming] = useState(false);
  const [cancelFeedback, setCancelFeedback] =
    useState<CancellationFeedback | null>(null);
  const [createSource, setCreateSource] = useState<
    "inline" | "tag" | "all_subscribers"
  >("inline");
  const [addressDraft, setAddressDraft] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [spendAcknowledged, setSpendAcknowledged] = useState(false);
  const [creationState, setCreationState] = useState<CreationState>("idle");
  const [creationMessage, setCreationMessage] = useState<string | null>(null);

  const mountedRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const jobsRequestRef = useRef(0);
  const detailGenerationRef = useRef(0);
  const resultsRequestRef = useRef(0);
  const cancelRequestRef = useRef(0);
  const pollFailuresRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelFlightRef = useRef(false);
  const createFlightRef = useRef(false);
  const createRequestRef = useRef(0);
  const idempotencyRef = useRef<{
    fingerprint: string;
    key: string;
  } | null>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);

  const stopPolling = useCallback((): void => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const loadJobs = useCallback(async (): Promise<boolean> => {
    if (!hasAdminAuthority || !mountedRef.current) return false;
    const requestId = ++jobsRequestRef.current;
    setJobsLoading(true);
    setJobsError(false);
    try {
      const response = await verificationApi.listJobs(JOB_HISTORY_LIMIT);
      if (!mountedRef.current || requestId !== jobsRequestRef.current)
        return false;
      const parsed = response.error
        ? null
        : parseVerificationJobs(response.data, JOB_HISTORY_LIMIT);
      if (!parsed) {
        setJobsError(true);
        setJobsLoading(false);
        return false;
      }
      setJobs(parsed.rows);
      setJobsLimitReached(parsed.limit_reached);
      setJobsLoading(false);
      return true;
    } catch {
      if (mountedRef.current && requestId === jobsRequestRef.current) {
        setJobsError(true);
        setJobsLoading(false);
      }
      return false;
    }
  }, [hasAdminAuthority]);

  const pollDetail = useCallback(
    async (jobId: string, generation: number): Promise<void> => {
      if (!hasAdminAuthority || !mountedRef.current) return;
      try {
        const response = await verificationApi.getJob(jobId);
        if (
          !mountedRef.current ||
          !hasAdminAuthority ||
          generation !== detailGenerationRef.current ||
          selectedIdRef.current !== jobId
        ) {
          return;
        }
        const parsed = response.error
          ? null
          : parseVerificationJobDetail(response.data, jobId);
        if (!parsed) {
          pollFailuresRef.current += 1;
          const paused = pollFailuresRef.current >= MAX_POLL_FAILURES;
          setPollState(paused ? "paused" : "retrying");
          if (!paused) {
            stopPolling();
            pollTimerRef.current = setTimeout(() => {
              void pollDetail(jobId, generation);
            }, POLL_INTERVAL_MS * pollFailuresRef.current);
          }
          return;
        }

        pollFailuresRef.current = 0;
        setPollState("healthy");
        setDetail(parsed);
        setJobs((current) =>
          current.map((entry) =>
            entry.id === parsed.job.id ? parsed.job : entry,
          ),
        );
        if (parsed.is_terminal) {
          stopPolling();
          return;
        }
        stopPolling();
        pollTimerRef.current = setTimeout(() => {
          void pollDetail(jobId, generation);
        }, POLL_INTERVAL_MS);
      } catch {
        if (
          !mountedRef.current ||
          !hasAdminAuthority ||
          generation !== detailGenerationRef.current ||
          selectedIdRef.current !== jobId
        ) {
          return;
        }
        pollFailuresRef.current += 1;
        const paused = pollFailuresRef.current >= MAX_POLL_FAILURES;
        setPollState(paused ? "paused" : "retrying");
        if (!paused) {
          stopPolling();
          pollTimerRef.current = setTimeout(() => {
            void pollDetail(jobId, generation);
          }, POLL_INTERVAL_MS * pollFailuresRef.current);
        }
      }
    },
    [hasAdminAuthority, stopPolling],
  );

  const loadResults = useCallback(
    async (
      jobId: string,
      status: VerificationStatus | "",
      offset: number,
      append: boolean,
    ): Promise<void> => {
      if (!hasAdminAuthority || !mountedRef.current) return;
      const requestId = ++resultsRequestRef.current;
      if (!append) {
        setResults([]);
        setHasMoreResults(false);
      }
      setResultsState("loading");
      try {
        const response = await verificationApi.jobResults(jobId, {
          status: status ? [status] : undefined,
          limit: RESULT_REQUEST_LIMIT,
          offset,
        });
        if (
          !mountedRef.current ||
          !hasAdminAuthority ||
          requestId !== resultsRequestRef.current ||
          selectedIdRef.current !== jobId
        ) {
          return;
        }
        const parsed = response.error
          ? null
          : parseVerificationResults(response.data, offset, RESULT_PAGE_SIZE);
        if (!parsed) {
          setResultsState("error");
          if (!append) setHasMoreResults(false);
          return;
        }
        setResults((current) =>
          append ? [...current, ...parsed.rows] : parsed.rows,
        );
        setHasMoreResults(parsed.has_more);
        setResultsState("ready");
      } catch {
        if (
          mountedRef.current &&
          hasAdminAuthority &&
          requestId === resultsRequestRef.current &&
          selectedIdRef.current === jobId
        ) {
          setResultsState("error");
          if (!append) setHasMoreResults(false);
        }
      }
    },
    [hasAdminAuthority],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (hasAdminAuthority) {
      void loadJobs();
    } else {
      jobsRequestRef.current += 1;
      detailGenerationRef.current += 1;
      resultsRequestRef.current += 1;
      cancelRequestRef.current += 1;
      createRequestRef.current += 1;
      idempotencyRef.current = null;
      selectedIdRef.current = null;
      stopPolling();
      setJobs([]);
      setJobsLoading(false);
      setJobsError(false);
      setJobsLimitReached(false);
      setSelectedId(null);
      setDetail(null);
      setResults([]);
      setResultsState("idle");
      setCancelFeedback(null);
      setCancelConfirming(false);
      setCreationState("idle");
      setCreationMessage(null);
      setSpendAcknowledged(false);
    }
    return () => {
      mountedRef.current = false;
      jobsRequestRef.current += 1;
      detailGenerationRef.current += 1;
      resultsRequestRef.current += 1;
      cancelRequestRef.current += 1;
      createRequestRef.current += 1;
      idempotencyRef.current = null;
      stopPolling();
    };
  }, [hasAdminAuthority, loadJobs, stopPolling]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    stopPolling();
    const generation = ++detailGenerationRef.current;
    resultsRequestRef.current += 1;
    pollFailuresRef.current = 0;
    setPollState("healthy");
    setDetail(null);
    setResults([]);
    setResultsState("idle");
    setHasMoreResults(false);
    setFilter("");
    setCancelConfirming(false);
    setCancelFeedback(null);
    if (hasAdminAuthority && selectedId) {
      detailHeadingRef.current?.focus();
      void pollDetail(selectedId, generation);
    }
    return () => {
      if (detailGenerationRef.current === generation)
        detailGenerationRef.current += 1;
      resultsRequestRef.current += 1;
      stopPolling();
    };
  }, [hasAdminAuthority, pollDetail, selectedId, stopPolling]);

  useEffect(() => {
    if (!hasAdminAuthority || !selectedId || !detail?.is_terminal) return;
    void loadResults(selectedId, filter, 0, false);
  }, [detail, filter, hasAdminAuthority, loadResults, selectedId]);

  const retryDetail = useCallback((): void => {
    if (!hasAdminAuthority || !selectedId) return;
    stopPolling();
    const generation = ++detailGenerationRef.current;
    pollFailuresRef.current = 0;
    setPollState("retrying");
    void pollDetail(selectedId, generation);
  }, [hasAdminAuthority, pollDetail, selectedId, stopPolling]);

  const cancelJob = useCallback(async (): Promise<void> => {
    if (!hasAdminAuthority || !selectedId || cancelFlightRef.current) return;
    const jobId = selectedId;
    const requestId = ++cancelRequestRef.current;
    const generation = ++detailGenerationRef.current;
    stopPolling();
    cancelFlightRef.current = true;
    setCancelBusy(true);
    setCancelConfirming(false);
    setCancelFeedback(null);

    const currentSelection = (): boolean =>
      mountedRef.current &&
      hasAdminAuthority &&
      requestId === cancelRequestRef.current &&
      generation === detailGenerationRef.current &&
      selectedIdRef.current === jobId;

    const resumeVerifiedStatus = (): void => {
      if (!currentSelection()) return;
      pollFailuresRef.current = 0;
      setPollState("retrying");
      stopPolling();
      pollTimerRef.current = setTimeout(() => {
        void pollDetail(jobId, generation);
      }, 0);
    };

    let cancellationAccepted = false;
    try {
      const response = await verificationApi.cancelJob(jobId);
      if (!currentSelection()) return;
      if (response.error) {
        setCancelFeedback({
          tone: "danger",
          title: "Cancellation was not confirmed",
          body: "The last verified run status remains authoritative. Refresh before retrying; no transport or provider detail is shown here.",
        });
        resumeVerifiedStatus();
        return;
      }
      cancellationAccepted = true;

      const refreshed = await verificationApi.getJob(jobId);
      if (!currentSelection()) return;
      const parsed = refreshed.error
        ? null
        : parseVerificationJobDetail(refreshed.data, jobId);
      if (!parsed) {
        setCancelFeedback({
          tone: "warning",
          title: "Request accepted; receipt not yet verified",
          body: "The cancellation endpoint returned, but the refreshed run record could not be verified. Live status polling has resumed.",
        });
        resumeVerifiedStatus();
        return;
      }

      setDetail(parsed);
      setPollState("healthy");
      setJobs((current) =>
        current.map((entry) =>
          entry.id === parsed.job.id ? parsed.job : entry,
        ),
      );
      if (parsed.job.status === "canceled") {
        setCancelFeedback({
          tone: "success",
          title: "Cancellation confirmed",
          body: "The authoritative run record now reports Canceled. A provider batch already in flight can still settle, so refresh the run before treating its credit count as final.",
        });
      } else if (parsed.is_terminal) {
        setCancelFeedback({
          tone: "info",
          title: `Run already ${JOB_STATUS_LABEL[parsed.job.status].toLowerCase()}`,
          body: "The refreshed run was already terminal when cancellation settled. Its terminal state and measured counters remain authoritative.",
        });
      } else {
        setCancelFeedback({
          tone: "warning",
          title: "Cancellation is still reconciling",
          body: "The endpoint returned, but the refreshed run is not terminal yet. Live status polling has resumed; do not assume additional credit use has stopped.",
        });
        resumeVerifiedStatus();
      }
      void loadJobs();
    } catch {
      if (currentSelection()) {
        setCancelFeedback(
          cancellationAccepted
            ? {
                tone: "warning",
                title: "Request accepted; receipt not yet verified",
                body: "The cancellation endpoint returned, but the refreshed run record could not be read. Live status polling has resumed.",
              }
            : {
                tone: "danger",
                title: "Cancellation ended without a receipt",
                body: "The operation may or may not have reached the server. Live status polling has resumed; verify the run before taking another action.",
              },
        );
        resumeVerifiedStatus();
      }
    } finally {
      cancelFlightRef.current = false;
      if (mountedRef.current) setCancelBusy(false);
    }
  }, [hasAdminAuthority, loadJobs, pollDetail, selectedId, stopPolling]);

  const draft = useMemo(
    () => buildCreateJobDraft(createSource, addressDraft, tagDraft),
    [addressDraft, createSource, tagDraft],
  );

  const resetCreateApproval = useCallback((): void => {
    idempotencyRef.current = null;
    setSpendAcknowledged(false);
    setCreationState("idle");
    setCreationMessage(null);
  }, []);

  const startJob = useCallback(async (): Promise<void> => {
    if (
      !hasAdminAuthority ||
      createFlightRef.current ||
      !spendAcknowledged ||
      !draft.input
    ) {
      return;
    }
    const fingerprint = JSON.stringify(draft.input);
    let identity = idempotencyRef.current;
    if (!identity || identity.fingerprint !== fingerprint) {
      const key = newJobIdempotencyKey();
      if (!key) {
        setCreationState("error");
        setCreationMessage(
          "This device could not create a safe request identity. Reload the desktop app before starting a billable run.",
        );
        return;
      }
      identity = { fingerprint, key };
      idempotencyRef.current = identity;
    }

    const requestId = ++createRequestRef.current;
    createFlightRef.current = true;
    setCreationState("submitting");
    setCreationMessage(null);
    try {
      const response = await verificationApi.createJob(
        draft.input,
        identity.key,
      );
      if (!mountedRef.current || requestId !== createRequestRef.current) return;
      if (response.error) {
        setCreationState("error");
        setCreationMessage(
          response.error.status === 503
            ? "Bulk processing is not enabled on this deployment. No successful run receipt was returned."
            : "The run was not confirmed. Retry this unchanged request to reuse its safety key; do not submit it as a new draft.",
        );
        return;
      }

      const parsed = parseVerificationJobs({ jobs: [response.data] }, 1);
      if (!parsed || parsed.rows.length !== 1) {
        // The server may have durably accepted the request even when an
        // intermediary changed the receipt. Keep the same key for a safe
        // retry and refresh history, where the canonical job may appear.
        setCreationState("error");
        setCreationMessage(
          "The acceptance receipt could not be verified. The unchanged request can be retried safely with the same request identity.",
        );
        void loadJobs();
        return;
      }

      const accepted = parsed.rows[0];
      setJobs((current) => [
        accepted,
        ...current.filter((job) => job.id !== accepted.id),
      ]);
      setSelectedId(accepted.id);
      setCreationState("accepted");
      setCreationMessage(
        "Run accepted. Progress and measured credit use are now read from the durable run ledger.",
      );
      idempotencyRef.current = null;
      setSpendAcknowledged(false);
      if (createSource === "inline") setAddressDraft("");
      if (createSource === "tag") setTagDraft("");
      void loadJobs();
    } catch {
      if (mountedRef.current && requestId === createRequestRef.current) {
        setCreationState("error");
        setCreationMessage(
          "The connection ended without a receipt. Retry the unchanged request; its safety key is preserved to prevent a duplicate run.",
        );
      }
    } finally {
      createFlightRef.current = false;
      if (mountedRef.current && requestId === createRequestRef.current) {
        setCreationState((current) =>
          current === "submitting" ? "idle" : current,
        );
      }
    }
  }, [
    createSource,
    draft.input,
    hasAdminAuthority,
    loadJobs,
    spendAcknowledged,
  ]);

  const selectJob = useCallback(
    (jobId: string, trigger: HTMLButtonElement): void => {
      returnFocusRef.current = trigger;
      setSelectedId(jobId);
    },
    [],
  );

  const closeDetails = useCallback((): void => {
    const returnTarget = returnFocusRef.current;
    setSelectedId(null);
    returnTarget?.focus();
  }, []);

  const jobColumns = useMemo<readonly DataTableColumn<VerificationJobView>[]>(
    () => [
      {
        id: "created",
        header: "Created",
        cell: (row) => (
          <time dateTime={row.created_at}>
            {formatTimestamp(row.created_at)}
          </time>
        ),
      },
      {
        id: "source",
        header: "Source",
        cell: (row) => sourceLabel(row.source),
      },
      {
        id: "status",
        header: "Status",
        cell: (row) => (
          <span className="verification-job-status" data-status={row.status}>
            {JOB_STATUS_LABEL[row.status]}
          </span>
        ),
      },
      {
        id: "progress",
        header: "Progress",
        align: "end",
        cell: (row) =>
          `${NUM.format(row.processed)} / ${NUM.format(row.total)}`,
      },
      {
        id: "credits",
        header: "Credits",
        align: "end",
        cell: (row) => NUM.format(row.credits_spent),
      },
      {
        id: "actions",
        header: <span className="visually-hidden">Actions</span>,
        align: "end",
        cell: (row) => (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={cancelBusy}
            aria-controls={
              selectedId === row.id ? "verification-run-detail" : undefined
            }
            aria-expanded={selectedId === row.id}
            aria-label={`View ${JOB_STATUS_LABEL[row.status].toLowerCase()} verification run created ${formatTimestamp(row.created_at)}`}
            onClick={(event) => selectJob(row.id, event.currentTarget)}
          >
            {selectedId === row.id ? "Viewing" : "View"}
          </button>
        ),
      },
    ],
    [cancelBusy, selectJob, selectedId],
  );

  if (roleStatus === "loading") {
    return <BulkLoading label="Loading bulk-verification permissions" />;
  }

  if (roleStatus === "unavailable") {
    return (
      <section className="verification-card">
        <Notice tone="warning" title="Permissions could not be verified">
          No verification history or recipient evidence was requested. Restore
          the workspace connection, then retry this tab.
        </Notice>
      </section>
    );
  }

  if (!hasAdminAuthority) {
    return (
      <section className="verification-card">
        <Notice tone="neutral" announcement="off" title="Admin access required">
          Verification runs can expose recipient-level evidence and vendor
          spend, so their history and cancellation controls are limited to
          workspace admins.
        </Notice>
      </section>
    );
  }

  const job = detail?.job ?? null;
  const percent =
    job && job.total > 0
      ? Math.min(100, Math.round((job.processed / job.total) * 100))
      : 0;
  const resultsTruth = resultPageTruth(
    results.length,
    hasMoreResults,
    resultsState,
  );

  return (
    <div className="verification-stack verification-bulk-workspace">
      <section
        className="verification-card"
        aria-labelledby="verification-runs-title"
      >
        <header className="verification-card-head">
          <div>
            <span className="verification-kicker">04 · Bulk operations</span>
            <h3 id="verification-runs-title">Start a verification run</h3>
          </div>
          <span className="verification-state-pill" data-state="healthy">
            Durable async worker
          </span>
        </header>
        <p className="verification-lede">
          Local checks, cached results, and the configured mailbox provider are
          applied in order. A durable request identity makes an uncertain submit
          safe to retry without creating a second billable run.
        </p>
        <div className="verification-form-grid">
          <div className="verification-field">
            <label htmlFor="verification-job-source">Recipient source</label>
            <select
              id="verification-job-source"
              value={createSource}
              disabled={creationState === "submitting"}
              onChange={(event) => {
                setCreateSource(
                  event.currentTarget.value as
                    | "inline"
                    | "tag"
                    | "all_subscribers",
                );
                resetCreateApproval();
              }}
            >
              <option value="inline">Paste addresses</option>
              <option value="tag">Subscribers with a tag</option>
              <option value="all_subscribers">All subscribers</option>
            </select>
          </div>

          {createSource === "inline" ? (
            <div className="verification-field verification-field--wide">
              <label htmlFor="verification-job-addresses">
                Email addresses
              </label>
              <textarea
                id="verification-job-addresses"
                rows={6}
                maxLength={BULK_DRAFT_CHAR_LIMIT}
                value={addressDraft}
                disabled={creationState === "submitting"}
                placeholder={"person@example.com\nanother@company.com"}
                aria-describedby="verification-job-address-help"
                onChange={(event) => {
                  setAddressDraft(event.currentTarget.value);
                  resetCreateApproval();
                }}
              />
              <span id="verification-job-address-help" className="muted">
                Separate addresses with a line break, comma, semicolon, or
                space. This desktop form accepts up to{" "}
                {NUM.format(BULK_PASTE_LIMIT)}
                entries; duplicates are measured by the server.
              </span>
            </div>
          ) : null}

          {createSource === "tag" ? (
            <div className="verification-field verification-field--wide">
              <label htmlFor="verification-job-tag">Exact subscriber tag</label>
              <input
                id="verification-job-tag"
                type="text"
                maxLength={512}
                value={tagDraft}
                disabled={creationState === "submitting"}
                autoComplete="off"
                onChange={(event) => {
                  setTagDraft(event.currentTarget.value);
                  resetCreateApproval();
                }}
              />
            </div>
          ) : null}
        </div>

        {createSource === "all_subscribers" ? (
          <Notice
            tone="warning"
            announcement="off"
            title="Workspace-wide scope"
          >
            This resolves the current subscriber directory on the server. Its
            final address count and credit ceiling are unknown until the run is
            accepted.
          </Notice>
        ) : null}

        {draft.error ? (
          <Notice tone="warning" announcement="off" title="Check this run">
            {draft.error}
          </Notice>
        ) : null}

        {draft.input ? (
          <label className="verification-checkbox-row">
            <input
              type="checkbox"
              checked={spendAcknowledged}
              disabled={creationState === "submitting"}
              onChange={(event) =>
                setSpendAcknowledged(event.currentTarget.checked)
              }
            />
            <span>
              I understand this run can use provider credits
              {draft.uniqueCount == null
                ? ", with the final count determined by the selected subscriber scope."
                : ` for up to ${NUM.format(draft.uniqueCount)} unique address${draft.uniqueCount === 1 ? "" : "es"}.`}
            </span>
          </label>
        ) : null}

        <div className="verification-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={
              !draft.input ||
              !spendAcknowledged ||
              creationState === "submitting"
            }
            onClick={() => void startJob()}
          >
            {creationState === "submitting"
              ? "Submitting safely…"
              : "Start verification"}
          </button>
          {draft.input && draft.addressCount != null ? (
            <span className="muted">
              {NUM.format(draft.addressCount)} submitted ·{" "}
              {NUM.format(draft.uniqueCount ?? 0)} unique
            </span>
          ) : null}
        </div>

        {creationMessage ? (
          <Notice
            tone={creationState === "accepted" ? "success" : "warning"}
            title={
              creationState === "accepted"
                ? "Verification run accepted"
                : "Run not confirmed"
            }
          >
            {creationMessage}
          </Notice>
        ) : null}
      </section>

      <section
        className="verification-card"
        aria-labelledby="verification-history-title"
      >
        <header className="verification-card-head">
          <div>
            <span className="verification-kicker">Run ledger</span>
            <h3 id="verification-history-title">Recent runs</h3>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={jobsLoading || cancelBusy}
            onClick={() => void loadJobs()}
          >
            {jobsLoading ? "Refreshing…" : "Refresh"}
          </button>
        </header>

        {jobsError ? (
          <Notice
            tone="warning"
            title="Recent runs could not be verified"
            action={
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void loadJobs()}
              >
                Retry
              </button>
            }
          >
            {jobs.length > 0
              ? "The last verified run ledger remains visible below."
              : "No empty-state claim is made until the run ledger loads."}
          </Notice>
        ) : null}

        <DataTable
          className="verification-history-table"
          caption="Recent verification runs"
          description="Newest first. Source references, recipient addresses, provider errors, and raw identifiers are withheld from this ledger."
          columns={jobColumns}
          rows={jobs}
          getRowKey={jobKey}
          loading={jobsLoading && jobs.length === 0}
          loadingLabel="Loading recent verification runs…"
          emptyState={
            jobsError
              ? "Run ledger unavailable."
              : "No verification runs are recorded."
          }
          density="compact"
          rowClassName={(row) =>
            selectedId === row.id ? "verification-row-selected" : undefined
          }
        />

        {!jobsLoading && !jobsError ? (
          <p className="verification-page-truth" role="status">
            {jobsLimitReached
              ? `Showing the first ${NUM.format(JOB_HISTORY_LIMIT)} runs returned by the recent-history endpoint. It does not provide a total, so older runs may exist.`
              : `${NUM.format(jobs.length)} run${jobs.length === 1 ? "" : "s"} returned. This request was not truncated by the ${NUM.format(JOB_HISTORY_LIMIT)}-run first-page limit.`}
          </p>
        ) : null}
      </section>

      {selectedId ? (
        <section
          id="verification-run-detail"
          className="verification-card verification-run-detail"
          aria-labelledby="verification-progress-title"
        >
          <header className="verification-card-head">
            <div>
              <span className="verification-kicker">Selected run</span>
              <h3
                ref={detailHeadingRef}
                id="verification-progress-title"
                tabIndex={-1}
              >
                Run progress and masked evidence
              </h3>
            </div>
            <div className="verification-head-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={cancelBusy}
                onClick={retryDetail}
              >
                Refresh run
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={cancelBusy}
                onClick={closeDetails}
              >
                Close details
              </button>
            </div>
          </header>

          {!job ? (
            pollState === "paused" ? (
              <Notice
                tone="warning"
                title="Live updates are paused"
                action={
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={retryDetail}
                  >
                    Retry updates
                  </button>
                }
              >
                Three consecutive responses could not be verified. No stale or
                malformed response is shown as current.
              </Notice>
            ) : (
              <BulkSectionLoading
                label={
                  pollState === "retrying"
                    ? "Retrying run status"
                    : "Loading run status"
                }
              />
            )
          ) : (
            <>
              {pollState !== "healthy" ? (
                <Notice
                  tone={pollState === "paused" ? "warning" : "info"}
                  title={
                    pollState === "paused"
                      ? "Live updates are paused"
                      : "Live update delayed"
                  }
                  action={
                    pollState === "paused" ? (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={retryDetail}
                      >
                        Retry updates
                      </button>
                    ) : undefined
                  }
                >
                  {pollState === "paused"
                    ? "The last verified progress remains visible. Retry when the connection is stable."
                    : "The last verified progress remains visible while Moosewave retries with backoff."}
                </Notice>
              ) : null}

              <div className="verification-progress-copy" aria-live="polite">
                <span>{JOB_STATUS_LABEL[job.status]}</span>
                <strong>
                  {NUM.format(job.processed)} of {NUM.format(job.total)} ·{" "}
                  {percent}%
                </strong>
              </div>
              <progress
                value={job.processed}
                max={Math.max(1, job.total)}
                aria-label={`Verification progress: ${job.processed} of ${job.total} addresses`}
              />

              {job.has_error ? (
                <Notice tone="danger" title="Run did not complete">
                  {(job.ambiguous ?? 0) > 0
                    ? `${NUM.format(job.ambiguous ?? 0)} provider outcome${(job.ambiguous ?? 0) === 1 ? " is" : "s are"} uncertain. Moosewave stopped the run instead of retrying work that might already have consumed credits.`
                    : "The run reported a failure. Provider and infrastructure details are intentionally hidden; no raw backend error is displayed."}
                </Notice>
              ) : null}

              <dl className="verification-stat-grid verification-stat-grid--compact">
                <div>
                  <dt>Local checks</dt>
                  <dd>{NUM.format(job.local_filtered)}</dd>
                </div>
                <div>
                  <dt>Cache hits</dt>
                  <dd>{NUM.format(job.cache_hits)}</dd>
                </div>
                <div>
                  <dt>Credits spent</dt>
                  <dd>{NUM.format(job.credits_spent)}</dd>
                </div>
                <div>
                  <dt>Credits saved</dt>
                  <dd>{NUM.format(detail?.credits_saved ?? 0)}</dd>
                </div>
                {(job.ambiguous ?? 0) > 0 ? (
                  <div>
                    <dt>Uncertain outcomes</dt>
                    <dd>{NUM.format(job.ambiguous ?? 0)}</dd>
                  </div>
                ) : null}
              </dl>

              {detail && Object.keys(detail.summary).length > 0 ? (
                <div
                  className="verification-summary-strip"
                  role="group"
                  aria-label="Processed verdict summary"
                >
                  {STATUS_ORDER.filter(
                    (status) => (detail.summary[status] ?? 0) > 0,
                  ).map((status) => (
                    <span key={status}>
                      {STATUS_LABEL[status]}{" "}
                      <strong>{NUM.format(detail.summary[status] ?? 0)}</strong>
                    </span>
                  ))}
                </div>
              ) : null}

              {!detail?.is_terminal && !cancelConfirming ? (
                <div className="verification-actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={cancelBusy}
                    onClick={() => setCancelConfirming(true)}
                  >
                    {cancelBusy ? "Canceling…" : "Cancel run…"}
                  </button>
                </div>
              ) : null}

              {!detail?.is_terminal && cancelConfirming ? (
                <div
                  className="verification-cancel-confirm"
                  role="group"
                  aria-labelledby="verification-cancel-title"
                >
                  <div>
                    <strong id="verification-cancel-title">
                      Stop future verification batches?
                    </strong>
                    <p>
                      A provider request already in flight can still settle and
                      consume credits. Cancellation takes effect only when the
                      refreshed run record confirms it.
                    </p>
                  </div>
                  <div className="verification-cancel-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={cancelBusy}
                      onClick={() => setCancelConfirming(false)}
                    >
                      Keep running
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={cancelBusy}
                      onClick={() => void cancelJob()}
                    >
                      {cancelBusy ? "Canceling…" : "Confirm cancellation"}
                    </button>
                  </div>
                </div>
              ) : null}

              {cancelFeedback ? (
                <Notice tone={cancelFeedback.tone} title={cancelFeedback.title}>
                  {cancelFeedback.body}
                </Notice>
              ) : null}

              {detail?.is_terminal ? (
                <div className="verification-results">
                  <header className="verification-results-head">
                    <div>
                      <span className="verification-kicker">
                        Recipient evidence
                      </span>
                      <h4>Masked result ledger</h4>
                    </div>
                    <div className="verification-field verification-filter">
                      <label htmlFor="verification-result-filter">
                        Filter results
                      </label>
                      <select
                        id="verification-result-filter"
                        value={filter}
                        disabled={resultsState === "loading"}
                        onChange={(event) => {
                          resultsRequestRef.current += 1;
                          setResults([]);
                          setHasMoreResults(false);
                          setResultsState("loading");
                          setFilter(
                            event.currentTarget.value as
                              | VerificationStatus
                              | "",
                          );
                        }}
                      >
                        <option value="">All statuses</option>
                        {STATUS_ORDER.filter(
                          (status) => (detail.summary[status] ?? 0) > 0,
                        ).map((status) => (
                          <option key={status} value={status}>
                            {STATUS_LABEL[status]} (
                            {NUM.format(detail.summary[status] ?? 0)})
                          </option>
                        ))}
                      </select>
                    </div>
                  </header>

                  <Notice
                    tone="neutral"
                    announcement="off"
                    title="Privacy-preserving evidence"
                  >
                    Local-parts and suggestions are masked. Failed or canceled
                    runs can include rows that were never processed. An
                    uncertain provider request is labeled separately and is
                    never presented as a mailbox verdict.
                  </Notice>

                  {resultsState === "error" ? (
                    <Notice
                      tone="warning"
                      title="Results page could not be verified"
                      action={
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() =>
                            void loadResults(
                              selectedId,
                              filter,
                              results.length,
                              results.length > 0,
                            )
                          }
                        >
                          Retry
                        </button>
                      }
                    >
                      {results.length > 0
                        ? "The last verified masked rows remain visible; no partial or malformed page was appended."
                        : "No malformed or partial page is displayed as authoritative."}
                    </Notice>
                  ) : null}

                  <DataTable
                    className="verification-results-table"
                    caption="Per-address verification results"
                    description="Resolution shows whether a local check, cache hit, or provider credit produced each processed verdict."
                    columns={RESULT_COLUMNS}
                    rows={results}
                    getRowKey={resultKey}
                    loading={resultsState === "loading" && results.length === 0}
                    loadingLabel="Loading masked verification results…"
                    emptyState={
                      resultsState === "error"
                        ? "Result page unavailable."
                        : "No addresses match this result filter."
                    }
                    density="compact"
                  />

                  {resultsState !== "idle" ? (
                    <>
                      {resultsState !== "error" ? (
                        <DataTableLoadMore
                          label="Verification results"
                          loadedCount={results.length}
                          totalCount={null}
                          hasMore={hasMoreResults}
                          busy={resultsState === "loading"}
                          onLoadMore={() =>
                            void loadResults(
                              selectedId,
                              filter,
                              results.length,
                              true,
                            )
                          }
                          endLabel="No additional rows were returned for this filter"
                        />
                      ) : null}
                      <p
                        className="verification-page-truth"
                        role="status"
                        aria-live="polite"
                      >
                        {resultsTruth}
                      </p>
                    </>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}

function BulkLoading({ label }: { label: string }): ReactElement {
  return (
    <section className="verification-card" aria-busy="true">
      <BulkSectionLoading label={label} />
    </section>
  );
}

function BulkSectionLoading({ label }: { label: string }): ReactElement {
  return (
    <div className="verification-loading" aria-busy="true">
      <span className="visually-hidden" role="status">
        {label}
      </span>
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </div>
  );
}

function sourceLabel(source: JobSource): string {
  const labels: Record<JobSource, string> = {
    inline: "Pasted addresses",
    upload: "Uploaded list",
    tag: "Subscriber tag",
    all_subscribers: "All subscribers",
  };
  return labels[source];
}

function resultPageTruth(
  count: number,
  hasMore: boolean,
  state: ResultsState,
): string {
  const formatted = NUM.format(count);
  if (state === "error") {
    return count > 0
      ? `${formatted} previously verified masked rows remain visible. The next page is unknown until retry succeeds.`
      : "No result-page completeness claim is made until a response is verified.";
  }
  if (hasMore) {
    return `${formatted} masked rows loaded. A sentinel row confirms more results exist; the endpoint does not provide a total.`;
  }
  return `${formatted} masked row${count === 1 ? "" : "s"} loaded. The latest page returned no additional row for this filter.`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString()
    : "Unavailable";
}

function resultKey(row: VerificationResultView): string {
  return row.row_key;
}

function jobKey(row: VerificationJobView): string {
  return row.id;
}

interface CreateJobDraft {
  input: CreateVerificationJobInput | null;
  error: string | null;
  addressCount: number | null;
  uniqueCount: number | null;
}

export function buildCreateJobDraft(
  source: "inline" | "tag" | "all_subscribers",
  addressDraft: string,
  tagDraft: string,
): CreateJobDraft {
  if (source === "all_subscribers") {
    return {
      input: { source: "all_subscribers" },
      error: null,
      addressCount: null,
      uniqueCount: null,
    };
  }
  if (source === "tag") {
    const tag = tagDraft.trim();
    if (!tag) {
      return {
        input: null,
        error: null,
        addressCount: null,
        uniqueCount: null,
      };
    }
    if (
      tag.length > 512 ||
      /[\p{Cc}\p{Cf}]/u.test(tag) ||
      new TextEncoder().encode(tag).length > 512
    ) {
      return {
        input: null,
        error: "The tag must be one visible line of at most 512 bytes.",
        addressCount: null,
        uniqueCount: null,
      };
    }
    return {
      input: { source: "tag", source_ref: tag },
      error: null,
      addressCount: null,
      uniqueCount: null,
    };
  }

  const addresses = addressDraft
    .split(/[\s,;]+/u)
    .map((email) => email.trim())
    .filter(Boolean);
  if (addresses.length === 0) {
    return {
      input: null,
      error: null,
      addressCount: 0,
      uniqueCount: 0,
    };
  }
  if (addresses.length > BULK_PASTE_LIMIT) {
    return {
      input: null,
      error: `This desktop form accepts at most ${NUM.format(BULK_PASTE_LIMIT)} addresses per run. Split this paste into smaller runs.`,
      addressCount: addresses.length,
      uniqueCount: null,
    };
  }
  if (
    addresses.some(
      (email) =>
        email.length > 320 ||
        new TextEncoder().encode(email).length > 320 ||
        /[\u0000\r\n]/u.test(email),
    )
  ) {
    return {
      input: null,
      error:
        "Every address must fit within 320 bytes. Invalid mailbox syntax can still be verified and graded.",
      addressCount: addresses.length,
      uniqueCount: null,
    };
  }
  const uniqueCount = new Set(addresses.map((email) => email.toLowerCase()))
    .size;
  return {
    input: { source: "inline", emails: addresses },
    error: null,
    addressCount: addresses.length,
    uniqueCount,
  };
}

function newJobIdempotencyKey(): string | null {
  const cryptoProvider = globalThis.crypto as
    | (Crypto & { randomUUID?: () => string })
    | undefined;
  if (typeof cryptoProvider?.randomUUID === "function") {
    return `desktop-verification-${cryptoProvider.randomUUID()}`;
  }
  if (typeof cryptoProvider?.getRandomValues !== "function") return null;
  const bytes = cryptoProvider.getRandomValues(new Uint8Array(16));
  return `desktop-verification-${Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function recommendationLabel(value: EmailHealthRecommendation): string {
  const labels: Record<EmailHealthRecommendation, string> = {
    send: "send",
    caution: "review",
    do_not_send: "do not send",
    blocked: "blocked",
  };
  return labels[value];
}
