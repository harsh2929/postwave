import {
  type ReactElement,
  type RefObject,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  apiMonetization as api,
  type GiftHistoryListOptions,
} from "../../lib/api-client";
import { fmtDate, fmtDateTime } from "../../lib/format-date";
import {
  type RemoteLoadResult,
  useRemoteResource,
} from "../../hooks/useRemoteResource";
import { SlideoverShell } from "../SlideoverShell";
import {
  decodeGiftHistoryPage,
  decodeGiftHistoryRecord,
  decodeGiftHistoryStats,
  giftHistoryCounts,
  giftHistoryMatchesFilter,
  giftHistorySearchPrefix,
  giftHistoryServerFilter,
  giftHistoryState,
  giftStateLabel,
  sanitizeGiftHistorySearchInput,
  type GiftHistoryFilter,
  type GiftHistoryPage,
  type GiftHistoryRecord,
  type GiftHistorySort,
  type GiftHistoryState,
  type GiftHistoryStats,
} from "./gift-history";

const PAGE_SIZE = 18;
const MAX_GIFT_HISTORY_OFFSET = 10_000;

const FILTERS: ReadonlyArray<{
  id: GiftHistoryFilter;
  label: string;
}> = [
  { id: "all", label: "All records" },
  { id: "open", label: "Open lifecycle" },
  { id: "redeemed", label: "Redeemed" },
  { id: "closed", label: "Closed" },
  { id: "cancelled", label: "Cancelled" },
  { id: "expired", label: "Expired" },
  { id: "refunded", label: "Refunded" },
  { id: "data_issue", label: "Readable issues on this page" },
];

const SORTS: ReadonlyArray<{
  id: GiftHistorySort;
  label: string;
}> = [
  { id: "newest", label: "Newest recorded first" },
  { id: "oldest", label: "Oldest recorded first" },
  { id: "duration", label: "Longest duration first" },
  { id: "status", label: "Lifecycle state" },
];

function GiftIcon({ size = 18 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 9h17v11.5h-17zM2.5 5.5h19V9h-19zM12 5.5v15" />
      <path d="M12 5.5c-2.7 0-5.5-.7-5.5-2.4 0-1.1.9-1.8 2-1.8 2.1 0 3.5 2.4 3.5 4.2ZM12 5.5c2.7 0 5.5-.7 5.5-2.4 0-1.1-.9-1.8-2-1.8-2.1 0-3.5 2.4-3.5 4.2Z" />
    </svg>
  );
}

function ShieldIcon(): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 5 6v5c0 4.6 2.8 8.1 7 10 4.2-1.9 7-5.4 7-10V6Z" />
      <path d="m9 12 2 2 4-5" />
    </svg>
  );
}

function RefreshIcon(): ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 7v5h-5" />
      <path d="M19 12a7 7 0 1 0-1.8 4.7" />
    </svg>
  );
}

function SearchIcon(): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </svg>
  );
}

function ArrowIcon(): ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14m-5-5 5 5-5 5" />
    </svg>
  );
}

function LinkIcon(): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2" />
    </svg>
  );
}

function stateClass(state: GiftHistoryState): string {
  switch (state) {
    case "pending":
      return "is-pending";
    case "paid":
      return "is-paid";
    case "redeemed":
      return "is-redeemed";
    case "cancelled":
      return "is-cancelled";
    case "expired":
      return "is-expired";
    case "refunded":
      return "is-refunded";
    case "data_issue":
      return "is-issue";
  }
}

function StateBadge({
  state,
  compact = false,
}: {
  state: GiftHistoryState;
  compact?: boolean;
}): ReactElement {
  return (
    <span
      className={`ghs-state ${stateClass(state)}${compact ? " is-compact" : ""}`}
    >
      <span aria-hidden="true" />
      {giftStateLabel(state)}
    </span>
  );
}

function safeDate(value: string | null): string {
  if (!value || Number.isNaN(Date.parse(value))) return "Unavailable";
  return fmtDate(value);
}

function safeDateTime(value: string | null): string {
  if (!value || Number.isNaN(Date.parse(value))) return "Unavailable";
  return fmtDateTime(value);
}

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function resolvedCount(stats: GiftHistoryStats | null): number | null {
  return stats
    ? stats.redeemed + stats.cancelled + stats.expired + stats.refunded
    : null;
}

