import {
  type ReactElement,
  type RefObject,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { SlideoverShell } from "../SlideoverShell";
import {
  apiMonetization as api,
  type DiscountHistoryEvent,
} from "../../lib/api-client";
import { fmtDate, fmtDateTime } from "../../lib/format-date";
import {
  decodeDiscountHistoryPayload,
  discountAppliesLabel,
  discountBenefitLabel,
  discountHistoryCounts,
  discountHistoryMatchesFilter,
  discountHistoryMatchesSearch,
  discountHistoryState,
  discountStateLabel,
  sortDiscountHistory,
  type DiscountHistoryFilter,
  type DiscountHistoryRecord,
  type DiscountHistorySort,
  type DiscountHistoryState,
} from "./discount-history";

const PAGE_SIZE = 12;

const FILTERS: ReadonlyArray<{
  id: DiscountHistoryFilter;
  label: string;
}> = [
  { id: "all", label: "All records" },
  { id: "within_stored_rules", label: "Within stored rules" },
  { id: "closed", label: "Closed by stored rules" },
  { id: "expired", label: "Expired" },
  { id: "cap_reached", label: "Cap reached" },
  { id: "data_issue", label: "Data issues" },
];

const SORTS: ReadonlyArray<{
  id: DiscountHistorySort;
  label: string;
}> = [
  { id: "newest", label: "Newest stored first" },
  { id: "oldest", label: "Oldest stored first" },
  { id: "label", label: "Record label A–Z" },
  { id: "redemptions", label: "Most recorded uses" },
  { id: "expiry", label: "Nearest expiry" },
];

function ArchiveIcon(): ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7.5h16v12H4z" />
      <path d="M3 4.5h18v3H3zM9 12h6" />
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
      <path d="M9 12h6" />
    </svg>
  );
}

