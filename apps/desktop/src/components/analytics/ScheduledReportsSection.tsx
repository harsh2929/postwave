/**
 * Scheduled analytics report administration.
 *
 * The surface is deliberately receipt-led:
 * - recurring definitions are shown separately from their latest durable run;
 * - "queued" and provider "accepted" never become "sent" or "delivered";
 * - response-ambiguous send-now retries reuse the original request identity;
 * - recipient mailboxes stay inside the editor and never leak into card titles,
 *   tooltips, confirmations, or toasts.
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

import { desktopRouteIdentityScope } from "../../lib/desktop-router";
import {
  type ScheduledReport,
  type ScheduledReportApiError,
  scheduledReportsApi,
} from "../../lib/api-client";
import { useCanAdmin, useMe } from "../../lib/store";
import {
  type ReportDraft,
  REPORT_TEMPLATES,
  WEEKDAYS,
  decodeScheduledReports,
  draftErrors as reportDraftErrors,
  draftFromReport,
  draftSchedule,
  draftToCreateInput,
  draftToPatchInput,
  formatReportDateTime,
  humanizeSchedule,
  isAmbiguousSendNowError,
  parseRecipients,
  reportOutcome,
  runStatusPresentation,
  safeScheduledReportDiagnostic,
  scheduledReportErrorMessage,
  sendNowMessage,
  templateLabel,
  timezonePolicyCopy,
  timezoneSuggestions,
} from "../../pages/analytics-scheduled-reports";
import { ConfirmModal } from "../ConfirmModal";
import { FormField } from "../FormField";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";

type LoadPhase = "idle" | "loading" | "ready" | "error";

interface ReportsSnapshot {
  identity: string;
  reports: ScheduledReport[] | null;
  phase: LoadPhase;
  message: string | null;
  diagnostic: string | null;
  verifiedAt: number | null;
}

interface ReportsFlight {
  identity: string;
  controller: AbortController;
  promise: Promise<void>;
}

interface SendIntent {
  identity: string;
  report: ScheduledReport;
  idempotencyKey: string;
  message: string | null;
  diagnostic: string | null;
  ambiguous: boolean;
}

interface DeleteIntent {
  identity: string;
  report: ScheduledReport;
  message: string | null;
  diagnostic: string | null;
}

function blankSnapshot(identity: string): ReportsSnapshot {
  return {
    identity,
    reports: null,
    phase: "idle",
    message: null,
    diagnostic: null,
    verifiedAt: null,
  };
}

function currentSnapshot(
  snapshot: ReportsSnapshot,
  identity: string,
): ReportsSnapshot {
  return snapshot.identity === identity ? snapshot : blankSnapshot(identity);
}

function reportIdentity(report: ScheduledReport): string {
  return report.id;
}

export function ScheduledReportsSection(): ReactElement {
  const canAdmin = useCanAdmin();
  const me = useMe();
  const panelId = useId();
  const headingId = useId();
  const identity = `${desktopRouteIdentityScope(me?.user, me?.tenant) ?? "unresolved"}:${me?.effectiveRole ?? "unknown"}`;

  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ReportsSnapshot>(() =>
    blankSnapshot(identity),
  );
  // undefined → closed, null → create, report → edit.
  const [formTarget, setFormTarget] = useState<
    ScheduledReport | null | undefined
  >(undefined);
  const [sendIntent, setSendIntent] = useState<SendIntent | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [deleteIntent, setDeleteIntent] = useState<DeleteIntent | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const identityRef = useRef(identity);
  const canAdminRef = useRef(canAdmin);
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const loadFlightRef = useRef<ReportsFlight | null>(null);
  const sendGenerationRef = useRef(0);
  const sendControllerRef = useRef<AbortController | null>(null);
  const sendIntentRef = useRef(sendIntent);
  const deleteGenerationRef = useRef(0);
  const deleteControllerRef = useRef<AbortController | null>(null);
  const deleteIntentRef = useRef(deleteIntent);

  identityRef.current = identity;
  canAdminRef.current = canAdmin;
  sendIntentRef.current = sendIntent;
  deleteIntentRef.current = deleteIntent;

  const load = useCallback(async (): Promise<void> => {
    const requestedIdentity = identityRef.current;
    if (!canAdminRef.current || requestedIdentity.startsWith("unresolved:")) {
      return;
    }
    const existing = loadFlightRef.current;
    if (existing?.identity === requestedIdentity) {
      return existing.promise;
    }
    existing?.controller.abort();

    const controller = new AbortController();
    const generation = ++loadGenerationRef.current;
    setSnapshot((previous) => {
      const current = currentSnapshot(previous, requestedIdentity);
      return {
        ...current,
        phase: "loading",
        message: null,
        diagnostic: null,
      };
    });

    const execute = async (): Promise<void> => {
      let result: Awaited<ReturnType<typeof scheduledReportsApi.list>>;
      try {
        result = await scheduledReportsApi.list({
          signal: controller.signal,
        });
      } catch {
        result = {
          error: {
            kind: "network",
            code: "scheduled_reports_read_failed",
            message: "Request failed.",
          },
        };
      }
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== loadGenerationRef.current ||
        requestedIdentity !== identityRef.current
      ) {
        return;
      }
      if (result.error) {
        setSnapshot((previous) => {
          const current = currentSnapshot(previous, requestedIdentity);
          return {
            ...current,
            phase: "error",
            message: scheduledReportErrorMessage(result.error, "load"),
            diagnostic: safeScheduledReportDiagnostic(result.error),
          };
        });
        return;
      }
      const reports = decodeScheduledReports(result.data?.reports);
      if (reports === null) {
        const error: ScheduledReportApiError = {
          kind: "parse",
          code: "invalid_scheduled_reports_response",
          message: "The server returned an invalid scheduled-report list.",
        };
        setSnapshot((previous) => {
          const current = currentSnapshot(previous, requestedIdentity);
          return {
            ...current,
            phase: "error",
            message: scheduledReportErrorMessage(error, "load"),
            diagnostic: safeScheduledReportDiagnostic(error),
          };
        });
        return;
      }
      setSnapshot({
        identity: requestedIdentity,
        reports,
        phase: "ready",
        message: null,
        diagnostic: null,
        verifiedAt: Date.now(),
      });
    };

    const promise = execute().finally(() => {
      if (loadFlightRef.current?.controller === controller) {
        loadFlightRef.current = null;
      }
    });
    loadFlightRef.current = {
      identity: requestedIdentity,
      controller,
      promise,
    };
    return promise;
  }, []);

  // A role/workspace transition immediately clears recipient-bearing data and
  // invalidates every late read or mutation result from the previous identity.
  useEffect(() => {
    identityRef.current = identity;
    canAdminRef.current = canAdmin;
    loadGenerationRef.current += 1;
    loadFlightRef.current?.controller.abort();
    loadFlightRef.current = null;
    sendGenerationRef.current += 1;
    sendControllerRef.current?.abort();
    sendControllerRef.current = null;
    deleteGenerationRef.current += 1;
    deleteControllerRef.current?.abort();
    deleteControllerRef.current = null;
    setSnapshot(blankSnapshot(identity));
    setFormTarget(undefined);
    setSendIntent(null);
    setSendBusy(false);
    setDeleteIntent(null);
    setDeleteBusy(false);
  }, [canAdmin, identity]);

  useEffect(() => {
    if (open && canAdmin) void load();
  }, [canAdmin, identity, load, open]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      loadFlightRef.current?.controller.abort();
      sendGenerationRef.current += 1;
      sendControllerRef.current?.abort();
      deleteGenerationRef.current += 1;
      deleteControllerRef.current?.abort();
    };
  }, []);

  const visible = currentSnapshot(snapshot, identity);
  const interactionsCurrent = snapshot.identity === identity;
  const visibleSendIntent =
    interactionsCurrent && sendIntent?.identity === identity
      ? sendIntent
      : null;
  const visibleDeleteIntent =
    interactionsCurrent && deleteIntent?.identity === identity
      ? deleteIntent
      : null;
  const reports = visible.reports;
  const count = reports?.length ?? null;
  const enabledCount = reports?.filter((report) => report.enabled).length ?? 0;
  const reviewCount =
    reports?.filter((report) => report.latest_run_status === "needs_review")
      .length ?? 0;
  const refreshing = visible.phase === "loading" && reports !== null;
  const initialLoading =
    visible.phase === "loading" && visible.reports === null;

  const openSendReview = (report: ScheduledReport): void => {
    if (!canAdminRef.current || sendBusy) return;
    setSendIntent({
      identity: identityRef.current,
      report,
      idempotencyKey: scheduledReportsApi.newSendNowKey(),
      message: null,
      diagnostic: null,
      ambiguous: false,
    });
  };

  const confirmSend = async (): Promise<void> => {
    const intent = sendIntentRef.current;
    if (
      !intent ||
      intent.identity !== identityRef.current ||
      sendBusy ||
      !canAdminRef.current
    ) {
      return;
    }
    const requestedIdentity = identityRef.current;
    const generation = ++sendGenerationRef.current;
    const controller = new AbortController();
    sendControllerRef.current?.abort();
    sendControllerRef.current = controller;
    setSendBusy(true);
    setSendIntent((current) =>
      current?.idempotencyKey === intent.idempotencyKey
        ? { ...current, message: null, diagnostic: null }
        : current,
    );

    let result: Awaited<ReturnType<typeof scheduledReportsApi.sendNow>>;
    try {
      result = await scheduledReportsApi.sendNow(
        intent.report.id,
        intent.idempotencyKey,
        { signal: controller.signal },
      );
    } catch {
      result = {
        error: {
          kind: "network",
          code: "scheduled_report_send_unconfirmed",
          message: "Request failed.",
        },
      };
    }
    if (
      !mountedRef.current ||
      controller.signal.aborted ||
      generation !== sendGenerationRef.current ||
      requestedIdentity !== identityRef.current ||
      intent.identity !== identityRef.current ||
      sendIntentRef.current?.idempotencyKey !== intent.idempotencyKey
    ) {
      return;
    }
    setSendBusy(false);
    sendControllerRef.current = null;
    if (result.error) {
      setSendIntent((current) =>
        current?.idempotencyKey === intent.idempotencyKey
          ? {
              ...current,
              message: scheduledReportErrorMessage(result.error, "send"),
              diagnostic: safeScheduledReportDiagnostic(result.error),
              ambiguous: isAmbiguousSendNowError(result.error),
            }
          : current,
      );
      return;
    }
    toast.success(sendNowMessage(intent.report, result.data));
    setSendIntent(null);
    await load();
  };

  const confirmDelete = async (): Promise<void> => {
    const intent = deleteIntentRef.current;
    if (
      !intent ||
      intent.identity !== identityRef.current ||
      deleteBusy ||
      !canAdminRef.current
    ) {
      return;
    }
    const requestedIdentity = identityRef.current;
    const generation = ++deleteGenerationRef.current;
    const controller = new AbortController();
    deleteControllerRef.current?.abort();
    deleteControllerRef.current = controller;
    setDeleteBusy(true);
    setDeleteIntent((current) =>
      current?.report.id === intent.report.id
        ? { ...current, message: null, diagnostic: null }
        : current,
    );
    let result: Awaited<ReturnType<typeof scheduledReportsApi.remove>>;
    try {
      result = await scheduledReportsApi.remove(intent.report.id, {
        signal: controller.signal,
      });
    } catch {
      result = {
        error: {
          kind: "network",
          code: "scheduled_report_delete_failed",
          message: "Request failed.",
        },
      };
    }
    if (
      !mountedRef.current ||
      controller.signal.aborted ||
      generation !== deleteGenerationRef.current ||
      requestedIdentity !== identityRef.current ||
      intent.identity !== identityRef.current ||
      deleteIntentRef.current?.report.id !== intent.report.id
    ) {
      return;
    }
    setDeleteBusy(false);
    deleteControllerRef.current = null;
    if (result.error) {
      setDeleteIntent((current) =>
        current?.report.id === intent.report.id
          ? {
              ...current,
              message: scheduledReportErrorMessage(result.error, "delete"),
              diagnostic: safeScheduledReportDiagnostic(result.error),
            }
          : current,
      );
      return;
    }
    toast.success(`Deleted “${intent.report.name}”`);
    setDeleteIntent(null);
    await load();
  };

  return (
    <section
      className="analytics-scheduled-reports"
      aria-labelledby={headingId}
      aria-busy={visible.phase === "loading" ? "true" : undefined}
    >
      <h3 className="sr-only" id={headingId}>
        Scheduled reports
      </h3>
      <div className="analytics-scheduled-header">
        <button
          type="button"
          className="analytics-scheduled-toggle"
          aria-label="Scheduled reports"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((current) => !current)}
        >
          <span
            className="analytics-scheduled-chevron"
            data-open={open ? "true" : "false"}
            aria-hidden="true"
          >
            ›
          </span>
          <span className="analytics-scheduled-title-copy">
            <span className="analytics-section-kicker">Distribution</span>
            <span className="analytics-scheduled-title">Scheduled reports</span>
            <span
              className="analytics-scheduled-summary"
              aria-live="polite"
              aria-atomic="true"
            >
              {count === null
                ? "Recurring email definitions with durable run receipts"
                : `${count} definition${count === 1 ? "" : "s"} · ${enabledCount} active${reviewCount > 0 ? ` · ${reviewCount} need review` : ""}`}
            </span>
          </span>
        </button>

        {open && canAdmin ? (
          <div className="analytics-scheduled-header-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={visible.phase === "loading"}
              onClick={() => void load()}
              aria-label="Refresh scheduled report delivery evidence"
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => setFormTarget(null)}
            >
              New report
            </button>
          </div>
        ) : null}
      </div>

      {open ? (
        <div className="analytics-scheduled-body" id={panelId}>
          {!canAdmin ? (
            <ScheduledReportsAccessNotice role={me?.effectiveRole ?? null} />
          ) : (
            <>
              <div className="analytics-scheduled-truth-note">
                <div>
                  <strong>Delivery evidence, not an inbox claim</strong>
                  <span>
                    “Accepted” means the mail provider accepted the request. It
                    does not prove inbox placement or an open.
                  </span>
                </div>
                {visible.verifiedAt ? (
                  <span className="analytics-scheduled-verified">
                    Verified{" "}
                    {new Date(visible.verifiedAt).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                ) : null}
              </div>

              {visible.message ? (
                <div className="analytics-scheduled-error" role="alert">
                  <div>
                    <strong>
                      {reports === null
                        ? "Delivery evidence unavailable"
                        : "Refresh not confirmed — showing last verified evidence"}
                    </strong>
                    <span>{visible.message}</span>
                    {visible.diagnostic ? (
                      <span className="analytics-scheduled-diagnostic">
                        Reference {visible.diagnostic}
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={visible.phase === "loading"}
                    onClick={() => void load()}
                  >
                    Retry
                  </button>
                </div>
              ) : null}

              {initialLoading || visible.phase === "idle" ? (
                <ScheduledReportsSkeleton />
              ) : reports?.length === 0 ? (
                <ScheduledReportsEmpty onCreate={() => setFormTarget(null)} />
              ) : reports ? (
                <ul className="analytics-scheduled-list">
                  {reports.map((report) => (
                    <li key={reportIdentity(report)}>
                      <ScheduledReportCard
                        report={report}
                        actionsDisabled={
                          sendBusy || deleteBusy || visible.phase === "loading"
                        }
                        sending={
                          sendBusy && sendIntent?.report.id === report.id
                        }
                        onSend={openSendReview}
                        onEdit={setFormTarget}
                        onDelete={(target) =>
                          setDeleteIntent({
                            identity,
                            report: target,
                            message: null,
                            diagnostic: null,
                          })
                        }
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {interactionsCurrent && formTarget !== undefined && canAdmin ? (
        <ScheduledReportFormModal
          key={`${identity}:${formTarget?.id ?? "new"}`}
          report={formTarget}
          onClose={() => setFormTarget(undefined)}
          onSaved={async () => {
            setFormTarget(undefined);
            await load();
          }}
        />
      ) : null}

      <SendNowReviewModal
        intent={visibleSendIntent}
        busy={sendBusy}
        onConfirm={confirmSend}
        onClose={() => {
          if (!sendBusy) setSendIntent(null);
        }}
      />

      <ConfirmModal
        open={visibleDeleteIntent !== null}
        danger
        title={`Delete “${visibleDeleteIntent?.report.name ?? "scheduled report"}”?`}
        description="The recurring definition stops immediately. Historical run evidence remains retained by the service."
        confirmLabel="Delete report"
        busy={deleteBusy}
        onConfirm={confirmDelete}
        onClose={() => {
          if (!deleteBusy) setDeleteIntent(null);
        }}
      >
        {visibleDeleteIntent?.message ? (
          <ActionFailure
            message={visibleDeleteIntent.message}
            diagnostic={visibleDeleteIntent.diagnostic}
          />
        ) : null}
      </ConfirmModal>
    </section>
  );
}

function ScheduledReportsAccessNotice({
  role,
}: {
  role: "admin" | "editor" | "viewer" | null;
}): ReactElement {
  const resolved = role !== null;
  return (
    <div className="analytics-scheduled-access" role="note">
      <span className="analytics-scheduled-access-mark" aria-hidden="true">
        {resolved ? "↗" : "…"}
      </span>
      <div>
        <strong>
          {resolved
            ? "Admin-only delivery settings"
            : "Administrator access is being verified"}
        </strong>
        <p>
          {resolved
            ? `Your current ${role} role can read the Analytics workspace, but scheduled definitions and recipient settings are restricted to admins.`
            : "Scheduled definitions contain recipient addresses, so Moosewave keeps them hidden until administrator access is confirmed."}
        </p>
      </div>
    </div>
  );
}

function ScheduledReportsSkeleton(): ReactElement {
  return (
    <div
      className="analytics-scheduled-skeleton"
      role="status"
      aria-label="Loading scheduled report definitions"
    >
      {[0, 1].map((index) => (
        <span key={index} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      ))}
    </div>
  );
}

function ScheduledReportsEmpty({
  onCreate,
}: {
  onCreate: () => void;
}): ReactElement {
  return (
    <div className="analytics-scheduled-empty">
      <span className="analytics-scheduled-empty-orbit" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <div>
        <strong>Turn a verified report into a dependable cadence</strong>
        <p>
          Choose a local timezone, review every recipient, and keep each run’s
          provider acceptance outcome visible here.
        </p>
      </div>
      <button type="button" className="btn btn-primary" onClick={onCreate}>
        Create first report
      </button>
    </div>
  );
}

function ScheduledReportCard({
  report,
  actionsDisabled,
  sending,
  onSend,
  onEdit,
  onDelete,
}: {
  report: ScheduledReport;
  actionsDisabled: boolean;
  sending: boolean;
  onSend: (report: ScheduledReport) => void;
  onEdit: (report: ScheduledReport) => void;
  onDelete: (report: ScheduledReport) => void;
}): ReactElement {
  const nameId = useId();
  const receiptId = useId();
  const status = runStatusPresentation(report.latest_run_status);
  const outcome = reportOutcome(report);
  const hasRun = Boolean(report.latest_run_id && report.latest_run_status);
  const runReference = report.latest_run_id?.slice(0, 8) ?? null;
  const nextDue = report.enabled
    ? formatReportDateTime(report.next_due_at, report.timezone)
    : "Paused";

  return (
    <article className="analytics-scheduled-card" aria-labelledby={nameId}>
      <header className="analytics-scheduled-card-header">
        <div className="analytics-scheduled-card-name">
          <span
            className="analytics-scheduled-template-mark"
            data-template={report.template}
            aria-hidden="true"
          >
            {templateLabel(report.template).slice(0, 1)}
          </span>
          <div>
            <h3 id={nameId}>{report.name}</h3>
            <p>
              {report.recipients.length} configured recipient
              {report.recipients.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <span
          className="analytics-scheduled-enabled"
          data-enabled={report.enabled ? "true" : "false"}
        >
          <i aria-hidden="true" />
          {report.enabled ? "Active" : "Paused"}
        </span>
      </header>

      <dl className="analytics-scheduled-definition">
        <div>
          <dt>Template</dt>
          <dd>{templateLabel(report.template)}</dd>
        </div>
        <div>
          <dt>Cadence</dt>
          <dd>{humanizeSchedule(report.schedule)}</dd>
          <dd className="analytics-scheduled-definition-detail">
            {report.timezone || "UTC"}
          </dd>
        </div>
        <div>
          <dt>Next due</dt>
          <dd>{nextDue}</dd>
        </div>
      </dl>

      <section
        className="analytics-scheduled-receipt"
        aria-labelledby={receiptId}
        data-tone={status.tone}
      >
        <div className="analytics-scheduled-receipt-head">
          <div>
            <span className="analytics-scheduled-receipt-kicker" id={receiptId}>
              Latest durable run
            </span>
            <span className="analytics-scheduled-run-status">
              <i aria-hidden="true" />
              {status.label}
            </span>
          </div>
          {hasRun ? (
            <div className="analytics-scheduled-run-identity">
              <span>Run {runReference}</span>
              <span>
                {formatReportDateTime(
                  report.latest_run_created_at,
                  report.timezone,
                )}
              </span>
            </div>
          ) : null}
        </div>

        <p className="analytics-scheduled-run-explanation">
          {status.explanation}
        </p>

        {hasRun ? (
          <dl
            className="analytics-scheduled-outcomes"
            aria-label={`Latest run outcomes for ${report.name}`}
          >
            <OutcomeDatum
              tone="success"
              label="Provider accepted"
              value={outcome.accepted}
            />
            <OutcomeDatum
              tone="danger"
              label="Rejected or skipped"
              value={outcome.failed}
            />
            <OutcomeDatum
              tone="warning"
              label="Unknown"
              value={outcome.unknown}
            />
            <OutcomeDatum
              tone="neutral"
              label="Pending"
              value={outcome.pending}
            />
          </dl>
        ) : null}
      </section>

      <footer className="analytics-scheduled-card-footer">
        <span className="analytics-scheduled-timezone-policy">
          {timezonePolicyCopy(report.timezone)}
        </span>
        <div className="analytics-scheduled-card-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={actionsDisabled}
            aria-label={`Review a one-off run of ${report.name}`}
            onClick={() => onSend(report)}
          >
            {sending ? "Queuing…" : "Send now"}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={actionsDisabled}
            onClick={() => onEdit(report)}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={actionsDisabled}
            aria-label={`Delete ${report.name}`}
            onClick={() => onDelete(report)}
          >
            Delete
          </button>
        </div>
      </footer>
    </article>
  );
}

function OutcomeDatum({
  tone,
  label,
  value,
}: {
  tone: "success" | "danger" | "warning" | "neutral";
  label: string;
  value: number;
}): ReactElement {
  return (
    <div data-tone={tone}>
      <dt>{label}</dt>
      <dd>{value.toLocaleString()}</dd>
    </div>
  );
}

function SendNowReviewModal({
  intent,
  busy,
  onConfirm,
  onClose,
}: {
  intent: SendIntent | null;
  busy: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const report = intent?.report;
  const latestNeedsReview = report?.latest_run_status === "needs_review";
  return (
    <ConfirmModal
      open={intent !== null}
      title={`Queue one run of “${report?.name ?? "scheduled report"}”?`}
      description="Review the blast radius before creating a durable manual run."
      confirmLabel={
        intent?.ambiguous
          ? "Retry same request"
          : latestNeedsReview
            ? "Queue another run"
            : "Queue run"
      }
      busy={busy}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      {report ? (
        <div className="analytics-scheduled-send-review">
          <dl>
            <div>
              <dt>Recipients</dt>
              <dd>
                All {report.recipients.length} configured recipient
                {report.recipients.length === 1 ? "" : "s"}
              </dd>
            </div>
            <div>
              <dt>Template</dt>
              <dd>{templateLabel(report.template)}</dd>
            </div>
            <div>
              <dt>Schedule context</dt>
              <dd>
                {humanizeSchedule(report.schedule)} · {report.timezone || "UTC"}
              </dd>
            </div>
          </dl>
          <div className="analytics-scheduled-send-caveat">
            <strong>
              {latestNeedsReview
                ? "The latest run has unknown provider outcomes."
                : "This queues work; it does not send synchronously."}
            </strong>
            <span>
              {latestNeedsReview
                ? "Queuing another run can contact recipients whose prior acceptance could not be confirmed. Investigate that run before proceeding."
                : "Provider acceptance is tracked per recipient. An uncertain provider outcome is marked “Needs review” and is not automatically retried."}
            </span>
          </div>
          {intent.message ? (
            <ActionFailure
              message={intent.message}
              diagnostic={intent.diagnostic}
              recovery={
                intent.ambiguous
                  ? "The retry button reuses the original request identity."
                  : undefined
              }
            />
          ) : null}
        </div>
      ) : null}
    </ConfirmModal>
  );
}

function ActionFailure({
  message,
  diagnostic,
  recovery,
}: {
  message: string;
  diagnostic: string | null;
  recovery?: string;
}): ReactElement {
  return (
    <div className="analytics-scheduled-action-error" role="alert">
      <strong>Action not confirmed</strong>
      <span>{message}</span>
      {recovery ? <span>{recovery}</span> : null}
      {diagnostic ? (
        <span className="analytics-scheduled-diagnostic">
          Reference {diagnostic}
        </span>
      ) : null}
    </div>
  );
}

function ScheduledReportFormModal({
  report,
  onClose,
  onSaved,
}: {
  /** null → create, row → edit. */
  report: ScheduledReport | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): ReactElement {
  const mode = report ? "edit" : "create";
  const timezoneListId = useId();
  const [draft, setDraft] = useState<ReportDraft>(() =>
    draftFromReport(report),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const mountedRef = useRef(true);
  const requestGenerationRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const suggestions = useMemo(timezoneSuggestions, []);
  const initialDraftFingerprintRef = useRef(reportDraftFingerprint(draft));
  const dirty =
    reportDraftFingerprint(draft) !== initialDraftFingerprintRef.current;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      requestControllerRef.current?.abort();
    };
  }, []);

  const patch = (next: Partial<ReportDraft>): void => {
    setDraft((current) => ({ ...current, ...next }));
    setErrors((current) => {
      if (Object.keys(current).length === 0) return current;
      const remaining = { ...current };
      for (const key of Object.keys(next)) delete remaining[key];
      delete remaining.form;
      return remaining;
    });
  };

  const save = async (): Promise<void> => {
    if (busy) return;
    const validation = reportDraftErrors(draft);
    setErrors(validation);
    if (Object.keys(validation).length > 0) return;

    const generation = ++requestGenerationRef.current;
    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    setBusy(true);
    let result:
      | Awaited<ReturnType<typeof scheduledReportsApi.update>>
      | Awaited<ReturnType<typeof scheduledReportsApi.create>>;
    try {
      result = report
        ? await scheduledReportsApi.update(
            report.id,
            draftToPatchInput(draft),
            {
              signal: controller.signal,
            },
          )
        : await scheduledReportsApi.create(draftToCreateInput(draft), {
            signal: controller.signal,
          });
    } catch {
      result = {
        error: {
          kind: "network",
          code: "scheduled_report_save_failed",
          message: "Request failed.",
        },
      };
    }
    if (
      !mountedRef.current ||
      controller.signal.aborted ||
      generation !== requestGenerationRef.current
    ) {
      return;
    }
    setBusy(false);
    requestControllerRef.current = null;
    if (result.error) {
      const action = report ? "update" : "create";
      const message = scheduledReportErrorMessage(result.error, action);
      const field = fieldForScheduledReportError(result.error);
      setErrors({ [field]: message });
      return;
    }
    toast.success(
      report
        ? `Updated “${draft.name.trim()}”`
        : `Scheduled “${draft.name.trim()}” in ${draft.timezone.trim() || "UTC"}`,
    );
    await onSaved();
  };

  const recipientsCount = parseRecipients(draft.recipientsText).length;
  const nextDuePreview =
    report &&
    draftSchedule(draft) === report.schedule &&
    draft.timezone.trim() === report.timezone
      ? formatReportDateTime(report.next_due_at, draft.timezone)
      : null;
  const requestClose = (): void => {
    if (busy) return;
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  };

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        closeOnBackdrop={!busy}
        closeOnEscape={!busy}
        closeDisabled={busy}
        size="lg"
        title={
          mode === "create"
            ? "New scheduled report"
            : `Edit ${report?.name ?? "report"}`
        }
        description="Define the local wall-clock cadence and every mailbox that will receive the report."
      >
        <form
          className="analytics-scheduled-form"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {errors.form ? (
            <ActionFailure message={errors.form} diagnostic={null} />
          ) : null}

          <div className="analytics-scheduled-form-grid">
            <FormField label="Name" required error={errors.name}>
              <input
                type="text"
                maxLength={160}
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
                placeholder="Monday engagement digest"
              />
            </FormField>

            <FormField
              label="Template"
              required
              error={errors.template}
              help={
                mode === "edit"
                  ? "The template is frozen after creation."
                  : REPORT_TEMPLATES.find(
                      (template) => template.value === draft.template,
                    )?.description
              }
            >
              <select
                value={draft.template}
                disabled={mode === "edit"}
                onChange={(event) => patch({ template: event.target.value })}
              >
                {REPORT_TEMPLATES.map((template) => (
                  <option key={template.value} value={template.value}>
                    {template.label}
                  </option>
                ))}
                {mode === "edit" &&
                !REPORT_TEMPLATES.some(
                  (template) => template.value === draft.template,
                ) ? (
                  <option value={draft.template}>{draft.template}</option>
                ) : null}
              </select>
            </FormField>
          </div>

          <div className="analytics-scheduled-form-section">
            <div className="analytics-scheduled-form-section-heading">
              <span>Cadence</span>
              <span>Evaluated in one explicit IANA timezone</span>
            </div>

            {draft.rawSchedule != null ? (
              <FormField
                label="Schedule"
                required
                error={errors.schedule}
                help={
                  'This stored schedule cannot be represented by the visual editor. Use "weekly:mon@09:00" or "monthly:14@09:00".'
                }
              >
                <input
                  type="text"
                  className="mono"
                  value={draft.rawSchedule}
                  onChange={(event) =>
                    patch({ rawSchedule: event.target.value })
                  }
                />
              </FormField>
            ) : (
              <FormField label="Schedule" required error={errors.schedule}>
                <div className="analytics-scheduled-cadence-controls">
                  <select
                    aria-label="Schedule frequency"
                    value={draft.schedule.kind}
                    onChange={(event) =>
                      patch({
                        schedule: {
                          ...draft.schedule,
                          kind: event.target.value as "weekly" | "monthly",
                        },
                      })
                    }
                  >
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                  {draft.schedule.kind === "weekly" ? (
                    <select
                      aria-label="Day of week"
                      value={draft.schedule.dow}
                      onChange={(event) =>
                        patch({
                          schedule: {
                            ...draft.schedule,
                            dow: event.target.value,
                          },
                        })
                      }
                    >
                      {WEEKDAYS.map((weekday) => (
                        <option key={weekday.value} value={weekday.value}>
                          {weekday.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <select
                      aria-label="Day of month"
                      value={draft.schedule.dom}
                      onChange={(event) =>
                        patch({
                          schedule: {
                            ...draft.schedule,
                            dom: event.target.value,
                          },
                        })
                      }
                    >
                      {Array.from({ length: 28 }, (_, index) =>
                        String(index + 1),
                      ).map((day) => (
                        <option key={day} value={day}>
                          Day {day}
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    type="time"
                    aria-label={`Send time in ${draft.timezone || "UTC"}`}
                    value={draft.schedule.time}
                    onChange={(event) =>
                      patch({
                        schedule: {
                          ...draft.schedule,
                          time: event.target.value,
                        },
                      })
                    }
                  />
                </div>
              </FormField>
            )}

            <FormField
              label="Timezone"
              required
              error={errors.timezone}
              help="Use a named IANA location so daylight-saving rules remain explicit."
            >
              <input
                type="text"
                list={timezoneListId}
                value={draft.timezone}
                onChange={(event) => patch({ timezone: event.target.value })}
                placeholder="America/New_York"
                autoCapitalize="off"
                spellCheck={false}
              />
            </FormField>
            <datalist id={timezoneListId}>
              {suggestions.map((timezone) => (
                <option key={timezone} value={timezone} />
              ))}
            </datalist>

            <div className="analytics-scheduled-dst-note" role="note">
              <strong>
                {nextDuePreview ?? "Next due time is computed on save"}
              </strong>
              <span>{timezonePolicyCopy(draft.timezone)}</span>
            </div>
          </div>

          <FormField
            label="Recipients"
            required
            error={errors.recipients}
            help={`One mailbox per line; commas also work. ${recipientsCount}/20 parsed.`}
          >
            <textarea
              rows={4}
              value={draft.recipientsText}
              onChange={(event) =>
                patch({ recipientsText: event.target.value })
              }
              placeholder={"founder@example.com\nteam@example.com"}
              spellCheck={false}
            />
          </FormField>

          {mode === "edit" ? (
            <FormField
              label="Recurring delivery"
              help={
                draft.enabled
                  ? "The next due occurrence remains active."
                  : "Manual runs remain available while the recurring cadence is paused."
              }
            >
              <label className="analytics-scheduled-enabled-control">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => patch({ enabled: event.target.checked })}
                />
                <span>Send on schedule</span>
              </label>
            </FormField>
          ) : null}

          <ModalFooter>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={requestClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy}
              aria-busy={busy ? "true" : undefined}
            >
              {busy
                ? "Saving…"
                : mode === "create"
                  ? "Create report"
                  : "Save changes"}
            </button>
          </ModalFooter>
        </form>
      </Modal>

      <ConfirmModal
        open={discardOpen}
        danger
        title="Discard unsaved report changes?"
        description="The report definition has not been saved. This cannot be recovered after the editor closes."
        confirmLabel="Discard changes"
        onConfirm={() => {
          setDiscardOpen(false);
          onClose();
        }}
        onClose={() => setDiscardOpen(false)}
      />
    </>
  );
}

function reportDraftFingerprint(draft: ReportDraft): string {
  return JSON.stringify({
    name: draft.name,
    template: draft.template,
    schedule: draft.schedule,
    rawSchedule: draft.rawSchedule,
    timezone: draft.timezone,
    recipientsText: draft.recipientsText,
    enabled: draft.enabled,
  });
}

function fieldForScheduledReportError(
  error: ScheduledReportApiError,
): "name" | "recipients" | "form" {
  if (error.code === "invalid_name") return "name";
  if (error.code === "invalid_recipients") return "recipients";
  return "form";
}
