/**
 * Cancel-flow save offer modal. Surfaced from the subscriber portal
 * when a paid member clicks Cancel. The modal opens by GET-ing
 * /api/v1/portal/retention-offer?tier_id=... and rendering the returned
 * offer; if `has_offer=false`, the parent should skip the modal and
 * proceed straight to cancellation.
 *
 * Accept → POST /api/v1/portal/retention-offer/accept (applies Stripe
 * coupon, pauses cancel). Decline → POST .../decline (records the
 * decline event, then the parent's cancel flow resumes).
 *
 * Inspired by Ghost / Substack / beehiiv cancel-flow save offers:
 * single-step interjection, headline + body + "claim offer" / "no
 * thanks" CTAs, decline-as-default to avoid dark-pattern accusations.
 *
 * Tracking: each modal mount logs a `shown` event so the funnel rollup
 * (shown → accepted vs shown → declined) is symmetrical. Accept logs
 * inside the API; decline logs from this component.
 */
import { type ReactElement, useEffect, useState } from "react";

import {
  apiRetentionOffers,
  type RetentionOffer,
} from "../../lib/api-client";
import { Modal, ModalFooter } from "../Modal";

interface RetentionOfferModalProps {
  /** Open / closed state — controlled by the parent. */
  open: boolean;
  /** Tier the member belongs to (looked up before the modal opens). */
  tierID: string;
  /** Subscriber identifiers — at least one should be set so the funnel
   * rollup can dedupe a single member's shown → accept|decline flow. */
  paidSubID?: string;
  subscriberEmail?: string;
  /** Stripe subscription id, used by the Accept call to apply the
   * coupon onto the live subscription. Empty disables Apply (the event
   * still logs locally so a sweeper can retry later). */
  stripeSubscriptionID?: string;
  /** Called when the member accepts — the parent should NOT proceed
   * with the cancellation, and should show a "you saved $X" toast. */
  onAccepted: (applied: boolean) => void;
  /** Called when the member declines OR no offer exists — the parent
   * should resume the cancellation flow. */
  onProceedToCancel: () => void;
  /** Called when the user closes the modal without choosing (Esc /
   * outside click). Treated the same as decline for funnel purposes
   * by the parent, but the parent may choose to keep the subscription
   * active instead — that's a UX policy decision left to the caller. */
  onDismiss: () => void;
}

export function RetentionOfferModal({
  open,
  tierID,
  paidSubID,
  subscriberEmail,
  stripeSubscriptionID,
  onAccepted,
  onProceedToCancel,
  onDismiss,
}: RetentionOfferModalProps): ReactElement | null {
  const [offer, setOffer] = useState<RetentionOffer | null>(null);
  const [amountLabel, setAmountLabel] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  /* Look up the tier's offer on open. If none → skip the modal and
   * bubble through to cancel so the user doesn't see a flash of empty
   * modal chrome. */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiRetentionOffers
      .lookupPortalRetentionOffer(tierID)
      .then((res) => {
        if (cancelled) return;
        setLoading(false);
        if (res.error || !res.data) {
          /* Lookup failed — surface the error inline so the user can
           * retry. A 5xx here shouldn't silently swallow the cancel
           * branch either; the parent can choose to call
           * onProceedToCancel() from the error UI. */
          setError("Could not load offer");
          return;
        }
        if (!res.data.has_offer || !res.data.offer) {
          /* No offer configured — skip the modal and resume cancel. */
          onProceedToCancel();
          return;
        }
        const loadedOffer = res.data.offer;
        setOffer(loadedOffer);
        setAmountLabel(res.data.amount_label ?? "");
        /* Log the shown event for the funnel. Best-effort — a failure
         * here doesn't change the user-visible state. */
        void apiRetentionOffers.logRetentionOfferEvent(loadedOffer.id, {
          event_type: "shown",
          paid_sub_id: paidSubID,
          subscriber_email: subscriberEmail,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : "Lookup failed");
      });
    return () => {
      cancelled = true;
    };
  }, [open, tierID, paidSubID, subscriberEmail, onProceedToCancel]);

  /* Accept the offer — apply the Stripe coupon and short-circuit the
   * in-flight cancel. */
  async function handleAccept(): Promise<void> {
    if (!offer) return;
    setSubmitting(true);
    setError(null);
    const res = await apiRetentionOffers.acceptPortalRetentionOffer({
      offer_id: offer.id,
      paid_sub_id: paidSubID,
      subscriber_email: subscriberEmail,
      stripe_subscription_id: stripeSubscriptionID,
    });
    setSubmitting(false);
    if (res.error || !res.data) {
      setError("Could not apply the offer. Please try again.");
      return;
    }
    onAccepted(res.data.applied);
  }

  /* Decline — record the decline event then resume cancellation. */
  async function handleDecline(): Promise<void> {
    if (!offer) {
      onProceedToCancel();
      return;
    }
    setSubmitting(true);
    /* Decline is best-effort — even if the API call fails we still
     * resume the cancel because the user's intent was unambiguous. */
    try {
      await apiRetentionOffers.declinePortalRetentionOffer({
        offer_id: offer.id,
        paid_sub_id: paidSubID,
        subscriber_email: subscriberEmail,
      });
    } finally {
      setSubmitting(false);
      onProceedToCancel();
    }
  }

  if (!open) return null;

  const headline = offer?.headline?.trim() || "Wait — here's a one-time offer";
  const body =
    offer?.body?.trim() ||
    (amountLabel
      ? `Stay subscribed and get ${amountLabel} for your next ${
          offer && offer.duration_months > 1
            ? `${offer.duration_months} billing cycles`
            : "billing cycle"
        }.`
      : "Stay subscribed to keep your access.");

  return (
    <Modal
      open={open}
      onClose={onDismiss}
      title={headline}
      description={body}
    >
      {loading ? (
        <p className="pw-modal-loading">Loading offer...</p>
      ) : error ? (
        <div className="pw-modal-error" role="alert">
          <p>{error}</p>
          <button
            type="button"
            onClick={onProceedToCancel}
            className="pw-link"
          >
            Continue with cancellation
          </button>
        </div>
      ) : offer ? (
        <div className="pw-retention-offer-body">
          {amountLabel ? (
            <div className="pw-retention-offer-amount" aria-label="discount">
              {amountLabel}
            </div>
          ) : null}
          <p>{body}</p>
          <p className="pw-retention-offer-fineprint">
            Discount applies to the next{" "}
            {offer.duration_months > 1
              ? `${offer.duration_months} billing cycles`
              : "billing cycle"}{" "}
            and is one-time.
          </p>
        </div>
      ) : null}

      <ModalFooter>
        <button
          type="button"
          onClick={() => void handleDecline()}
          disabled={submitting}
          className="pw-btn pw-btn-secondary"
        >
          No thanks, cancel anyway
        </button>
        <button
          type="button"
          onClick={() => void handleAccept()}
          disabled={submitting || !offer}
          className="pw-btn pw-btn-primary"
        >
          {submitting ? "Applying..." : "Claim offer"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
