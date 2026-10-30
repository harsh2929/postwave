import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { domainWarmupApi } from "../../lib/api-client";
import type { WarmupPlan } from "../../lib/api/domain-warmup";
import { useCanAdmin, useRoleStatus } from "../../lib/store";
import { Icon } from "../Icon";
import { Notice } from "../Notice";
import { parseWarmupPlans } from "./sending-control-response-contract";

import "../../styles-deliverability-controls.css";

const NUM = new Intl.NumberFormat();
const MAX_DOMAIN_CHARACTERS = 253;

export function DomainWarmupPanel(): ReactElement {
  const canAdmin = useCanAdmin();
  const roleStatus = useRoleStatus();
  const [plans, setPlans] = useState<WarmupPlan[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) return;
    if (!canAdmin) {
      setPlans(null);
      setLoading(false);
      setFailed(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setFailed(false);
    try {
      const result = await domainWarmupApi.list();
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      const parsed = result.error ? null : parseWarmupPlans(result.data);
      if (parsed) setPlans(parsed);
      else setFailed(true);
    } catch {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setFailed(true);
      }
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [canAdmin]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, [load]);

  if (roleStatus === "loading") return <WarmupAccessSkeleton />;
  if (!canAdmin) return <WarmupAccessBoundary />;

  return (
    <section
      className="dhw-control-evidence dhw-warmup"
      aria-labelledby="dhw-warmup-title"
    >
      <header>
        <span className="dhw-control-evidence-icon">
          <Icon name="chart-bars" size={17} />
        </span>
        <div>
          <small>Configured scheduler evidence</small>
          <h3 id="dhw-warmup-title">Domain warmup plans</h3>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh plans"}
        </button>
      </header>

      <Notice
        tone="warning"
        announcement="off"
        title="Planning evidence, not a send-path guarantee"
      >
        These rows describe the scheduler’s configured ramp. The currently
        verified send path does not enforce these daily caps, so do not treat a
        plan as proof that live traffic is constrained.
      </Notice>

      {failed ? (
        <div className="dhw-control-evidence-error" role="alert">
          <Icon name="alert-triangle" size={16} />
          <span>
            Warmup-plan evidence could not be verified.
            {plans ? " The last verified inventory remains visible." : ""}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load()}
            disabled={loading}
          >
            Retry
          </button>
        </div>
      ) : null}

      {loading && plans === null ? (
        <div className="dhw-control-evidence-skeleton" aria-busy="true">
          <div className="skel" />
          <div className="skel" />
          <span className="visually-hidden" role="status">
            Loading configured warmup plans
          </span>
        </div>
      ) : plans?.length === 0 ? (
        <div className="dhw-control-evidence-empty">
          <Icon name="clock" size={18} />
          <div>
            <strong>No configured plan returned</strong>
            <p>
              This does not prove that new domains ramp automatically or that
              live send volume is capped.
            </p>
          </div>
        </div>
      ) : plans ? (
        <ul className="dhw-warmup-list">
          {plans.map((plan) => (
            <PlanRow key={plan.id} plan={plan} />
          ))}
        </ul>
      ) : null}

      {loading && plans ? (
        <p className="dhw-control-evidence-stale" role="status">
          Refreshing while the last verified plan inventory remains visible.
        </p>
      ) : null}
    </section>
  );
}

function WarmupAccessSkeleton(): ReactElement {
  return (
    <section
      className="dhw-control-evidence dhw-warmup"
      aria-label="Domain warmup access"
      aria-busy="true"
    >
      <div className="dhw-control-evidence-skeleton">
        <div className="skel" />
        <span className="visually-hidden" role="status">
          Resolving domain warmup access
        </span>
      </div>
    </section>
  );
}

function WarmupAccessBoundary(): ReactElement {
  return (
    <section
      className="dhw-control-evidence dhw-warmup"
      aria-label="Domain warmup access"
    >
      <Notice tone="neutral" announcement="off" title="Admin access required">
        Warmup plans are served by an admin-scoped endpoint. This workspace does
        not request the inventory for the current role.
      </Notice>
    </section>
  );
}

function PlanRow({ plan }: { plan: WarmupPlan }): ReactElement {
  const peak = Math.max(plan.target_daily, ...plan.schedule, 1);
  const status = boundedText(plan.status, 40, "Unknown");
  const domain = boundedText(
    plan.domain,
    MAX_DOMAIN_CHARACTERS,
    "Unknown domain",
  );
  const lastObserved = validDateLabel(plan.last_observed_at);
  const updated = validDateLabel(plan.updated_at);
  const started = validDateLabel(plan.started_on, true);

  return (
    <li className="dhw-warmup-plan">
      <div className="dhw-warmup-plan-head">
        <div>
          <strong>{domain}</strong>
          <span data-status={statusTone(status)}>{status}</span>
        </div>
        <small>
          {plan.schedule.length.toLocaleString()} configured daily cap
          {plan.schedule.length === 1 ? "" : "s"}
        </small>
      </div>

      <dl className="dhw-warmup-facts">
        <PlanFact
          label="Target per day"
          value={NUM.format(plan.target_daily)}
        />
        <PlanFact
          label="Configured duration"
          value={NUM.format(plan.days) + " day" + (plan.days === 1 ? "" : "s")}
        />
        <PlanFact label="Configured start" value={started ?? "Unverified"} />
        <PlanFact
          label="Last scheduler count"
          value={NUM.format(plan.last_sent_count)}
          detail={
            lastObserved
              ? "Observed " + lastObserved
              : "Observation time unavailable"
          }
        />
      </dl>

      {plan.schedule.length > 0 ? (
        <>
          <div className="dhw-warmup-chart" aria-hidden="true">
            {plan.schedule.map((cap, index) => (
              <span
                key={String(index) + "-" + String(cap)}
                style={{
                  height:
                    String(Math.max(6, Math.round((cap / peak) * 100))) + "%",
                }}
              />
            ))}
          </div>
          <details className="dhw-warmup-schedule">
            <summary>
              Review exact daily schedule
              <Icon name="chevron-down" size={13} />
            </summary>
            <ol>
              {plan.schedule.map((cap, index) => (
                <li key={String(index) + "-" + String(cap)}>
                  <span>Configured day {index + 1}</span>
                  <strong>{NUM.format(cap)}</strong>
                </li>
              ))}
            </ol>
          </details>
        </>
      ) : (
        <p className="dhw-warmup-no-schedule">
          No daily schedule values were returned for this plan.
        </p>
      )}

      <p className="dhw-warmup-provenance">
        {updated
          ? "Plan record updated " + updated + ". "
          : "Plan update time unverified. "}
        Counts are scheduler observations and are not authoritative live-send
        enforcement evidence.
      </p>
    </li>
  );
}

function PlanFact({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}): ReactElement {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function statusTone(value: string): "healthy" | "warning" | "neutral" {
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === "paused") return "warning";
  return "neutral";
}

function validDateLabel(
  value: string | undefined,
  dateOnly = false,
): string | null {
  if (!value) return null;
  const normalized =
    dateOnly && /^\d{4}-\d{2}-\d{2}$/u.test(value)
      ? value + "T00:00:00Z"
      : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return dateOnly
    ? date.toLocaleDateString(undefined, { timeZone: "UTC" })
    : date.toLocaleString();
}

function boundedText(value: string, maximum: number, fallback: string): string {
  const safe = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
  if (!safe) return fallback;
  if (safe.length <= maximum) return safe;
  return safe.slice(0, Math.max(1, maximum - 1)) + "…";
}
