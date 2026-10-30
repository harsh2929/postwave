import type {
  RetentionOfferHistoryRow,
  RetentionOfferRecord,
  RetentionReconciliation,
  RetentionWinbackSettings,
} from "./retention-offers-contract";

export type RetentionStatusFilter = "all" | "active" | "inactive";
export type RetentionDiscountFilter = "all" | "percent" | "fixed";
export type RetentionEvidenceFilter =
  | "all"
  | "measured"
  | "zero"
  | "unknown"
  | "anomaly";
export type RetentionHistorySort =
  | "newest"
  | "oldest"
  | "updated-desc"
  | "tier-asc"
  | "shown-desc"
  | "accepted-desc";

export interface RetentionHistoryQuery {
  query?: string;
  status?: RetentionStatusFilter;
  discount?: RetentionDiscountFilter;
  evidence?: RetentionEvidenceFilter;
  sort?: RetentionHistorySort;
}

export interface RetentionDiscountPresentation {
  label: string;
  spokenLabel: string;
  currencyKnown: boolean;
}

export type RetentionReadinessState =
  | "observed"
  | "attention"
  | "unknown"
  | "blocked"
  | "not-applicable";

export interface RetentionReadinessFact {
  id:
    | "history-mode"
    | "funnel-integrity"
    | "provider-reference"
    | "fixed-currency"
    | "winback-observation";
  label: string;
  state: RetentionReadinessState;
  detail: string;
  basis: "source-contract" | "response";
}

export interface RetentionReadinessInput {
  reconciliation: RetentionReconciliation;
  offersAvailable: boolean;
  offersPending: boolean;
  offersStale?: boolean;
  funnelPending: boolean;
  winback: RetentionWinbackSettings | null;
  winbackPending: boolean;
}

function normalizedSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US")
    .slice(0, 256);
}

function deterministicText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function metric(row: RetentionOfferHistoryRow, key: "shown" | "accepted") {
  return row.funnelState === "matched" ? (row.funnel?.[key] ?? null) : null;
}

function evidenceMatches(
  row: RetentionOfferHistoryRow,
  evidence: RetentionEvidenceFilter,
): boolean {
  switch (evidence) {
    case "measured":
      return row.funnelState === "matched" && (row.funnel?.shown ?? 0) > 0;
    case "zero":
      return row.funnelState === "matched" && row.funnel?.shown === 0;
    case "unknown":
      return row.funnelState === "unavailable" || row.funnelState === "missing";
    case "anomaly":
      return (
        row.funnelState === "missing" ||
        row.funnelState === "duplicate" ||
        row.funnelState === "tier-mismatch" ||
        row.funnelState === "outcome-excess"
      );
    default:
      return true;
  }
}

export function retentionDiscountPresentation(
  offer: Pick<RetentionOfferRecord, "discount">,
): RetentionDiscountPresentation {
  if (offer.discount.kind === "percent") {
    return {
      label: `${offer.discount.percent}% off`,
      spokenLabel: `${offer.discount.percent} percent off`,
      currencyKnown: true,
    };
  }
  // The wire carries an integer count but no currency or precision. Keep the
  // stored unit literal: dividing by 100 would still invent a two-decimal
  // monetary model even though the UI correctly avoids a dollar symbol.
  const amount = offer.discount.minorUnits.toLocaleString("en-US");
  return {
    label: `${amount} minor units off`,
    spokenLabel: `${amount} minor units off; the record does not identify the billing currency or decimal precision`,
    currencyKnown: false,
  };
}

/**
 * Search only the operational row projection. Tenant IDs, raw provider
 * references cannot accidentally become searchable. Body copy is deliberately
 * omitted from the global query even though detail inspection retains it.
 */
export function retentionRowMatchesQuery(
  row: RetentionOfferHistoryRow,
  rawQuery: string,
): boolean {
  const query = normalizedSearchText(rawQuery);
  if (!query) return true;
  const storedState = row.offer.active ? "active" : "inactive";
  if (query === "active" || query === "inactive") {
    return storedState === query;
  }
  const discount = retentionDiscountPresentation(row.offer).label;
  return [
    row.offer.id,
    row.tierName,
    row.offer.tierId,
    row.offer.headline,
    storedState,
    discount,
  ].some(
    (candidate) =>
      candidate !== null && normalizedSearchText(candidate).includes(query),
  );
}

