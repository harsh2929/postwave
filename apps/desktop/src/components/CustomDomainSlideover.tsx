/** DNS-ownership detail for one legacy branded-hostname registration. */

import {
  type ReactElement,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  customDomainPurposeLabel,
} from "./domains/custom-domain-contract";
import { SlideoverShell } from "./SlideoverShell";
import { toast } from "./Toast";
import type { CustomDomain, DNSRecord } from "../lib/api-client";
import { writeClipboardText } from "../lib/clipboard";
import { CUSTOM_DOMAIN_RELEASE_HOLD_MESSAGE } from "../lib/custom-domain-operational-availability";
import { fmtDateTime } from "../lib/format-date";

interface Props {
  domain: CustomDomain;
  onClose: () => void;
  onChange?: (updated: CustomDomain | null) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

interface DNSRecordCardProps {
  record: DNSRecord;
  index: number;
  copied: string | null;
  onCopy: (key: string, value: string, label: string) => void;
}

function CopyGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="6.5" y="6.5" width="9" height="9" rx="1.5" />
      <path d="M4.5 12.5h-1v-9h9v1" />
    </svg>
  );
}

function CheckGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="m4 10.5 3.5 3.5L16 5.5" />
    </svg>
  );
}

function recordState(record: DNSRecord): {
  label: string;
  className: string;
} {
  if (record.verified === true) {
    return { label: "Found", className: "is-found" };
  }
  if (record.verified === false && record.error) {
    return { label: "Not found", className: "is-missing" };
  }
  if (record.verified === false) {
    return { label: "Not confirmed", className: "is-pending" };
  }
  return { label: "Not checked", className: "is-unknown" };
}

function DNSRecordCard({
  record,
  index,
  copied,
  onCopy,
}: DNSRecordCardProps): ReactElement {
  const state = recordState(record);
  const baseKey = `record-${index}`;
  return (
    <article className="cd-record-card">
      <header className="cd-record-head">
        <div>
          <span className="cd-record-number" aria-hidden="true">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span className="cd-record-type">{record.type}</span>
        </div>
        <span className={`cd-record-state ${state.className}`}>
          <span aria-hidden="true" />
          {state.label}
        </span>
      </header>

      <dl className="cd-record-fields">
        <div>
          <dt>Host / name</dt>
          <dd>
            <code>{record.name}</code>
            <button
              type="button"
              className="cd-copy-button"
              onClick={() =>
                onCopy(`${baseKey}-host`, record.name, `${record.type} host`)
              }
              aria-label={`Copy host for ${record.type} record ${index + 1}`}
            >
              {copied === `${baseKey}-host` ? <CheckGlyph /> : <CopyGlyph />}
              <span>
                {copied === `${baseKey}-host` ? "Copied" : "Copy host"}
              </span>
            </button>
          </dd>
        </div>
        <div>
          <dt>Target / value</dt>
          <dd>
            <code>{record.value}</code>
            <button
              type="button"
              className="cd-copy-button"
              onClick={() =>
                onCopy(`${baseKey}-value`, record.value, `${record.type} value`)
              }
              aria-label={`Copy value for ${record.type} record ${index + 1}`}
            >
              {copied === `${baseKey}-value` ? <CheckGlyph /> : <CopyGlyph />}
              <span>
                {copied === `${baseKey}-value` ? "Copied" : "Copy value"}
              </span>
            </button>
          </dd>
        </div>
      </dl>

      {record.error ? (
        <p className="cd-record-error">
          <span aria-hidden="true">!</span>
          {record.error}
        </p>
      ) : null}
    </article>
  );
}

function VerificationPath({ domain }: { domain: CustomDomain }): ReactElement {
  const verified = domain.verified;
  return (
    <section className="cd-detail-section" aria-labelledby="cd-path-title">
      <div className="cd-detail-heading">
        <div>
          <p>Readiness path</p>
          <h3 id="cd-path-title">What this registry can prove</h3>
        </div>
        <span className="cd-scope-pill">Ownership scope</span>
      </div>
      <ol className="cd-detail-path">
        <li className="is-complete">
          <span className="cd-detail-path-mark">
            <CheckGlyph />
          </span>
          <span>
            <strong>Registered</strong>
            <small>Hostname stored in this workspace</small>
          </span>
        </li>
        <li className={verified ? "is-complete" : "is-action"}>
          <span className="cd-detail-path-mark">
            {verified ? <CheckGlyph /> : "2"}
          </span>
          <span>
            <strong>DNS ownership</strong>
            <small>
              {verified
                ? "Required records found at the last successful check"
                : "No successful stored ownership check is available"}
            </small>
          </span>
        </li>
        <li className="is-blocked">
          <span className="cd-detail-path-mark">3</span>
          <span>
            <strong>TLS certificate</strong>
            <small>Issuance and renewal are not connected</small>
          </span>
        </li>
        <li className="is-blocked">
          <span className="cd-detail-path-mark">4</span>
          <span>
            <strong>Traffic routing</strong>
            <small>No production consumer is qualified</small>
          </span>
        </li>
      </ol>
    </section>
  );
}

function buildRecordClipboard(records: readonly DNSRecord[]): string {
  return records
    .map(
      (record, index) =>
        `${index + 1}. ${record.type}\nHost: ${record.name}\nValue: ${record.value}`,
    )
    .join("\n\n");
}

