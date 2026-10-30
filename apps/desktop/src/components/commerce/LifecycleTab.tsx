/**
 * Commerce → Lifecycle tab (#33d).
 *
 * Per-integration lifecycle messaging health: the evaluate action
 * (admin — flips back-in-stock / price-drop subscriptions to eligible)
 * and the lifecycle report table (subscription totals by status,
 * commerce events over the last 30 days, notify backlog).
 */
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The named lifecycle table is a bounded horizontal overflow region that keyboard users must be able to pan. */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { ConfirmModal } from "../ConfirmModal";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";
import {
  type CommerceIntegration,
  type CommerceLifecycleReport,
  commerceApi,
} from "../../lib/api-client";

import {
  evaluateSummaryMessage,
  eventCounts30d,
  fmtCommerceDate,
  lifecycleRows,
} from "./commerce-helpers";

type ReportState =
  | {
      integrationId: "";
      phase: "idle";
      report: null;
      error: null;
    }
  | {
      integrationId: string;
      phase: "loading";
      report: null;
      error: null;
    }
  | {
      integrationId: string;
      phase: "error";
      report: null;
      error: string;
    }
  | {
      integrationId: string;
      phase: "ready";
      report: CommerceLifecycleReport;
      error: null;
    };

const IDLE_REPORT: ReportState = {
  integrationId: "",
  phase: "idle",
  report: null,
  error: null,
};

const LOAD_FAILURE =
  "The lifecycle service could not be reached. Check the connection and retry.";
const INVALID_REPORT =
  "The service returned an invalid lifecycle report. Retry before acting on these totals.";
const WRONG_STORE_REPORT =
  "The service returned a report for another store. No totals are shown; retry to restore verified store context.";
const EVALUATE_FAILURE =
  "The lifecycle evaluator could not be reached. No completion was confirmed; try again.";

function integrationLabel(integration: CommerceIntegration): string {
  return (
    integration.shop_domain ||
    `${integration.provider} · ${integration.id.slice(0, 8)}`
  );
}

function eventLabel(value: string): string {
  const words = value
    .split(/[._-]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.join(" ") || "Recorded event";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCountMap(value: unknown): value is Record<string, number> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isCount)
  );
}

function isLifecycleStats(
  value: unknown,
): value is CommerceLifecycleReport["cart_recovery"] {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { total?: unknown; by_status?: unknown };
  return isCount(candidate.total) && isCountMap(candidate.by_status);
}

function isLifecycleReport(value: unknown): value is CommerceLifecycleReport {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CommerceLifecycleReport>;
  return (
    typeof candidate.integration_id === "string" &&
    typeof candidate.generated_at === "string" &&
    isLifecycleStats(candidate.cart_recovery) &&
    isLifecycleStats(candidate.back_in_stock) &&
    isLifecycleStats(candidate.price_drop) &&
    isCountMap(candidate.events_last_30_days) &&
    isCount(candidate.eligible_last_30_days) &&
    isCount(candidate.notified_pending)
  );
}

function isEvaluationAcknowledgement(value: unknown): value is {
  back_in_stock_eligible: number;
  price_drop_eligible: number;
  evaluated_at: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    back_in_stock_eligible?: unknown;
    price_drop_eligible?: unknown;
    evaluated_at?: unknown;
  };
  return (
    isCount(candidate.back_in_stock_eligible) &&
    isCount(candidate.price_drop_eligible) &&
    typeof candidate.evaluated_at === "string"
  );
}

interface LifecycleController {
  selectedIntegrationId: string;
  selectedLabel: string;
  reportState: ReportState;
  evaluationTarget: CommerceIntegration | null;
  evaluationOpen: boolean;
  evaluating: boolean;
  selectIntegration: (integrationId: string) => void;
  refreshReport: () => void;
  openEvaluation: () => void;
  closeEvaluation: () => void;
  confirmEvaluation: () => Promise<void>;
}