function EvidenceJourney({
  stats,
  page,
  loading,
  statsUnavailable,
}: {
  stats: GiftHistoryStats | null;
  page: GiftHistoryPage | null;
  loading: boolean;
  statsUnavailable: boolean;
}): ReactElement {
  const pageCounts = page ? giftHistoryCounts(page.items) : null;
  const resolved = resolvedCount(stats);
  return (
    <aside className="ghs-journey" aria-label="Gift lifecycle evidence path">
      <div className="ghs-journey-head">
        <span>Lifecycle evidence</span>
        <span className="ghs-journey-live">
          <span aria-hidden="true" />
          {loading ? "Reading snapshot" : "Archive connected"}
        </span>
      </div>
      <div className="ghs-journey-track">
        <article>
          <span className="ghs-journey-index">01</span>
          <span className="ghs-journey-icon">
            <GiftIcon size={17} />
          </span>
          <div>
            <strong>Gift recorded</strong>
            <small>
              {stats
                ? `${stats.total.toLocaleString()} on file`
                : statsUnavailable
                  ? "Aggregate unavailable"
                  : "Reading total…"}
            </small>
          </div>
        </article>
        <span className="ghs-journey-connector is-active" aria-hidden="true">
          <span />
        </span>
        <article>
          <span className="ghs-journey-index">02</span>
          <span className="ghs-journey-icon">
            <LinkIcon />
          </span>
          <div>
            <strong>Provider linked</strong>
            <small>
              {pageCounts
                ? `${pageCounts.providerLinked.toLocaleString()} on this page`
                : "Reading page…"}
            </small>
          </div>
        </article>
        <span className="ghs-journey-connector is-active" aria-hidden="true">
          <span />
        </span>
        <article>
          <span className="ghs-journey-index">03</span>
          <span className="ghs-journey-icon">
            <span className="ghs-journey-check" aria-hidden="true" />
          </span>
          <div>
            <strong>Lifecycle resolved</strong>
            <small>
              {resolved === null
                ? statsUnavailable
                  ? "Aggregate unavailable"
                  : "Reading outcomes…"
                : `${resolved.toLocaleString()} terminal outcomes`}
            </small>
          </div>
        </article>
      </div>
      <p>
        This signal reports stored lifecycle evidence only. It does not expose
        purchaser or recipient identity, checkout credentials, provider objects,
        entitlement state, or a live redemption path.
      </p>
    </aside>
  );
}

function Hero({
  stats,
  page,
  loading,
  statsUnavailable,
}: {
  stats: GiftHistoryStats | null;
  page: GiftHistoryPage | null;
  loading: boolean;
  statsUnavailable: boolean;
}): ReactElement {
  const open = stats ? stats.pending + stats.paid : null;
  return (
    <section className="ghs-hero" aria-labelledby="gift-history-title">
      <div className="ghs-hero-copy">
        <div className="ghs-eyebrow">
          <span>
            <GiftIcon />
          </span>
          Monetization archive
        </div>
        <div className="ghs-status-row" role="status">
          <span className="ghs-status-chip">
            <span aria-hidden="true" />
            Historical lifecycle
          </span>
          <span className="ghs-status-secondary">
            <ShieldIcon />
            Identity-minimized
          </span>
        </div>
        <h1 id="gift-history-title">
          See how a gift moved from intention to access.
        </h1>
        <p>
          Read the stored lifecycle as a coherent evidence trail—without
          bringing emails, personal messages, payment links, redemption secrets,
          tenant IDs, or provider identifiers into this workspace.
        </p>
        <div className="ghs-hero-facts" aria-label="Gift archive snapshot">
          <span>
            <strong>Records on file</strong>
            {stats
              ? stats.total.toLocaleString()
              : statsUnavailable
                ? "Unavailable"
                : "—"}
          </span>
          <span>
            <strong>Open lifecycle</strong>
            {open === null
              ? statsUnavailable
                ? "Unavailable"
                : "—"
              : open.toLocaleString()}
          </span>
          <span>
            <strong>Conversion</strong>
            {statsUnavailable
              ? "Unavailable"
              : percent(stats?.conversionRate ?? null)}
          </span>
        </div>
        <p className="ghs-authority-note">
          <ShieldIcon />
          <span>
            A provider-link flag means only that a local invoice reference was
            recorded. It is not proof of payment, settlement, refund,
            entitlement, or provider reconciliation.
          </span>
        </p>
      </div>
      <EvidenceJourney
        stats={stats}
        page={page}
        loading={loading}
        statsUnavailable={statsUnavailable}
      />
    </section>
  );
}

function SummaryGrid({
  stats,
  activeFilter,
  onFilter,
}: {
  stats: GiftHistoryStats;
  activeFilter: GiftHistoryFilter;
  onFilter: (filter: GiftHistoryFilter) => void;
}): ReactElement {
  const open = stats.pending + stats.paid;
  const closed =
    stats.redeemed + stats.cancelled + stats.expired + stats.refunded;
  const cells: ReadonlyArray<{
    label: string;
    value: string;
    note: string;
    filter?: GiftHistoryFilter;
    tone: string;
  }> = [
    {
      label: "Total archive",
      value: stats.total.toLocaleString(),
      note: "Every stored lifecycle",
      filter: "all",
      tone: "neutral",
    },
    {
      label: "Redeemed",
      value: stats.redeemed.toLocaleString(),
      note: "Access recorded",
      filter: "redeemed",
      tone: "positive",
    },
    {
      label: "Open",
      value: open.toLocaleString(),
      note: `${stats.pending.toLocaleString()} pending · ${stats.paid.toLocaleString()} paid`,
      filter: "open",
      tone: "open",
    },
    {
      label: "Closed",
      value: closed.toLocaleString(),
      note: "Terminal stored outcomes",
      filter: "closed",
      tone: "closed",
    },
    {
      label: "Conversion",
      value: percent(stats.conversionRate),
      note: "Redeemed ÷ resolved",
      tone: "signal",
    },
  ];
  return (
    <section className="ghs-summary" aria-label="Gift lifecycle summary">
      {cells.map((cell) => {
        const selected = cell.filter === activeFilter;
        const content = (
          <>
            <span className={`ghs-summary-mark is-${cell.tone}`} />
            <span className="ghs-summary-label">{cell.label}</span>
            <strong>{cell.value}</strong>
            <small>{cell.note}</small>
          </>
        );
        return cell.filter ? (
          <button
            key={cell.label}
            type="button"
            className={selected ? "is-selected" : undefined}
            aria-pressed={selected}
            onClick={() => onFilter(cell.filter ?? "all")}
          >
            {content}
          </button>
        ) : (
          <article key={cell.label}>{content}</article>
        );
      })}
    </section>
  );
}