function LockIcon(): ReactElement {
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
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function SearchIcon(): ReactElement {
  return (
    <svg
      width="15"
      height="15"
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

function RefreshIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
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

function stateClass(state: DiscountHistoryState): string {
  switch (state) {
    case "within_stored_rules":
      return "is-within";
    case "expired":
      return "is-expired";
    case "cap_reached":
      return "is-cap";
    case "data_issue":
      return "is-issue";
  }
}

function StateBadge({
  state,
  compact = false,
}: {
  state: DiscountHistoryState;
  compact?: boolean;
}): ReactElement {
  return (
    <span
      className={`dhs-state ${stateClass(state)}${compact ? " is-compact" : ""}`}
    >
      <span aria-hidden="true" />
      {discountStateLabel(state)}
    </span>
  );
}

function countForFilter(
  filter: DiscountHistoryFilter,
  counts: ReturnType<typeof discountHistoryCounts>,
): number {
  if (filter === "closed") return counts.closed;
  return counts[filter];
}

function fetchedAtLabel(value: string | null): string {
  if (!value) return "Not fetched yet";
  return `Fetched ${fmtDateTime(value)}`;
}

function safeDate(value: string | null): string {
  if (!value || Number.isNaN(Date.parse(value))) return "Unavailable";
  return fmtDate(value);
}

function EvidenceFlow({
  recordCount,
  redemptionCount,
  loading,
}: {
  recordCount: number | null;
  redemptionCount: number | null;
  loading: boolean;
}): ReactElement {
  return (
    <aside className="dhs-flow" aria-label="Discount evidence boundary">
      <div className="dhs-flow-head">
        <span>Evidence path</span>
        <span className="dhs-flow-status">
          <span aria-hidden="true" />
          {loading ? "Reading snapshot" : "Local record only"}
        </span>
      </div>
      <div className="dhs-flow-track">
        <article>
          <span className="dhs-flow-index">01</span>
          <span className="dhs-flow-icon">
            <ArchiveIcon />
          </span>
          <div>
            <strong>Stored terms</strong>
            <small>
              {recordCount === null
                ? "Reading…"
                : `${recordCount.toLocaleString()} record${recordCount === 1 ? "" : "s"}`}
            </small>
          </div>
        </article>
        <span className="dhs-flow-connector is-recorded" aria-hidden="true">
          <span />
        </span>
        <article>
          <span className="dhs-flow-index">02</span>
          <span className="dhs-flow-icon">
            <span className="dhs-recorded-dot" aria-hidden="true" />
          </span>
          <div>
            <strong>Recorded uses</strong>
            <small>
              {redemptionCount === null
                ? "Reading…"
                : `${redemptionCount.toLocaleString()} counter total`}
            </small>
          </div>
        </article>
        <span className="dhs-flow-connector is-boundary" aria-hidden="true" />
        <article className="is-locked">
          <span className="dhs-flow-index">03</span>
          <span className="dhs-flow-icon">
            <LockIcon />
          </span>
          <div>
            <strong>Provider + checkout</strong>
            <small>Not verified here</small>
          </div>
        </article>
      </div>
      <p>
        The moving signal stops at the evidence boundary: this screen can read
        local history, but it cannot prove provider state or checkout behavior.
      </p>
    </aside>
  );
}

function Hero({
  counts,
  loading,
  fetchedAt,
}: {
  counts: ReturnType<typeof discountHistoryCounts> | null;
  loading: boolean;
  fetchedAt: string | null;
}): ReactElement {
  return (
    <section className="dhs-hero" aria-labelledby="discount-history-title">
      <div className="dhs-hero-copy">
        <div className="dhs-eyebrow">
          <span>
            <ArchiveIcon />
          </span>
          Monetization archive
        </div>
        <div className="dhs-status-row" role="status">
          <span className="dhs-status-chip">
            <span aria-hidden="true" />
            Historical snapshot
          </span>
          <span className="dhs-status-secondary">
            <ShieldIcon />
            Read-only boundary
          </span>
        </div>
        <h1 id="discount-history-title">
          Read the commercial record without inventing checkout truth.
        </h1>
        <p>
          Inspect stored discount terms and recorded use counters with an
          explicit evidence boundary. Nothing on this route creates, edits,
          redeems, disables, or provider-verifies a discount.
        </p>
        <div
          className="dhs-hero-facts"
          aria-label="Current historical snapshot"
        >
          <span>
            <strong>Records on file</strong>
            {counts ? counts.all.toLocaleString() : "—"}
          </span>
          <span>
            <strong>Recorded uses</strong>
            {counts ? counts.recordedRedemptions.toLocaleString() : "—"}
          </span>
          <span>
            <strong>Retrieval</strong>
            {fetchedAt ? fmtDateTime(fetchedAt) : loading ? "In progress" : "—"}
          </span>
        </div>
        <p className="dhs-authority-note">
          <ShieldIcon />
          <span>
            “Within stored rules” evaluates only the local expiry and counter
            fields. It is not an availability, entitlement, provider, price, or
            checkout guarantee.
          </span>
        </p>
      </div>
      <EvidenceFlow
        recordCount={counts?.all ?? null}
        redemptionCount={counts?.recordedRedemptions ?? null}
        loading={loading}
      />
    </section>
  );
}

function SummaryGrid({
  counts,
  onFilter,
}: {
  counts: ReturnType<typeof discountHistoryCounts>;
  onFilter: (filter: DiscountHistoryFilter) => void;
}): ReactElement {
  const cells: ReadonlyArray<{
    label: string;
    value: number;
    detail: string;
    filter?: DiscountHistoryFilter;
    tone: string;
  }> = [
    {
      label: "Records on file",
      value: counts.all,
      detail: "Every readable local discount row.",
      filter: "all",
      tone: "neutral",
    },
    {
      label: "Within stored rules",
      value: counts.within_stored_rules,
      detail: "No local expiry or cap closure detected.",
      filter: "within_stored_rules",
      tone: "within",
    },
    {
      label: "Stored-rule closures",
      value: counts.closed,
      detail: "Expired or at the recorded cap.",
      filter: "closed",
      tone: "closed",
    },
    {
      label: "Recorded uses",
      value: counts.recordedRedemptions,
      detail: "Sum of local counters; not a revenue total.",
      tone: "uses",
    },
  ];
  return (
    <section className="dhs-summary" aria-label="Historical snapshot summary">
      {cells.map((cell) => {
        const content = (
          <>
            <span className="dhs-summary-label">{cell.label}</span>
            <strong>{cell.value.toLocaleString()}</strong>
            <small>{cell.detail}</small>
          </>
        );
        return cell.filter ? (
          <button
            key={cell.label}
            type="button"
            className={`dhs-summary-cell is-${cell.tone}`}
            onClick={() => onFilter(cell.filter!)}
            aria-label={`${cell.label}: ${cell.value.toLocaleString()}. Filter records.`}
          >
            {content}
          </button>
        ) : (
          <div key={cell.label} className={`dhs-summary-cell is-${cell.tone}`}>
            {content}
          </div>
        );
      })}
    </section>
  );
}

function ControlBar({
  search,
  filter,
  sort,
  counts,
  resultCount,
  fetchedAt,
  refreshing,
  onSearch,
  onFilter,
  onSort,
  onRefresh,
}: {
  search: string;
  filter: DiscountHistoryFilter;
  sort: DiscountHistorySort;
  counts: ReturnType<typeof discountHistoryCounts>;
  resultCount: number;
  fetchedAt: string | null;
  refreshing: boolean;
  onSearch: (value: string) => void;
  onFilter: (value: DiscountHistoryFilter) => void;
  onSort: (value: DiscountHistorySort) => void;
  onRefresh: () => void;
}): ReactElement {
  const hasNarrowing = search.trim().length > 0 || filter !== "all";
  return (
    <section className="dhs-controls" aria-labelledby="discount-records-title">
      <div className="dhs-controls-head">
        <div>
          <p>Local history</p>
          <h2 id="discount-records-title">Discount records</h2>
          <span aria-live="polite">
            {resultCount.toLocaleString()} matching{" "}
            {resultCount === 1 ? "record" : "records"} ·{" "}
            {fetchedAtLabel(fetchedAt)}
          </span>
        </div>
        <button
          type="button"
          className="dhs-refresh"
          onClick={onRefresh}
          disabled={refreshing}
          aria-disabled={refreshing || undefined}
        >
          <RefreshIcon />
          {refreshing ? "Refreshing snapshot…" : "Refresh snapshot"}
        </button>
      </div>
      <div className="dhs-control-row">
        <label className="dhs-search">
          <span className="visually-hidden">Search discount records</span>
          <SearchIcon />
          <input
            type="search"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search) {
                event.preventDefault();
                onSearch("");
              }
            }}
            placeholder="Search record label, benefit, currency, or scope…"
            autoComplete="off"
          />
          {search ? (
            <button
              type="button"
              onClick={() => onSearch("")}
              aria-label="Clear search"
            >
              Clear
            </button>
          ) : null}
        </label>
        <label className="dhs-sort">
          <span>Sort</span>
          <select
            value={sort}
            onChange={(event) =>
              onSort(event.target.value as DiscountHistorySort)
            }
          >
            {SORTS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="dhs-filter-group">
        <legend className="visually-hidden">Filter discount history</legend>
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={filter === item.id}
            onClick={() => onFilter(item.id)}
          >
            <span>{item.label}</span>
            <strong>{countForFilter(item.id, counts).toLocaleString()}</strong>
          </button>
        ))}
        {hasNarrowing ? (
          <button
            type="button"
            className="dhs-clear-filters"
            onClick={() => {
              onSearch("");
              onFilter("all");
            }}
          >
            Reset
          </button>
        ) : null}
      </fieldset>
    </section>
  );
}