function useLifecycleController(
  integrations: CommerceIntegration[] | null,
  canAdmin: boolean,
): LifecycleController {
  const [integrationId, setIntegrationId] = useState("");
  const [reportState, setReportState] = useState<ReportState>(IDLE_REPORT);
  const [evaluationTargetId, setEvaluationTargetId] = useState<string | null>(
    null,
  );
  const [evaluating, setEvaluating] = useState(false);

  const mountedRef = useRef(true);
  const reportRequestRef = useRef(0);
  const selectedIntegrationIdRef = useRef("");
  const evaluationFlightRef = useRef(false);

  const knownIntegrations = integrations ?? [];
  const selectedIntegrationId =
    integrations === null
      ? integrationId
      : knownIntegrations.some((item) => item.id === integrationId)
        ? integrationId
        : (knownIntegrations[0]?.id ?? "");
  const selectedIntegration =
    knownIntegrations.find((item) => item.id === selectedIntegrationId) ?? null;
  const selectedLabel = selectedIntegration
    ? integrationLabel(selectedIntegration)
    : "selected store";

  // Keep the completion guard current during render. This closes the small gap
  // before effects run when a parent removes or replaces the selected store.
  selectedIntegrationIdRef.current = selectedIntegrationId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      reportRequestRef.current += 1;
    };
  }, []);

  // Repair a disappeared selection deterministically. The derived selection
  // above prevents even one paint of the removed store's report.
  useEffect(() => {
    if (integrations !== null && integrationId !== selectedIntegrationId) {
      setIntegrationId(selectedIntegrationId);
    }
  }, [integrationId, integrations, selectedIntegrationId]);

  const load = useCallback(
    async (targetIntegrationId: string): Promise<void> => {
      if (!targetIntegrationId) return;
      const request = ++reportRequestRef.current;
      setReportState({
        integrationId: targetIntegrationId,
        phase: "loading",
        report: null,
        error: null,
      });

      try {
        const result = await commerceApi.lifecycleReport(targetIntegrationId);
        if (
          !mountedRef.current ||
          request !== reportRequestRef.current ||
          selectedIntegrationIdRef.current !== targetIntegrationId
        ) {
          return;
        }
        if (result.error) {
          setReportState({
            integrationId: targetIntegrationId,
            phase: "error",
            report: null,
            error: result.error.message || LOAD_FAILURE,
          });
          return;
        }
        if (!isLifecycleReport(result.data)) {
          setReportState({
            integrationId: targetIntegrationId,
            phase: "error",
            report: null,
            error: INVALID_REPORT,
          });
          return;
        }
        if (result.data.integration_id !== targetIntegrationId) {
          setReportState({
            integrationId: targetIntegrationId,
            phase: "error",
            report: null,
            error: WRONG_STORE_REPORT,
          });
          return;
        }
        setReportState({
          integrationId: targetIntegrationId,
          phase: "ready",
          report: result.data,
          error: null,
        });
      } catch {
        if (
          !mountedRef.current ||
          request !== reportRequestRef.current ||
          selectedIntegrationIdRef.current !== targetIntegrationId
        ) {
          return;
        }
        setReportState({
          integrationId: targetIntegrationId,
          phase: "error",
          report: null,
          error: LOAD_FAILURE,
        });
      }
    },
    [],
  );

  useEffect(() => {
    if (!selectedIntegrationId) {
      reportRequestRef.current += 1;
      setReportState(IDLE_REPORT);
      return;
    }
    void load(selectedIntegrationId);
  }, [load, selectedIntegrationId]);

  useEffect(() => {
    if (!evaluationTargetId || evaluating) return;
    const targetStillExists = knownIntegrations.some(
      (item) => item.id === evaluationTargetId,
    );
    if (!canAdmin || !targetStillExists) setEvaluationTargetId(null);
  }, [canAdmin, evaluating, evaluationTargetId, knownIntegrations]);

  const evaluate = useCallback(
    async (targetIntegrationId: string): Promise<boolean> => {
      if (!targetIntegrationId || evaluationFlightRef.current) return false;
      evaluationFlightRef.current = true;
      if (mountedRef.current) setEvaluating(true);

      try {
        const result = await commerceApi.evaluateLifecycle(targetIntegrationId);
        if (!mountedRef.current) return false;
        if (result.error) {
          toast.error({
            message: "Evaluation failed",
            detail: result.error.message || EVALUATE_FAILURE,
          });
          return false;
        }
        if (!isEvaluationAcknowledgement(result.data)) {
          toast.error({
            message: "Evaluation acknowledgement incomplete",
            detail:
              "The action may have completed, but its counters could not be verified. The report is refreshing; review it before deciding whether to run evaluation again.",
          });
          if (selectedIntegrationIdRef.current === targetIntegrationId) {
            void load(targetIntegrationId);
          }
          // A successful transport with an invalid acknowledgement is
          // ambiguous. Close the confirmation so a casual second click cannot
          // repeat a mutation that may already have completed.
          return true;
        }
        toast.success({
          message: evaluateSummaryMessage(result.data),
          detail:
            "Eligibility was updated. This acknowledgement is not notification or delivery evidence; verify downstream automation and delivery logs.",
        });
        if (selectedIntegrationIdRef.current === targetIntegrationId) {
          void load(targetIntegrationId);
        }
        return true;
      } catch {
        if (mountedRef.current) {
          toast.error({
            message: "Evaluation failed",
            detail: EVALUATE_FAILURE,
          });
        }
        return false;
      } finally {
        evaluationFlightRef.current = false;
        if (mountedRef.current) setEvaluating(false);
      }
    },
    [load],
  );

  const currentReportState =
    reportState.integrationId === selectedIntegrationId
      ? reportState
      : ({
          integrationId: selectedIntegrationId,
          phase: "loading",
          report: null,
          error: null,
        } satisfies ReportState);
  const evaluationTarget =
    knownIntegrations.find((item) => item.id === evaluationTargetId) ?? null;

  return {
    selectedIntegrationId,
    selectedLabel,
    reportState: currentReportState,
    evaluationTarget,
    evaluationOpen: evaluationTargetId !== null,
    evaluating,
    selectIntegration(nextId) {
      if (nextId === selectedIntegrationIdRef.current) return;
      // Invalidate the previous response immediately, before React's next
      // effect has a chance to start the replacement request.
      reportRequestRef.current += 1;
      selectedIntegrationIdRef.current = nextId;
      setIntegrationId(nextId);
      setEvaluationTargetId(null);
      setReportState({
        integrationId: nextId,
        phase: "loading",
        report: null,
        error: null,
      });
    },
    refreshReport() {
      void load(selectedIntegrationId);
    },
    openEvaluation() {
      setEvaluationTargetId(selectedIntegrationId);
    },
    closeEvaluation() {
      if (!evaluating) setEvaluationTargetId(null);
    },
    async confirmEvaluation() {
      if (!evaluationTargetId) return;
      const succeeded = await evaluate(evaluationTargetId);
      if (succeeded && mountedRef.current) setEvaluationTargetId(null);
    },
  };
}