function AggregateUnavailable({
  onRetry,
}: {
  onRetry: () => void;
}): ReactElement {
  return (
    <section
      className="ghs-summary-unavailable"
      role="alert"
      aria-labelledby="ghs-aggregate-unavailable-title"
    >
      <span className="ghs-summary-unavailable-icon" aria-hidden="true">
        <ShieldIcon />
      </span>
      <div>
        <span>Aggregate unavailable</span>
        <h2 id="ghs-aggregate-unavailable-title">
          The verified record archive is still usable.
        </h2>
        <p>
          Summary totals could not be verified, so no lifecycle count or
          conversion is inferred. Record-level evidence remains available below.
        </p>
      </div>
      <button type="button" className="btn btn-sm" onClick={onRetry}>
        Retry aggregate
      </button>
    </section>
  );
}

function ProvenanceBand({
  page,
  stats,
  refreshing,
}: {
  page: GiftHistoryPage | null;
  stats: GiftHistoryStats | null;
  refreshing: boolean;
}): ReactElement {
  return (
    <div className="ghs-provenance" role="status">
      <span>
        <span className="ghs-provenance-dot" aria-hidden="true" />
        <strong>{refreshing ? "Refreshing evidence" : "Verified reads"}</strong>
      </span>
      <span>
        Records{" "}
        {page?.snapshotAt ? safeDateTime(page.snapshotAt) : "not verified"}
      </span>
      <span>
        Aggregate{" "}
        {stats?.generatedAt ? safeDateTime(stats.generatedAt) : "not verified"}
      </span>
      <span className="ghs-provenance-safe">
        <ShieldIcon />
        Sanitized projection · no-store
      </span>
    </div>
  );
}

function ControlBar({
  search,
  filter,
  sort,
  resultTotal,
  refreshing,
  onSearch,
  onFilter,
  onSort,
  onRefresh,
}: {
  search: string;
  filter: GiftHistoryFilter;
  sort: GiftHistorySort;
  resultTotal: number | null;
  refreshing: boolean;
  onSearch: (value: string) => void;
  onFilter: (value: GiftHistoryFilter) => void;
  onSort: (value: GiftHistorySort) => void;
  onRefresh: () => void;
}): ReactElement {
  const searchPrefix = giftHistorySearchPrefix(search);
  const invalidSearch = search.trim() !== "" && !searchPrefix;
  return (
    <section className="ghs-controls" aria-label="Gift history controls">
      <div className="ghs-controls-heading">
        <div>
          <span>Archive explorer</span>
          <strong>
            {resultTotal === null
              ? "Reading records"
              : `${resultTotal.toLocaleString()} ${resultTotal === 1 ? "record" : "records"}`}
          </strong>
        </div>
        <button
          type="button"
          className="btn btn-sm ghs-refresh"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshIcon />
          {refreshing ? "Refreshing…" : "Refresh evidence"}
        </button>
      </div>
      <div className="ghs-control-grid">
        <label className="ghs-search">
          <span className="visually-hidden">Find by gift record prefix</span>
          <SearchIcon />
          <input
            type="search"
            value={search}
            maxLength={96}
            autoComplete="off"
            placeholder="Find by gift record prefix"
            aria-invalid={invalidSearch}
            aria-describedby="ghs-search-boundary"
            onChange={(event) =>
              onSearch(sanitizeGiftHistorySearchInput(event.target.value))
            }
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear gift record search"
              onClick={() => onSearch("")}
            >
              Clear
            </button>
          ) : null}
        </label>
        <label className="ghs-select">
          <span>Lifecycle</span>
          <select
            value={filter}
            onChange={(event) =>
              onFilter(event.target.value as GiftHistoryFilter)
            }
          >
            {FILTERS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label className="ghs-select">
          <span>Order</span>
          <select
            value={sort}
            onChange={(event) => onSort(event.target.value as GiftHistorySort)}
          >
            {SORTS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p
        id="ghs-search-boundary"
        className={`ghs-search-boundary${invalidSearch ? " is-invalid" : ""}`}
        role="status"
      >
        {invalidSearch
          ? "Enter 8–32 hexadecimal characters from a Gift record label. The current result stays in place; nothing is sent until the prefix is valid."
          : "Search is deliberately limited to the server-authored gift record prefix. This reporting scope cannot probe purchaser or recipient identity."}
      </p>
    </section>
  );
}