function compareNewest(
  left: RetentionOfferHistoryRow,
  right: RetentionOfferHistoryRow,
): number {
  const timeDifference =
    Date.parse(right.offer.createdAt) - Date.parse(left.offer.createdAt);
  return timeDifference || compareText(left.offer.id, right.offer.id);
}

function compareOldest(
  left: RetentionOfferHistoryRow,
  right: RetentionOfferHistoryRow,
): number {
  const timeDifference =
    Date.parse(left.offer.createdAt) - Date.parse(right.offer.createdAt);
  return timeDifference || compareText(left.offer.id, right.offer.id);
}

function compareRecentlyUpdated(
  left: RetentionOfferHistoryRow,
  right: RetentionOfferHistoryRow,
): number {
  const timeDifference =
    Date.parse(right.offer.updatedAt) - Date.parse(left.offer.updatedAt);
  return timeDifference || compareNewest(left, right);
}

function compareMetric(
  left: RetentionOfferHistoryRow,
  right: RetentionOfferHistoryRow,
  key: "shown" | "accepted",
): number {
  const leftMetric = metric(left, key);
  const rightMetric = metric(right, key);
  if (leftMetric === null && rightMetric !== null) return 1;
  if (leftMetric !== null && rightMetric === null) return -1;
  if (
    leftMetric !== null &&
    rightMetric !== null &&
    leftMetric !== rightMetric
  ) {
    return rightMetric - leftMetric;
  }
  return compareNewest(left, right);
}

/**
 * Return a new deterministically ordered collection. Every comparator ends in
 * the immutable offer ID, so order does not depend on response arrival order.
 */
