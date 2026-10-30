import {
  type ReactElement,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useRemoteResource } from "../../hooks/useRemoteResource";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import {
  loadRetentionFunnel,
  loadRetentionOffers,
  loadRetentionTiers,
  loadRetentionWinbackSettings,
} from "../../lib/api/retention-history";
import {
  acceptanceRateOf,
  reconcileRetentionHistory,
  type RetentionFunnelCollection,
  type RetentionFunnelTotals,
  type RetentionOfferCollection,
  type RetentionOfferHistoryRow,
  type RetentionReconciliation,
} from "../../lib/retention-offers-contract";
import {
  filterAndSortRetentionRows,
  retentionDiscountPresentation,
  retentionReadinessFacts,
  type RetentionDiscountFilter,
  type RetentionEvidenceFilter,
  type RetentionHistorySort,
  type RetentionStatusFilter,
} from "../../lib/retention-offers-view-model";
import { fmtDateTime } from "../../lib/format-date";
import { useMe } from "../../lib/store";
import { Icon, type IconName } from "../Icon";
import { RetentionHistoryReadinessPanel } from "./RetentionHistoryReadinessPanel";
import { RetentionOfferDetail } from "./RetentionOfferDetail";
import { RETENTION_HISTORY_PAGE_SIZE } from "./retention-history-route";
import { useRetentionHistoryRoute } from "./useRetentionHistoryRoute";

