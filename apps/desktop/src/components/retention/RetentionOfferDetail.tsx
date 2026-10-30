import { type ReactElement, type RefObject } from "react";

import { fmtDateTime } from "../../lib/format-date";
import {
  acceptanceRateOf,
  type RetentionOfferHistoryRow,
} from "../../lib/retention-offers-contract";
import { retentionDiscountPresentation } from "../../lib/retention-offers-view-model";
import { SlideoverShell } from "../SlideoverShell";

function compactReference(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function metric(value: number | undefined): string {
  return value === undefined ? "—" : value.toLocaleString();
}

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function evidenceLabel(
  row: RetentionOfferHistoryRow,
  reconciliationPending: boolean,
): string {
  if (reconciliationPending) return "Reconciliation in progress";
  switch (row.funnelState) {
    case "matched":
      return "Reconciled counters";
    case "outcome-excess":
      return "Outcome-count conflict";
    case "duplicate":
      return "Duplicate funnel records";
    case "tier-mismatch":
      return "Tier mismatch";
    case "missing":
      return "Funnel record missing";
    case "unavailable":
      return "Funnel unavailable";
  }
}

export function RetentionOfferDetail({
  row,
  open,
  tierCatalogueAvailable = false,
  tierCatalogueStale = false,
  reconciliationPending = false,
  onClose,
  returnFocusRef,
}: {
  row: RetentionOfferHistoryRow | null;
  open: boolean;
  tierCatalogueAvailable?: boolean;
  tierCatalogueStale?: boolean;
  reconciliationPending?: boolean;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}): ReactElement | null {
  if (!row) return null;
  const { offer, funnel } = row;
  const discount = retentionDiscountPresentation(offer);
  const trustedFunnel = row.funnelState === "matched" ? funnel : null;
  const title = offer.headline ?? "Untitled retention offer";
  const missingFromCatalogue = row.tierName === null && tierCatalogueAvailable;
  const tierPresentation =
    row.tierName ??
    `Tier ${compactReference(offer.tierId)}${
      missingFromCatalogue
        ? ` · absent from ${
            tierCatalogueStale ? "last verified" : "verified"
          } catalogue`
        : ""
    }`;

  return (
    <SlideoverShell
      open={open}
      onClose={onClose}
      size="lg"
      eyebrow="Retention record"
      title={title}
      subtitle={`${tierPresentation} · ${offer.active ? "Marked active" : "Marked inactive"}`}
      returnFocusRef={returnFocusRef}
      className="rhs-detail"
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="rhs-detail-status" role="status">
        <span
          className={`rhs-state-dot ${
            row.funnelState === "matched" ? "is-good" : "is-attention"
          }`}
          aria-hidden="true"
        />
        <strong>{evidenceLabel(row, reconciliationPending)}</strong>
        <span>
          This drawer never edits an offer or certifies provider delivery.
        </span>
      </div>

      <section
        className="rhs-detail-section"
        aria-labelledby="rhs-detail-terms"
      >
        <div className="rhs-detail-heading">
          <span>01</span>
          <div>
            <p>Stored terms</p>
            <h3 id="rhs-detail-terms">What this stored row contains</h3>
          </div>
        </div>
        <dl className="rhs-detail-grid">
          <div>
            <dt>Tier</dt>
            <dd>
              {row.tierName ??
                (missingFromCatalogue
                  ? `Name absent from the ${
                      tierCatalogueStale ? "last verified" : "verified"
                    } catalogue`
                  : "Name unavailable")}
              <small>Reference {offer.tierId}</small>
            </dd>
          </div>
          <div>
            <dt>Discount</dt>
            <dd aria-label={discount.spokenLabel}>
              {discount.label}
              {!discount.currencyKnown ? (
                <small>Currency is absent from this record.</small>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>
              {offer.durationMonths.toLocaleString()}{" "}
              {offer.durationMonths === 1 ? "month" : "months"}
            </dd>
          </div>
          <div>
            <dt>Stored state</dt>
            <dd>{offer.active ? "Marked active" : "Marked inactive"}</dd>
          </div>
          <div>
            <dt>Coupon reference</dt>
            <dd>
              {offer.providerCouponPresent ? "Present" : "Not recorded"}
              <small>Presence is not provider verification.</small>
            </dd>
          </div>
          <div>
            <dt>Record reference</dt>
            <dd>{offer.id}</dd>
          </div>
        </dl>
        <div className="rhs-offer-copy">
          <span>Stored customer-facing copy</span>
          <strong>{offer.headline ?? "No headline recorded"}</strong>
          <p>{offer.body ?? "No body copy recorded."}</p>
        </div>
      </section>

      <section
        className="rhs-detail-section"
        aria-labelledby="rhs-detail-outcomes"
      >
        <div className="rhs-detail-heading">
          <span>02</span>
          <div>
            <p>Recorded outcomes</p>
            <h3 id="rhs-detail-outcomes">All-time raw event counters</h3>
          </div>
        </div>
        {funnel && !reconciliationPending ? (
          <div
            className={`rhs-detail-metrics ${
              trustedFunnel ? "" : "is-untrusted"
            }`}
          >
            <div>
              <span>Shown</span>
              <strong>{metric(funnel.shown)}</strong>
            </div>
            <div>
              <span>Accepted</span>
              <strong>{metric(funnel.accepted)}</strong>
            </div>
            <div>
              <span>Declined</span>
              <strong>{metric(funnel.declined)}</strong>
            </div>
            <div>
              <span>Expired</span>
              <strong>{metric(funnel.expired)}</strong>
            </div>
            <div>
              <span>Derived acceptance</span>
              <strong>
                {trustedFunnel
                  ? percent(acceptanceRateOf(trustedFunnel))
                  : "Withheld"}
              </strong>
            </div>
          </div>
        ) : (
          <div className="rhs-detail-unknown" role="note">
            <strong>
              {reconciliationPending
                ? "Offer and funnel refreshes are being reconciled"
                : "No reconciled funnel row"}
            </strong>
            <p>
              {reconciliationPending
                ? "Counts remain withheld until both critical reads verify together."
                : "Counts remain unknown. This is not evidence that the offer has zero activity."}
            </p>
          </div>
        )}
        <p className="rhs-evidence-caveat">
          Counters come from stored events. The current API does not establish
          unique people, event attribution, a reporting window, recovered
          revenue, or provider reconciliation.
        </p>
      </section>

      <section
        className="rhs-detail-section"
        aria-labelledby="rhs-detail-provenance"
      >
        <div className="rhs-detail-heading">
          <span>03</span>
          <div>
            <p>Record provenance</p>
            <h3 id="rhs-detail-provenance">What is—and is not—available</h3>
          </div>
        </div>
        <dl className="rhs-provenance-list">
          <div>
            <dt>Created</dt>
            <dd>{fmtDateTime(offer.createdAt)}</dd>
          </div>
          <div>
            <dt>Last stored update</dt>
            <dd>{fmtDateTime(offer.updatedAt)}</dd>
          </div>
          <div>
            <dt>Audience or segment</dt>
            <dd>Not available from this API</dd>
          </div>
          <div>
            <dt>Attribution source</dt>
            <dd>Not available from this API</dd>
          </div>
          <div>
            <dt>Recovered revenue</dt>
            <dd>Not available from this API</dd>
          </div>
          <div>
            <dt>Provider application receipt</dt>
            <dd>Not available from this API</dd>
          </div>
        </dl>
      </section>
    </SlideoverShell>
  );
}
