import { type ReactElement, type ReactNode, useRef } from "react";

import type { ConsentReceipt } from "../../lib/api-client";
import {
  consentOutcomeLabel,
  consentOutcomeTone,
  consentReceiptIdentity,
  evidenceKindLabel,
  exactConsentTimestamp,
  formatConsentTimestamp,
} from "../../lib/consent-evidence-view";
import { Icon } from "../Icon";
import { Notice } from "../Notice";
import { SlideoverShell } from "../SlideoverShell";

function UserValue({ children }: { children: ReactNode }): ReactElement {
  return <bdi dir="auto">{children}</bdi>;
}

function DetailFact({
  term,
  children,
  code = false,
}: {
  term: string;
  children: ReactNode;
  code?: boolean;
}): ReactElement {
  return (
    <div className="consent-detail-fact">
      <dt>{term}</dt>
      <dd className={code ? "mono" : undefined} dir="auto">
        {children}
      </dd>
    </div>
  );
}

export function ReceiptDrawer({
  receipt,
  gpcSignalInLoadedWindow = null,
  onClose,
}: {
  receipt: ConsentReceipt;
  gpcSignalInLoadedWindow?: boolean | null;
  onClose: () => void;
}): ReactElement {
  const inspectButtonRef = useRef<HTMLButtonElement | null>(null);
  const rawDetailsRef = useRef<HTMLDetailsElement | null>(null);
  const rawSummaryRef = useRef<HTMLElement | null>(null);
  const exactOccurredAt = exactConsentTimestamp(receipt.at);
  const exactRecordedAt = exactConsentTimestamp(receipt.recorded_at);
  const contextFields = [
    {
      label: "Source detail",
      recorded: Boolean(receipt.source_detail?.trim()),
    },
    {
      label: "Policy version",
      recorded: Boolean(receipt.privacy_policy_version?.trim()),
    },
    {
      label: "Captured text",
      recorded: Boolean(receipt.captured_text?.trim()),
    },
    { label: "IP address", recorded: Boolean(receipt.ip?.trim()) },
    { label: "User agent", recorded: Boolean(receipt.user_agent?.trim()) },
  ];
  const recordedContext = contextFields.filter(
    (field) => field.recorded,
  ).length;

  return (
    <SlideoverShell
      open
      onClose={onClose}
      size="lg"
      eyebrow={evidenceKindLabel(receipt.kind)}
      title={receipt.subscriber_email}
      subtitle={
        "Recorded evidence " +
        consentReceiptIdentity(receipt) +
        " · server-recorded " +
        formatConsentTimestamp(receipt.recorded_at)
      }
      initialFocusRef={inspectButtonRef}
      headerActions={
        <button
          ref={inspectButtonRef}
          type="button"
          className="btn"
          onClick={() => {
            if (rawDetailsRef.current) rawDetailsRef.current.open = true;
            window.requestAnimationFrame(() => rawSummaryRef.current?.focus());
          }}
        >
          Review raw evidence
        </button>
      }
    >
      <div className="consent-detail">
        <Notice
          tone="neutral"
          title="Stored evidence, not an independent assurance"
          announcement="off"
        >
          This panel shows exact fields from one validated list row. It does not
          independently prove complete history, append-only storage, retention,
          legal hold, policy delivery, legal sufficiency, or current send
          eligibility.
        </Notice>

        <section
          className="consent-detail-hero"
          aria-labelledby="consent-decision-title"
        >
          <div>
            <span className="consent-kicker">Recorded state</span>
            <h2 id="consent-decision-title">
              <UserValue>
                {receipt.prev_state || "Prior state not recorded"}
              </UserValue>
              <Icon name="arrow-right" size={18} />
              <UserValue>{receipt.new_state}</UserValue>
            </h2>
          </div>
          <span
            className={"consent-outcome-badge " + consentOutcomeTone(receipt)}
          >
            <UserValue>{consentOutcomeLabel(receipt)}</UserValue>
          </span>
        </section>

        <section
          className="consent-detail-section"
          aria-labelledby="consent-record-title"
        >
          <header>
            <div>
              <span className="consent-kicker">Record identity</span>
              <h2 id="consent-record-title">What the source returned</h2>
            </div>
          </header>
          <dl className="consent-detail-grid">
            <DetailFact term="Exact identity" code>
              {consentReceiptIdentity(receipt)}
            </DetailFact>
            <DetailFact term="Evidence type">
              {evidenceKindLabel(receipt.kind)}
            </DetailFact>
            <DetailFact term="Recorded state">{receipt.new_state}</DetailFact>
            <DetailFact term="Prior state">
              {receipt.prev_state || "Not recorded"}
            </DetailFact>
            <DetailFact term="Evidence occurred">
              <span>{formatConsentTimestamp(receipt.at)}</span>
              {exactOccurredAt ? (
                <code className="consent-exact-time">{exactOccurredAt}</code>
              ) : null}
            </DetailFact>
            <DetailFact term="Server recorded">
              <span>{formatConsentTimestamp(receipt.recorded_at)}</span>
              {exactRecordedAt ? (
                <code className="consent-exact-time">{exactRecordedAt}</code>
              ) : null}
            </DetailFact>
          </dl>
        </section>

        <section
          className="consent-detail-section"
          aria-labelledby="consent-provenance-title"
        >
          <header>
            <div>
              <span className="consent-kicker">Provenance</span>
              <h2 id="consent-provenance-title">Recorded capture context</h2>
            </div>
            <span className="consent-context-count">
              {recordedContext} of {contextFields.length} optional context
              fields recorded
            </span>
          </header>
          <dl className="consent-detail-grid">
            <DetailFact term="Source" code>
              {receipt.source}
            </DetailFact>
            <DetailFact term="Source detail">
              {receipt.source_detail || "Not recorded"}
            </DetailFact>
            <DetailFact term="Policy version" code>
              {receipt.privacy_policy_version || "Not recorded"}
            </DetailFact>
            <DetailFact term="Captured text">
              <span className="consent-captured-text">
                {receipt.captured_text || "Not recorded"}
              </span>
            </DetailFact>
            <DetailFact term="IP address" code>
              {receipt.ip || "Not recorded"}
            </DetailFact>
            <DetailFact term="User agent">
              {receipt.user_agent || "Not recorded"}
            </DetailFact>
          </dl>
          <ul
            className="consent-context-checklist"
            aria-label="Optional context field presence"
          >
            {contextFields.map((field) => (
              <li key={field.label} data-recorded={field.recorded || undefined}>
                <span aria-hidden="true">{field.recorded ? "✓" : "—"}</span>
                <span>{field.label}</span>
                <strong>{field.recorded ? "Recorded" : "Not recorded"}</strong>
              </li>
            ))}
          </ul>
        </section>

        <section
          className="consent-detail-section"
          aria-labelledby="consent-gpc-title"
        >
          <header>
            <div>
              <span className="consent-kicker">Bounded correlation</span>
              <h2 id="consent-gpc-title">Global Privacy Control signal</h2>
            </div>
          </header>
          {gpcSignalInLoadedWindow === null ? (
            <Notice
              tone="warning"
              title="Event correlation unavailable"
              announcement="off"
            >
              The consent-event response is not currently contract-validated,
              so this panel cannot correlate a GPC signal for the subscriber.
            </Notice>
          ) : gpcSignalInLoadedWindow ? (
            <Notice
              tone="info"
              title="Signal found in loaded events"
              announcement="off"
            >
              A GPC-tagged event for this email appears in loaded event pages.
              This does not establish the subscriber&apos;s current preference
              or prove downstream enforcement.
            </Notice>
          ) : (
            <Notice
              tone="neutral"
              title="No match in loaded event pages"
              announcement="off"
            >
              No GPC-tagged event for this email appears in the event pages
              currently loaded. This is not proof that no signal exists in
              complete history.
            </Notice>
          )}
        </section>

        <details ref={rawDetailsRef} className="consent-raw-evidence">
          <summary
            ref={(node) => {
              rawSummaryRef.current = node;
            }}
          >
            Inspect raw list-row payload
          </summary>
          <Notice
            tone="warning"
            title="Sensitive personal data"
            announcement="off"
            className="consent-raw-warning"
          >
            The raw payload can contain an email address, IP address, browser
            details, policy text, and source metadata. Do not paste it into an
            unapproved system.
          </Notice>
          <pre
            className="mono"
            aria-label="Raw consent evidence JSON"
            dir="ltr"
          >
            {JSON.stringify(receipt, null, 2)}
          </pre>
        </details>
      </div>
    </SlideoverShell>
  );
}

export function MissingReceiptDrawer({
  identity,
  onClose,
}: {
  identity: string;
  onClose: () => void;
}): ReactElement {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  return (
    <SlideoverShell
      open
      onClose={onClose}
      size="md"
      eyebrow="Consent evidence"
      title="Record not in loaded pages"
      subtitle={"Requested evidence " + identity}
      initialFocusRef={closeButtonRef}
      headerActions={
        <button
          ref={closeButtonRef}
          type="button"
          className="btn"
          onClick={onClose}
        >
          Close
        </button>
      }
    >
      <Notice tone="warning" title="This is not a not-found determination">
        The exact receipt/proof identity is not present in pages currently
        loaded for this page family. Moosewave will not infer that the record was
        deleted or never existed.
      </Notice>
    </SlideoverShell>
  );
}