const TABS = [
  {
    id: "overview",
    label: "Overview",
    eyebrow: "Outcome pulse",
    description: "Read the all-time event snapshot and its integrity.",
    icon: "chart-bars",
  },
  {
    id: "history",
    label: "Offer history",
    eyebrow: "Per-tier evidence",
    description: "Find stored terms and inspect complete retained records.",
    icon: "clock",
  },
  {
    id: "readiness",
    label: "Readiness",
    eyebrow: "Release boundary",
    description: "Separate stored facts from unavailable runtime proof.",
    icon: "shield-check",
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  eyebrow: string;
  description: string;
  icon: IconName;
}>;

type CriticalPairSnapshot =
  | {
      scope: string;
      phase: "refreshing" | "untrusted";
    }
  | {
      scope: string;
      phase: "verified";
      offers: RetentionOfferCollection;
      funnel: RetentionFunnelCollection;
    };

type SupportingResultState = "ready" | "pending" | "unavailable";

function refreshHasFailure(
  resources: readonly { stale: boolean; failure: unknown }[],
  criticalPhase: CriticalPairSnapshot["phase"] | null,
): boolean {
  return (
    criticalPhase === "untrusted" ||
    resources.some((resource) => resource.stale && resource.failure !== null)
  );
}

const COMPACT_LAYOUT_QUERY = "(max-width: 700px)";

function useCompactRetentionLayout(): boolean {
  const [compact, setCompact] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(COMPACT_LAYOUT_QUERY).matches
      : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(COMPACT_LAYOUT_QUERY);
    const update = (): void => setCompact(media.matches);
    update();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  return compact;
}

function number(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function verifiedAt(value: number | null): string {
  return value === null
    ? "Not verified"
    : fmtDateTime(new Date(value).toISOString());
}

function compactReference(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function anomalyCount(reconciliation: RetentionReconciliation): number {
  return (
    reconciliation.missingTileOfferIds.length +
    reconciliation.duplicateTileOfferIds.length +
    reconciliation.orphanTileOfferIds.length +
    reconciliation.tierMismatchOfferIds.length +
    reconciliation.outcomeExcessOfferIds.length
  );
}

function trustedTotals(
  reconciliation: RetentionReconciliation,
  withheld = false,
): RetentionFunnelTotals | null {
  return !withheld && reconciliation.integrity === "reconciled"
    ? reconciliation.matchedTotals
    : null;
}

function FunnelPath({
  reconciliation,
  offersAvailable,
  offersStale,
  funnelPending,
  loading,
  reconciliationPending,
}: {
  reconciliation: RetentionReconciliation;
  offersAvailable: boolean;
  offersStale: boolean;
  funnelPending: boolean;
  loading: boolean;
  reconciliationPending: boolean;
}): ReactElement {
  const trusted = trustedTotals(reconciliation, reconciliationPending);
  return (
    <aside
      className="rhs-path"
      aria-label="Retention evidence path: stored offer, raw event counters, then an unverified provider and runtime boundary."
    >
      <div className="rhs-path-head" aria-hidden="true">
        <span>Evidence path</span>
        <span className="rhs-path-live">
          <i />
          {loading
            ? "Reading snapshot"
            : reconciliationPending
              ? "Reconciling paired reads"
              : "Read-only boundary"}
        </span>
      </div>
      <ol aria-hidden="true">
        <li>
          <span className="rhs-path-index">01</span>
          <span className="rhs-path-icon">
            <Icon name="clock" size={17} />
          </span>
          <div>
            <strong>Offer rows read</strong>
            <small>
              {offersAvailable
                ? `${reconciliation.rows.length.toLocaleString()} ${
                    offersStale ? "last verified" : "current stored"
                  } ${reconciliation.rows.length === 1 ? "row" : "rows"}`
                : loading
                  ? "Reading current rows"
                  : "Offer rows unavailable"}
            </small>
          </div>
        </li>
        <li className="rhs-path-connector is-observed">
          <span />
        </li>
        <li>
          <span className="rhs-path-index">02</span>
          <span className="rhs-path-icon">
            <Icon name="chart-bars" size={17} />
          </span>
          <div>
            <strong>Events counted</strong>
            <small>
              {!offersAvailable
                ? "Cannot reconcile without offer rows"
                : reconciliationPending
                  ? "Reconciling paired reads"
                  : trusted
                    ? `${trusted.shown.toLocaleString()} shown events`
                    : reconciliation.integrity === "inconsistent"
                      ? "Integrity review required"
                      : funnelPending
                        ? "Reading funnel counters"
                        : "Funnel unavailable"}
            </small>
          </div>
        </li>
        <li className="rhs-path-connector is-boundary" />
        <li className="is-locked">
          <span className="rhs-path-index">03</span>
          <span className="rhs-path-icon">
            <Icon name="lock" size={17} />
          </span>
          <div>
            <strong>Delivery + recovery</strong>
            <small>Not certified by these reads</small>
          </div>
        </li>
      </ol>
      <p>
        The signal stops where the evidence stops. Stored events do not prove
        portal exposure, provider application, recovered revenue, or an active
        win-back worker.
      </p>
    </aside>
  );
}

function Hero({
  reconciliation,
  activeOffers,
  offersAvailable,
  offersStale,
  funnelPending,
  loading,
  lastVerifiedAt,
  reconciliationPending,
}: {
  reconciliation: RetentionReconciliation;
  activeOffers: number;
  offersAvailable: boolean;
  offersStale: boolean;
  funnelPending: boolean;
  loading: boolean;
  lastVerifiedAt: number | null;
  reconciliationPending: boolean;
}): ReactElement {
  const trusted = trustedTotals(reconciliation, reconciliationPending);
  return (
    <section className="rhs-hero" aria-labelledby="retention-history-title">
      <div className="rhs-hero-copy">
        <div className="rhs-kicker">
          <span className="rhs-kicker-icon" aria-hidden="true">
            <Icon name="clock" size={17} />
          </span>
          <span>Retention evidence</span>
          <i aria-hidden="true" />
          <span className="rhs-readiness">
            {offersStale ? "Last verified rows" : "Current stored rows"}
          </span>
        </div>
        <div className="rhs-status-row" role="status">
          <span className="rhs-status-chip">
            <span aria-hidden="true" />
            Admin · read only
          </span>
          <span>
            <Icon name="lock" size={14} />
            No authoring or delivery controls
          </span>
        </div>
        <h1 id="retention-history-title">
          See what the retention record can prove—and where it stops.
        </h1>
        <p>
          Inspect{" "}
          {offersStale
            ? "the last verified tier-bound offer-row response"
            : "current tier-bound offer rows"}{" "}
          and all-time event counters returned by Moosewave. Stored terms can be
          overwritten; this route does not create an offer, invoke a cancel
          flow, apply a discount, or verify provider delivery.
        </p>
        <div className="rhs-hero-facts" aria-label="Retention history facts">
          <span>
            <strong>
              {offersAvailable
                ? reconciliation.rows.length.toLocaleString()
                : "—"}
            </strong>
            <small>
              {offersStale ? "last verified offer rows" : "stored offer rows"}
            </small>
          </span>
          <span>
            <strong>
              {offersAvailable ? activeOffers.toLocaleString() : "—"}
            </strong>
            <small>marked active</small>
          </span>
          <span>
            <strong>
              {offersAvailable ? number(trusted?.shown ?? null) : "—"}
            </strong>
            <small>reconciled shown-event rows</small>
          </span>
          <span>
            <strong>
              {lastVerifiedAt === null
                ? "Not yet"
                : fmtDateTime(new Date(lastVerifiedAt).toISOString())}
            </strong>
            <small>offer rows read</small>
          </span>
        </div>
      </div>
      <FunnelPath
        reconciliation={reconciliation}
        offersAvailable={offersAvailable}
        offersStale={offersStale}
        funnelPending={funnelPending}
        loading={loading}
        reconciliationPending={reconciliationPending}
      />
    </section>
  );
}

function ProvenanceBand({
  offersAt,
  funnelAt,
  tiersAt,
  winbackAt,
  offersStale,
  funnelStale,
  tiersStale,
  winbackStale,
  refreshing,
}: {
  offersAt: number | null;
  funnelAt: number | null;
  tiersAt: number | null;
  winbackAt: number | null;
  offersStale: boolean;
  funnelStale: boolean;
  tiersStale: boolean;
  winbackStale: boolean;
  refreshing: boolean;
}): ReactElement {
  return (
    <div className="rhs-provenance" role="status">
      <span className="rhs-provenance-state">
        <i aria-hidden="true" />
        <strong>{refreshing ? "Refreshing reads" : "Independent reads"}</strong>
      </span>
      <span>
        Offers {verifiedAt(offersAt)}
        {offersStale ? " · stale" : ""}
      </span>
      <span>
        Funnel {verifiedAt(funnelAt)}
        {funnelStale ? " · stale" : ""}
      </span>
      <span>
        Tier names {verifiedAt(tiersAt)}
        {tiersStale ? " · stale" : ""}
      </span>
      <span>
        Stored settings {verifiedAt(winbackAt)}
        {winbackStale ? " · stale" : ""}
      </span>
    </div>
  );
}

function SummaryGrid({
  reconciliation,
  funnelPending,
  reconciliationPending,
}: {
  reconciliation: RetentionReconciliation;
  funnelPending: boolean;
  reconciliationPending: boolean;
}): ReactElement {
  const totals = trustedTotals(reconciliation, reconciliationPending);
  const rate =
    totals && totals.shown > 0 ? totals.accepted / totals.shown : null;
  const note = reconciliationPending
    ? "Reconciling refreshed reads"
    : reconciliation.integrity === "reconciled"
      ? "All matching funnel rows"
      : reconciliation.integrity === "inconsistent"
        ? "Withheld pending reconciliation"
        : funnelPending
          ? "Funnel read in progress"
          : "Funnel read unavailable";
  const cells = [
    {
      label: "Shown",
      value: number(totals?.shown ?? null),
      note,
      tone: "signal",
    },
    {
      label: "Accepted",
      value: number(totals?.accepted ?? null),
      note: "Raw accepted events",
      tone: "positive",
    },
    {
      label: "Declined",
      value: number(totals?.declined ?? null),
      note: "Raw declined events",
      tone: "neutral",
    },
    {
      label: "Expired",
      value: number(totals?.expired ?? null),
      note: "Raw expired events",
      tone: "muted",
    },
    {
      label: "Acceptance",
      value: percent(rate),
      note: "Accepted ÷ shown events",
      tone: "accent",
    },
  ] as const;
  return (
    <section className="rhs-summary" aria-label="All-time event summary">
      {cells.map((cell) => (
        <article key={cell.label} className={`is-${cell.tone}`}>
          <span className="rhs-summary-mark" aria-hidden="true" />
          <span>{cell.label}</span>
          <strong>{cell.value}</strong>
          <small>{cell.note}</small>
        </article>
      ))}
    </section>
  );
}

function IntegrityNotice({
  reconciliation,
  pending,
  reconciling,
  allowAssertive,
  onRetry,
}: {
  reconciliation: RetentionReconciliation;
  pending: boolean;
  reconciling: boolean;
  allowAssertive: boolean;
  onRetry: () => void;
}): ReactElement | null {
  if (reconciling) {
    return (
      <section
        className="rhs-integrity is-unknown"
        aria-labelledby="rhs-integrity-title"
      >
        <span className="rhs-integrity-icon" aria-hidden="true">
          <Icon name="clock" size={18} />
        </span>
        <div role="status">
          <span>Pair reconciliation</span>
          <h2 id="rhs-integrity-title">
            Offer and funnel refreshes are being reconciled.
          </h2>
          <p>
            Previous joins and aggregate claims are withheld until both
            independent reads finish the same refresh attempt.
          </p>
        </div>
      </section>
    );
  }
  if (reconciliation.integrity === "reconciled") return null;
  const unavailable = reconciliation.integrity === "unavailable";
  const reading = unavailable && pending;
  const issues = anomalyCount(reconciliation);
  const diagnostics = [
    {
      key: "missing",
      label: "Missing funnel tiles",
      ids: reconciliation.missingTileOfferIds,
    },
    {
      key: "duplicate",
      label: "Duplicate funnel tiles",
      ids: reconciliation.duplicateTileOfferIds,
    },
    {
      key: "orphan",
      label: "Orphan funnel tiles",
      ids: reconciliation.orphanTileOfferIds,
    },
    {
      key: "tier",
      label: "Tier mismatches",
      ids: reconciliation.tierMismatchOfferIds,
    },
    {
      key: "outcome",
      label: "Outcomes exceed shown",
      ids: reconciliation.outcomeExcessOfferIds,
    },
  ].filter((diagnostic) => diagnostic.ids.length > 0);
  return (
    <section
      className={`rhs-integrity ${unavailable ? "is-unknown" : "is-attention"}`}
      aria-labelledby="rhs-integrity-title"
    >
      <span className="rhs-integrity-icon" aria-hidden="true">
        <Icon name={unavailable ? "eye-off" : "alert-triangle"} size={18} />
      </span>
      <div role={reading || !allowAssertive ? "status" : "alert"}>
        <span>{unavailable ? "Funnel unknown" : "Integrity review"}</span>
        <h2 id="rhs-integrity-title">
          {unavailable
            ? reading
              ? "Offer records are ready; funnel counters are still loading."
              : "Offer records remain visible; outcome totals do not."
            : `${issues.toLocaleString()} reconciliation ${
                issues === 1 ? "issue blocks" : "issues block"
              } aggregate claims.`}
        </h2>
        <p>
          {unavailable
            ? reading
              ? "No zero or rate is asserted while the independent funnel read is in progress."
              : "The funnel request did not produce verified data. Dashes mean unknown, never zero."
            : "Missing, duplicate, orphaned, tier-mismatched, or outcome-count-conflicting rows are contained instead of folded into a rate."}
        </p>
      </div>
      {reading ? null : (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry paired reads
        </button>
      )}
      {unavailable ? null : (
        <div
          className="rhs-integrity-breakdown"
          aria-label="Reconciliation issue index"
        >
          <span>Issue index</span>
          <div>
            {diagnostics.map((diagnostic) => (
              <details key={diagnostic.key}>
                <summary>
                  <strong>{diagnostic.label}</strong>
                  <span>{diagnostic.ids.length.toLocaleString()}</span>
                </summary>
                <ul>
                  {diagnostic.ids.slice(0, 5).map((id) => (
                    <li key={id}>
                      <code>{id}</code>
                    </li>
                  ))}
                </ul>
                {diagnostic.ids.length > 5 ? (
                  <p>
                    {(diagnostic.ids.length - 5).toLocaleString()} additional
                    references are omitted from this bounded preview.
                  </p>
                ) : null}
              </details>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function ObservationGrid({
  reconciliation,
  reconciliationPending,
}: {
  reconciliation: RetentionReconciliation;
  reconciliationPending: boolean;
}): ReactElement {
  const offers = reconciliation.rows.map((row) => row.offer);
  const active = offers.filter((offer) => offer.active);
  const fixed = offers.filter((offer) => offer.discount.kind === "fixed");
  const activeWithoutCoupon = active.filter(
    (offer) => !offer.providerCouponPresent,
  );
  const totals = trustedTotals(reconciliation, reconciliationPending);
  const observations = [
    {
      icon: "clock" as const,
      label: "Coverage",
      value: reconciliationPending
        ? "Refresh reconciliation in progress"
        : reconciliation.integrity === "reconciled"
          ? `${reconciliation.rows.length.toLocaleString()} of ${reconciliation.rows.length.toLocaleString()} offers matched`
          : "Aggregate coverage is not complete",
      detail:
        "The funnel is an all-time event rollup with no server-provided reporting window.",
    },
    {
      icon: "key" as const,
      label: "Provider references",
      value:
        active.length === 0
          ? "No active rows to inspect"
          : activeWithoutCoupon.length === 0
            ? "Reference present on each active row"
            : `${activeWithoutCoupon.length.toLocaleString()} active ${
                activeWithoutCoupon.length === 1 ? "row lacks" : "rows lack"
              } a reference`,
      detail:
        "Reference presence does not prove the coupon exists, matches currency, or can be applied.",
    },
    {
      icon: "alert-triangle" as const,
      label: "Currency boundary",
      value:
        fixed.length === 0
          ? "No fixed-amount rows"
          : `${fixed.length.toLocaleString()} fixed ${
              fixed.length === 1 ? "row has" : "rows have"
            } no stored currency`,
      detail:
        "Fixed amounts are displayed without a symbol so the interface never guesses USD.",
    },
    {
      icon: "users" as const,
      label: "People boundary",
      value:
        totals === null
          ? "Outcome identity unknown"
          : `${totals.accepted.toLocaleString()} accepted events, not verified people`,
      detail:
        "The rollup does not establish unique members, subject identity, or event deduplication.",
    },
  ];
  return (
    <section
      className="rhs-observations"
      aria-labelledby="rhs-observations-title"
    >
      <div className="rhs-section-heading">
        <div>
          <span>Operator notes</span>
          <h2 id="rhs-observations-title">
            Read the caveat beside the signal.
          </h2>
        </div>
        <p>Every observation is constrained to data available on this route.</p>
      </div>
      <div className="rhs-observation-grid">
        {observations.map((item) => (
          <article key={item.label}>
            <span className="rhs-observation-icon" aria-hidden="true">
              <Icon name={item.icon} size={17} />
            </span>
            <div>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <p>{item.detail}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function OverviewPanel({
  reconciliation,
  funnelPending,
  reconciliationPending,
  allowIntegrityAlert,
  onRetryFunnel,
}: {
  reconciliation: RetentionReconciliation;
  funnelPending: boolean;
  reconciliationPending: boolean;
  allowIntegrityAlert: boolean;
  onRetryFunnel: () => void;
}): ReactElement {
  return (
    <div className="rhs-panel-stack">
      <SummaryGrid
        reconciliation={reconciliation}
        funnelPending={funnelPending}
        reconciliationPending={reconciliationPending}
      />
      <IntegrityNotice
        reconciliation={reconciliation}
        pending={funnelPending}
        reconciling={reconciliationPending}
        allowAssertive={allowIntegrityAlert}
        onRetry={onRetryFunnel}
      />
      <ObservationGrid
        reconciliation={reconciliation}
        reconciliationPending={reconciliationPending}
      />
      <section
        className="rhs-definition"
        aria-labelledby="rhs-definition-title"
      >
        <span className="rhs-definition-icon" aria-hidden="true">
          <Icon name="shield-check" size={19} />
        </span>
        <div>
          <span>Metric definition</span>
          <h2 id="rhs-definition-title">Acceptance is a raw event ratio.</h2>
          <p>
            The interface derives accepted ÷ shown from reconciled integer
            counters. It does not use the server&apos;s floating-point rate and
            does not call events people, conversions, or recovered revenue.
          </p>
        </div>
      </section>
    </div>
  );
}

function rowEvidence(
  row: RetentionOfferHistoryRow,
  reconciliationPending = false,
): {
  label: string;
  tone: string;
} {
  if (reconciliationPending) {
    return { label: "Reconciling", tone: "unknown" };
  }
  switch (row.funnelState) {
    case "matched":
      return { label: "Reconciled", tone: "good" };
    case "outcome-excess":
      return { label: "Outcome conflict", tone: "attention" };
    case "duplicate":
      return { label: "Duplicate", tone: "attention" };
    case "tier-mismatch":
      return { label: "Tier mismatch", tone: "attention" };
    case "missing":
      return { label: "Missing tile", tone: "unknown" };
    case "unavailable":
      return { label: "Unknown", tone: "unknown" };
  }
}

function tierLabel(
  row: RetentionOfferHistoryRow,
  catalogueAvailable: boolean,
  catalogueStale: boolean,
): string {
  if (row.tierName) return row.tierName;
  const reference = `Tier ${compactReference(row.offer.tierId)}`;
  if (!catalogueAvailable) return reference;
  return `${reference} · absent from ${
    catalogueStale ? "last verified" : "verified"
  } catalogue`;
}

function HistoryControls({
  query,
  status,
  discount,
  evidence,
  sort,
  resultCount,
  refreshing,
  supportingState,
  onQuery,
  onStatus,
  onDiscount,
  onEvidence,
  onSort,
  onRefresh,
}: {
  query: string;
  status: RetentionStatusFilter;
  discount: RetentionDiscountFilter;
  evidence: RetentionEvidenceFilter;
  sort: RetentionHistorySort;
  resultCount: number | null;
  refreshing: boolean;
  supportingState: SupportingResultState;
  onQuery: (value: string) => void;
  onStatus: (value: RetentionStatusFilter) => void;
  onDiscount: (value: RetentionDiscountFilter) => void;
  onEvidence: (value: RetentionEvidenceFilter) => void;
  onSort: (value: RetentionHistorySort) => void;
  onRefresh: () => void;
}): ReactElement {
  const [draftQuery, setDraftQuery] = useState(query);
  const searchId = useId();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const restoreSearchFocusRef = useRef(false);

  useEffect(() => {
    setDraftQuery(query);
  }, [query]);

  useLayoutEffect(() => {
    if (!restoreSearchFocusRef.current || draftQuery.length > 0) return;
    restoreSearchFocusRef.current = false;
    searchInputRef.current?.focus({ preventScroll: true });
  }, [draftQuery]);

  const updateQuery = (rawValue: string): void => {
    const nextValue = rawValue.replace(/^\s+/u, "");
    setDraftQuery(nextValue);
    if (nextValue.length === 0 || !/\s$/u.test(nextValue)) {
      onQuery(nextValue);
    }
  };

  const commitQuery = (): void => {
    const nextValue = draftQuery.trim();
    setDraftQuery(nextValue);
    if (nextValue !== query) onQuery(nextValue);
  };

  return (
    <section className="rhs-controls" aria-label="Offer history controls">
      <div className="rhs-search">
        <label htmlFor={searchId}>Search retained offers</label>
        <span className="rhs-search-field">
          <Icon name="eye" size={15} />
          <input
            ref={searchInputRef}
            id={searchId}
            type="search"
            value={draftQuery}
            maxLength={256}
            onBlur={commitQuery}
            onChange={(event) => updateQuery(event.target.value)}
            placeholder="Tier, offer ID, headline, state, or amount"
          />
          {draftQuery ? (
            <button
              type="button"
              onClick={() => {
                restoreSearchFocusRef.current = true;
                updateQuery("");
              }}
              aria-label="Clear offer search"
            >
              <Icon name="x" size={13} />
            </button>
          ) : null}
        </span>
      </div>
      <div className="rhs-control-selects">
        <label>
          <span>Stored state</span>
          <select
            value={status}
            onChange={(event) =>
              onStatus(event.target.value as RetentionStatusFilter)
            }
          >
            <option value="all">All states</option>
            <option value="active">Active records</option>
            <option value="inactive">Inactive records</option>
          </select>
        </label>
        <label>
          <span>Discount</span>
          <select
            value={discount}
            onChange={(event) =>
              onDiscount(event.target.value as RetentionDiscountFilter)
            }
          >
            <option value="all">All discounts</option>
            <option value="percent">Percent</option>
            <option value="fixed">Fixed amount</option>
          </select>
        </label>
        <label>
          <span>Evidence</span>
          <select
            value={evidence}
            onChange={(event) =>
              onEvidence(event.target.value as RetentionEvidenceFilter)
            }
          >
            <option value="all">All evidence</option>
            <option value="measured">Measured</option>
            <option value="zero">Zero shown</option>
            <option value="unknown">Unknown or missing</option>
            <option value="anomaly">Row reconciliation issues</option>
          </select>
        </label>
        <label>
          <span>Order</span>
          <select
            value={sort}
            onChange={(event) =>
              onSort(event.target.value as RetentionHistorySort)
            }
          >
            <option value="newest">Newest recorded</option>
            <option value="oldest">Oldest recorded</option>
            <option value="updated-desc">Recently updated</option>
            <option value="tier-asc">Tier A–Z</option>
            <option value="shown-desc">Most shown</option>
            <option value="accepted-desc">Most accepted</option>
          </select>
        </label>
      </div>
      <div className="rhs-controls-meta" role="status">
        <span>
          {resultCount === null
            ? supportingState === "unavailable"
              ? "Supporting results unavailable"
              : "Supporting results pending"
            : `${resultCount.toLocaleString()} matching ${
                resultCount === 1 ? "offer" : "offers"
              }`}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <Icon name="clock" size={14} />
          {refreshing ? "Refreshing…" : "Refresh records"}
        </button>
      </div>
      {supportingState === "pending" ? (
        <p className="rhs-controls-phase" role="status">
          Evidence counters or tier names needed by these controls are still
          loading. Results and metric order will settle before the table is
          shown.
        </p>
      ) : supportingState === "unavailable" ? (
        <p className="rhs-controls-phase" role="status">
          A selected tier-name, evidence, or metric-order control depends on a
          read that could not be verified. Results are withheld until that read
          succeeds; change the dependent control or retry the disclosed source.
        </p>
      ) : evidence === "anomaly" ? (
        <p className="rhs-controls-phase">
          This filter covers offer-row reconciliation issues. Orphan funnel
          tiles have no offer row and remain indexed in Overview.
        </p>
      ) : null}
    </section>
  );
}

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- A labelled,
   focusable overflow region is the WCAG keyboard path for the table between
   the desktop and card-layout breakpoints. */
function OfferHistoryTable({
  rows,
  offset,
  offersStale,
  reconciliationPending,
  supportingState,
  tierCatalogueAvailable,
  tierCatalogueStale,
  scrollable,
  onOffset,
  onOpen,
}: {
  rows: readonly RetentionOfferHistoryRow[];
  offset: number;
  offersStale: boolean;
  reconciliationPending: boolean;
  supportingState: SupportingResultState;
  tierCatalogueAvailable: boolean;
  tierCatalogueStale: boolean;
  scrollable: boolean;
  onOffset: (value: number) => void;
  onOpen: (row: RetentionOfferHistoryRow, invoker: HTMLElement) => void;
}): ReactElement {
  const page = rows.slice(offset, offset + RETENTION_HISTORY_PAGE_SIZE);
  const pageNumber = Math.floor(offset / RETENTION_HISTORY_PAGE_SIZE) + 1;
  const pageCount = Math.max(
    1,
    Math.ceil(rows.length / RETENTION_HISTORY_PAGE_SIZE),
  );
  return (
    <section className="rhs-history-card" aria-labelledby="rhs-history-title">
      <div className="rhs-section-heading rhs-history-heading">
        <div>
          <span>
            {offersStale
              ? "Last verified per-tier rows"
              : "Current per-tier rows"}
          </span>
          <h2 id="rhs-history-title">Stored offers and recorded outcomes</h2>
        </div>
        <p>Open a row for copy, dates, full counters, and evidence gaps.</p>
      </div>
      {supportingState === "pending" ? (
        <div className="rhs-filter-empty" role="status" aria-busy="true">
          <span aria-hidden="true">
            <Icon name="clock" size={22} />
          </span>
          <h3>Supporting evidence is still loading.</h3>
          <p>
            The selected tier-name, evidence, or metric-order control will be
            applied only after its independent read settles.
          </p>
        </div>
      ) : supportingState === "unavailable" ? (
        <div className="rhs-filter-empty" role="status">
          <span aria-hidden="true">
            <Icon name="alert-triangle" size={22} />
          </span>
          <h3>Supporting results are unavailable.</h3>
          <p>
            This control depends on tier names or funnel evidence that could not
            be verified. No empty-result claim or metric order is shown.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="rhs-filter-empty">
          <span aria-hidden="true">
            <Icon name="eye-off" size={22} />
          </span>
          <h3>No offer matches these controls.</h3>
          <p>
            Change the search or filters. The underlying stored response has not
            been changed.
          </p>
        </div>
      ) : (
        <>
          <div
            className="rhs-table-wrap"
            role="region"
            aria-label={
              scrollable
                ? "Scrollable retention offer table"
                : "Retention offer cards"
            }
            tabIndex={scrollable ? 0 : undefined}
          >
            <table>
              <caption>
                {offersStale
                  ? "Last verified retention offer rows."
                  : "Current retention offer rows."}{" "}
                Terms may have been overwritten. All counts are raw, all-time
                stored events.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Offer</th>
                  <th scope="col">Terms</th>
                  <th scope="col">Stored state</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Shown</th>
                  <th scope="col">Accepted</th>
                  <th scope="col">Evidence</th>
                  <th scope="col">
                    <span className="visually-hidden">Inspect</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.map((row) => {
                  const discount = retentionDiscountPresentation(row.offer);
                  const evidence = rowEvidence(row, reconciliationPending);
                  const trusted =
                    !reconciliationPending && row.funnelState === "matched"
                      ? row.funnel
                      : null;
                  const resolvedTierLabel = tierLabel(
                    row,
                    tierCatalogueAvailable,
                    tierCatalogueStale,
                  );
                  return (
                    <tr key={row.offer.id}>
                      <th scope="row" data-label="Offer">
                        <strong>
                          {row.offer.headline ?? "Untitled retained offer"}
                        </strong>
                        <small>{resolvedTierLabel}</small>
                      </th>
                      <td data-label="Terms">
                        <span aria-label={discount.spokenLabel}>
                          {discount.label}
                        </span>
                        <small>
                          {row.offer.durationMonths}{" "}
                          {row.offer.durationMonths === 1 ? "month" : "months"}
                          {!discount.currencyKnown
                            ? " · currency not stored"
                            : ""}
                        </small>
                      </td>
                      <td data-label="Stored state">
                        <span
                          className={`rhs-record-state ${
                            row.offer.active ? "is-active" : "is-inactive"
                          }`}
                        >
                          <i aria-hidden="true" />
                          {row.offer.active
                            ? "Marked active"
                            : "Marked inactive"}
                        </span>
                      </td>
                      <td data-label="Updated">
                        <time dateTime={row.offer.updatedAt}>
                          {fmtDateTime(row.offer.updatedAt)}
                        </time>
                        <small>
                          Created {fmtDateTime(row.offer.createdAt)}
                        </small>
                      </td>
                      <td data-label="Shown">
                        {trusted ? trusted.shown.toLocaleString() : "—"}
                      </td>
                      <td data-label="Accepted">
                        {trusted ? trusted.accepted.toLocaleString() : "—"}
                        {trusted && acceptanceRateOf(trusted) !== null ? (
                          <small>
                            {percent(acceptanceRateOf(trusted))} of shown
                          </small>
                        ) : null}
                      </td>
                      <td data-label="Evidence">
                        <span
                          className={`rhs-evidence-state is-${evidence.tone}`}
                        >
                          <i aria-hidden="true" />
                          {evidence.label}
                        </span>
                      </td>
                      <td data-label="Inspect">
                        <button
                          type="button"
                          className="rhs-row-open"
                          onClick={(event) => {
                            onOpen(row, event.currentTarget);
                          }}
                          aria-label={`Inspect ${row.offer.headline ?? "untitled offer"} for ${resolvedTierLabel}`}
                        >
                          Inspect
                          <Icon name="chevron-right" size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="rhs-print-context">
            Printed page {pageNumber.toLocaleString()} of{" "}
            {pageCount.toLocaleString()}. This output contains{" "}
            {page.length.toLocaleString()} of {rows.length.toLocaleString()}{" "}
            matching offer rows; active URL search and filters may apply.
          </p>
          <nav className="rhs-pagination" aria-label="Offer history pages">
            <span role="status" aria-live="polite">
              Page {pageNumber.toLocaleString()} of {pageCount.toLocaleString()}
            </span>
            <div>
              <button
                type="button"
                className="btn btn-sm"
                disabled={offset === 0}
                onClick={() =>
                  onOffset(Math.max(0, offset - RETENTION_HISTORY_PAGE_SIZE))
                }
              >
                <Icon name="chevron-left" size={14} />
                Previous
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={offset + RETENTION_HISTORY_PAGE_SIZE >= rows.length}
                onClick={() => onOffset(offset + RETENTION_HISTORY_PAGE_SIZE)}
              >
                Next
                <Icon name="chevron-right" size={14} />
              </button>
            </div>
          </nav>
        </>
      )}
    </section>
  );
}
/* eslint-enable jsx-a11y/no-noninteractive-tabindex */

function InitialHistoryState(): ReactElement {
  return (
    <section
      className="rhs-initial"
      aria-busy="true"
      aria-labelledby="rhs-initial-title"
    >
      <div>
        <span className="rhs-skeleton rhs-skeleton-kicker" />
        <span className="rhs-skeleton rhs-skeleton-title" />
        <span className="rhs-skeleton rhs-skeleton-copy" />
      </div>
      <div className="rhs-skeleton-grid">
        {Array.from({ length: 5 }, (_, index) => (
          <span className="rhs-skeleton" key={index} />
        ))}
      </div>
      <p id="rhs-initial-title" className="visually-hidden">
        Loading retention history
      </p>
    </section>
  );
}

function HistoryUnavailable({
  accessDenied,
  message,
  onRetry,
}: {
  accessDenied: boolean;
  message: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <section
      className="rhs-unavailable"
      role="alert"
      aria-labelledby="rhs-unavailable-title"
    >
      <span className="rhs-unavailable-icon" aria-hidden="true">
        <Icon name={accessDenied ? "lock" : "alert-triangle"} size={23} />
      </span>
      <div>
        <span>
          {accessDenied ? "Admin access required" : "History unavailable"}
        </span>
        <h2 id="rhs-unavailable-title">
          {accessDenied
            ? "No retention data was loaded for this role."
            : "The stored offer-row response could not be verified."}
        </h2>
        <p>{message}</p>
      </div>
      <button type="button" className="btn" onClick={onRetry}>
        Check again
      </button>
    </section>
  );
}

function TrueEmptyState({
  stale,
  refreshing,
  onRefresh,
}: {
  stale: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}): ReactElement {
  return (
    <section className="rhs-empty" aria-labelledby="rhs-empty-title">
      <span className="rhs-empty-icon" aria-hidden="true">
        <Icon name="clock" size={24} />
      </span>
      <span>
        {stale ? "Last verified empty response" : "Valid empty response"}
      </span>
      <h2 id="rhs-empty-title">
        {stale
          ? "No offer rows were present in the last verified response."
          : "No current stored offer rows were returned."}
      </h2>
      <p>
        {stale
          ? "The most recent refresh failed, so this empty collection is retained only as last-verified evidence."
          : "This means the admin read returned a valid, empty collection."}{" "}
        It does not imply that authoring is available in this release.
      </p>
      <button
        type="button"
        className="btn btn-sm"
        onClick={onRefresh}
        disabled={refreshing}
      >
        <Icon name="clock" size={14} />
        {refreshing ? "Refreshing…" : "Refresh records"}
      </button>
    </section>
  );
}

function useRetentionHistoryWorkspaceModel() {
  const me = useMe();
  const tenantId = me?.tenant ?? null;
  const tenantIdentity = tenantId ?? "unresolved";
  const tenantResolved = tenantId !== null;
  const compactLayout = useCompactRetentionLayout();
  const [criticalPairSnapshot, setCriticalPairSnapshot] =
    useState<CriticalPairSnapshot | null>(null);
  const criticalPairAttemptRef = useRef(0);
  const identityCycleRef = useRef({ identity: tenantIdentity, epoch: 0 });
  if (identityCycleRef.current.identity !== tenantIdentity) {
    identityCycleRef.current = {
      identity: tenantIdentity,
      epoch: identityCycleRef.current.epoch + 1,
    };
    criticalPairAttemptRef.current += 1;
  }
  const criticalPairScope = `${tenantIdentity}:${identityCycleRef.current.epoch}`;
  const tenantIdentityRef = useRef(tenantIdentity);
  tenantIdentityRef.current = tenantIdentity;

  useEffect(() => {
    criticalPairAttemptRef.current += 1;
    setCriticalPairSnapshot(null);
  }, [criticalPairScope]);
  const offers = useRemoteResource(
    () =>
      tenantId === null
        ? Promise.resolve({
            error: {
              kind: "invalid_config" as const,
              code: "workspace_unresolved",
            },
          })
        : loadRetentionOffers(tenantId),
    {
      identity: `retention:offers:${tenantIdentity}`,
      auto: tenantResolved,
    },
  );
  const funnel = useRemoteResource(loadRetentionFunnel, {
    identity: `retention:funnel:${tenantIdentity}`,
    auto: tenantResolved,
  });
  const tiers = useRemoteResource(loadRetentionTiers, {
    identity: `retention:tiers:${tenantIdentity}`,
    auto: tenantResolved,
  });
  const winback = useRemoteResource(loadRetentionWinbackSettings, {
    identity: `retention:settings:${tenantIdentity}`,
    auto: tenantResolved,
  });

  const visibleCriticalPair =
    criticalPairSnapshot?.scope === criticalPairScope
      ? criticalPairSnapshot
      : null;
  const reconciliationOffers =
    visibleCriticalPair?.phase === "verified"
      ? visibleCriticalPair.offers.items
      : (offers.data?.items ?? []);
  const reconciliationFunnel =
    visibleCriticalPair === null
      ? (funnel.data?.items ?? null)
      : visibleCriticalPair.phase === "verified"
        ? visibleCriticalPair.funnel.items
        : null;
  const reconciliation = useMemo(
    () =>
      reconcileRetentionHistory(
        reconciliationOffers,
        reconciliationFunnel,
        tiers.data?.items ?? [],
      ),
    [reconciliationFunnel, reconciliationOffers, tiers.data],
  );
  const criticalPairRefreshing = visibleCriticalPair?.phase === "refreshing";
  const activeOffers = reconciliation.rows.filter(
    (row) => row.offer.active,
  ).length;
  const refreshing =
    criticalPairRefreshing ||
    offers.transport === "loading" ||
    funnel.transport === "loading" ||
    tiers.transport === "loading" ||
    winback.transport === "loading";
  const refreshNeedsAttention = refreshHasFailure(
    [offers, funnel, tiers, winback],
    visibleCriticalPair?.phase ?? null,
  );
  const initialLoading =
    offers.data === null &&
    (offers.transport === "loading" || offers.transport === "idle");
  const funnelPending =
    criticalPairRefreshing ||
    (funnel.data === null &&
      (funnel.transport === "loading" || funnel.transport === "idle"));
  const winbackPending =
    winback.data === null &&
    (winback.transport === "loading" || winback.transport === "idle");
  const offerUnavailable = offers.data === null && offers.transport === "error";
  const routeState = useRetentionHistoryRoute({
    rows: reconciliation.rows,
    rowsReady: offers.data !== null,
    rowsStale: offers.stale,
    identityScope: tenantIdentity,
  });
  const { tab, query, status, discount, evidence, sort, page } =
    routeState.view;
  const deferredQuery = useDeferredValue(query);
  const queryNeedsTierCatalogue = deferredQuery.trim().length > 0;
  const sortNeedsTierCatalogue = sort === "tier-asc";
  const filterNeedsFunnel = evidence !== "all";
  const sortNeedsFunnel = sort === "shown-desc" || sort === "accepted-desc";
  const supportingResultsPending =
    ((queryNeedsTierCatalogue || sortNeedsTierCatalogue) &&
      tiers.transport === "loading") ||
    ((filterNeedsFunnel || sortNeedsFunnel) && funnelPending);
  const supportingResultsUnavailable =
    ((queryNeedsTierCatalogue || sortNeedsTierCatalogue) &&
      tiers.data === null &&
      tiers.transport === "error") ||
    ((filterNeedsFunnel || sortNeedsFunnel) &&
      !funnelPending &&
      reconciliationFunnel === null);
  const supportingResultState: SupportingResultState = supportingResultsPending
    ? "pending"
    : supportingResultsUnavailable
      ? "unavailable"
      : "ready";
  const tierCatalogueAvailable = tiers.data !== null;
  const missingCatalogueOfferIds = useMemo(
    () =>
      tierCatalogueAvailable
        ? reconciliation.rows
            .filter((row) => row.tierName === null)
            .map((row) => row.offer.id)
        : [],
    [reconciliation.rows, tierCatalogueAvailable],
  );
  const tabs = useTabsInteraction({
    activation: "manual",
    orientation: compactLayout ? "vertical" : "horizontal",
    value: tab,
    items: TABS.map((item) => ({ value: item.id })),
    onChange: routeState.setTab,
  });

  const filteredRows = useMemo(
    () =>
      filterAndSortRetentionRows(reconciliation.rows, {
        query: deferredQuery,
        status,
        discount,
        evidence,
        sort,
      }),
    [deferredQuery, discount, evidence, reconciliation.rows, sort, status],
  );
  const pageCount = Math.max(
    1,
    Math.ceil(filteredRows.length / RETENTION_HISTORY_PAGE_SIZE),
  );
  const offset = (page - 1) * RETENTION_HISTORY_PAGE_SIZE;
  const facts = useMemo(
    () =>
      retentionReadinessFacts({
        reconciliation,
        offersAvailable: offers.data !== null,
        offersPending: initialLoading,
        offersStale: offers.stale,
        funnelPending,
        winback: winback.data,
        winbackPending,
      }),
    [
      funnelPending,
      initialLoading,
      offers.data,
      offers.stale,
      reconciliation,
      winback.data,
      winbackPending,
    ],
  );
  useEffect(() => {
    if (
      offers.data !== null &&
      deferredQuery === query &&
      supportingResultState === "ready" &&
      page > pageCount
    ) {
      routeState.replacePage(pageCount);
    }
  }, [
    deferredQuery,
    offers.data,
    page,
    pageCount,
    query,
    routeState.replacePage,
    supportingResultState,
  ]);

  const refreshCriticalPair = async (): Promise<void> => {
    const identity = tenantIdentity;
    const scope = criticalPairScope;
    const attempt = ++criticalPairAttemptRef.current;
    setCriticalPairSnapshot({ scope, phase: "refreshing" });
    const [offerResult, funnelResult] = await Promise.all([
      offers.reloadResult(),
      funnel.reloadResult(),
    ]);
    if (
      criticalPairAttemptRef.current !== attempt ||
      tenantIdentityRef.current !== identity ||
      identityCycleRef.current.identity !== identity ||
      `${identity}:${identityCycleRef.current.epoch}` !== scope
    ) {
      return;
    }
    if (offerResult?.data !== undefined && funnelResult?.data !== undefined) {
      setCriticalPairSnapshot({
        scope,
        phase: "verified",
        offers: offerResult.data,
        funnel: funnelResult.data,
      });
      return;
    }
    setCriticalPairSnapshot({ scope, phase: "untrusted" });
  };

  const refreshAll = (): void => {
    void Promise.all([refreshCriticalPair(), tiers.reload(), winback.reload()]);
  };

  return {
    activeOffers,
    compactLayout,
    criticalPairRefreshing,
    discount,
    evidence,
    facts,
    filteredRows,
    funnel,
    funnelPending,
    initialLoading,
    missingCatalogueOfferIds,
    offerUnavailable,
    offers,
    offset,
    query,
    reconciliation,
    refreshAll,
    refreshCriticalPair,
    refreshNeedsAttention,
    refreshing,
    routeState,
    sort,
    status,
    supportingResultState,
    tab,
    tabs,
    tierCatalogueAvailable,
    tiers,
    visibleCriticalPair,
    winback,
  };
}

function EvidenceBoundaryStrip(): ReactElement {
  return (
    <div className="rhs-boundary-strip">
      <span>
        <Icon name="clock" size={15} />
        Counts are event rows, not unique customers.
      </span>
      <span>
        <Icon name="users" size={15} />
        No reporting window or fixed-amount currency is exposed.
      </span>
      <span>
        <Icon name="lock" size={15} />
        “Marked active” does not prove an offer was shown.
      </span>
      <span>
        <Icon name="alert-triangle" size={15} />
        Stored offer terms can be overwritten; this is not an append-only
        archive.
      </span>
    </div>
  );
}

export function RetentionHistoryWorkspace(): ReactElement {
  const model = useRetentionHistoryWorkspaceModel();

  return (
    <div className="page rhs-page">
      <Hero
        reconciliation={model.reconciliation}
        activeOffers={model.activeOffers}
        offersAvailable={model.offers.data !== null}
        offersStale={model.offers.stale}
        funnelPending={model.funnelPending}
        loading={model.initialLoading}
        lastVerifiedAt={model.offers.lastVerifiedAt}
        reconciliationPending={model.criticalPairRefreshing}
      />

      <EvidenceBoundaryStrip />

      <ProvenanceBand
        offersAt={model.offers.lastVerifiedAt}
        funnelAt={model.funnel.lastVerifiedAt}
        tiersAt={model.tiers.lastVerifiedAt}
        winbackAt={model.winback.lastVerifiedAt}
        offersStale={model.offers.stale}
        funnelStale={model.funnel.stale}
        tiersStale={model.tiers.stale}
        winbackStale={model.winback.stale}
        refreshing={model.refreshing}
      />

      {model.refreshNeedsAttention ? (
        <section className="rhs-support-notice is-attention" role="alert">
          <Icon name="alert-triangle" size={16} />
          <span>
            <strong>Refresh incomplete.</strong> One or more reads could not be
            verified. Last-verified evidence and every affected claim are
            labelled below.
          </span>
          <button
            type="button"
            onClick={model.refreshAll}
            disabled={model.refreshing}
          >
            {model.refreshing ? "Retrying…" : "Retry incomplete refresh"}
          </button>
        </section>
      ) : null}

      {model.offers.stale && model.offers.failure ? (
        <section className="rhs-stale">
          <div>
            <strong>Using the last verified offer-row response.</strong>
            <span>{model.offers.failure.message}</span>
          </div>
        </section>
      ) : null}

      {model.funnel.stale && model.funnel.failure ? (
        <section className="rhs-support-notice is-stale">
          <Icon name="alert-triangle" size={16} />
          <span>
            <strong>Funnel refresh failed.</strong> Its last verified response
            from {verifiedAt(model.funnel.lastVerifiedAt)} is retained, but
            joined metrics remain withheld until offer and funnel reads verify
            together.
          </span>
        </section>
      ) : null}

      {model.tiers.stale && model.tiers.failure ? (
        <section className="rhs-support-notice is-stale">
          <Icon name="alert-triangle" size={16} />
          <span>
            <strong>Tier-name refresh failed.</strong> Labels use the last
            verified response from {verifiedAt(model.tiers.lastVerifiedAt)};
            opaque tier IDs remain canonical.
          </span>
        </section>
      ) : null}

      {model.winback.stale && model.winback.failure ? (
        <section className="rhs-support-notice is-stale">
          <Icon name="alert-triangle" size={16} />
          <span>
            <strong>Stored-setting refresh failed.</strong> Readiness uses the
            last verified response from{" "}
            {verifiedAt(model.winback.lastVerifiedAt)}; runtime delivery remains
            unverified.
          </span>
        </section>
      ) : null}

      {model.visibleCriticalPair?.phase === "untrusted" ? (
        <section className="rhs-support-notice is-attention">
          <Icon name="alert-triangle" size={16} />
          <span>
            <strong>Paired refresh incomplete.</strong> Offer rows remain
            inspectable, but funnel joins, row evidence, totals, and rates are
            unknown until both critical reads verify in one refresh attempt.
          </span>
        </section>
      ) : null}

      {model.tiers.transport === "error" && model.tiers.data === null ? (
        <section className="rhs-support-notice" role="status">
          <Icon name="alert-triangle" size={16} />
          <span>
            Tier names are unavailable. Opaque tier references remain visible
            without blocking offer history.
          </span>
          <button type="button" onClick={() => void model.tiers.reload()}>
            Retry names
          </button>
        </section>
      ) : null}

      {model.missingCatalogueOfferIds.length > 0 ? (
        <section className="rhs-support-notice is-attention" role="status">
          <Icon name="alert-triangle" size={16} />
          <span>
            <strong>Verified tier-catalogue gap.</strong>{" "}
            {model.missingCatalogueOfferIds.length.toLocaleString()} offer{" "}
            {model.missingCatalogueOfferIds.length === 1
              ? "row references"
              : "rows reference"}{" "}
            tier IDs absent from the{" "}
            {model.tiers.stale ? "last verified" : "verified"} catalogue. Opaque
            IDs remain visible and searchable.
          </span>
          <button type="button" onClick={() => void model.tiers.reload()}>
            Retry names
          </button>
        </section>
      ) : null}

      {model.routeState.repairBlocked ? (
        <section className="rhs-support-notice is-attention" role="alert">
          <Icon name="alert-triangle" size={16} />
          <span>
            <strong>Route repair was blocked.</strong> The current URL remains
            uncanonical until its guarded navigation can complete.
          </span>
          <button type="button" onClick={model.routeState.retryBlockedRepair}>
            Retry route repair
          </button>
        </section>
      ) : null}

      <div
        ref={model.tabs.listRef}
        className="rhs-tabs"
        {...model.tabs.listProps}
        aria-label="Retention history views"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            {...model.tabs.getTabProps(item.id)}
            className={model.tab === item.id ? "is-active" : ""}
          >
            <span className="rhs-tab-icon" aria-hidden="true">
              <Icon name={item.icon} size={18} />
            </span>
            <span>
              <small>{item.eyebrow}</small>
              <strong>{item.label}</strong>
              <em>{item.description}</em>
            </span>
            <Icon name="chevron-right" size={16} />
          </button>
        ))}
      </div>

      {TABS.map((item) => (
        <section
          key={item.id}
          {...model.tabs.getPanelProps(item.id)}
          className="rhs-tab-panel"
          data-retention-panel={item.id}
        >
          {model.tab !== item.id ? null : model.initialLoading ? (
            <InitialHistoryState />
          ) : model.offerUnavailable ? (
            <HistoryUnavailable
              accessDenied={model.offers.access === "denied"}
              message={
                model.offers.failure?.message ??
                "The server could not verify the stored offer-row response."
              }
              onRetry={() => void model.refreshCriticalPair()}
            />
          ) : item.id === "readiness" ? (
            <RetentionHistoryReadinessPanel
              facts={model.facts}
              winback={model.winback.data}
              winbackUnavailable={
                model.winback.transport === "error" &&
                model.winback.data === null
              }
              onRetryWinback={() => void model.winback.reload()}
            />
          ) : item.id === "overview" ? (
            model.offers.data?.items.length === 0 ? (
              <div className="rhs-panel-stack">
                <TrueEmptyState
                  stale={model.offers.stale}
                  refreshing={model.refreshing}
                  onRefresh={model.refreshAll}
                />
                <IntegrityNotice
                  reconciliation={model.reconciliation}
                  pending={model.funnelPending}
                  reconciling={model.criticalPairRefreshing}
                  allowAssertive={!model.refreshNeedsAttention}
                  onRetry={() => void model.refreshCriticalPair()}
                />
              </div>
            ) : (
              <OverviewPanel
                reconciliation={model.reconciliation}
                funnelPending={model.funnelPending}
                reconciliationPending={model.criticalPairRefreshing}
                allowIntegrityAlert={!model.refreshNeedsAttention}
                onRetryFunnel={() => void model.refreshCriticalPair()}
              />
            )
          ) : (
            <div className="rhs-panel-stack">
              <HistoryControls
                query={model.query}
                status={model.status}
                discount={model.discount}
                evidence={model.evidence}
                sort={model.sort}
                resultCount={
                  model.supportingResultState === "ready"
                    ? model.filteredRows.length
                    : null
                }
                refreshing={model.refreshing}
                supportingState={model.supportingResultState}
                onQuery={model.routeState.setQuery}
                onStatus={model.routeState.setStatus}
                onDiscount={model.routeState.setDiscount}
                onEvidence={model.routeState.setEvidence}
                onSort={model.routeState.setSort}
                onRefresh={model.refreshAll}
              />
              {model.offers.data?.items.length === 0 ? (
                <TrueEmptyState
                  stale={model.offers.stale}
                  refreshing={model.refreshing}
                  onRefresh={model.refreshAll}
                />
              ) : (
                <OfferHistoryTable
                  rows={model.filteredRows}
                  offset={model.offset}
                  offersStale={model.offers.stale}
                  reconciliationPending={model.criticalPairRefreshing}
                  supportingState={model.supportingResultState}
                  tierCatalogueAvailable={model.tierCatalogueAvailable}
                  tierCatalogueStale={model.tiers.stale}
                  scrollable={!model.compactLayout}
                  onOffset={(nextOffset) =>
                    model.routeState.setPage(
                      Math.floor(nextOffset / RETENTION_HISTORY_PAGE_SIZE) + 1,
                    )
                  }
                  onOpen={model.routeState.openOffer}
                />
              )}
            </div>
          )}
        </section>
      ))}

      <p
        className="visually-hidden"
        data-retention-route-announcement
        role="status"
        aria-live="polite"
      >
        {model.routeState.announcement}
      </p>

      <RetentionOfferDetail
        row={model.routeState.selectedRow}
        open={model.routeState.selectedRow !== null}
        reconciliationPending={model.criticalPairRefreshing}
        tierCatalogueAvailable={model.tierCatalogueAvailable}
        tierCatalogueStale={model.tiers.stale}
        onClose={model.routeState.closeOffer}
        returnFocusRef={model.routeState.returnFocusRef}
      />
    </div>
  );
}
