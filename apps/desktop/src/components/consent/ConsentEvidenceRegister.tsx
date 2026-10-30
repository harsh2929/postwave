import { type ReactElement, type ReactNode } from "react";

import type { ConsentReceipt } from "../../lib/api-client";
import {
  consentOutcomeLabel,
  consentOutcomeTone,
  consentReceiptIdentity,
  evidenceKindLabel,
  exactConsentTimestamp,
  formatConsentTimestamp,
  relativeConsentTimestamp,
  truncateConsentValue,
} from "../../lib/consent-evidence-view";
import { DataTable, type DataTableColumn } from "../table/DataTable";

function UserValue({ children }: { children: ReactNode }): ReactElement {
  return <bdi dir="auto">{children}</bdi>;
}

interface ConsentEvidenceRegisterProps {
  rows: ConsentReceipt[];
  gpcSubjects: ReadonlySet<string>;
  eventCorrelationAvailable: boolean;
  onOpen: (receipt: ConsentReceipt, opener: HTMLElement) => void;
}

export function ConsentEvidenceTable({
  rows,
  gpcSubjects,
  eventCorrelationAvailable,
  onOpen,
}: ConsentEvidenceRegisterProps): ReactElement {
  const columns: readonly DataTableColumn<ConsentReceipt>[] = [
    {
      id: "subject",
      header: "Subscriber",
      width: "260px",
      cell: (receipt) => {
        const gpc = gpcSubjects.has(
          receipt.subscriber_email.trim().toLowerCase(),
        );
        return (
          <div className="consent-subject-cell">
            <strong>
              <UserValue>{receipt.subscriber_email}</UserValue>
            </strong>
            {eventCorrelationAvailable && gpc ? (
              <span
                className="consent-gpc-badge"
                title="A GPC signal for this email appears in the loaded event window. This is not a statement of current preference or enforcement."
              >
                GPC in loaded events
              </span>
            ) : null}
          </div>
        );
      },
    },
    {
      id: "outcome",
      header: "Recorded state",
      width: "150px",
      cell: (receipt) => (
        <span
          className={"consent-outcome-badge " + consentOutcomeTone(receipt)}
        >
          <UserValue>{consentOutcomeLabel(receipt)}</UserValue>
        </span>
      ),
    },
    {
      id: "evidence",
      header: "Evidence",
      width: "160px",
      cell: (receipt) => (
        <span className="consent-kind-label">
          {evidenceKindLabel(receipt.kind)}
        </span>
      ),
    },
    {
      id: "provenance",
      header: "Recorded provenance",
      width: "220px",
      cell: (receipt) => (
        <div className="consent-provenance-cell">
          <code dir="auto">{truncateConsentValue(receipt.source, 34)}</code>
          <span title={receipt.source_detail} dir="auto">
            {truncateConsentValue(receipt.source_detail, 42)}
          </span>
        </div>
      ),
    },
    {
      id: "policy",
      header: "Policy",
      width: "145px",
      cell: (receipt) => (
        <span
          className="consent-policy-cell"
          title={receipt.privacy_policy_version}
          dir="auto"
        >
          {truncateConsentValue(receipt.privacy_policy_version, 24)}
        </span>
      ),
    },
    {
      id: "recorded",
      header: "Recorded",
      width: "190px",
      cell: (receipt) => (
        <time
          className="consent-time-cell"
          dateTime={exactConsentTimestamp(receipt.recorded_at) ?? undefined}
        >
          <span>{formatConsentTimestamp(receipt.recorded_at)}</span>
          {relativeConsentTimestamp(receipt.recorded_at) ? (
            <small>{relativeConsentTimestamp(receipt.recorded_at)}</small>
          ) : null}
        </time>
      ),
    },
    {
      id: "review",
      header: <span className="visually-hidden">Review</span>,
      width: "110px",
      align: "end",
      cell: (receipt) => (
        <button
          type="button"
          className="btn consent-review-button"
          aria-label={
            "Review " +
            evidenceKindLabel(receipt.kind).toLowerCase() +
            " for " +
            receipt.subscriber_email
          }
          onClick={(event) => onOpen(receipt, event.currentTarget)}
        >
          Review
        </button>
      ),
    },
  ];
  return (
    <div className="consent-table-view">
      <DataTable
        caption="Loaded receipt and proof evidence"
        description="A local view over contract-validated cursor pages with one insert-visibility boundary. Governed changes may affect continuation pages. Use Review to inspect exact stored fields."
        columns={columns}
        rows={rows}
        getRowKey={consentReceiptIdentity}
        density="comfortable"
        stickyHeader
      />
    </div>
  );
}

export function ConsentEvidenceCards({
  rows,
  gpcSubjects,
  eventCorrelationAvailable,
  onOpen,
}: ConsentEvidenceRegisterProps): ReactElement {
  return (
    <ol
      className="consent-card-view"
      aria-label="Loaded receipt and proof evidence"
    >
      {rows.map((receipt) => {
        const gpc = gpcSubjects.has(
          receipt.subscriber_email.trim().toLowerCase(),
        );
        return (
          <li
            key={consentReceiptIdentity(receipt)}
            className="consent-evidence-card"
          >
            <div className="consent-evidence-card-topline">
              <span
                className={
                  "consent-outcome-badge " + consentOutcomeTone(receipt)
                }
              >
                <UserValue>{consentOutcomeLabel(receipt)}</UserValue>
              </span>
              <span>{evidenceKindLabel(receipt.kind)}</span>
            </div>
            <h3>
              <UserValue>{receipt.subscriber_email}</UserValue>
            </h3>
            {eventCorrelationAvailable && gpc ? (
              <span className="consent-gpc-badge">GPC in loaded events</span>
            ) : null}
            <dl>
              <div>
                <dt>Source</dt>
                <dd>
                  <code dir="auto">
                    {truncateConsentValue(receipt.source, 44)}
                  </code>
                </dd>
              </div>
              <div>
                <dt>Policy</dt>
                <dd dir="auto">
                  {truncateConsentValue(receipt.privacy_policy_version, 32)}
                </dd>
              </div>
              <div>
                <dt>Recorded</dt>
                <dd>{formatConsentTimestamp(receipt.recorded_at)}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="btn consent-card-review"
              onClick={(event) => onOpen(receipt, event.currentTarget)}
            >
              Review recorded evidence
            </button>
          </li>
        );
      })}
    </ol>
  );
}
