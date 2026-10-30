import type { ReactElement } from "react";

import type { PIIReviewReceipt } from "../../lib/api/pii-findings";
import { fmtDateTime } from "../../lib/format-date";
import {
  piiFingerprintDetail,
  piiFingerprintLabel,
  piiReasonLabel,
  piiStatusLabel,
} from "./pii-findings-ui";

export function PIIReviewReceiptView({
  receipt,
  compact = false,
}: {
  receipt: PIIReviewReceipt;
  compact?: boolean;
}): ReactElement {
  return (
    <section
      className={`pii-receipt${compact ? " is-compact" : ""}`}
      aria-label={`Immutable ${piiStatusLabel(receipt.status).toLowerCase()} receipt`}
    >
      <header>
        <div>
          <span className="pii-review-eyebrow">Immutable review receipt</span>
          <strong>{piiReasonLabel(receipt.reason)}</strong>
        </div>
        <span className="pii-receipt-lock">Locked</span>
      </header>
      {receipt.reason === "legacy_migrated" ? (
        <p className="pii-receipt-legacy">
          This terminal decision predates auditable receipts. Its original
          rationale was not available and has not been reconstructed.
        </p>
      ) : null}
      <p className="pii-receipt-comment">{receipt.comment}</p>
      <dl>
        <div>
          <dt>Outcome</dt>
          <dd>{piiStatusLabel(receipt.status)}</dd>
        </div>
        <div>
          <dt>Recorded</dt>
          <dd>{fmtDateTime(receipt.reviewed_at)}</dd>
        </div>
        <div>
          <dt>Actor</dt>
          <dd>
            {receipt.actor_type} · {receipt.actor_id}
          </dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd className="tabular">{receipt.evidence_reference}</dd>
        </div>
        <div>
          <dt>Detector</dt>
          <dd>
            {receipt.detector_name} {receipt.detector_version}
          </dd>
        </div>
        <div>
          <dt>Policy</dt>
          <dd>
            {receipt.policy_name} {receipt.policy_version}
          </dd>
        </div>
      </dl>
      <div className="pii-receipt-proofs">
        <span>
          Receipt <code>{receipt.receipt_id}</code>
        </span>
        <span>
          {piiFingerprintLabel(receipt.fingerprint_scheme)} snapshot{" "}
          <code>{receipt.fingerprint}</code>
        </span>
        <span>
          Fingerprint protection{" "}
          <code>
            {piiFingerprintDetail(
              receipt.fingerprint_scheme,
              receipt.fingerprint_key_version,
            )}
          </code>
        </span>
        <span>
          Finding version <code>{receipt.finding_updated_at}</code>
        </span>
      </div>
    </section>
  );
}
