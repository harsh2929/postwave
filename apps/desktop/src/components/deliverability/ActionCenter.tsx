import type { ReactElement } from "react";

import type { DeliverabilityHubBreach } from "../../lib/api-client";
import { ALL_DESKTOP_SECTIONS } from "../../lib/desktop-routes";
import { type Section, setSection } from "../../lib/store";
import { ExternalLink } from "../ExternalLink";
import { Icon } from "../Icon";
import { toast } from "../Toast";

interface Props {
  breaches: DeliverabilityHubBreach[] | null;
  loading?: boolean;
  unavailable?: boolean;
  onOpenHubEvidence?: () => void;
}

const SECTION_SET = new Set<string>(ALL_DESKTOP_SECTIONS);

export function ActionCenter({
  breaches,
  loading = false,
  unavailable = false,
  onOpenHubEvidence,
}: Props): ReactElement {
  if (breaches === null && loading) return <ActionCenterSkeleton />;
  if (breaches === null || unavailable) return <ActionCenterUnavailable />;
  if (breaches.length === 0) return <ActionCenterClear />;

  const critical = breaches.filter(
    ({ severity }) => severity === "critical",
  ).length;
  return (
    <section className="card dhw-actions" aria-labelledby="dhw-actions-title">
      <header>
        <span className="dhw-actions-icon">
          <Icon name="alert-triangle" size={17} />
        </span>
        <div>
          <span>Action center</span>
          <h3 id="dhw-actions-title">
            {breaches.length} signal{breaches.length === 1 ? "" : "s"} to triage
          </h3>
        </div>
        <span
          className={
            critical > 0 ? "dhw-actions-count is-critical" : "dhw-actions-count"
          }
        >
          {critical > 0 ? `${critical} critical` : "Review advised"}
        </span>
      </header>
      <ol>
        {breaches.map((breach, index) => (
          <BreachRow
            key={breach.code}
            breach={breach}
            index={index}
            onOpenHubEvidence={onOpenHubEvidence}
          />
        ))}
      </ol>
    </section>
  );
}

function BreachRow({
  breach,
  index,
  onOpenHubEvidence,
}: {
  breach: DeliverabilityHubBreach;
  index: number;
  onOpenHubEvidence?: () => void;
}): ReactElement {
  const act = (): void => {
    const cta = breach.fix_cta;
    if (!cta) return;
    if (cta.section === "deliverabilityHub" && onOpenHubEvidence) {
      onOpenHubEvidence();
      return;
    }
    if (cta.section && SECTION_SET.has(cta.section)) {
      setSection(cta.section as Section);
    }
  };
  return (
    <li data-severity={breach.severity}>
      <span className="dhw-action-order" aria-hidden="true">
        {String(index + 1).padStart(2, "0")}
      </span>
      <div className="dhw-action-body">
        <div className="dhw-action-title">
          <span>{severityLabel(breach.severity)}</span>
          <strong>{breach.title}</strong>
        </div>
        {breach.detail ? <p>{breach.detail}</p> : null}
        <dl>
          <BreachFact
            label="Observed"
            value={metricValue(breach, "observed")}
          />
          <BreachFact
            label="Threshold"
            value={metricValue(breach, "threshold")}
          />
          <BreachFact label="Signal" value={signalLabel(breach.metric)} />
        </dl>
        {breach.suggestion ? (
          <div className="dhw-action-guidance">
            <Icon name="arrow-right" size={13} />
            <span>{sentence(breach.suggestion)}</span>
          </div>
        ) : null}
        {breach.since && validDate(breach.since) ? (
          <time dateTime={breach.since}>
            Active since {new Date(breach.since).toLocaleString()}
          </time>
        ) : null}
      </div>
      {breach.fix_cta?.href ? (
        <ExternalLink
          className="btn btn-sm"
          href={breach.fix_cta.href}
          onOpenError={() => {
            toast.error("The external remediation link could not be opened.");
          }}
        >
          {breach.fix_cta.label}
          <Icon name="arrow-up-right" size={13} />
        </ExternalLink>
      ) : breach.fix_cta ? (
        <button type="button" className="btn btn-sm" onClick={act}>
          {breach.fix_cta.label}
          <Icon name="chevron-right" size={13} />
        </button>
      ) : null}
    </li>
  );
}

function BreachFact({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactElement {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ActionCenterClear(): ReactElement {
  return (
    <section
      className="card dhw-actions dhw-actions-clear"
      aria-labelledby="dhw-actions-clear-title"
    >
      <span className="dhw-actions-icon">
        <Icon name="shield-check" size={18} />
      </span>
      <div>
        <span>Action center</span>
        <h3 id="dhw-actions-clear-title">No threshold breach in this score</h3>
        <p>
          A later worker computation may change this result. Continue to review
          independent provider and recipient evidence.
        </p>
      </div>
    </section>
  );
}

function ActionCenterSkeleton(): ReactElement {
  return (
    <section className="card dhw-actions" aria-busy="true">
      <div className="skel" style={{ width: 120, height: 12 }} />
      <div className="skel" style={{ width: "74%", height: 54 }} />
      <span className="visually-hidden" role="status">
        Loading deliverability priorities
      </span>
    </section>
  );
}

function ActionCenterUnavailable(): ReactElement {
  return (
    <section className="card dhw-actions dhw-actions-unavailable">
      <span className="dhw-actions-icon">
        <Icon name="alert-triangle" size={18} />
      </span>
      <div>
        <span>Action center</span>
        <h3>Priorities could not be verified</h3>
        <p>Refresh the score before treating this workspace as clear.</p>
      </div>
    </section>
  );
}

function severityLabel(value: DeliverabilityHubBreach["severity"]): string {
  if (value === "critical") return "Critical";
  if (value === "warn") return "Warning";
  return "Information";
}

function metricValue(
  breach: DeliverabilityHubBreach,
  key: "observed" | "threshold",
): string {
  const value = breach[key];
  if (value === undefined) return "Not reported";
  if (breach.metric?.includes("rate")) {
    const percent = value * 100;
    return `${percent.toFixed(percent < 1 ? 2 : 1)}%`;
  }
  return value.toLocaleString();
}

function signalLabel(value: string | undefined): string {
  if (!value) return "Unspecified";
  return value.replaceAll("_", " ");
}

function validDate(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

function sentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Review the supporting evidence.";
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}${/[.!?]$/u.test(trimmed) ? "" : "."}`;
}
