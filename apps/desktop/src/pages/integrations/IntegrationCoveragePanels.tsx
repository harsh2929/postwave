import type { CSSProperties, ReactElement, ReactNode } from "react";

import type {
  IntegrationCustomerStackCoverage,
  IntegrationsCoverageResponse,
  IntegrationsReadinessResponse,
  IntegrationsStackReport,
} from "../../lib/api-client";
import {
  ALL_FILTER,
  badgeLabel,
  categoryLabel,
  filterIntegrationStacks,
} from "../integrations-helpers";
import { badgeTone, maturityTone } from "./IntegrationPresentation";
import { BlueprintTokenList, Metric } from "./IntegrationPanelPrimitives";

function stackStatusTone(status: string): string {
  switch (status) {
    case "ready":
      return "var(--pw-success)";
    case "covered":
      return "var(--pw-info)";
    case "partial":
      return "var(--pw-warning)";
    case "gap":
      return "var(--pw-danger)";
    default:
      return "var(--pw-fg-muted)";
  }
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function ratioPercentage(value: number, target: number): number {
  return clampPercentage((value / Math.max(1, target)) * 100);
}

function ProgressCard({
  label,
  value,
  detail,
  tone = "var(--pw-accent)",
}: {
  label: string;
  value: number;
  detail: ReactNode;
  tone?: string;
}): ReactElement {
  const percentage = clampPercentage(value);
  return (
    <div
      className="int-progress-card"
      style={{ "--int-progress-tone": tone } as CSSProperties}
    >
      <div className="int-progress-heading">
        <span>{label}</span>
        <strong>{percentage}%</strong>
      </div>
      <div
        className="int-progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage}
      >
        <span style={{ width: `${percentage}%` }} />
      </div>
      <div className="int-progress-detail">{detail}</div>
    </div>
  );
}

function ReportLoading({ label }: { label: string }): ReactElement {
  return (
    <div className="int-report-loading" role="status" aria-label={label}>
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

function ReportUnavailable({
  title,
  detail,
}: {
  title: string;
  detail: string;
}): ReactElement {
  return (
    <section className="int-report-unavailable" role="status">
      <span aria-hidden="true">?</span>
      <div>
        <h3>{title}</h3>
        <p>{detail}</p>
      </div>
    </section>
  );
}

function StackCard({
  stack,
  onOpenIntegration,
}: {
  stack: IntegrationCustomerStackCoverage;
  onOpenIntegration: (slug: string) => void;
}): ReactElement {
  return (
    <article
      className="int-stack-card"
      style={
        { "--int-stack-tone": stackStatusTone(stack.status) } as CSSProperties
      }
    >
      <header className="int-stack-card-header">
        <div>
          <div className="int-kicker">
            {categoryLabel(stack.segment, new Map())}
          </div>
          <h3>{stack.name}</h3>
        </div>
        <span className="int-stack-status">
          {categoryLabel(stack.status, new Map())}
        </span>
      </header>
      <p className="int-stack-summary">{stack.summary}</p>
      <div className="int-stack-progress-row">
        <div
          className="int-progress-track"
          role="progressbar"
          aria-label={`${stack.name} required coverage`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={clampPercentage(stack.coverage_pct)}
        >
          <span style={{ width: `${clampPercentage(stack.coverage_pct)}%` }} />
        </div>
        <strong>{clampPercentage(stack.coverage_pct)}%</strong>
      </div>
      <div className="int-stack-facts" aria-label={`${stack.name} evidence`}>
        <span>
          <strong>{stack.required_covered}</strong>/{stack.required_total}{" "}
          required
        </span>
        <span>
          <strong>{stack.optional_covered}</strong>/{stack.optional_total}{" "}
          optional
        </span>
        <span>
          <strong>{stack.native_managed}</strong> native
        </span>
        <span>
          <strong>{stack.bridge_ready}</strong> bridge-ready
        </span>
      </div>
      <div className="int-stack-components" aria-label="Stack components">
        {stack.components.map((component) => (
          <button
            key={`${stack.key}-${component.slug}-${component.role}`}
            type="button"
            className="int-stack-component"
            data-available={component.available ? "true" : "false"}
            data-native={component.native_managed ? "true" : undefined}
            onClick={() => onOpenIntegration(component.slug)}
            aria-label={`${component.name}: ${component.reason}`}
          >
            <span className="int-component-node" aria-hidden="true" />
            <span className="int-component-copy">
              <strong>{component.name}</strong>
              <span>
                {categoryLabel(component.role, new Map())} ·{" "}
                {component.required ? "Required" : "Optional"}
              </span>
            </span>
            <span className="int-component-state">
              {component.native_managed
                ? component.runtime_status === "partial"
                  ? "Foundation"
                  : "Native"
                : component.bridge_available
                  ? "Bridge"
                  : component.available
                    ? "Available"
                    : "Gap"}
            </span>
          </button>
        ))}
      </div>
      <BlueprintTokenList
        title="Recommended next actions"
        empty="No follow-up actions"
        values={stack.next_actions}
      />
    </article>
  );
}

export function StacksPanel({
  report,
  loading,
  query,
  category,
  badge,
  onOpenIntegration,
}: {
  report: IntegrationsStackReport | null;
  loading: boolean;
  query: string;
  category: string;
  badge: string;
  categoryLabels: Map<string, string>;
  onOpenIntegration: (slug: string) => void;
}): ReactElement {
  if (loading) return <ReportLoading label="Loading stack coverage" />;
  if (!report) {
    return (
      <ReportUnavailable
        title="Stack evidence is unavailable"
        detail="Moosewave will not infer customer-stack readiness from a missing report. Refresh evidence before using this view for a client decision."
      />
    );
  }
  const { stacks, highest_impact_gaps: gaps } = filterIntegrationStacks(
    report,
    query,
    category,
    badge,
  );

  return (
    <section
      className="int-report-surface"
      aria-label="Customer stack coverage"
    >
      <div className="int-report-overview">
        <ProgressCard
          label="Required stack coverage"
          value={report.covered_pct}
          detail={`${report.covered_stacks} of ${report.total_stacks} stacks covered`}
          tone={
            report.newsletter_commerce_ok
              ? "var(--pw-success)"
              : "var(--pw-warning)"
          }
        />
        <ProgressCard
          label="Program target"
          value={report.target_coverage_pct}
          detail={
            report.newsletter_commerce_ok
              ? "Newsletter-commerce threshold reached"
              : "Threshold remains open"
          }
          tone="var(--pw-info)"
        />
        <div className="int-report-metrics">
          <Metric
            label="Ready"
            value={
              (report.summary["status:ready"] ?? 0) +
              (report.summary["status:covered"] ?? 0)
            }
            tone="success"
          />
          <Metric
            label="Partial"
            value={report.summary["status:partial"] ?? 0}
            tone="warning"
          />
          <Metric
            label="Gaps"
            value={report.summary["status:gap"] ?? 0}
            tone="danger"
          />
        </div>
      </div>

      <div
        className={`int-assurance-banner ${report.newsletter_commerce_ok ? "is-qualified" : "is-open"}`}
      >
        <span className="int-assurance-mark" aria-hidden="true" />
        <div>
          <strong>
            {report.newsletter_commerce_ok
              ? "Reference-stack threshold reached"
              : "Reference-stack gaps remain"}
          </strong>
          <p>
            Coverage counts required components only when a verified native,
            bridge, migration, or ready-recipe path exists. It is architecture
            evidence—not proof that an individual customer account is connected.
          </p>
        </div>
      </div>

      <div className="int-stack-layout">
        <div className="int-stack-list">
          {stacks.length ? (
            stacks.map((stack) => (
              <StackCard
                key={stack.key}
                stack={stack}
                onOpenIntegration={onOpenIntegration}
              />
            ))
          ) : (
            <div className="int-inline-empty">
              No stacks match these filters.
            </div>
          )}
        </div>
        <aside className="int-impact-rail">
          <header>
            <div className="int-kicker">Portfolio leverage</div>
            <h3>Highest-impact gaps</h3>
            <p>
              Providers that unblock the most required reference-stack paths.
            </p>
          </header>
          <div className="int-impact-list">
            {gaps.length ? (
              gaps.map((gap, index) => (
                <button
                  key={gap.slug}
                  type="button"
                  className="int-impact-item"
                  onClick={() => onOpenIntegration(gap.slug)}
                >
                  <span className="int-impact-rank">{index + 1}</span>
                  <span>
                    <strong>{gap.name}</strong>
                    <span>{gap.reason}</span>
                  </span>
                  <span className="int-impact-count">
                    {gap.stacks} stacks · {gap.required_count} required
                  </span>
                </button>
              ))
            ) : (
              <div className="int-inline-empty">
                No impact gaps match these filters.
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

export function CoveragePanel({
  coverage,
  readiness,
  loading,
  query,
  category,
  badge,
  categoryLabels,
  onOpenGap,
}: {
  coverage: IntegrationsCoverageResponse | null;
  readiness: IntegrationsReadinessResponse | null;
  loading: boolean;
  query: string;
  category: string;
  badge: string;
  categoryLabels: Map<string, string>;
  onOpenGap: (slug: string) => void;
}): ReactElement {
  if (loading) return <ReportLoading label="Loading integration coverage" />;
  if (!coverage) {
    return (
      <ReportUnavailable
        title="Coverage evidence is unavailable"
        detail="No maturity score is shown because the coverage response could not be verified. Refresh evidence before using this view in a client conversation."
      />
    );
  }

  const needle = query.trim().toLowerCase();
  const categories = coverage.categories.filter((item) => {
    if (category !== ALL_FILTER && item.key !== category) return false;
    if (!needle) return true;
    return [item.key, item.label, item.maturity]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
  const gaps = coverage.priority_gaps.filter((gap) => {
    if (category !== ALL_FILTER && gap.category !== category) return false;
    if (badge !== ALL_FILTER && gap.current_badge !== badge) return false;
    if (!needle) return true;
    return [
      gap.slug,
      gap.name,
      gap.category,
      gap.phase ?? "",
      gap.current_badge,
      gap.runtime_status,
      gap.reason,
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
  const publicProgress = ratioPercentage(
    coverage.public_entries,
    coverage.target_public_entries,
  );
  const nativeProgress = ratioPercentage(
    coverage.native_managed,
    coverage.target_native_managed,
  );
  const nativeVerifiedProgress = ratioPercentage(
    coverage.native_verified,
    coverage.target_native_verified,
  );

  return (
    <section
      className="int-report-surface"
      aria-label="Integration coverage evidence"
    >
      <div className="int-coverage-progress">
        <ProgressCard
          label="Public catalog parity"
          value={publicProgress}
          detail={`${coverage.public_entries} of ${coverage.target_public_entries} truth-labelled entries`}
          tone={
            coverage.public_parity ? "var(--pw-success)" : "var(--pw-warning)"
          }
        />
        <ProgressCard
          label="Native-managed breadth"
          value={nativeProgress}
          detail={`${coverage.native_managed} of ${coverage.target_native_managed} managed foundations`}
          tone={coverage.native_parity ? "var(--pw-success)" : "var(--pw-info)"}
        />
        <ProgressCard
          label="API-verified native"
          value={nativeVerifiedProgress}
          detail={`${coverage.native_verified} of ${coverage.target_native_verified} certified connectors`}
          tone={
            coverage.native_verification_parity
              ? "var(--pw-success)"
              : "var(--pw-warning)"
          }
        />
      </div>
      <div className="int-coverage-facts">
        <Metric
          label="Bridge-ready"
          value={coverage.bridge_ready}
          tone="info"
        />
        <Metric
          label="Ready recipes"
          value={coverage.available_recipes}
          tone="success"
        />
        <Metric label="Generated" value={coverage.generated_recipes} />
        <Metric
          label="Priority gaps"
          value={coverage.priority_gaps.length}
          tone={coverage.priority_gaps.length ? "warning" : "success"}
        />
      </div>

      <div
        className={`int-assurance-banner ${coverage.public_parity ? "is-qualified" : "is-open"}`}
      >
        <span className="int-assurance-mark" aria-hidden="true" />
        <div>
          <strong>
            {coverage.public_parity
              ? "Catalog parity reached"
              : `${coverage.public_gap} public catalog gaps remain`}
          </strong>
          <p>
            Native-managed gap {coverage.native_gap}; API-verification gap{" "}
            {coverage.native_verification_gap}. A catalog entry or foundation is
            not equivalent to a provider-certified production connection.
          </p>
        </div>
      </div>

      <div className="int-coverage-layout">
        <div className="int-category-panel">
          <header className="int-report-section-header">
            <div>
              <div className="int-kicker">Portfolio distribution</div>
              <h3>Category maturity</h3>
            </div>
            <span>{categories.length} visible</span>
          </header>
          <div className="int-category-list">
            {categories.length ? (
              categories.map((item) => {
                const verifiedPct = ratioPercentage(
                  item.native_verified,
                  item.total,
                );
                return (
                  <article
                    key={item.key}
                    className="int-category-card"
                    style={
                      {
                        "--int-maturity-tone": maturityTone(item.maturity),
                      } as CSSProperties
                    }
                  >
                    <header>
                      <div>
                        <h4>{categoryLabel(item.key, categoryLabels)}</h4>
                        <span>{item.total} catalog entries</span>
                      </div>
                      <span>{categoryLabel(item.maturity, new Map())}</span>
                    </header>
                    <div className="int-category-bar" aria-hidden="true">
                      <span style={{ width: `${verifiedPct}%` }} />
                    </div>
                    <div className="int-category-facts">
                      <span>{item.native_verified} verified</span>
                      <span>{item.native_partial} foundations</span>
                      <span>{item.bridge_ready} bridge-ready</span>
                      <span>{item.available_recipes} recipes</span>
                      <span>{item.planned} planned</span>
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="int-inline-empty">
                No categories match these filters.
              </div>
            )}
          </div>
        </div>

        <aside className="int-gap-panel">
          <header className="int-report-section-header">
            <div>
              <div className="int-kicker">Next best work</div>
              <h3>Priority native gaps</h3>
            </div>
            <span>{gaps.length} visible</span>
          </header>
          <div className="int-gap-list">
            {gaps.length ? (
              gaps.map((gap) => (
                <article key={gap.slug} className="int-gap-card">
                  <header>
                    <div>
                      <h4>{gap.name}</h4>
                      <span>{categoryLabel(gap.category, categoryLabels)}</span>
                    </div>
                    <span
                      style={
                        {
                          "--int-gap-tone": badgeTone(gap.current_badge),
                        } as CSSProperties
                      }
                    >
                      {badgeLabel(gap.current_badge)}
                    </span>
                  </header>
                  <p>{gap.reason}</p>
                  <footer>
                    <span>
                      {gap.bridge_available ? "Bridge path" : "No bridge"}
                    </span>
                    <span>{categoryLabel(gap.runtime_status, new Map())}</span>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => onOpenGap(gap.slug)}
                    >
                      Inspect evidence
                    </button>
                  </footer>
                </article>
              ))
            ) : (
              <div className="int-inline-empty">
                No priority gaps match these filters.
              </div>
            )}
          </div>
        </aside>
      </div>

      <ReadinessEvidence readiness={readiness} onOpenGap={onOpenGap} />
    </section>
  );
}

function ReadinessEvidence({
  readiness,
  onOpenGap,
}: {
  readiness: IntegrationsReadinessResponse | null;
  onOpenGap: (slug: string) => void;
}): ReactElement {
  if (!readiness) {
    return (
      <ReportUnavailable
        title="Readiness evidence was not verified"
        detail="Coverage remains visible, but checks, blockers, and recommendations are intentionally unknown rather than reported as zero."
      />
    );
  }
  const severityRank = new Map([
    ["blocker", 0],
    ["critical", 1],
    ["error", 2],
    ["warning", 3],
  ]);
  const issues = [...readiness.issues].sort(
    (left, right) =>
      (severityRank.get(left.severity) ?? 9) -
      (severityRank.get(right.severity) ?? 9),
  );
  return (
    <section
      className="int-readiness-evidence"
      aria-labelledby="readiness-evidence-title"
    >
      <header className="int-readiness-evidence-header">
        <div>
          <div className="int-kicker">Release boundary</div>
          <h3 id="readiness-evidence-title">
            Readiness checks and remediation
          </h3>
          <p>{readiness.public_claim}</p>
        </div>
        <span
          data-qualified={readiness.marketable_public_claim ? "true" : "false"}
        >
          {readiness.marketable_public_claim
            ? "Public claim qualified"
            : "Public claim on hold"}
        </span>
      </header>
      <div className="int-readiness-grid">
        <div>
          <h4>Checks</h4>
          <div className="int-check-list">
            {readiness.checks.map((check) => (
              <article key={check.key} data-state={check.state}>
                <span className="int-check-mark" aria-hidden="true" />
                <div>
                  <strong>{check.label}</strong>
                  <p>{check.message}</p>
                </div>
                <span>{check.count}</span>
              </article>
            ))}
          </div>
        </div>
        <div>
          <h4>Issues</h4>
          <div className="int-readiness-issue-list">
            {issues.length ? (
              issues.map((issue) => (
                <article
                  key={`${issue.key}-${issue.slug ?? "global"}`}
                  data-severity={issue.severity}
                >
                  <header>
                    <strong>
                      {issue.name ?? categoryLabel(issue.key, new Map())}
                    </strong>
                    <span>{categoryLabel(issue.severity, new Map())}</span>
                  </header>
                  <p>{issue.message}</p>
                  {issue.remediation ? <div>{issue.remediation}</div> : null}
                  {issue.slug ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => onOpenGap(issue.slug!)}
                    >
                      Inspect integration
                    </button>
                  ) : null}
                </article>
              ))
            ) : (
              <div className="int-inline-empty">
                No reported readiness issues.
              </div>
            )}
          </div>
        </div>
        <div>
          <h4>Recommendations</h4>
          <ol className="int-recommendation-list">
            {readiness.recommendations.length ? (
              readiness.recommendations.map((recommendation) => (
                <li key={recommendation}>{recommendation}</li>
              ))
            ) : (
              <li>No additional recommendations were reported.</li>
            )}
          </ol>
        </div>
      </div>
    </section>
  );
}
