import type { CSSProperties, ReactElement } from "react";

import type {
  PIIFinding,
  PIIFindingStatus,
  PIIReviewInput,
} from "../../lib/api/pii-findings";
import { fmtDateTime } from "../../lib/format-date";
import { PIIFindingDecisionForm } from "./PIIFindingDecisionForm";
import {
  piiFingerprintDetail,
  piiFingerprintLabel,
  piiStatusClass,
  piiStatusLabel,
  piiTypeLabel,
  shortFingerprint,
} from "./pii-findings-ui";
import { PIIReviewReceiptView } from "./PIIReviewReceiptView";

interface Props {
  finding: PIIFinding;
  activeOutcome?: Exclude<PIIFindingStatus, "pending"> | null;
  decisionError?: string | null;
  decisionsDisabled?: boolean;
  onBeginDecision?: (
    outcome: Exclude<PIIFindingStatus, "pending">,
    trigger: HTMLButtonElement,
  ) => void;
  onCancelDecision?: () => void;
  onSubmitDecision?: (input: PIIReviewInput) => Promise<boolean>;
}

export function PIIFindingRecord({
  finding,
  activeOutcome,
  decisionError,
  decisionsDisabled = false,
  onBeginDecision,
  onCancelDecision,
  onSubmitDecision,
}: Props): ReactElement {
  const confidence = Math.round(finding.confidence * 100);
  return (
    <article
      id={`pii-finding-record-${finding.id}`}
      className="pii-finding-record"
      aria-labelledby={`pii-finding-${finding.id}`}
      tabIndex={-1}
    >
      <header className="pii-finding-record-header">
        <div className="pii-finding-record-title">
          <span className="pii-type-badge">{piiTypeLabel(finding.detected_type)}</span>
          <div>
            <h4 id={`pii-finding-${finding.id}`}>{finding.field_name}</h4>
            <span className="tabular">Subscriber {finding.subscriber_id}</span>
          </div>
        </div>
        <span className={`pii-status-badge ${piiStatusClass(finding.status)}`}>
          <span aria-hidden="true" />
          {piiStatusLabel(finding.status)}
        </span>
      </header>

      <div className="pii-finding-evidence-grid">
        <div className="pii-confidence">
          <span>
            Detector confidence <strong className="tabular">{confidence}%</strong>
          </span>
          <span
            className="pii-confidence-track"
            role="meter"
            aria-label="Detector confidence"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={confidence}
          >
            <span style={{ "--pii-confidence": `${confidence}%` } as CSSProperties} />
          </span>
        </div>
        <dl className="pii-finding-metadata">
          <div>
            <dt>Detected</dt>
            <dd>{fmtDateTime(finding.created_at)}</dd>
          </div>
          <div>
            <dt>Scanner</dt>
            <dd>
              {finding.scanner_name} {finding.scanner_version}
            </dd>
          </div>
          <div>
            <dt>Detector</dt>
            <dd>
              {finding.detector_name} {finding.detector_version}
            </dd>
          </div>
          <div>
            <dt>Policy</dt>
            <dd>
              {finding.policy_name} {finding.policy_version}
            </dd>
          </div>
        </dl>
      </div>

      <div className="pii-fingerprint">
        <div>
          <span>{piiFingerprintLabel(finding.fingerprint_scheme)}</span>
          <strong>
            {piiFingerprintDetail(
              finding.fingerprint_scheme,
              finding.fingerprint_key_version,
            )}
          </strong>
        </div>
        <code
          aria-label={`${piiFingerprintLabel(finding.fingerprint_scheme)} ${finding.fingerprint}`}
        >
          <span aria-hidden="true">{shortFingerprint(finding.fingerprint)}</span>
          <span className="visually-hidden">{finding.fingerprint}</span>
        </code>
      </div>

      {finding.status === "pending" && !activeOutcome ? (
        <div className="pii-finding-actions">
          <span>
            A terminal decision needs a reason, comment, and non-secret evidence reference.
          </span>
          <div>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={(event) => onBeginDecision?.("reviewed", event.currentTarget)}
              disabled={!onBeginDecision || decisionsDisabled}
            >
              Review…
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={(event) => onBeginDecision?.("dismissed", event.currentTarget)}
              disabled={!onBeginDecision || decisionsDisabled}
            >
              Dismiss…
            </button>
          </div>
        </div>
      ) : null}

      {finding.status === "pending" &&
      activeOutcome &&
      onCancelDecision &&
      onSubmitDecision ? (
        <PIIFindingDecisionForm
          finding={finding}
          outcome={activeOutcome}
          error={decisionError}
          onCancel={onCancelDecision}
          onSubmit={onSubmitDecision}
        />
      ) : null}

      {finding.status !== "pending" && finding.review_receipt ? (
        <PIIReviewReceiptView receipt={finding.review_receipt} compact />
      ) : null}
    </article>
  );
}