function RetainedError({
  scope,
  onRetry,
}: {
  scope: "record page" | "aggregate statistics";
  onRetry: () => void;
}): ReactElement {
  return (
    <div className="ghs-retained-error" role="alert">
      <ShieldIcon />
      <span>
        <strong>Refresh failed; verified {scope} remain visible.</strong>
        The service did not return a new readable snapshot. No raw upstream
        detail is displayed.
      </span>
      <button type="button" className="btn btn-sm" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function IntegrityBanner({
  issueCount,
  rejectedRows,
  envelopeIssues,
  onReview,
}: {
  issueCount: number;
  rejectedRows: number;
  envelopeIssues: number;
  onReview: () => void;
}): ReactElement {
  return (
    <div className="ghs-integrity" role="status">
      <ShieldIcon />
      <span>
        <strong>Archive integrity needs review.</strong>
        {issueCount.toLocaleString()} readable{" "}
        {issueCount === 1 ? "record has" : "records have"} field warnings
        {rejectedRows > 0
          ? `; ${rejectedRows.toLocaleString()} contract-invalid ${rejectedRows === 1 ? "row was" : "rows were"} contained`
          : ""}
        {envelopeIssues > 0
          ? `; ${envelopeIssues.toLocaleString()} envelope ${envelopeIssues === 1 ? "warning was" : "warnings were"} detected`
          : ""}
        . Nothing has been silently treated as healthy.
      </span>
      <button type="button" onClick={onReview}>
        Review this page
      </button>
    </div>
  );
}

function LoadingRecords(): ReactElement {
  return (
    <section className="ghs-loading" aria-label="Loading gift history">
      <div className="ghs-loading-head">
        <span />
        <span />
      </div>
      <div className="ghs-loading-grid">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index}>
            <span />
            <span />
            <span />
            <span />
          </div>
        ))}
      </div>
      <span className="visually-hidden" role="status">
        Verifying gift lifecycle records…
      </span>
    </section>
  );
}

