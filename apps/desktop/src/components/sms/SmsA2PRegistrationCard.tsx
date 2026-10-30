import type { ReactElement } from "react";

import { Notice } from "../Notice";

export const SMS_A2P_REGISTRATION_RELEASE_HOLD =
  "sms_a2p_registration_release_held";

export const SMS_A2P_REGISTRATION_RELEASE_HOLD_COPY =
  "A2P carrier registration is unavailable until durable idempotency, reconciliation, and minimized provider receipts are deployed.";

/**
 * Stable desktop containment for the backend A2P registration release hold.
 *
 * This card deliberately has no sender read, submit, poll, form, or retry
 * callback. Rendering a focusable-looking disabled action would still invite
 * an operation that the authoritative backend always rejects.
 */
export function SmsA2PRegistrationCard(): ReactElement {
  return (
    <section
      className="card sms-a2p-release-hold"
      aria-labelledby="sms-a2p-registration-title"
    >
      <div className="card-header">
        <div>
          <div className="card-title" id="sms-a2p-registration-title">
            A2P 10DLC registration
          </div>
          <div className="card-subtitle muted">
            Carrier registration controls are not available in this release.
          </div>
        </div>
      </div>
      <div className="card-body">
        <Notice tone="warning" announcement="polite">
          <strong>Registration actions are release-held</strong>
          <p>{SMS_A2P_REGISTRATION_RELEASE_HOLD_COPY}</p>
          <p>
            No sender read, brand submission, campaign submission, or provider
            status polling request is started by this card. Existing provider
            status records are not refreshed here.
          </p>
          <p className="muted small">
            Release boundary: <code>{SMS_A2P_REGISTRATION_RELEASE_HOLD}</code>
          </p>
        </Notice>
      </div>
    </section>
  );
}
