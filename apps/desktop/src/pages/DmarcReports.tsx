/**
 * DMARC Reports is an evidence workspace, not a DNS editor or an inbox-
 * placement score. Every displayed number passes the local aggregate-report
 * contract and every bounded result set carries its completeness receipt.
 */

import {
  type ReactElement,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { DmarcHealthCards } from "../components/dmarc/DmarcHealthCards";
import { DmarcPolicyAdvisor } from "../components/dmarc/DmarcPolicyAdvisor";
import { DmarcSourceSlideover } from "../components/dmarc/DmarcSourceSlideover";
import { DmarcSuggestionsBanner } from "../components/dmarc/DmarcSuggestionsBanner";
import { DmarcTopSourcesTable } from "../components/dmarc/DmarcTopSourcesTable";
import {
  DMARC_RANGES,
  DMARC_REPORT_LIMIT,
  buildDmarcCsv,
  filterDmarcReports,
  parseDmarcInsights,
  parseDmarcReports,
  rangeDays,
  rangeStart,
  type DmarcRange,
  type DmarcReportFilter,
  type DmarcWorkspace,
} from "../components/dmarc/dmarc-contract";
import { DmarcReportSlideover } from "../components/DmarcReportSlideover";
import { Notice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { DataTable, type DataTableColumn } from "../components/table/DataTable";
import {
  type ApiResult,
  type DmarcInsights,
  type DmarcReport,
  type DmarcReportsResponse,
  type DmarcSource,
  api,
} from "../lib/api-client";
import { saveFile } from "../lib/file-transfer";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import "../styles-dmarc-reports.css";

type Resource<T> = {
  data: T | null;
  error: string | null;
  errorKind: "request" | "contract" | null;
  loading: boolean;
  scopeKey: string;
};

type ExportState = {
  status: "idle" | "saving" | "saved" | "cancelled" | "error";
  message: string | null;
};

const EMPTY_REPORTS: Resource<DmarcReportsResponse> = {
  data: null,
  error: null,
  errorKind: null,
  loading: true,
  scopeKey: "",
};

const EMPTY_INSIGHTS: Resource<DmarcInsights> = {
  data: null,
  error: null,
  errorKind: null,
  loading: true,
  scopeKey: "",
};

const WORKSPACES: ReadonlyArray<{
  value: DmarcWorkspace;
  label: string;
  description: string;
}> = [
  {
    value: "overview",
    label: "Overview",
    description: "Alignment, policy evidence, and recommended investigations",
  },
  {
    value: "sources",
    label: "Sources",
    description: "The highest-volume sending IPs in the validated snapshot",
  },
  {
    value: "reports",
    label: "Reports",
    description: "Aggregate-report receipts and a bounded CSV export",
  },
];

const EXPECTED_REPORT_LAG_MS = 72 * 60 * 60 * 1_000;

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatCountLabel(
  value: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${formatCount(value)} ${value === 1 ? singular : plural}`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function formatDateRange(begin: string, end: string): string {
  const start = new Date(begin);
  const finish = new Date(end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(finish.getTime())) {
    return `${begin} – ${end}`;
  }
  return `${start.toLocaleDateString(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  })} – ${finish.toLocaleDateString(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  })} UTC`;
}

function formatLag(milliseconds: number): string {
  const hours = Math.max(0, Math.floor(milliseconds / (60 * 60 * 1_000)));
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function evidenceRecency(insights: DmarcInsights): {
  label: string;
  detail: string;
  tone: "current" | "caution" | "unknown";
} {
  if (!insights.latestReportAt) {
    return {
      label: "No ingested receipt in window",
      detail:
        "Report cadence and the reporting connection cannot be inferred from this screen.",
      tone: "unknown",
    };
  }
  const lag =
    Date.parse(insights.generatedAt) - Date.parse(insights.latestReportAt);
  if (lag > EXPECTED_REPORT_LAG_MS) {
    return {
      label: `Newest receipt is ${formatLag(lag)} old`,
      detail: `Latest ingested report: ${formatTimestamp(insights.latestReportAt)}. Investigate the reporting gap before trusting trend continuity.`,
      tone: "caution",
    };
  }
  return {
    label: "Recent ingested receipt",
    detail: `Latest ingested report: ${formatTimestamp(insights.latestReportAt)}.`,
    tone: "current",
  };
}

function crossResourceDifferences(
  insights: DmarcInsights | null,
  reports: DmarcReportsResponse | null,
): string[] {
  if (!insights || !reports) return [];
  const differences: string[] = [];
  if (insights.reportCount !== reports.meta.totalReports) {
    differences.push(
      `Insights count ${formatCountLabel(insights.reportCount, "report")} while the list receipt counts ${formatCountLabel(reports.meta.totalReports, "report")}.`,
    );
  }
  const tolerance = 5 * 60 * 1_000;
  const reportFrom = reports.meta.scope.from;
  const reportTo = reports.meta.scope.to;
  if (
    !reportFrom ||
    Math.abs(Date.parse(reportFrom) - Date.parse(insights.windowStart)) >
      tolerance
  ) {
    differences.push("The two resources do not share the same lower bound.");
  }
  if (
    !reportTo ||
    Math.abs(Date.parse(reportTo) - Date.parse(insights.windowEnd)) > tolerance
  ) {
    differences.push("The two resources do not share the same upper bound.");
  }
  return differences;
}

function policyLabel(policy: DmarcReport["policyP"]): string {
  if (policy === "none") return "Monitor only";
  if (policy === "quarantine") return "Quarantine";
  if (policy === "reject") return "Reject";
  return "Not reported";
}

function reportAlignment(report: DmarcReport): string {
  const total = report.passCount + report.failCount;
  if (total === 0) return "No messages";
  const ratio = report.passCount / total;
  return `${(ratio * 100).toFixed(ratio >= 0.995 ? 2 : 1)}%`;
}

function requestMessage(): string {
  return "The request did not complete. Check connectivity and try again.";
}

async function settleRequest<T>(
  request: Promise<ApiResult<T>>,
): Promise<{ result?: ApiResult<T>; thrown?: string }> {
  try {
    return { result: await request };
  } catch {
    return { thrown: requestMessage() };
  }
}

function canonicalDomain(value: string): string | null {
  const candidate = value.trim().toLowerCase();
  if (candidate === "") return "";
  if (
    candidate.length > 253 ||
    candidate.endsWith(".") ||
    candidate.includes("..")
  ) {
    return null;
  }
  return candidate
    .split(".")
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
    ? candidate
    : null;
}

function DomainControl({
  domain,
  domains,
  inventoryTruncated,
  onChange,
}: {
  domain: string;
  domains: string[];
  inventoryTruncated: boolean;
  onChange: (domain: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState(domain);
  useEffect(() => setDraft(domain), [domain]);
  const canonical = canonicalDomain(draft);
  const invalid = canonical === null;
  const unchanged = canonical === domain;
  const hint = invalid
    ? "Enter a valid ASCII hostname without a trailing dot."
    : inventoryTruncated
      ? "Inventory is partial. Choose a known domain or enter its exact hostname."
      : "Choose a discovered domain, enter an exact hostname, or leave blank for all.";
  return (
    <form
      className="dmarc-scope__control"
      onSubmit={(event) => {
        event.preventDefault();
        if (canonical !== null && canonical !== domain) onChange(canonical);
      }}
    >
      <label htmlFor="dmarc-domain">Sending domain</label>
      <div className="dmarc-domain-input">
        <input
          id="dmarc-domain"
          className="input"
          type="text"
          list="dmarc-domain-options"
          value={draft}
          maxLength={253}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="All available domains"
          aria-invalid={invalid || undefined}
          aria-describedby="dmarc-domain-hint"
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <datalist id="dmarc-domain-options">
          {domains.map((candidate) => (
            <option key={candidate} value={candidate} />
          ))}
        </datalist>
        <button
          type="submit"
          className="btn btn-sm"
          disabled={invalid || unchanged}
        >
          Apply
        </button>
      </div>
      <span
        id="dmarc-domain-hint"
        className={invalid ? "is-invalid" : undefined}
      >
        {hint}
      </span>
    </form>
  );
}

function beginResource<T>(
  previous: Resource<T>,
  scopeKey: string,
): Resource<T> {
  return {
    data: previous.scopeKey === scopeKey ? previous.data : null,
    error: null,
    errorKind: null,
    loading: true,
    scopeKey,
  };
}

function failResource<T>(
  previous: Resource<T>,
  scopeKey: string,
  errorKind: "request" | "contract",
  message: string,
): Resource<T> {
  return {
    data: previous.scopeKey === scopeKey ? previous.data : null,
    error: message,
    errorKind,
    loading: false,
    scopeKey,
  };
}

function LoadingPanel({ label }: { label: string }): ReactElement {
  return (
    <section className="dmarc-loading-panel" role="status" aria-live="polite">
      <span className="dmarc-spinner" aria-hidden="true" />
      <div>
        <strong>{label}</strong>
        <span>Validating the response contract before showing evidence.</span>
      </div>
    </section>
  );
}

function ResourceFailure({
  label,
  resource,
  onRetry,
}: {
  label: string;
  resource: Resource<unknown>;
  onRetry: () => void;
}): ReactElement | null {
  if (!resource.error) return null;
  const retained = resource.data !== null;
  return (
    <Notice
      tone={resource.errorKind === "contract" ? "danger" : "warning"}
      title={
        resource.errorKind === "contract"
          ? `${label} response withheld`
          : `${label} could not be refreshed`
      }
      action={
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      }
      announcement="polite"
    >
      {resource.error}{" "}
      {retained
        ? "The last contract-valid snapshot for this exact scope remains visible and is marked as stale."
        : "No empty state, zero metric, or policy conclusion has been inferred."}
    </Notice>
  );
}

function ScopeBar({
  domain,
  domains,
  domainInventoryTruncated,
  insightsIncomplete,
  insightsLoading,
  insights,
  range,
  reportsIncomplete,
  reportsLoading,
  reports,
  insightsStale,
  reportsStale,
  refreshButtonRef,
  onDomainChange,
  onRangeChange,
  onRefresh,
}: {
  domain: string;
  domains: string[];
  domainInventoryTruncated: boolean;
  insightsIncomplete: boolean;
  insightsLoading: boolean;
  insights: DmarcInsights | null;
  range: DmarcRange;
  reportsIncomplete: boolean;
  reportsLoading: boolean;
  reports: DmarcReportsResponse | null;
  insightsStale: boolean;
  reportsStale: boolean;
  refreshButtonRef: RefObject<HTMLButtonElement | null>;
  onDomainChange: (domain: string) => void;
  onRangeChange: (range: DmarcRange) => void;
  onRefresh: () => void;
}): ReactElement {
  const recency = insights ? evidenceRecency(insights) : null;
  const loading = insightsLoading || reportsLoading;
  const receiptTitle = (
    label: string,
    data: DmarcInsights | DmarcReportsResponse | null,
    loadingState: boolean,
    staleState: boolean,
    incompleteState: boolean,
  ): string => {
    if (loadingState && data) return `Refreshing ${label}…`;
    if (loadingState) return `Validating ${label}…`;
    if (staleState) return `Last contract-valid ${label}`;
    if (data) return `Contract-valid ${label}`;
    if (incompleteState) return `${label} unavailable`;
    return `Waiting for ${label}`;
  };
  return (
    <section className="dmarc-scope" aria-label="DMARC evidence scope">
      <DomainControl
        domain={domain}
        domains={domains}
        inventoryTruncated={domainInventoryTruncated}
        onChange={onDomainChange}
      />
      <fieldset className="dmarc-range-picker">
        <legend>Evidence window</legend>
        <div className="dmarc-segmented">
          {DMARC_RANGES.map((candidate) => (
            <button
              key={candidate.value}
              type="button"
              aria-pressed={candidate.value === range}
              onClick={() => onRangeChange(candidate.value)}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      </fieldset>
      <button
        ref={refreshButtonRef}
        type="button"
        className="btn dmarc-refresh"
        onClick={onRefresh}
        disabled={loading}
      >
        {loading ? "Refreshing…" : "Refresh evidence"}
      </button>
      <div className="dmarc-scope__receipts" aria-live="polite">
        <article className="dmarc-scope__receipt">
          <span
            className={`dmarc-receipt-dot${insightsStale || insightsIncomplete ? " is-stale" : ""}`}
            aria-hidden="true"
          />
          <div>
            <strong>
              {receiptTitle(
                "insights snapshot",
                insights,
                insightsLoading,
                insightsStale,
                insightsIncomplete,
              )}
            </strong>
            <span>
              {insights
                ? `Queried ${formatTimestamp(insights.generatedAt)}`
                : "No validated insights receipt"}
            </span>
            {insights ? (
              <small>
                Window {formatTimestamp(insights.windowStart)} to{" "}
                {formatTimestamp(insights.windowEnd)}
              </small>
            ) : null}
          </div>
        </article>
        <article className="dmarc-scope__receipt">
          <span
            className={`dmarc-receipt-dot${reportsStale || reportsIncomplete ? " is-stale" : ""}`}
            aria-hidden="true"
          />
          <div>
            <strong>
              {receiptTitle(
                "report-list snapshot",
                reports,
                reportsLoading,
                reportsStale,
                reportsIncomplete,
              )}
            </strong>
            <span>
              {reports
                ? `Queried ${formatTimestamp(reports.meta.generatedAt)}`
                : "No validated report-list receipt"}
            </span>
            {reports ? (
              <small>
                Scope{" "}
                {reports.meta.scope.from
                  ? formatTimestamp(reports.meta.scope.from)
                  : "unbounded"}
                {" to "}
                {reports.meta.scope.to
                  ? formatTimestamp(reports.meta.scope.to)
                  : "unbounded"}
              </small>
            ) : null}
          </div>
        </article>
        <article
          className="dmarc-scope__recency"
          data-tone={recency?.tone ?? "unknown"}
        >
          <strong>{recency?.label ?? "Evidence recency unavailable"}</strong>
          <span>
            {recency?.detail ??
              "Insights must validate before report recency can be assessed."}
          </span>
        </article>
        <p className="dmarc-scope__independent-note">
          Insights and report rows have independent query receipts; this screen
          does not represent them as one atomic database snapshot.
        </p>
      </div>
      {domainInventoryTruncated ? (
        <div className="dmarc-scope__warning" role="note">
          The discovery inventory reached its limit. The editable domain control
          accepts an exact known hostname even when it is absent from
          suggestions.
        </div>
      ) : null}
    </section>
  );
}

type DmarcWorkspaceTabs = ReturnType<typeof useTabsInteraction<DmarcWorkspace>>;

function WorkspaceTabs({ tabs }: { tabs: DmarcWorkspaceTabs }): ReactElement {
  return (
    <div
      ref={tabs.listRef}
      className="dmarc-workspace-tabs"
      {...tabs.listProps}
      aria-label="DMARC workspaces"
    >
      {WORKSPACES.map((workspace) => (
        <button
          key={workspace.value}
          type="button"
          {...tabs.getTabProps(workspace.value)}
        >
          <strong>{workspace.label}</strong>
          <span>{workspace.description}</span>
        </button>
      ))}
    </div>
  );
}

function Overview({
  insights,
  loading,
  onSelectSource,
}: {
  insights: DmarcInsights | null;
  loading: boolean;
  onSelectSource: (source: DmarcSource, trigger: HTMLButtonElement) => void;
}): ReactElement {
  if (!insights) {
    return loading ? (
      <LoadingPanel label="Loading aggregate evidence" />
    ) : (
      <section className="dmarc-unavailable">
        <h2>Overview unavailable</h2>
        <p>The aggregate evidence response has not passed validation.</p>
      </section>
    );
  }
  if (insights.totalMessages === 0) {
    const hasReports = insights.reportCount > 0;
    return (
      <div className="dmarc-overview">
        <section className="dmarc-zero-evidence">
          <div className="dmarc-zero-evidence__signal" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <p className="dmarc-kicker">
              {hasReports
                ? "Reports without usable message rows"
                : "No ingested report receipts"}
            </p>
            <h2>
              {hasReports
                ? `${formatCount(insights.reportCount)} report${insights.reportCount === 1 ? "" : "s"} contributed no positive message count.`
                : "No aggregate reports were ingested in this evidence window."}
            </h2>
            <p>
              {hasReports
                ? "Alignment and disposition are unavailable—not zero. Review the report receipts and ingestion pipeline before drawing a policy conclusion."
                : "This does not prove reporting is connected, that no mail was sent, or that authentication is healthy."}
            </p>
            <dl className="dmarc-zero-evidence__receipt">
              <div>
                <dt>Reports</dt>
                <dd>{formatCount(insights.reportCount)}</dd>
              </div>
              <div>
                <dt>Reporting days</dt>
                <dd>{formatCount(insights.reportingDays)}</dd>
              </div>
              <div>
                <dt>Messages</dt>
                <dd>Not observed</dd>
              </div>
            </dl>
          </div>
        </section>
        <DmarcHealthCards insights={insights} loading={loading} />
        <div className="dmarc-overview__grid">
          {hasReports && insights.domain ? (
            <DmarcPolicyAdvisor insights={insights} />
          ) : null}
          <DmarcSuggestionsBanner suggestions={insights.suggestions} />
        </div>
      </div>
    );
  }
  const primarySources =
    insights.topFailingSources.length > 0
      ? insights.topFailingSources
      : insights.topSources;
  return (
    <div className="dmarc-overview">
      <DmarcHealthCards insights={insights} loading={loading} />
      <div className="dmarc-overview__grid">
        <DmarcPolicyAdvisor insights={insights} />
        <DmarcSuggestionsBanner suggestions={insights.suggestions} />
      </div>
      <DmarcTopSourcesTable
        title={
          insights.topFailingSources.length > 0
            ? "Highest-volume sources needing investigation"
            : "Highest-volume observed sources"
        }
        description={
          insights.topFailingSources.length > 0
            ? "Ranked by observed unaligned volume. A failure is evidence to investigate, not proof of spoofing."
            : "Ranked by observed message volume in this bounded snapshot."
        }
        sources={primarySources}
        onSelect={onSelectSource}
      />
    </div>
  );
}

function SourcesWorkspace({
  insights,
  loading,
  onSelectSource,
}: {
  insights: DmarcInsights | null;
  loading: boolean;
  onSelectSource: (source: DmarcSource, trigger: HTMLButtonElement) => void;
}): ReactElement {
  if (!insights) {
    return loading ? (
      <LoadingPanel label="Loading source evidence" />
    ) : (
      <section className="dmarc-unavailable">
        <h2>Source evidence unavailable</h2>
        <p>
          No source ranking is shown without a contract-valid insights response.
        </p>
      </section>
    );
  }
  return (
    <div className="dmarc-workspace-stack">
      <header className="dmarc-section-heading">
        <div>
          <p className="dmarc-kicker">Observed sending infrastructure</p>
          <h2>
            {formatCountLabel(insights.sourceCount, "source IP")} in scope
          </h2>
          <p>
            The table contains the server-ranked top{" "}
            {insights.topSources.length}. Open a source for its bounded
            per-report contribution.
          </p>
        </div>
        <span className="dmarc-evidence-pill">
          {insights.sourceListTruncated
            ? "Partial ranking"
            : "Complete ranking"}
        </span>
      </header>
      {insights.sourceListTruncated ? (
        <Notice tone="info" title="Top sources only" announcement="off">
          {formatCount(insights.sourceCount)} sources were observed; this
          response includes {formatCount(insights.topSources.length)}. Totals
          above still cover the complete aggregate scope. Narrow to one domain
          or a shorter window when possible. This desktop build has no source
          continuation cursor, so do not treat the ranking as a complete source
          inventory.
        </Notice>
      ) : null}
      <DmarcTopSourcesTable
        title="Top observed sources"
        description="Ranked by message volume. DMARC evidence does not identify the operator or intent behind an IP."
        sources={insights.topSources}
        onSelect={onSelectSource}
        emptyState="No source IPs were present in the contract-valid snapshot."
      />
    </div>
  );
}

function ReportsWorkspace({
  exportState,
  filter,
  loading,
  query,
  reports,
  stale,
  onExport,
  onFilterChange,
  onQueryChange,
  onSelectReport,
}: {
  exportState: ExportState;
  filter: DmarcReportFilter;
  loading: boolean;
  query: string;
  reports: DmarcReportsResponse | null;
  stale: boolean;
  onExport: () => void;
  onFilterChange: (filter: DmarcReportFilter) => void;
  onQueryChange: (query: string) => void;
  onSelectReport: (report: DmarcReport, trigger: HTMLButtonElement) => void;
}): ReactElement {
  const rows = useMemo(
    () => filterDmarcReports(reports?.items ?? [], filter, query),
    [filter, query, reports],
  );
  const columns = useMemo<readonly DataTableColumn<DmarcReport>[]>(
    () => [
      {
        id: "period",
        header: "Report period",
        width: "220px",
        cell: (report) => (
          <button
            type="button"
            className="dmarc-table-link"
            onClick={(event) => onSelectReport(report, event.currentTarget)}
            aria-label={`Open ${formatDateRange(report.dateBegin, report.dateEnd)} report from ${report.orgName} for ${report.domain}`}
          >
            {formatDateRange(report.dateBegin, report.dateEnd)}
          </button>
        ),
      },
      {
        id: "domain",
        header: "Sending domain",
        width: "210px",
        cell: (report) => <code>{report.domain}</code>,
      },
      {
        id: "reporter",
        header: "Reporting organization",
        width: "190px",
        cell: (report) => report.orgName,
      },
      {
        id: "messages",
        header: "Messages",
        width: "110px",
        align: "end",
        cell: (report) => formatCount(report.passCount + report.failCount),
      },
      {
        id: "alignment",
        header: "Aligned",
        width: "110px",
        align: "end",
        cell: reportAlignment,
      },
      {
        id: "policy",
        header: "Observed policy",
        width: "140px",
        cell: (report) => policyLabel(report.policyP),
      },
    ],
    [onSelectReport],
  );

  if (!reports) {
    return loading ? (
      <LoadingPanel label="Loading report receipts" />
    ) : (
      <section className="dmarc-unavailable">
        <h2>Report receipts unavailable</h2>
        <p>
          No rows or export are shown without a contract-valid list response.
        </p>
      </section>
    );
  }

  return (
    <div className="dmarc-workspace-stack">
      <header className="dmarc-section-heading">
        <div>
          <p className="dmarc-kicker">Aggregate-report receipts</p>
          <h2>
            {formatCount(reports.meta.returned)} of{" "}
            {formatCountLabel(reports.meta.totalReports, "report")} loaded
          </h2>
          <p>
            Rows are parsed aggregate report summaries. Source-level records and
            original XML are intentionally not exposed in this list.
          </p>
        </div>
        <span className="dmarc-evidence-pill">
          {reports.meta.hasMore ? "Partial list" : "Complete list"}
        </span>
      </header>
      {reports.meta.hasMore ? (
        <Notice
          tone="warning"
          title="This list and export are partial"
          announcement="off"
        >
          The endpoint returned its {formatCount(reports.meta.limit)}-report
          ceiling. Aggregate totals in Overview cover the full scope; this table
          and CSV contain only the {formatCount(reports.meta.returned)} loaded
          receipts. Narrow the domain or time window when possible. This build
          has no report continuation cursor, so completeness-sensitive work must
          not rely on this partial export.
        </Notice>
      ) : null}
      <div className="dmarc-report-toolbar">
        <label className="dmarc-search">
          <span>Find a loaded report</span>
          <input
            className="input"
            type="search"
            value={query}
            maxLength={256}
            placeholder="Domain, organization, or report ID"
            onChange={(event) => onQueryChange(event.currentTarget.value)}
          />
        </label>
        <div
          className="dmarc-segmented"
          role="group"
          aria-label="Filter loaded reports by alignment result"
        >
          {(
            [
              ["all", "All loaded"],
              ["aligned", "Fully aligned"],
              ["failed", "Has unaligned"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => onFilterChange(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn"
          onClick={onExport}
          disabled={rows.length === 0 || exportState.status === "saving"}
          aria-describedby="dmarc-export-receipt"
        >
          {exportState.status === "saving"
            ? "Preparing export…"
            : `Export ${formatCount(rows.length)} loaded ${rows.length === 1 ? "row" : "rows"}`}
        </button>
      </div>
      <div
        id="dmarc-export-receipt"
        className="dmarc-export-receipt"
        aria-live="polite"
      >
        <span className="dmarc-filter-result" role="status">
          {formatCount(rows.length)} loaded report
          {rows.length === 1 ? " matches" : "s match"} the local search and
          filter.
        </span>
        <span>
          CSV includes the selected scope, snapshot time, total report count,
          local filters, and a {reports.meta.hasMore ? "partial" : "complete"}
          {stale ? " stale-snapshot" : ""} export receipt.
        </span>
        {exportState.message ? (
          <strong data-status={exportState.status}>
            {exportState.message}
          </strong>
        ) : null}
      </div>
      <DataTable
        caption="DMARC aggregate report receipts"
        description={`Showing ${formatCount(rows.length)} of ${formatCount(
          reports.meta.returned,
        )} loaded ${reports.meta.returned === 1 ? "report" : "reports"} after local filters.`}
        columns={columns}
        rows={rows}
        getRowKey={(report) => report.id}
        density="compact"
        loading={loading && reports.items.length === 0}
        loadingLabel="Refreshing report receipts…"
        emptyState={
          reports.items.length === 0
            ? "No aggregate reports were returned for this validated scope."
            : "No loaded reports match the current search and filter."
        }
        className="dmarc-reports-table"
      />
    </div>
  );
}

export function DmarcReports(): ReactElement {
  const [workspace, setWorkspace] = useState<DmarcWorkspace>("overview");
  const workspaceTabs = useTabsInteraction<DmarcWorkspace>({
    value: workspace,
    items: WORKSPACES,
    onChange: setWorkspace,
  });
  const [range, setRange] = useState<DmarcRange>("30d");
  const [domain, setDomain] = useState("");
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [reports, setReports] = useState(EMPTY_REPORTS);
  const [insights, setInsights] = useState(EMPTY_INSIGHTS);
  const [reportFilter, setReportFilter] = useState<DmarcReportFilter>("all");
  const [reportQuery, setReportQuery] = useState("");
  const [exportState, setExportState] = useState<ExportState>({
    status: "idle",
    message: null,
  });
  const [selectedReport, setSelectedReport] = useState<DmarcReport | null>(
    null,
  );
  const [selectedSource, setSelectedSource] = useState<DmarcSource | null>(
    null,
  );
  const requestGenerationRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const exportGenerationRef = useRef(0);
  const exportAbortRef = useRef<AbortController | null>(null);
  const reportTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sourceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const refreshButtonRef = useRef<HTMLButtonElement | null>(null);
  const days = rangeDays(range);
  const scopeKey = `${domain || "*"}|${days}`;

  useEffect(() => {
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const generation = ++requestGenerationRef.current;
    setReports((previous) => beginResource(previous, scopeKey));
    setInsights((previous) => beginResource(previous, scopeKey));

    const requestedWindowEnd = new Date();
    const from = rangeStart(range, requestedWindowEnd);
    const to = requestedWindowEnd.toISOString();
    const reportRequest = settleRequest(
      api.listDmarcReports({
        ...(domain ? { domain } : {}),
        from,
        to,
        limit: DMARC_REPORT_LIMIT,
        signal: controller.signal,
      }),
    );
    const insightRequest = settleRequest(
      api.getDmarcInsights({
        ...(domain ? { domain } : {}),
        days,
        signal: controller.signal,
      }),
    );

    const isCurrent = (): boolean =>
      !controller.signal.aborted && generation === requestGenerationRef.current;

    void reportRequest.then((reportOutcome) => {
      if (!isCurrent()) return;
      if (reportOutcome.thrown) {
        setReports((previous) =>
          failResource(previous, scopeKey, "request", reportOutcome.thrown!),
        );
      } else if (reportOutcome.result && "error" in reportOutcome.result) {
        const message = reportOutcome.result.error?.message;
        setReports((previous) =>
          failResource(
            previous,
            scopeKey,
            "request",
            message || "The report receipt request could not be completed.",
          ),
        );
      } else {
        const parsed = parseDmarcReports(reportOutcome.result?.data, {
          ...(domain ? { domain } : {}),
          from,
          to,
          limit: DMARC_REPORT_LIMIT,
        });
        if (!parsed) {
          setReports((previous) =>
            failResource(
              previous,
              scopeKey,
              "contract",
              "Moosewave rejected an unexpected report-list payload.",
            ),
          );
        } else {
          setReports({
            data: parsed,
            error: null,
            errorKind: null,
            loading: false,
            scopeKey,
          });
        }
      }
    });

    void insightRequest.then((insightOutcome) => {
      if (!isCurrent()) return;
      if (insightOutcome.thrown) {
        setInsights((previous) =>
          failResource(previous, scopeKey, "request", insightOutcome.thrown!),
        );
      } else if (insightOutcome.result && "error" in insightOutcome.result) {
        const message = insightOutcome.result.error?.message;
        setInsights((previous) =>
          failResource(
            previous,
            scopeKey,
            "request",
            message || "The aggregate insights request could not be completed.",
          ),
        );
      } else {
        const parsed = parseDmarcInsights(insightOutcome.result?.data, {
          ...(domain ? { domain } : {}),
          days,
        });
        if (!parsed) {
          setInsights((previous) =>
            failResource(
              previous,
              scopeKey,
              "contract",
              "Moosewave rejected an unexpected aggregate-insights payload.",
            ),
          );
        } else {
          setInsights({
            data: parsed,
            error: null,
            errorKind: null,
            loading: false,
            scopeKey,
          });
        }
      }
    });

    return () => controller.abort();
  }, [days, domain, range, refreshGeneration, scopeKey]);

  useEffect(() => {
    setReportFilter("all");
    setReportQuery("");
    setSelectedReport(null);
    setSelectedSource(null);
  }, [scopeKey]);

  useEffect(() => {
    exportGenerationRef.current += 1;
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
    setExportState({ status: "idle", message: null });
  }, [
    reportFilter,
    reportQuery,
    reports.data?.meta.generatedAt,
    reports.error,
    scopeKey,
  ]);

  useEffect(
    () => () => {
      exportAbortRef.current?.abort();
    },
    [],
  );

  const currentReports = reports.scopeKey === scopeKey ? reports.data : null;
  const currentInsights = insights.scopeKey === scopeKey ? insights.data : null;
  const loading = reports.loading || insights.loading;
  const reportsStale = Boolean(reports.error && currentReports);
  const insightsStale = Boolean(insights.error && currentInsights);
  const reportsIncomplete = Boolean(reports.error);
  const insightsIncomplete = Boolean(insights.error);
  const domains = currentReports?.meta.availableDomains ?? [];
  const receiptDifferences = crossResourceDifferences(
    currentInsights,
    currentReports,
  );

  const subtitle = currentInsights
    ? currentInsights.totalMessages === 0
      ? `No aggregate messages observed across ${formatCountLabel(currentInsights.reportingDays, "reporting day")}`
      : `${formatCountLabel(currentInsights.totalMessages, "message")} across ${formatCountLabel(
          currentInsights.reportCount,
          "report",
        )} · ${formatCountLabel(currentInsights.sourceCount, "source IP")}`
    : loading
      ? "Validating aggregate evidence…"
      : currentReports
        ? `${formatCountLabel(currentReports.meta.totalReports, "report receipt")} available; aggregate insights are unavailable`
        : "Aggregate evidence is currently unavailable";

  const refresh = (): void => {
    exportGenerationRef.current += 1;
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
    setExportState({ status: "idle", message: null });
    setRefreshGeneration((value) => value + 1);
  };

  const exportReports = async (): Promise<void> => {
    if (!currentReports || exportAbortRef.current) return;
    const exportRows = filterDmarcReports(
      currentReports.items,
      reportFilter,
      reportQuery,
    );
    if (exportRows.length === 0) return;
    const controller = new AbortController();
    const generation = ++exportGenerationRef.current;
    exportAbortRef.current = controller;
    setExportState({
      status: "saving",
      message: "Preparing the receipt-bearing CSV…",
    });
    try {
      const result = await saveFile({
        data: buildDmarcCsv(exportRows, {
          exportedAt: new Date().toISOString(),
          snapshotGeneratedAt: currentReports.meta.generatedAt,
          scopeDomain: currentReports.meta.scope.domain ?? "",
          scopeFrom: currentReports.meta.scope.from ?? "",
          scopeTo: currentReports.meta.scope.to ?? "",
          scopeWindowDays: days,
          localFilter: reportFilter,
          localQuery: reportQuery.trim(),
          totalReports: currentReports.meta.totalReports,
          partial: currentReports.meta.hasMore,
          stale: reportsStale,
        }),
        suggestedName: `dmarc-reports-${range}-${domain || "all-domains"}.csv`,
        label: "DMARC report evidence export",
        privacy: "confidential",
        mimeType: "text/csv;charset=utf-8",
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        generation !== exportGenerationRef.current
      ) {
        return;
      }
      if (result.ok && result.status === "cancelled") {
        setExportState({
          status: "cancelled",
          message: "Export cancelled; no destination was written.",
        });
      } else if (result.ok) {
        setExportState({
          status: "saved",
          message:
            result.status === "download_started"
              ? "Download started with its evidence receipt."
              : "CSV saved with its evidence receipt.",
        });
      } else {
        setExportState({ status: "error", message: result.message });
      }
    } catch {
      if (
        controller.signal.aborted ||
        generation !== exportGenerationRef.current
      ) {
        return;
      }
      setExportState({
        status: "error",
        message: "Moosewave could not prepare the export. Try again.",
      });
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null;
    }
  };

  return (
    <div className="dmarc-page">
      <PageHeader
        eyebrow="Authentication evidence"
        title="DMARC reports"
        subtitle={subtitle}
      />
      <ScopeBar
        domain={domain}
        domains={domains}
        domainInventoryTruncated={
          currentReports?.meta.domainInventoryTruncated ?? false
        }
        insightsIncomplete={insightsIncomplete}
        insightsLoading={insights.loading}
        insights={currentInsights}
        range={range}
        reportsIncomplete={reportsIncomplete}
        reportsLoading={reports.loading}
        reports={currentReports}
        insightsStale={insightsStale}
        reportsStale={reportsStale}
        refreshButtonRef={refreshButtonRef}
        onDomainChange={setDomain}
        onRangeChange={setRange}
        onRefresh={refresh}
      />

      {receiptDifferences.length > 0 ? (
        <Notice
          tone="warning"
          title="Independent evidence receipts do not reconcile"
          announcement="polite"
        >
          {receiptDifferences.join(" ")} Treat comparisons as provisional and
          refresh before exporting or making an operational decision.
        </Notice>
      ) : null}

      <div className="dmarc-resource-notices">
        <ResourceFailure
          label="Report receipts"
          resource={reports}
          onRetry={() => {
            refreshButtonRef.current?.focus();
            refresh();
          }}
        />
        <ResourceFailure
          label="Aggregate insights"
          resource={insights}
          onRetry={() => {
            refreshButtonRef.current?.focus();
            refresh();
          }}
        />
      </div>

      <aside
        className="dmarc-truth-note"
        aria-label="How to interpret DMARC evidence"
      >
        <strong>Evidence boundary</strong>
        <span>
          These fields were contract-validated after ingestion from aggregate
          report payloads. This screen does not prove reporter authenticity,
          sender identity, an active reporting connection, inbox placement,
          intent, or your live DNS record.
        </span>
      </aside>

      <WorkspaceTabs tabs={workspaceTabs} />

      {workspace === "overview" ? (
        <section
          {...workspaceTabs.getPanelProps("overview")}
          aria-busy={insights.loading || undefined}
        >
          <Overview
            insights={currentInsights}
            loading={insights.loading}
            onSelectSource={(source, trigger) => {
              sourceTriggerRef.current = trigger;
              setSelectedReport(null);
              setSelectedSource(source);
            }}
          />
        </section>
      ) : null}
      {workspace === "sources" ? (
        <section
          {...workspaceTabs.getPanelProps("sources")}
          aria-busy={insights.loading || undefined}
        >
          <SourcesWorkspace
            insights={currentInsights}
            loading={insights.loading}
            onSelectSource={(source, trigger) => {
              sourceTriggerRef.current = trigger;
              setSelectedReport(null);
              setSelectedSource(source);
            }}
          />
        </section>
      ) : null}
      {workspace === "reports" ? (
        <section
          {...workspaceTabs.getPanelProps("reports")}
          aria-busy={reports.loading || undefined}
        >
          <ReportsWorkspace
            exportState={exportState}
            filter={reportFilter}
            loading={reports.loading}
            query={reportQuery}
            reports={currentReports}
            stale={reportsStale}
            onExport={() => void exportReports()}
            onFilterChange={setReportFilter}
            onQueryChange={setReportQuery}
            onSelectReport={(report, trigger) => {
              reportTriggerRef.current = trigger;
              setSelectedSource(null);
              setSelectedReport(report);
            }}
          />
        </section>
      ) : null}

      {selectedReport ? (
        <DmarcReportSlideover
          report={selectedReport}
          returnFocusRef={reportTriggerRef as RefObject<HTMLElement | null>}
          onClose={() => setSelectedReport(null)}
        />
      ) : null}
      {selectedSource ? (
        <DmarcSourceSlideover
          ip={selectedSource.sourceIp}
          domain={domain || undefined}
          days={days}
          returnFocusRef={sourceTriggerRef as RefObject<HTMLElement | null>}
          onClose={() => setSelectedSource(null)}
        />
      ) : null}
    </div>
  );
}
