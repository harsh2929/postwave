import {
  type ReactElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type DeliverabilityHubSummary,
  deliverabilityHubApi,
} from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { ConfirmModal } from "../ConfirmModal";
import { Icon } from "../Icon";
import { toast } from "../Toast";
import { classifyRepairOverride } from "./repair-override-contract";

interface Props {
  summary: DeliverabilityHubSummary | null;
  loading: boolean;
  onRepaired?: () => void;
}

export function ScoreCard({
  summary,
  loading,
  onRepaired,
}: Props): ReactElement {
  const isAdmin = useCanAdmin();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [overriding, setOverriding] = useState(false);
  const [awaitingAuthoritativeRefresh, setAwaitingAuthoritativeRefresh] =
    useState<
      | "committed"
      | "committed-conservatively-fenced"
      | "commit-outcome-unknown-conservatively-fenced"
      | "outcome-unknown"
      | null
    >(null);
  const overrideInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const restoreButtonRef = useRef<HTMLButtonElement | null>(null);
  const refreshBaselineRef = useRef<DeliverabilityHubSummary | null>(null);
  const restoreStatusId = useId();
  const trendStatusId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (
      awaitingAuthoritativeRefresh &&
      summary !== refreshBaselineRef.current
    ) {
      refreshBaselineRef.current = null;
      setAwaitingAuthoritativeRefresh(null);
    }
  }, [awaitingAuthoritativeRefresh, summary]);

  if (loading) return <ScoreInputsSkeleton />;
  if (!summary) return <ScoreInputsUnavailable />;

  const override = async (): Promise<void> => {
    if (!isAdmin || overrideInFlightRef.current) return;
    overrideInFlightRef.current = true;
    setOverriding(true);
    try {
      const result = await deliverabilityHubApi.repairOverride();
      if (!mountedRef.current) return;
      const disposition = classifyRepairOverride(result);
      if (disposition.kind === "rejected") {
        toast.error({
          message: "Couldn’t clear the repair override",
          detail: "The server did not confirm a cap restoration.",
        });
        return;
      }
      setConfirmOpen(false);
      refreshBaselineRef.current = summary;
      setAwaitingAuthoritativeRefresh(disposition.kind);
      if (disposition.kind === "committed") {
        toast.success(
          "Repair override cleared. Refreshing the recorded sending state.",
        );
      } else if (disposition.kind === "committed-conservatively-fenced") {
        toast.info({
          id: "deliverability-repair-cap-fenced",
          message: "Repair override cleared; sending remains safely fenced",
          detail:
            "The recorded cap was restored, but shared cap coordination has not converged. Refreshing authoritative state—do not repeat the clear action.",
          duration: 10_000,
        });
      } else {
        toast.error({
          id: "deliverability-repair-outcome-unknown",
          message: "Cap restoration outcome needs verification",
          detail:
            "The request may have committed. Sending remains conservatively fenced while authoritative state refreshes; do not repeat the clear action.",
          duration: 12_000,
        });
      }
      onRepaired?.();
    } catch {
      if (mountedRef.current) {
        toast.error({
          message: "Couldn’t clear the repair override",
          detail: "The request could not be completed. No success was assumed.",
        });
      }
    } finally {
      overrideInFlightRef.current = false;
      if (mountedRef.current) setOverriding(false);
    }
  };

  const trend = summary.trend ?? "flat";
  const delta = summary.trend_delta ?? 0;
  const windowDays = summary.window_days ?? 30;
  const sampleQualified = summary.sample_qualified;
  const sampleSize = summary.totals.sends_30d;
  const rateMetricTone = (
    value: number | undefined,
    warning: number,
    danger: number,
    higherIsBetter: boolean,
  ) =>
    sampleQualified
      ? rateTone(value, warning, danger, higherIsBetter)
      : ("neutral" as const);
  return (
    <section
      className="card dhw-score-inputs"
      aria-labelledby="dhw-score-inputs-title"
    >
      <header>
        <span className="dhw-score-inputs-icon">
          <Icon name="chart-bars" size={17} />
        </span>
        <div>
          <span>Score explanation</span>
          <h3 id="dhw-score-inputs-title">Current model inputs</h3>
        </div>
        <span
          className={`dhw-score-trend is-${sampleQualified && summary.trend_reference_at ? trend : "flat"}`}
          aria-describedby={
            summary.trend_reference_at ? trendStatusId : undefined
          }
        >
          {sampleQualified && summary.trend_reference_at
            ? trendLabel(trend, delta)
            : "No qualified 7-day baseline"}
        </span>
        {summary.trend_reference_at ? (
          <span id={trendStatusId} className="visually-hidden">
            Qualified comparison snapshot: {new Date(summary.trend_reference_at).toLocaleString()}.
          </span>
        ) : null}
      </header>

      {!sampleQualified ? (
        <div className="dhw-sample-notice" role="status">
          <span aria-hidden="true">
            <Icon name="clock" size={16} />
          </span>
          <div>
            <strong>Rate sample is not qualified yet</strong>
            <p>
              {sampleSize.toLocaleString()} of{" "}
              {summary.minimum_sample_sends.toLocaleString()} successful
              campaign sends are available in this {windowDays}-day window.
              Rates remain visible as observations, but they do not affect the
              score, trigger a degradation alert, or start automatic throttling.
            </p>
          </div>
        </div>
      ) : null}

      <div className="dhw-score-metrics">
        <ScoreMetric
          label="Bounce rate"
          value={rate(summary.bounce_rate, true)}
          detail={`${summary.totals.sends_30d.toLocaleString()} campaign sends · ${windowDays}d`}
          tone={rateMetricTone(summary.bounce_rate, 0.005, 0.02, false)}
        />
        <ScoreMetric
          label="Complaint rate"
          value={rate(summary.complaint_rate, true)}
          detail={`${summary.totals.sends_30d.toLocaleString()} campaign sends · ${windowDays}d`}
          tone={rateMetricTone(summary.complaint_rate, 0.0005, 0.001, false)}
        />
        <ScoreMetric
          label="Human engagement"
          value={rate(summary.engagement_rate, false)}
          detail="unique campaign recipients after machine filtering"
          tone={rateMetricTone(summary.engagement_rate, 0.1, 0.1, true)}
        />
        <ScoreMetric
          label="Machine-open share"
          value={rate(summary.opens_machine_pct, false)}
          detail="excluded from human opens"
          tone="neutral"
        />
      </div>

      <p className="dhw-score-method">
        The score is a directional operating signal, not an inbox-placement
        guarantee. Event rates use successful campaign sends and campaign-bound
        feedback in the displayed window; transactional mail is outside this
        rate sample. Domain authentication and recent blocklist observations
        remain workspace-wide inputs. Snapshot comparisons are restricted to
        qualified observations from the same model version.
      </p>

      {summary.auto_throttled ? (
        <div className="dhw-repair" role="alert">
          <span>
            <Icon name="alert-triangle" size={17} />
          </span>
          <div>
            <strong>Recorded reputation repair is active</strong>
            <p>
              A background repair action lowered the workspace’s hourly send cap
              after its low-score condition was met. New sends use the recorded
              cap until an admin clears this override.
            </p>
            {summary.auto_throttle_reason ? (
              <small>
                Server reason: {safeReason(summary.auto_throttle_reason)}
              </small>
            ) : null}
            {awaitingAuthoritativeRefresh ? (
              <small role="status">
                {awaitingAuthoritativeRefresh ===
                  "commit-outcome-unknown-conservatively-fenced" ||
                awaitingAuthoritativeRefresh === "outcome-unknown"
                  ? "Clear outcome is being verified. Do not repeat this action until a fresh authoritative summary arrives."
                  : "Clear was recorded. Waiting for a fresh authoritative summary before another action is allowed."}
              </small>
            ) : null}
          </div>
          <button
            ref={restoreButtonRef}
            type="button"
            className={`btn btn-sm${!isAdmin || overriding || awaitingAuthoritativeRefresh !== null ? " pw-discoverable-unavailable" : ""}`}
            aria-disabled={
              !isAdmin || overriding || awaitingAuthoritativeRefresh !== null
            }
            aria-describedby={restoreStatusId}
            onClick={() => {
              if (
                isAdmin &&
                !overriding &&
                awaitingAuthoritativeRefresh === null
              ) {
                setConfirmOpen(true);
              }
            }}
          >
            {!isAdmin
              ? "Admin action"
              : awaitingAuthoritativeRefresh ===
                    "commit-outcome-unknown-conservatively-fenced" ||
                  awaitingAuthoritativeRefresh === "outcome-unknown"
                ? "Verification required"
                : awaitingAuthoritativeRefresh
                  ? "Refreshing recorded state"
                  : "Review cap restoration"}
          </button>
          <small id={restoreStatusId} className="pw-action-status">
            {!isAdmin
              ? "Only a workspace admin can review cap restoration."
              : overriding
                ? "The cap restoration request is in progress."
                : awaitingAuthoritativeRefresh
                  ? "Wait for a fresh authoritative summary before reviewing another restoration."
                  : "Opens a typed confirmation before changing live sending capacity."}
          </small>
        </div>
      ) : null}

      <ConfirmModal
        open={confirmOpen}
        title="Restore the recorded send cap?"
        description="This changes live sending capacity; it does not repair the underlying reputation signals."
        confirmLabel="Restore recorded cap"
        typeToConfirm="RESTORE SENDING"
        busy={overriding}
        returnFocusRef={restoreButtonRef}
        onClose={() => setConfirmOpen(false)}
        onConfirm={override}
      >
        <div className="dhw-repair-confirmation">
          <strong>What the server will do</strong>
          <ul>
            <li>Clear the active repair override.</li>
            <li>Restore the prior hourly cap recorded with that override.</li>
            <li>
              Leave every underlying bounce, complaint, DNS, and blocklist
              signal unchanged.
            </li>
          </ul>
          <p>
            A later worker evaluation can apply another throttle if its
            low-score condition is met again.
          </p>
        </div>
      </ConfirmModal>
    </section>
  );
}

function ScoreMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "healthy" | "warning" | "danger" | "neutral";
}): ReactElement {
  return (
    <article data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function ScoreInputsSkeleton(): ReactElement {
  return (
    <section className="card dhw-score-inputs" aria-busy="true">
      <div className="skel" style={{ height: 14, width: 160 }} />
      <div className="dhw-score-metrics">
        {[0, 1, 2, 3].map((item) => (
          <div className="skel" style={{ height: 92 }} key={item} />
        ))}
      </div>
      <span className="visually-hidden" role="status">
        Loading score inputs
      </span>
    </section>
  );
}

function ScoreInputsUnavailable(): ReactElement {
  return (
    <section className="card dhw-score-inputs">
      <header>
        <span className="dhw-score-inputs-icon">
          <Icon name="alert-triangle" size={17} />
        </span>
        <div>
          <span>Score explanation</span>
          <h3>Inputs unavailable</h3>
        </div>
      </header>
      <p className="dhw-score-method">
        No verified score inputs are available. Independent evidence surfaces
        may still load below.
      </p>
    </section>
  );
}

function rate(value: number | undefined, precise: boolean): string {
  if (value === undefined) return "—";
  const percent = value * 100;
  return `${percent.toFixed(precise && percent < 1 ? 2 : 1)}%`;
}

function rateTone(
  value: number | undefined,
  warning: number,
  danger: number,
  higherIsBetter: boolean,
): "healthy" | "warning" | "danger" | "neutral" {
  if (value === undefined) return "neutral";
  if (higherIsBetter) return value < danger ? "danger" : "healthy";
  if (value > danger) return "danger";
  if (value > warning) return "warning";
  return "healthy";
}

function trendLabel(
  trend: DeliverabilityHubSummary["trend"],
  delta: number,
): string {
  if (trend === "flat") return "Stable vs history";
  const amount = Math.abs(delta);
  return `${trend === "up" ? "Up" : "Down"} ${amount} point${amount === 1 ? "" : "s"}`;
}

function safeReason(value: string): string {
  return /^auto: reputation_repair score=\d{1,3}$/u.test(value)
    ? value.replace("auto: reputation_repair", "low score recorded")
    : "automatic reputation repair";
}