export function LifecycleTab({
  integrations,
  integrationsErr,
  canAdmin,
}: {
  integrations: CommerceIntegration[] | null;
  integrationsErr: string | null;
  canAdmin: boolean;
}): ReactElement {
  const controller = useLifecycleController(integrations, canAdmin);
  const evaluateButtonRef = useRef<HTMLButtonElement | null>(null);

  if (integrationsErr && (!integrations || integrations.length === 0)) {
    return (
      <div className="notice" role="alert">
        <span>{integrationsErr}</span>
      </div>
    );
  }
  if (integrations === null) {
    return <p className="muted">Loading integrations…</p>;
  }
  if (integrations.length === 0) {
    return (
      <div className="list-empty">
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            ·
          </div>
          <h3>Lifecycle messaging needs a store integration</h3>
          <p>
            The evaluator checks inventory and price history from a connected
            store. Connect one on the Integrations tab first.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="commerce-surface"
      aria-busy={
        controller.reportState.phase === "loading" || controller.evaluating
          ? "true"
          : undefined
      }
    >
      <SectionHeader
        title="Lifecycle health"
        description="Inspect eligibility and lifecycle status for one store. Eligibility is a workflow state—not proof that a notification was queued, sent, or delivered."
        actions={
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <select
              value={controller.selectedIntegrationId}
              aria-label="Lifecycle store"
              disabled={controller.evaluating}
              onChange={(event) =>
                controller.selectIntegration(event.currentTarget.value)
              }
            >
              {integrations.map((integration) => (
                <option key={integration.id} value={integration.id}>
                  {integrationLabel(integration)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-sm"
              disabled={
                controller.reportState.phase === "loading" ||
                controller.evaluating ||
                !controller.selectedIntegrationId
              }
              onClick={controller.refreshReport}
            >
              {controller.reportState.phase === "loading"
                ? "Refreshing…"
                : "Refresh report"}
            </button>
            {canAdmin ? (
              <button
                ref={evaluateButtonRef}
                type="button"
                className="btn btn-sm btn-primary"
                disabled={
                  controller.evaluating || !controller.selectedIntegrationId
                }
                onClick={controller.openEvaluation}
              >
                {controller.evaluating ? "Evaluating…" : "Evaluate eligibility"}
              </button>
            ) : null}
          </div>
        }
      />

      {integrationsErr ? (
        <div className="notice" role="alert">
          <span>
            Store refresh failed. This report stays scoped to the last loaded
            store; refresh store states before treating its connection status as
            current.
          </span>
        </div>
      ) : null}

      <aside
        className="card"
        aria-label="How to read lifecycle readiness"
        style={{ padding: 16, marginBottom: 16 }}
      >
        <div className="section-title">Readiness, not delivery proof</div>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
          This report summarizes stored subscription states and recent commerce
          events for{" "}
          <strong style={{ color: "var(--pw-fg)" }}>
            {controller.selectedLabel}
          </strong>
          . “Awaiting notification” comes from lifecycle records; confirm
          automation runs and provider delivery logs before treating a message
          as dispatched or delivered.
        </p>
        {!canAdmin ? (
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>
            <strong style={{ color: "var(--pw-fg)" }}>Viewer access:</strong>{" "}
            you can inspect and refresh this report. An owner or admin must run
            eligibility evaluation.
          </p>
        ) : null}
      </aside>

      {controller.reportState.phase === "error" ? (
        <div className="notice" role="alert">
          <span>
            Couldn&apos;t load the lifecycle report:{" "}
            {controller.reportState.error}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={controller.refreshReport}
          >
            Retry
          </button>
        </div>
      ) : controller.reportState.phase !== "ready" ? (
        <p className="muted" role="status" aria-live="polite">
          Loading lifecycle report for {controller.selectedLabel}…
        </p>
      ) : (
        <LifecycleReportView
          report={controller.reportState.report}
          integrationLabel={controller.selectedLabel}
        />
      )}

      <ConfirmModal
        open={controller.evaluationOpen}
        title={`Evaluate eligibility for ${
          controller.evaluationTarget
            ? integrationLabel(controller.evaluationTarget)
            : "this store"
        }?`}
        description="This write action can update subscription workflow state. Review its evidence boundary before continuing."
        confirmLabel="Run evaluation"
        busy={controller.evaluating}
        returnFocusRef={evaluateButtonRef}
        onClose={controller.closeEvaluation}
        onConfirm={controller.confirmEvaluation}
      >
        <div className="card" style={{ padding: 14 }}>
          <p style={{ margin: 0, fontSize: 13 }}>
            <strong>What it updates:</strong> pending back-in-stock and
            price-drop subscriptions are checked against current inventory and
            price history; qualifying records may become eligible.
          </p>
          <p className="muted" style={{ margin: "10px 0 0", fontSize: 13 }}>
            <strong style={{ color: "var(--pw-fg)" }}>Preflight limits:</strong>{" "}
            candidate count, channel impact, and inventory/price freshness are
            not returned before this action. Continue only after reviewing the
            store&apos;s imported data.
          </p>
          <p className="muted" style={{ margin: "10px 0 0", fontSize: 13 }}>
            <strong style={{ color: "var(--pw-fg)" }}>
              What it does not prove:
            </strong>{" "}
            a successful evaluation does not prove any notification was queued,
            sent, or delivered. Verify the downstream automation run and
            provider delivery record separately.
          </p>
        </div>
      </ConfirmModal>
    </div>
  );
}

function LifecycleReportView({
  report,
  integrationLabel: reportIntegrationLabel,
}: {
  report: CommerceLifecycleReport;
  integrationLabel: string;
}): ReactElement {
  const rows = lifecycleRows(report);
  const events = eventCounts30d(report);

  return (
    <>
      <div className="pw-data-table">
        <div
          className="pw-data-table__scroll"
          role="region"
          aria-label={`Lifecycle subscription status for ${reportIntegrationLabel}`}
          tabIndex={0}
        >
          <table>
            <caption className="visually-hidden">
              Lifecycle subscription totals and status breakdown for{" "}
              {reportIntegrationLabel}
            </caption>
            <thead>
              <tr>
                <th scope="col">Lifecycle</th>
                <th scope="col" data-align="end">
                  Total
                </th>
                <th scope="col">Status breakdown</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.kind}>
                  <th scope="row">{row.kind}</th>
                  <td className="tabular" data-align="end">
                    {row.total.toLocaleString()}
                  </td>
                  <td className="muted tabular">{row.byStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <dl
        aria-label="Lifecycle report summary"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 8,
          margin: "12px 0 0",
        }}
      >
        <div className="card" style={{ padding: 12 }}>
          <dt className="muted" style={{ fontSize: 12 }}>
            Eligible in last 30 days
          </dt>
          <dd
            className="tabular"
            style={{ margin: "4px 0 0", fontWeight: 650 }}
          >
            {report.eligible_last_30_days.toLocaleString()}
          </dd>
        </div>
        <div className="card" style={{ padding: 12 }}>
          <dt className="muted" style={{ fontSize: 12 }}>
            Awaiting notification
          </dt>
          <dd
            className="tabular"
            style={{ margin: "4px 0 0", fontWeight: 650 }}
          >
            {report.notified_pending.toLocaleString()}
          </dd>
        </div>
        <div className="card" style={{ padding: 12 }}>
          <dt className="muted" style={{ fontSize: 12 }}>
            Report generated
          </dt>
          <dd style={{ margin: "4px 0 0", fontWeight: 650 }}>
            {fmtCommerceDate(report.generated_at)}
          </dd>
        </div>
      </dl>

      {events.length > 0 ? (
        <section className="card" style={{ marginTop: 16, padding: 16 }}>
          <h4 className="section-title" style={{ margin: 0 }}>
            Commerce events · last 30 days
          </h4>
          <p className="muted" style={{ margin: "5px 0 10px", fontSize: 12 }}>
            Recorded event volume for this store; counts do not imply an
            automation or notification ran.
          </p>
          <ul
            aria-label="Commerce event counts in the last 30 days"
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              margin: 0,
              padding: 0,
              listStyle: "none",
            }}
          >
            {events.map((event) => (
              <li key={event.event} className="badge">
                <bdi>{eventLabel(event.event)}</bdi>{" "}
                <strong className="tabular">
                  {event.count.toLocaleString()}
                </strong>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          No commerce events recorded in the last 30 days.
        </p>
      )}
    </>
  );
}