function UsageBar({
  record,
  compact = false,
}: {
  record: DiscountHistoryRecord;
  compact?: boolean;
}): ReactElement {
  const capped = record.maxRedemptions !== null;
  const percentage = capped
    ? Math.min(100, (record.timesRedeemed / record.maxRedemptions!) * 100)
    : 0;
  return (
    <div className={`dhs-usage${compact ? " is-compact" : ""}`}>
      <div>
        <span className="tabular">{record.timesRedeemed.toLocaleString()}</span>
        <small>
          {capped
            ? ` of ${record.maxRedemptions!.toLocaleString()} recorded`
            : " recorded · no stored cap"}
        </small>
      </div>
      {capped ? (
        <span
          className="dhs-usage-track"
          role="progressbar"
          aria-label={`Recorded uses for ${record.label}`}
          aria-valuemin={0}
          aria-valuemax={record.maxRedemptions!}
          aria-valuenow={Math.min(record.timesRedeemed, record.maxRedemptions!)}
        >
          <span style={{ width: `${percentage}%` }} />
        </span>
      ) : null}
    </div>
  );
}

function RecordList({
  records,
  onInspect,
}: {
  records: readonly DiscountHistoryRecord[];
  onInspect: (
    record: DiscountHistoryRecord,
    trigger: HTMLButtonElement,
  ) => void;
}): ReactElement {
  return (
    <div className="dhs-list-shell">
      <div className="dhs-list-head" aria-hidden="true">
        <span>Record label + stored benefit</span>
        <span>Scope</span>
        <span>Recorded use</span>
        <span>Stored expiry</span>
        <span>Local record state</span>
        <span />
      </div>
      <ul className="dhs-records" aria-label="Discount history records">
        {records.map((record) => {
          const state = discountHistoryState(record);
          return (
            <li key={record.key}>
              <article className={`dhs-record ${stateClass(state)}`}>
                <div className="dhs-record-primary">
                  <span className="dhs-record-label">
                    Record label + stored benefit
                  </span>
                  <button
                    type="button"
                    className="dhs-code"
                    onClick={(event) => onInspect(record, event.currentTarget)}
                    aria-label={`Inspect ${record.label}`}
                  >
                    <span className="mono">{record.label}</span>
                    <small>{discountBenefitLabel(record)}</small>
                  </button>
                </div>
                <div className="dhs-record-field">
                  <span className="dhs-record-label">Scope</span>
                  <strong>{discountAppliesLabel(record.appliesTo)}</strong>
                  <small>Stored application rule</small>
                </div>
                <div className="dhs-record-field">
                  <span className="dhs-record-label">Recorded use</span>
                  <UsageBar record={record} compact />
                </div>
                <div className="dhs-record-field">
                  <span className="dhs-record-label">Stored expiry</span>
                  <strong className="tabular">
                    {safeDate(record.expiresAt)}
                  </strong>
                  <small>
                    {record.expiresAt ? "Local timestamp" : "No stored expiry"}
                  </small>
                </div>
                <div className="dhs-record-state">
                  <span className="dhs-record-label">Local record state</span>
                  <StateBadge state={state} compact />
                  <small>Not provider-verified</small>
                </div>
                <button
                  type="button"
                  className="dhs-inspect"
                  onClick={(event) => onInspect(record, event.currentTarget)}
                  aria-label={`Open details for ${record.label}`}
                >
                  <ArrowIcon />
                </button>
              </article>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LoadingRecords(): ReactElement {
  return (
    <div
      className="dhs-loading"
      role="status"
      aria-label="Loading discount history"
    >
      {[0, 1, 2, 3, 4].map((item) => (
        <div key={item}>
          <span />
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

function TerminalState({
  kind,
  onRetry,
  onReset,
}: {
  kind: "empty" | "error" | "filtered";
  onRetry?: () => void;
  onReset?: () => void;
}): ReactElement {
  const copy =
    kind === "error"
      ? {
          eyebrow: "Snapshot unavailable",
          title: "The archive could not be read.",
          detail:
            "No historical data is being inferred. Retry the same read when the service is available.",
        }
      : kind === "filtered"
        ? {
            eyebrow: "No match",
            title: "Nothing on file matches this view.",
            detail:
              "Change the search or stored-rule filters. The underlying archive has not been modified.",
          }
        : {
            eyebrow: "No local history",
            title: "There are no discount records on file.",
            detail:
              "This is a truthful empty archive, not an invitation to create a provider-backed discount. Authoring remains unavailable from this route.",
          };
  return (
    <section className={`dhs-terminal is-${kind}`} aria-label={copy.title}>
      <span className="dhs-terminal-art" aria-hidden="true">
        <ArchiveIcon />
        <span />
        <span />
      </span>
      <div>
        <p>{copy.eyebrow}</p>
        <h2>{copy.title}</h2>
        <span>{copy.detail}</span>
        {onRetry || onReset ? (
          <div>
            {onRetry ? (
              <button type="button" className="btn" onClick={onRetry}>
                Retry snapshot
              </button>
            ) : null}
            {onReset ? (
              <button type="button" className="btn" onClick={onReset}>
                Reset filters
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

interface TimelineEvent {
  key: string;
  redeemedAt: string | null;
  subscriberLinked: boolean;
}

function redemptionRows(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  for (const field of ["items", "data", "results"] as const) {
    if (Array.isArray(row[field])) return row[field];
  }
  return null;
}

function decodeTimeline(value: unknown): TimelineEvent[] | null {
  const rows = redemptionRows(value);
  if (!rows) return null;
  return rows.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Partial<DiscountHistoryEvent> & Record<string, unknown>;
    const redeemedAt =
      typeof row.redeemed_at === "string" &&
      !Number.isNaN(Date.parse(row.redeemed_at))
        ? row.redeemed_at
        : null;
    return [
      {
        key: `${index}:${redeemedAt ?? "unknown"}`,
        redeemedAt,
        subscriberLinked: row.subscriber_linked === true,
      },
    ];
  });
}

function RecordDetail({
  record,
  onClose,
  returnFocusRef,
}: {
  record: DiscountHistoryRecord;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}): ReactElement {
  const [timeline, setTimeline] = useState<TimelineEvent[] | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const state = discountHistoryState(record);

  useEffect(() => {
    let cancelled = false;
    setTimeline(null);
    setTimelineError(null);
    if (!record.sourceRecordID) {
      setTimeline([]);
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const response = await api.listDiscountRedemptions(
          record.sourceRecordID!,
          { limit: 12 },
        );
        if (cancelled) return;
        if (response.error) {
          setTimelineError(response.error.message);
          setTimeline([]);
          return;
        }
        const decoded = decodeTimeline(response.data);
        if (!decoded) {
          setTimelineError("The event service returned an unreadable payload.");
          setTimeline([]);
          return;
        }
        setTimeline(decoded);
      } catch {
        if (!cancelled) {
          setTimelineError("The recent-event request did not complete.");
          setTimeline([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [record.key, record.sourceRecordID, attempt]);

  return (
    <SlideoverShell
      open
      onClose={onClose}
      size="lg"
      className="dhs-drawer"
      returnFocusRef={returnFocusRef}
      eyebrow="Historical discount record"
      title={<span className="mono">{record.label}</span>}
      subtitle={`${discountBenefitLabel(record)} · ${discountAppliesLabel(record.appliesTo)}`}
      footer={
        <div className="dhs-drawer-footer">
          <span>
            <ShieldIcon />
            Inspection only · no mutation or checkout probe
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      }
    >
      <section className={`dhs-verdict ${stateClass(state)}`}>
        <div>
          <p>Local record evaluation</p>
          <h3>{discountStateLabel(state)}</h3>
          <span>
            {state === "within_stored_rules"
              ? "The stored expiry and counter fields do not close this record."
              : state === "expired"
                ? "The stored expiry timestamp has passed."
                : state === "cap_reached"
                  ? "The local counter meets or exceeds the stored cap."
                  : "One or more stored fields cannot be trusted without review."}
          </span>
        </div>
        <StateBadge state={state} />
        <p>
          This is not a provider status or a promise that any checkout honors a
          related discount.
        </p>
      </section>

      <section className="dhs-drawer-section">
        <header>
          <p>Stored terms</p>
          <h3>What this row says</h3>
          <span>
            Values below are a local snapshot, not live provider terms.
          </span>
        </header>
        <dl className="dhs-term-grid">
          <div>
            <dt>Benefit</dt>
            <dd>{discountBenefitLabel(record)}</dd>
          </div>
          <div>
            <dt>Application scope</dt>
            <dd>{discountAppliesLabel(record.appliesTo)}</dd>
          </div>
          <div>
            <dt>Stored expiry</dt>
            <dd className="tabular">{safeDate(record.expiresAt)}</dd>
          </div>
          <div>
            <dt>Stored creation</dt>
            <dd className="tabular">{safeDate(record.createdAt)}</dd>
          </div>
        </dl>
      </section>

      <section className="dhs-drawer-section">
        <header>
          <p>Recorded use</p>
          <h3>Counter position</h3>
          <span>
            A local counter is not proof of billing, discount amount, or
            complete event lineage.
          </span>
        </header>
        <UsageBar record={record} />
      </section>

      {record.issues.length > 0 ? (
        <section
          className="dhs-integrity"
          aria-labelledby="dhs-integrity-title"
        >
          <div>
            <ShieldIcon />
          </div>
          <span>
            <strong id="dhs-integrity-title">Stored data needs review</strong>
            <small>
              This record stays visible so malformed history cannot disappear
              behind an empty state.
            </small>
          </span>
          <ul>
            {record.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="dhs-drawer-section">
        <header className="dhs-timeline-head">
          <div>
            <p>Recent ledger events</p>
            <h3>Newest recorded activity</h3>
            <span>
              Up to 12 events are requested. This view deliberately does not
              render subscriber identifiers or claim export completeness.
            </span>
          </div>
          {timelineError ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </button>
          ) : null}
        </header>
        {timelineError ? (
          <div className="dhs-inline-error" role="alert">
            <ShieldIcon />
            <span>
              <strong>Recent events unavailable.</strong>
              {timelineError}
            </span>
          </div>
        ) : timeline === null ? (
          <div className="dhs-timeline-loading" role="status">
            <span />
            <span />
            <span />
          </div>
        ) : timeline.length === 0 ? (
          <div className="dhs-timeline-empty">
            No readable redemption events were returned for this record.
          </div>
        ) : (
          <ol className="dhs-timeline">
            {timeline.map((event) => (
              <li key={event.key}>
                <span className="dhs-timeline-mark" aria-hidden="true" />
                <div>
                  <strong>
                    {event.subscriberLinked
                      ? "Subscriber-linked event"
                      : "Unattributed event"}
                  </strong>
                  <time dateTime={event.redeemedAt ?? undefined}>
                    {event.redeemedAt
                      ? fmtDateTime(event.redeemedAt)
                      : "Timestamp unavailable"}
                  </time>
                </div>
              </li>
            ))}
          </ol>
        )}
        {timeline && timeline.length > 0 ? (
          <p className="dhs-timeline-foot">
            Showing {timeline.length.toLocaleString()} recent{" "}
            {timeline.length === 1 ? "event" : "events"} against a stored
            counter of {record.timesRedeemed.toLocaleString()}. A mismatch is
            not reconciled by this screen.
          </p>
        ) : null}
      </section>

      <section className="dhs-boundary-grid" aria-label="Evidence boundaries">
        <article className="is-readable">
          <span>
            <ArchiveIcon />
          </span>
          <p>Readable here</p>
          <h3>Local record</h3>
          <small>Stored terms, counters, timestamps, and recent events.</small>
        </article>
        <article className="is-locked">
          <span>
            <LockIcon />
          </span>
          <p>Not established</p>
          <h3>Provider state</h3>
          <small>No provider adapter or reconciliation receipt is shown.</small>
        </article>
        <article className="is-locked">
          <span>
            <LockIcon />
          </span>
          <p>Not established</p>
          <h3>Checkout result</h3>
          <small>No mounted checkout validation path is exercised here.</small>
        </article>
      </section>
    </SlideoverShell>
  );
}

export function DiscountHistoryWorkspace(): ReactElement {
  const mountedRef = useRef(false);
  const rowsRef = useRef<DiscountHistoryRecord[] | null>(null);
  const loadRef = useRef<Promise<void> | null>(null);
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const [rows, setRows] = useState<DiscountHistoryRecord[] | null>(null);
  const [rejectedRows, setRejectedRows] = useState(0);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [filter, setFilter] = useState<DiscountHistoryFilter>("all");
  const [sort, setSort] = useState<DiscountHistorySort>("newest");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<DiscountHistoryRecord | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (loadRef.current) {
      await loadRef.current;
      return;
    }
    const hasSnapshot = rowsRef.current !== null;
    if (hasSnapshot) setRefreshing(true);
    else setInitialLoading(true);
    const request = (async () => {
      try {
        const response = await api.listDiscounts();
        if (!mountedRef.current) return;
        if (response.error) {
          setError(response.error.message);
          return;
        }
        const decoded = decodeDiscountHistoryPayload(response.data);
        if (!decoded.recognized) {
          setError("The archive service returned an unreadable payload.");
          return;
        }
        rowsRef.current = decoded.items;
        setRows(decoded.items);
        setRejectedRows(decoded.rejectedRows);
        setFetchedAt(new Date().toISOString());
        setError(null);
      } catch {
        if (mountedRef.current) {
          setError("The discount history request did not complete.");
        }
      } finally {
        if (mountedRef.current) {
          setInitialLoading(false);
          setRefreshing(false);
        }
      }
    })();
    loadRef.current = request;
    try {
      await request;
    } finally {
      if (loadRef.current === request) loadRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const counts = useMemo(() => discountHistoryCounts(rows ?? []), [rows]);
  const filtered = useMemo(() => {
    const matching = (rows ?? []).filter(
      (record) =>
        discountHistoryMatchesFilter(record, filter) &&
        discountHistoryMatchesSearch(record, deferredSearch),
    );
    return sortDiscountHistory(matching, sort);
  }, [rows, filter, deferredSearch, sort]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const firstVisible = filtered.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastVisible = Math.min(page * PAGE_SIZE, filtered.length);

  useEffect(() => {
    setPage(1);
  }, [filter, deferredSearch, sort]);
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const resetFilters = (): void => {
    setSearch("");
    setFilter("all");
    setPage(1);
  };

  const hasSnapshot = rows !== null;
  return (
    <main className="dhs-page">
      <Hero
        counts={hasSnapshot ? counts : null}
        loading={initialLoading || refreshing}
        fetchedAt={fetchedAt}
      />

      {hasSnapshot && rows.length > 0 ? (
        <SummaryGrid
          counts={counts}
          onFilter={(next) => {
            setFilter(next);
            setPage(1);
          }}
        />
      ) : null}

      {hasSnapshot ? (
        <ControlBar
          search={search}
          filter={filter}
          sort={sort}
          counts={counts}
          resultCount={filtered.length}
          fetchedAt={fetchedAt}
          refreshing={refreshing}
          onSearch={setSearch}
          onFilter={setFilter}
          onSort={setSort}
          onRefresh={() => void load()}
        />
      ) : null}

      {error && hasSnapshot ? (
        <div className="dhs-retained-error" role="alert">
          <ShieldIcon />
          <span>
            <strong>Refresh failed; the last readable snapshot remains.</strong>
            {error}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {hasSnapshot && (rejectedRows > 0 || counts.data_issue > 0) ? (
        <div className="dhs-integrity-banner" role="status">
          <ShieldIcon />
          <span>
            {counts.data_issue.toLocaleString()} readable{" "}
            {counts.data_issue === 1 ? "record has" : "records have"} field
            integrity warnings
            {rejectedRows > 0
              ? `; ${rejectedRows.toLocaleString()} non-object ${rejectedRows === 1 ? "row was" : "rows were"} rejected`
              : ""}
            . Nothing has been silently classified as usable.
          </span>
          <button type="button" onClick={() => setFilter("data_issue")}>
            Review data issues
          </button>
        </div>
      ) : null}

      {!hasSnapshot && initialLoading ? (
        <LoadingRecords />
      ) : !hasSnapshot && error ? (
        <TerminalState kind="error" onRetry={() => void load()} />
      ) : hasSnapshot && rows.length === 0 ? (
        <TerminalState kind="empty" />
      ) : hasSnapshot && filtered.length === 0 ? (
        <TerminalState kind="filtered" onReset={resetFilters} />
      ) : (
        <>
          <RecordList
            records={pageRows}
            onInspect={(record, trigger) => {
              detailReturnFocusRef.current = trigger;
              setSelected(record);
            }}
          />
          {pageCount > 1 ? (
            <nav className="dhs-pagination" aria-label="Discount history pages">
              <span>
                Showing {firstVisible.toLocaleString()}–
                {lastVisible.toLocaleString()} of{" "}
                {filtered.length.toLocaleString()}
              </span>
              <div>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  Previous
                </button>
                <span aria-live="polite">
                  Page {page.toLocaleString()} of {pageCount.toLocaleString()}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={page >= pageCount}
                  onClick={() =>
                    setPage((value) => Math.min(pageCount, value + 1))
                  }
                >
                  Next
                </button>
              </div>
            </nav>
          ) : null}
        </>
      )}

      <section className="dhs-release-boundary" aria-label="Release boundary">
        <div>
          <ShieldIcon />
        </div>
        <span>
          <strong>Historical inspection is the complete route boundary.</strong>
          Provider-backed authoring, extension, redemption, disabling, live
          validation, and complete personally identified export remain outside
          this desktop release.
        </span>
      </section>

      {selected ? (
        <RecordDetail
          record={selected}
          onClose={() => setSelected(null)}
          returnFocusRef={detailReturnFocusRef}
        />
      ) : null}
    </main>
  );
}