export function filterAndSortRetentionRows(
  rows: readonly RetentionOfferHistoryRow[],
  input: RetentionHistoryQuery = {},
): RetentionOfferHistoryRow[] {
  const status = input.status ?? "all";
  const discount = input.discount ?? "all";
  const evidence = input.evidence ?? "all";
  const sort = input.sort ?? "newest";
  const query = input.query ?? "";

  return rows
    .filter((row) => {
      if (status === "active" && !row.offer.active) return false;
      if (status === "inactive" && row.offer.active) return false;
      if (discount !== "all" && row.offer.discount.kind !== discount) {
        return false;
      }
      return (
        evidenceMatches(row, evidence) && retentionRowMatchesQuery(row, query)
      );
    })
    .slice()
    .sort((left, right) => {
      switch (sort) {
        case "oldest":
          return compareOldest(left, right);
        case "updated-desc":
          return compareRecentlyUpdated(left, right);
        case "tier-asc": {
          const tierDifference = compareText(
            deterministicText(left.tierName ?? left.offer.tierId),
            deterministicText(right.tierName ?? right.offer.tierId),
          );
          return tierDifference || compareNewest(left, right);
        }
        case "shown-desc":
          return compareMetric(left, right, "shown");
        case "accepted-desc":
          return compareMetric(left, right, "accepted");
        default:
          return compareNewest(left, right);
      }
    });
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

/**
 * Readiness language is deliberately evidence-scoped. A coupon reference is
 * only a reference-presence observation; it is never promoted into a claim
 * that Stripe, portal delivery, the win-back worker, or reconciliation works.
 */
export function retentionReadinessFacts(
  input: RetentionReadinessInput,
): RetentionReadinessFact[] {
  const {
    funnelPending,
    offersAvailable,
    offersPending,
    offersStale = false,
    reconciliation,
    winback,
    winbackPending,
  } = input;
  const offers = reconciliation.rows.map((row) => row.offer);
  const activeOffers = offers.filter((offer) => offer.active);
  const activeWithoutReference = activeOffers.filter(
    (offer) => !offer.providerCouponPresent,
  ).length;
  const fixedOffers = offers.filter(
    (offer) => offer.discount.kind === "fixed",
  ).length;
  const offerSnapshotLabel = offersStale
    ? "last verified offer rows"
    : "current stored offers";

  const funnelFact: RetentionReadinessFact = !offersAvailable
    ? {
        id: "funnel-integrity",
        label: "Funnel evidence",
        state: "unknown",
        detail: offersPending
          ? "The offer-row response is still loading, so funnel reconciliation is pending."
          : "The offer-row response is unavailable, so funnel rows cannot be reconciled to current stored offers.",
        basis: "response",
      }
    : reconciliation.integrity === "unavailable"
      ? {
          id: "funnel-integrity",
          label: "Funnel evidence",
          state: "unknown",
          detail: funnelPending
            ? "The funnel response is still loading, so no zero or rate is asserted yet."
            : `The funnel response is unavailable, so no zero or rate can be asserted for the ${offerSnapshotLabel}.`,
          basis: "response",
        }
      : reconciliation.integrity === "inconsistent"
        ? {
            id: "funnel-integrity",
            label: "Funnel evidence",
            state: "attention",
            detail: `${anomalyCount(reconciliation)} reconciliation issue${
              anomalyCount(reconciliation) === 1 ? "" : "s"
            } must be resolved before treating the totals as complete.`,
            basis: "response",
          }
        : {
            id: "funnel-integrity",
            label: "Funnel evidence",
            state: "observed",
            detail:
              "Each offer has one matching funnel tile; rates are recomputed from the accepted and shown counts.",
            basis: "response",
          };

  const providerFact: RetentionReadinessFact = !offersAvailable
    ? {
        id: "provider-reference",
        label: "Provider references",
        state: "unknown",
        detail: offersPending
          ? "The offer-row response is still loading, so provider-reference assessment is pending."
          : "The offer-row response is unavailable, so provider-reference presence cannot be assessed.",
        basis: "response",
      }
    : activeOffers.length === 0
      ? {
          id: "provider-reference",
          label: "Provider references",
          state: "not-applicable",
          detail: "There are no active offers to inspect.",
          basis: "response",
        }
      : activeWithoutReference > 0
        ? {
            id: "provider-reference",
            label: "Provider references",
            state: "attention",
            detail: `${activeWithoutReference} active offer${
              activeWithoutReference === 1 ? " has" : "s have"
            } no coupon reference on the retained record.`,
            basis: "response",
          }
        : {
            id: "provider-reference",
            label: "Provider references",
            state: "unknown",
            detail:
              "Every active offer has a coupon reference, but reference presence does not verify provider state or successful application.",
            basis: "response",
          };

  const currencyFact: RetentionReadinessFact = !offersAvailable
    ? {
        id: "fixed-currency",
        label: "Fixed-discount currency",
        state: "unknown",
        detail: offersPending
          ? "The offer-row response is still loading, so fixed-amount currency assessment is pending."
          : "The offer-row response is unavailable, so fixed-amount currency exposure cannot be assessed.",
        basis: "response",
      }
    : fixedOffers === 0
      ? {
          id: "fixed-currency",
          label: "Fixed-discount currency",
          state: "not-applicable",
          detail: `No ${offersStale ? "last verified" : "current stored"} offer row uses a fixed amount.`,
          basis: "response",
        }
      : {
          id: "fixed-currency",
          label: "Fixed-discount currency",
          state: "unknown",
          detail: `${fixedOffers} fixed offer${
            fixedOffers === 1 ? "" : "s"
          } store minor units without a currency; no currency symbol is safe to infer.`,
          basis: "response",
        };

  const winbackFact: RetentionReadinessFact =
    winback === null
      ? {
          id: "winback-observation",
          label: "Win-back settings",
          state: "unknown",
          detail: winbackPending
            ? "Win-back settings are still loading."
            : "Win-back settings are unavailable.",
          basis: "response",
        }
      : !winback.enabled
        ? {
            id: "winback-observation",
            label: "Win-back settings",
            state: "observed",
            detail: "The retained setting reports win-backs disabled.",
            basis: "response",
          }
        : winback.churnProfilesScored === 0
          ? {
              id: "winback-observation",
              label: "Win-back settings",
              state: "attention",
              detail:
                "The stored enabled flag is true, but zero churn profiles are scored. This does not prove a running worker or eligible recipient.",
              basis: "response",
            }
          : {
              id: "winback-observation",
              label: "Win-back settings",
              state: "unknown",
              detail: `${winback.churnProfilesScored.toLocaleString()} churn profiles are scored, but that count does not verify worker startup, eligibility gates, or delivery.`,
              basis: "response",
            };

  return [
    {
      id: "history-mode",
      label: "Production delivery",
      state: "blocked",
      detail: `This surface is limited to strictly decoded ${
        offersStale ? "last verified" : "current"
      } offer rows and all-time event counters. It does not certify authoring, portal acceptance, Stripe application, event authenticity, automated win-backs, or provider reconciliation.`,
      basis: "source-contract",
    },
    funnelFact,
    providerFact,
    currencyFact,
    winbackFact,
  ];
}
