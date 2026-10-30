import { type ReactElement } from "react";

import { Notice } from "../Notice";
import { REFERRAL_SUBSCRIBER_LINKS_UNAVAILABLE_REASON } from "../../lib/referral-operational-availability";

import "../../styles-referrals.css";

/**
 * Subscriber referral links are deliberately not fetched here. The retired
 * endpoint minted a live public attribution token from a read-scoped GET.
 * Reintroduce progress only against a pure, token-free inspection projection;
 * link issuance must be a separate, audited authority.
 */
export function ReferralProgressPanel({
  subscriberId: _subscriberId,
}: {
  subscriberId: string | number;
}): ReactElement {
  return (
    <section
      className="ref-progress-panel"
      data-referral-links-gated
      aria-labelledby="referral-links-gated-title"
    >
      <div id="referral-links-gated-title" className="section-title">
        Referral progress
      </div>
      <Notice tone="neutral" announcement="off">
        {REFERRAL_SUBSCRIBER_LINKS_UNAVAILABLE_REASON}
      </Notice>
    </section>
  );
}