function CustomDomainSlideoverBody({
  domain,
  onClose,
  returnFocusRef,
}: Props): ReactElement {
  const [copied, setCopied] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const copiedTimerRef = useRef<number | null>(null);
  const activeRef = useRef(true);
  const records = domain.dns_records;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  const onCopy = async (
    key: string,
    value: string,
    label: string,
  ): Promise<void> => {
    const result = await writeClipboardText(value, {
      contentClass: "public",
      label: "DNS record",
    });
    if (!activeRef.current) return;
    if (!result.ok) {
      toast.error({
        message: `${label} could not be copied`,
        detail: result.message,
      });
      setAnnouncement(`${label} could not be copied.`);
      return;
    }
    setCopied(key);
    setAnnouncement(`${label} copied to the clipboard.`);
    toast.success({ message: `${label} copied` });
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => {
      setCopied((current) => (current === key ? null : current));
      copiedTimerRef.current = null;
    }, 1800);
  };

  return (
    <SlideoverShell
      open
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      size="lg"
      className="cd-domain-slideover"
      eyebrow="Branded domain · ownership registry"
      title={domain.domain}
      subtitle={
        <span className="cd-detail-subtitle">
          <span className={domain.verified ? "is-verified" : "is-pending"}>
            <span aria-hidden="true" />
            {domain.verified ? "Last check passed" : "Needs DNS"}
          </span>
          <span aria-hidden="true">·</span>
          <span>{customDomainPurposeLabel(domain.purpose)}</span>
        </span>
      }
      busy={false}
      footer={
        <div className="cd-detail-footer-actions">
          <span className="cd-registry-id">
            Registry ID <code>{domain.id}</code>
          </span>
          <button
            type="button"
            className="btn"
            onClick={onClose}
          >
            Close
          </button>
          <span className="cd-verify-action">
            <button
              type="button"
              className="btn btn-primary pw-discoverable-unavailable"
              disabled
              aria-describedby="custom-domain-release-hold"
            >
              DNS re-check held
            </button>
            <span id="custom-domain-release-hold" className="cd-action-reason">
              {CUSTOM_DOMAIN_RELEASE_HOLD_MESSAGE}
            </span>
          </span>
        </div>
      }
    >
      <div className="cd-detail-boundary" role="note">
        <span className="cd-boundary-icon" aria-hidden="true">
          i
        </span>
        <div>
          <strong>Ownership evidence only</strong>
          <p>
            A stored verification result records historical DNS ownership
            evidence only. Re-checking is release-held and this registry does
            not activate the hostname, issue a certificate, or route traffic.
          </p>
        </div>
      </div>

      <dl className="cd-detail-facts">
        <div>
          <dt>Registration intent</dt>
          <dd>{customDomainPurposeLabel(domain.purpose)}</dd>
        </div>
        <div>
          <dt>Added to workspace</dt>
          <dd>{fmtDateTime(domain.createdAt)}</dd>
        </div>
        <div>
          <dt>Last successful ownership check</dt>
          <dd>
            {domain.verified && domain.verifiedAt
              ? fmtDateTime(domain.verifiedAt)
              : domain.verified
                ? "Timestamp unavailable"
                : "No successful check recorded"}
          </dd>
        </div>
      </dl>

      <VerificationPath domain={domain} />

      <section className="cd-detail-section" aria-labelledby="cd-records-title">
        <div className="cd-detail-heading">
          <div>
            <p>DNS setup</p>
            <h3 id="cd-records-title">Required ownership records</h3>
            <span>
              Publish the exact type, host, and value at your DNS provider.
            </span>
          </div>
          {records.length > 0 ? (
            <button
              type="button"
              className="btn btn-sm cd-copy-all"
              onClick={() =>
                void onCopy(
                  "all-records",
                  buildRecordClipboard(records),
                  "All DNS records",
                )
              }
            >
              {copied === "all-records" ? <CheckGlyph /> : <CopyGlyph />}
              {copied === "all-records" ? "Copied all" : "Copy all records"}
            </button>
          ) : null}
        </div>

        {records.length === 0 ? (
          <div className="cd-records-empty" role="status">
            <strong>No DNS records were returned.</strong>
            <span>
              This registration cannot be verified. Registration intake is held
              while the server contract is repaired.
            </span>
          </div>
        ) : (
          <div className="cd-record-list">
            {records.map((record, index) => (
              <DNSRecordCard
                key={`${record.type}-${record.name}-${index}`}
                record={record}
                index={index}
                copied={copied}
                onCopy={(key, value, label) => void onCopy(key, value, label)}
              />
            ))}
          </div>
        )}

        <p className="cd-dns-guidance">
          These are stored legacy values, not a current DNS instruction or
          routing promise. DNS re-check is release-held until the complete
          custom-domain serving lifecycle is qualified.
        </p>
      </section>

      <section
        className="cd-removal-boundary"
        aria-labelledby="cd-removal-title"
      >
        <div>
          <p>Dependency safety</p>
          <h3 id="cd-removal-title">Removal is intentionally held</h3>
          <span>
            Moosewave cannot yet prove that no form, link, archive, or external
            integration depends on this hostname. Destructive removal is not
            offered from this screen until that inventory is authoritative.
          </span>
        </div>
        <span className="cd-held-pill">Dependency graph required</span>
      </section>

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </SlideoverShell>
  );
}

/** Reset request/copy state when a different domain opens. */
export function CustomDomainSlideover(props: Props): ReactElement {
  return <CustomDomainSlideoverBody key={props.domain.id} {...props} />;
}