function TerminalState({
  kind,
  onRetry,
  onReset,
}: {
  kind: "error" | "empty" | "filtered" | "page_clean";
  onRetry?: () => void;
  onReset?: () => void;
}): ReactElement {
  const content =
    kind === "error"
      ? {
          eyebrow: "Archive unavailable",
          title: "No verified gift history is available.",
          body: "The initial read did not complete. Retry to request a fresh sanitized snapshot.",
        }
      : kind === "page_clean"
        ? {
            eyebrow: "Page integrity",
            title: "No readable field issues appear on this page.",
            body: "This review mode is page-local. Continue through the archive to inspect later pages, or show every record on this page.",
          }
        : kind === "filtered"
          ? {
              eyebrow: "No matching evidence",
              title: "Nothing on this page matches these controls.",
              body: "Clear the search and lifecycle filter to return to the complete archive result.",
            }
          : {
              eyebrow: "Archive ready",
              title: "No gift lifecycle records are on file.",
              body: "Historical records will appear here only after a separately verified commerce system writes them. This workspace cannot issue a gift.",
            };
  return (
    <section className={`ghs-terminal is-${kind}`} role="status">
      <div className="ghs-terminal-art" aria-hidden="true">
        <span>
          <GiftIcon size={28} />
        </span>
        <i />
        <i />
        <i />
      </div>
      <div>
        <span>{content.eyebrow}</span>
        <h2>{content.title}</h2>
        <p>{content.body}</p>
        {onRetry ? (
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            Retry archive read
          </button>
        ) : null}
        {onReset ? (
          <button type="button" className="btn" onClick={onReset}>
            {kind === "page_clean"
              ? "Show every record on this page"
              : "Clear controls"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function LifecycleTrack({
  record,
  compact = false,
}: {
  record: GiftHistoryRecord;
  compact?: boolean;
}): ReactElement {
  const state = giftHistoryState(record);
  const terminal = ["redeemed", "cancelled", "expired", "refunded"].includes(
    state,
  );
  return (
    <div
      className={`ghs-lifecycle-track${compact ? " is-compact" : ""}`}
      aria-label={`Lifecycle: recorded, ${giftStateLabel(state)}`}
    >
      <span className="is-complete">
        <i aria-hidden="true" />
        Recorded
      </span>
      <b className="is-complete" aria-hidden="true" />
      <span className={state === "pending" ? "is-current" : "is-complete"}>
        <i aria-hidden="true" />
        {state === "paid" ? "Paid" : "Open"}
      </span>
      <b className={terminal ? "is-complete" : undefined} aria-hidden="true" />
      <span className={terminal ? "is-current" : undefined}>
        <i aria-hidden="true" />
        {terminal ? giftStateLabel(state) : "Outcome"}
      </span>
    </div>
  );
}

function EvidencePill({
  label,
  present,
}: {
  label: string;
  present: boolean | null;
}): ReactElement {
  return (
    <span
      className={`ghs-evidence-pill ${present === true ? "is-present" : present === false ? "is-absent" : "is-unknown"}`}
    >
      <i aria-hidden="true" />
      {label}:{" "}
      {present === true
        ? "recorded"
        : present === false
          ? "not recorded"
          : "unknown"}
    </span>
  );
}

function RecordCard({
  record,
  onInspect,
}: {
  record: GiftHistoryRecord;
  onInspect: (record: GiftHistoryRecord, trigger: HTMLElement) => void;
}): ReactElement {
  const state = giftHistoryState(record);
  return (
    <article className={`ghs-card ${stateClass(state)}`}>
      <div className="ghs-card-top">
        <div className="ghs-card-icon">
          <GiftIcon />
        </div>
        <div>
          <span>Sanitized archive record</span>
          <h3>{record.label}</h3>
        </div>
        <StateBadge state={state} compact />
      </div>
      <div className="ghs-card-primary">
        <div>
          <span>Plan class</span>
          <strong>{record.planLabel}</strong>
        </div>
        <div>
          <span>Duration</span>
          <strong>
            {record.durationMonths === null
              ? "Unavailable"
              : `${record.durationMonths.toLocaleString()} ${record.durationMonths === 1 ? "month" : "months"}`}
          </strong>
        </div>
        <div>
          <span>Recorded</span>
          <strong>{safeDate(record.createdAt)}</strong>
        </div>
      </div>
      <LifecycleTrack record={record} compact />
      <div className="ghs-card-evidence" aria-label="Recorded evidence flags">
        <EvidencePill
          label="Provider reference"
          present={record.providerInvoiceLinked}
        />
        <EvidencePill
          label="Recipient member"
          present={record.recipientMemberLinked}
        />
      </div>
      {record.issues.length > 0 ? (
        <p className="ghs-card-warning">
          <ShieldIcon />
          {record.issues.length.toLocaleString()} integrity{" "}
          {record.issues.length === 1 ? "warning" : "warnings"}
        </p>
      ) : null}
      <div className="ghs-card-footer">
        <button
          type="button"
          className="ghs-inspect"
          onClick={(event) => onInspect(record, event.currentTarget)}
          aria-label={`Inspect ${record.label}`}
        >
          Inspect evidence
          <ArrowIcon />
        </button>
      </div>
    </article>
  );
}

function RecordList({
  records,
  onInspect,
}: {
  records: readonly GiftHistoryRecord[];
  onInspect: (record: GiftHistoryRecord, trigger: HTMLElement) => void;
}): ReactElement {
  return (
    <section className="ghs-records" aria-labelledby="gift-records-heading">
      <div className="ghs-records-heading">
        <div>
          <span>Record-level evidence</span>
          <h2 id="gift-records-heading">Lifecycle archive</h2>
        </div>
        <span className="ghs-records-count">
          {records.length.toLocaleString()} loaded{" "}
          {records.length === 1 ? "record" : "records"}
        </span>
      </div>
      <div className="ghs-card-grid">
        {records.map((record) => (
          <RecordCard key={record.key} record={record} onInspect={onInspect} />
        ))}
      </div>
    </section>
  );
}

function Pagination({
  page,
  onOffset,
}: {
  page: GiftHistoryPage;
  onOffset: (offset: number) => void;
}): ReactElement {
  const pageNumber = Math.floor(page.offset / page.limit) + 1;
  const maxReachableOffset =
    Math.floor(MAX_GIFT_HISTORY_OFFSET / page.limit) * page.limit;
  const reachableTotal = Math.min(page.total, maxReachableOffset + page.limit);
  const pageCount = Math.max(1, Math.ceil(reachableTotal / page.limit));
  const first = page.items.length === 0 ? 0 : page.offset + 1;
  const last = Math.min(page.offset + page.items.length, page.total);
  const nextOffset = page.offset + page.limit;
  const windowLimited =
    page.offset >= maxReachableOffset &&
    page.offset + page.items.length < page.total;
  return (
    <nav className="ghs-pagination" aria-label="Gift history pages">
      <span aria-live="polite">
        Showing {first.toLocaleString()}–{last.toLocaleString()} of{" "}
        {page.total.toLocaleString()}
        {windowLimited
          ? " · archive window limit reached; narrow the lifecycle filter or record prefix"
          : ""}
      </span>
      <div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={page.offset === 0}
          onClick={() => onOffset(Math.max(0, page.offset - page.limit))}
        >
          Previous
        </button>
        <span>
          Page {pageNumber.toLocaleString()} of {pageCount.toLocaleString()}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={
            page.offset + page.items.length >= page.total ||
            nextOffset > MAX_GIFT_HISTORY_OFFSET
          }
          onClick={() => onOffset(nextOffset)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function loadGiftDetail(
  recordID: string,
): Promise<RemoteLoadResult<GiftHistoryRecord>> {
  const response = await api.getGiftSubscription(recordID);
  if (response.error) return { error: response.error };
  if (!isObject(response.data)) {
    return {
      error: {
        kind: "parse",
        message: "Gift detail response did not match its contract",
      },
    };
  }
  const record = decodeGiftHistoryRecord(response.data, 0);
  if (
    record.sourceRecordID?.toLocaleLowerCase() !== recordID.toLocaleLowerCase()
  ) {
    return {
      error: {
        kind: "parse",
        message: "Gift detail did not match the requested record",
      },
    };
  }
  return { data: record };
}

function Timeline({ record }: { record: GiftHistoryRecord }): ReactElement {
  const state = giftHistoryState(record);
  const events: Array<{
    label: string;
    detail: string;
    value: string | null;
    kind: string;
  }> = [
    {
      label: "Record created",
      detail: "The local gift lifecycle began.",
      value: record.createdAt,
      kind: "recorded",
    },
  ];
  if (record.providerInvoiceLinked === true) {
    events.push({
      label: "Provider reference linked",
      detail:
        "A local invoice reference exists. Payment and settlement are not verified here.",
      value: null,
      kind: "provider",
    });
  }
  if (state === "redeemed") {
    events.push({
      label: "Access recorded",
      detail:
        "The local lifecycle records redemption or grant. Entitlement reconciliation is outside this route.",
      value: record.redeemedAt,
      kind: "positive",
    });
  }
  if (state === "cancelled") {
    events.push({
      label: "Cancellation recorded",
      detail:
        "The local lifecycle is closed as cancelled. No provider void or refund is proven here.",
      value: record.canceledAt,
      kind: "closed",
    });
  }
  if (state === "expired") {
    events.push({
      label: "Expiry recorded",
      detail: "The stored claim window is closed as expired.",
      value: record.expiresAt,
      kind: "closed",
    });
  }
  if (state === "refunded") {
    events.push({
      label: "Refund status recorded",
      detail:
        "The local row is marked refunded. A provider refund receipt is not exposed here.",
      value: null,
      kind: "closed",
    });
  }
  if ((state === "pending" || state === "paid") && record.expiresAt) {
    events.push({
      label: "Stored expiry boundary",
      detail: "This is a local deadline, not a provider-side guarantee.",
      value: record.expiresAt,
      kind: "future",
    });
  }
  return (
    <ol className="ghs-detail-timeline">
      {events.map((event, index) => (
        <li key={`${event.label}:${index}`} className={`is-${event.kind}`}>
          <span aria-hidden="true" />
          <div>
            <strong>{event.label}</strong>
            <p>{event.detail}</p>
          </div>
          <time dateTime={event.value ?? undefined}>
            {event.value ? safeDateTime(event.value) : "Timestamp not exposed"}
          </time>
        </li>
      ))}
    </ol>
  );
}

function DetailFacts({ record }: { record: GiftHistoryRecord }): ReactElement {
  const facts: ReadonlyArray<[string, string]> = [
    ["Archive label", record.label],
    ["Plan class", record.planLabel],
    [
      "Duration",
      record.durationMonths === null
        ? "Unavailable"
        : `${record.durationMonths.toLocaleString()} ${record.durationMonths === 1 ? "month" : "months"}`,
    ],
    ["Lifecycle", giftStateLabel(giftHistoryState(record))],
    ["Created", safeDateTime(record.createdAt)],
    ["Expiry boundary", safeDateTime(record.expiresAt)],
  ];
  return (
    <dl className="ghs-detail-facts">
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DetailEvidence({
  record,
}: {
  record: GiftHistoryRecord;
}): ReactElement {
  const evidence: ReadonlyArray<{
    label: string;
    present: boolean | null;
    detail: string;
  }> = [
    {
      label: "Personal message",
      present: record.messageRecorded,
      detail: "Presence only; message content is withheld.",
    },
    {
      label: "Provider invoice reference",
      present: record.providerInvoiceLinked,
      detail: "Presence only; identifier and payment URL are withheld.",
    },
    {
      label: "Gifter member linkage",
      present: record.gifterMemberLinked,
      detail: "Linkage presence only; subscriber identity is withheld.",
    },
    {
      label: "Recipient member linkage",
      present: record.recipientMemberLinked,
      detail: "Linkage presence only; subscriber identity is withheld.",
    },
  ];
  return (
    <div className="ghs-detail-evidence">
      {evidence.map((entry) => (
        <article key={entry.label}>
          <span
            className={
              entry.present === true
                ? "is-present"
                : entry.present === false
                  ? "is-absent"
                  : "is-unknown"
            }
          >
            <i aria-hidden="true" />
            {entry.present === true
              ? "Recorded"
              : entry.present === false
                ? "Not recorded"
                : "Unknown"}
          </span>
          <h3>{entry.label}</h3>
          <p>{entry.detail}</p>
        </article>
      ))}
    </div>
  );
}

function RecordDetail({
  initialRecord,
  onClose,
  returnFocusRef,
}: {
  initialRecord: GiftHistoryRecord;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}): ReactElement {
  const detail = useRemoteResource(
    () =>
      initialRecord.sourceRecordID
        ? loadGiftDetail(initialRecord.sourceRecordID)
        : Promise.resolve({
            error: {
              kind: "parse" as const,
              message: "Gift record identifier is unavailable",
            },
          }),
    {
      identity: `gift-history-detail:${initialRecord.sourceRecordID ?? initialRecord.key}`,
      initialData: initialRecord,
    },
  );
  const record = detail.data ?? initialRecord;
  const refreshing = detail.transport === "loading";
  return (
    <SlideoverShell
      open
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      size="lg"
      className="ghs-detail-shell"
      eyebrow="Sanitized gift evidence"
      title={record.label}
      subtitle={
        <span className="ghs-detail-subtitle">
          <StateBadge state={giftHistoryState(record)} compact />
          <span>{record.planLabel}</span>
          <span aria-hidden="true">·</span>
          <span>
            {record.durationMonths === null
              ? "Duration unavailable"
              : `${record.durationMonths.toLocaleString()} months`}
          </span>
        </span>
      }
      footer={
        <div className="ghs-detail-footer">
          <span>
            <ShieldIcon />
            Identity-minimized archive projection
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Close evidence
          </button>
        </div>
      }
    >
      {detail.transport === "error" ? (
        <RetainedError
          scope="record page"
          onRetry={() => void detail.reload()}
        />
      ) : null}
      <div className="ghs-detail-provenance" role="status">
        <span className={refreshing ? "is-reading" : undefined}>
          <span aria-hidden="true" />
          {refreshing ? "Re-verifying record" : "Detail verified"}
        </span>
        <span>
          Full gift ID, identities, free text, and provider objects are not
          present in this response.
        </span>
      </div>

      <section
        className="ghs-detail-section"
        aria-labelledby="ghs-detail-summary"
      >
        <div className="ghs-detail-heading">
          <span>01</span>
          <div>
            <h2 id="ghs-detail-summary">Record summary</h2>
            <p>
              The bounded fields that identify this lifecycle without disclosing
              personal or provider-held values.
            </p>
          </div>
        </div>
        <DetailFacts record={record} />
        <LifecycleTrack record={record} />
      </section>

      <section
        className="ghs-detail-section"
        aria-labelledby="ghs-detail-timeline"
      >
        <div className="ghs-detail-heading">
          <span>02</span>
          <div>
            <h2 id="ghs-detail-timeline">Lifecycle trail</h2>
            <p>
              Events are shown only when the sanitized archive contains
              corresponding stored evidence.
            </p>
          </div>
        </div>
        <Timeline record={record} />
      </section>

      <section
        className="ghs-detail-section"
        aria-labelledby="ghs-detail-signals"
      >
        <div className="ghs-detail-heading">
          <span>03</span>
          <div>
            <h2 id="ghs-detail-signals">Evidence signals</h2>
            <p>
              Boolean linkage signals preserve operational context while
              withholding the linked values.
            </p>
          </div>
        </div>
        <DetailEvidence record={record} />
      </section>

      {record.issues.length > 0 ? (
        <section
          className="ghs-detail-issues"
          aria-labelledby="ghs-detail-issues"
        >
          <h2 id="ghs-detail-issues">
            <ShieldIcon />
            Data integrity warnings
          </h2>
          <ul>
            {record.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="ghs-boundary-grid" aria-label="Evidence boundaries">
        <article className="is-readable">
          <span>
            <GiftIcon />
          </span>
          <p>Readable here</p>
          <h3>Stored lifecycle</h3>
          <small>
            Sanitized state, duration, timestamps, and linkage flags.
          </small>
        </article>
        <article className="is-private">
          <span>
            <ShieldIcon />
          </span>
          <p>Intentionally withheld</p>
          <h3>Personal identity</h3>
          <small>No purchaser, recipient, member, or message content.</small>
        </article>
        <article className="is-locked">
          <span>
            <LinkIcon />
          </span>
          <p>Not established</p>
          <h3>Provider + entitlement</h3>
          <small>No checkout, settlement, refund, or access receipt.</small>
        </article>
      </section>
    </SlideoverShell>
  );
}

async function loadGiftHistory(
  options: GiftHistoryListOptions,
): Promise<RemoteLoadResult<GiftHistoryPage>> {
  const response = await api.listGiftSubscriptions(options);
  if (response.error) return { error: response.error };
  const decoded = decodeGiftHistoryPage(response.data);
  if (!decoded.recognized) {
    return {
      error: {
        kind: "parse",
        message: "Gift history response did not match its contract",
      },
    };
  }
  return { data: decoded };
}

async function loadGiftStats(): Promise<RemoteLoadResult<GiftHistoryStats>> {
  const response = await api.getGiftSubscriptionStats();
  if (response.error) return { error: response.error };
  const decoded = decodeGiftHistoryStats(response.data);
  if (!decoded || decoded.issues.length > 0) {
    return {
      error: {
        kind: "parse",
        message: "Gift statistics response failed integrity checks",
      },
    };
  }
  return { data: decoded };
}

export function GiftHistoryWorkspace(): ReactElement {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const deferredSearchPrefix = giftHistorySearchPrefix(deferredSearch);
  const [acceptedSearchPrefix, setAcceptedSearchPrefix] = useState<
    string | undefined
  >(undefined);
  const [filter, setFilter] = useState<GiftHistoryFilter>("all");
  const [sort, setSort] = useState<GiftHistorySort>("newest");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<GiftHistoryRecord | null>(null);
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const serverFilter = giftHistoryServerFilter(filter);
  const listOptions: GiftHistoryListOptions = {
    limit: PAGE_SIZE,
    offset,
    q: acceptedSearchPrefix,
    filter: serverFilter,
    sort,
  };
  const listIdentity = [
    "gift-history",
    PAGE_SIZE,
    offset,
    acceptedSearchPrefix ?? "no-search",
    serverFilter ?? "all",
    sort,
  ].join(":");
  const history = useRemoteResource(() => loadGiftHistory(listOptions), {
    identity: listIdentity,
  });
  const stats = useRemoteResource(loadGiftStats, {
    identity: "gift-history-statistics",
  });
  const page = history.data;
  const aggregate = stats.data;
  const statsUnavailable = stats.transport === "error" && stats.data === null;
  const initialLoading =
    history.transport === "loading" && history.data === null;
  const refreshing =
    history.transport === "loading" || stats.transport === "loading";
  const pageCounts = useMemo(
    () => giftHistoryCounts(page?.items ?? []),
    [page],
  );
  const visibleRecords = useMemo(
    () =>
      filter === "data_issue"
        ? (page?.items ?? []).filter((record) =>
            giftHistoryMatchesFilter(record, "data_issue"),
          )
        : (page?.items ?? []),
    [filter, page],
  );

  useEffect(() => {
    if (deferredSearch.trim() === "") {
      setAcceptedSearchPrefix(undefined);
    } else if (deferredSearchPrefix) {
      setAcceptedSearchPrefix(deferredSearchPrefix);
    }
  }, [deferredSearch, deferredSearchPrefix]);

  useEffect(() => {
    setOffset(0);
  }, [acceptedSearchPrefix, filter, sort]);

  useEffect(() => {
    if (!page || page.total === 0 || offset < page.total) return;
    setOffset(
      Math.max(0, Math.floor((page.total - 1) / page.limit) * page.limit),
    );
  }, [offset, page]);

  useEffect(() => {
    if (!selected || !page) return;
    const current = page.items.find(
      (record) => record.sourceRecordID === selected.sourceRecordID,
    );
    if (current) setSelected(current);
  }, [page, selected]);

  const refresh = (): void => {
    void Promise.all([history.reload(), stats.reload()]);
  };
  const resetControls = (): void => {
    setSearch("");
    setFilter("all");
    setSort("newest");
    setOffset(0);
  };
  const integrityCount =
    pageCounts.data_issue +
    (page?.rejectedRows ?? 0) +
    (page?.envelopeIssues.length ?? 0);
  return (
    <section className="ghs-page" aria-labelledby="gift-history-title">
      <Hero
        stats={aggregate}
        page={page}
        loading={initialLoading || refreshing}
        statsUnavailable={statsUnavailable}
      />

      {aggregate ? (
        <SummaryGrid
          stats={aggregate}
          activeFilter={filter}
          onFilter={setFilter}
        />
      ) : statsUnavailable ? (
        <AggregateUnavailable onRetry={() => void stats.reload()} />
      ) : (
        <div className="ghs-summary-skeleton" aria-hidden="true">
          {Array.from({ length: 5 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
      )}

      <ProvenanceBand page={page} stats={aggregate} refreshing={refreshing} />

      {stats.transport === "error" && aggregate ? (
        <RetainedError
          scope="aggregate statistics"
          onRetry={() => void stats.reload()}
        />
      ) : null}

      <ControlBar
        search={search}
        filter={filter}
        sort={sort}
        resultTotal={page?.total ?? null}
        refreshing={refreshing}
        onSearch={setSearch}
        onFilter={setFilter}
        onSort={setSort}
        onRefresh={refresh}
      />

      {history.transport === "error" && page ? (
        <RetainedError
          scope="record page"
          onRetry={() => void history.reload()}
        />
      ) : null}

      {page && integrityCount > 0 ? (
        <IntegrityBanner
          issueCount={pageCounts.data_issue}
          rejectedRows={page.rejectedRows}
          envelopeIssues={page.envelopeIssues.length}
          onReview={() => setFilter("data_issue")}
        />
      ) : null}

      {initialLoading ? (
        <LoadingRecords />
      ) : !page && history.transport === "error" ? (
        <TerminalState kind="error" onRetry={() => void history.reload()} />
      ) : page &&
        page.total === 0 &&
        !acceptedSearchPrefix &&
        filter === "all" ? (
        <TerminalState kind="empty" />
      ) : page && visibleRecords.length === 0 ? (
        filter === "data_issue" ? (
          <>
            <TerminalState kind="page_clean" onReset={() => setFilter("all")} />
            <Pagination page={page} onOffset={setOffset} />
          </>
        ) : (
          <TerminalState kind="filtered" onReset={resetControls} />
        )
      ) : page ? (
        <>
          <RecordList
            records={visibleRecords}
            onInspect={(record, trigger) => {
              detailReturnFocusRef.current = trigger;
              setSelected(record);
            }}
          />
          <Pagination page={page} onOffset={setOffset} />
        </>
      ) : null}

      <section className="ghs-release-boundary" aria-label="Release boundary">
        <div>
          <ShieldIcon />
        </div>
        <span>
          <strong>Historical inspection is the complete route boundary.</strong>
          Gift creation, cancellation, editing, payment handoff, redemption,
          attribution identities, provider reconciliation, entitlement changes,
          and export are absent from this desktop release.
        </span>
      </section>

      {selected ? (
        <RecordDetail
          initialRecord={selected}
          onClose={() => setSelected(null)}
          returnFocusRef={detailReturnFocusRef}
        />
      ) : null}
    </section>
  );
}
