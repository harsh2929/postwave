import type { ReactElement, RefObject } from "react";

import type { DmarcReport } from "../lib/api-client";
import { SlideoverShell } from "./SlideoverShell";

interface Props {
  report: DmarcReport;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function formatPeriod(begin: string, end: string): string {
  return `${formatDate(begin)} – ${formatDate(end)}`;
}

function policyLabel(policy: DmarcReport["policyP"]): string {
  if (policy === "none") return "p=none · monitoring";
  if (policy === "quarantine") return "p=quarantine";
  if (policy === "reject") return "p=reject";
  return "Not reported";
}

export function DmarcReportSlideover({
  report,
  onClose,
  returnFocusRef,
}: Props): ReactElement {
  const total = report.passCount + report.failCount;
  const alignment = total > 0 ? report.passCount / total : null;

  return (
    <SlideoverShell
      open
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      size="md"
      className="dmarc-detail-slideover"
      eyebrow="Validated report receipt"
      title={report.domain}
      subtitle={report.orgName}
    >
      <div className="dmarc-detail-scope">
        <span>Report period</span>
        <strong>{formatPeriod(report.dateBegin, report.dateEnd)}</strong>
      </div>

      <section
        className="dmarc-detail-metrics"
        aria-label="Report message summary"
      >
        <div>
          <span>Messages</span>
          <strong>{total.toLocaleString()}</strong>
        </div>
        <div>
          <span>Aligned</span>
          <strong>{report.passCount.toLocaleString()}</strong>
          <small>
            {alignment === null
              ? "No denominator"
              : `${(alignment * 100).toFixed(alignment >= 0.995 ? 2 : 1)}%`}
          </small>
        </div>
        <div data-tone={report.failCount > 0 ? "negative" : undefined}>
          <span>Unaligned</span>
          <strong>{report.failCount.toLocaleString()}</strong>
        </div>
      </section>

      {total === 0 ? (
        <div className="dmarc-detail-boundary" role="note">
          This report contains no messages. No alignment percentage is inferred.
        </div>
      ) : null}

      <section
        className="dmarc-detail-section"
        aria-labelledby="dmarc-report-policy"
      >
        <p className="dmarc-kicker">Policy evidence</p>
        <h3 id="dmarc-report-policy">{policyLabel(report.policyP)}</h3>
        <dl className="dmarc-detail-list">
          <div>
            <dt>Legacy pct observation</dt>
            <dd>
              {report.policyPct === null
                ? "Not reported"
                : `${report.policyPct}%`}
            </dd>
          </div>
          <div>
            <dt>Reporting organization</dt>
            <dd>{report.orgName}</dd>
          </div>
          <div>
            <dt>Ingested</dt>
            <dd>{formatDate(report.receivedAt)}</dd>
          </div>
        </dl>
        <div className="dmarc-detail-boundary" role="note">
          This is the policy value carried by the aggregate-report payload. It
          is not a live DNS observation, a reporter-authenticity verdict, or a
          complete TXT record. The historical pct tag was removed from the
          current DMARC specification; retain it only as legacy report evidence.
        </div>
      </section>

      <section
        className="dmarc-detail-section"
        aria-labelledby="dmarc-report-provenance"
      >
        <p className="dmarc-kicker">Provenance</p>
        <h3 id="dmarc-report-provenance">Report identifiers</h3>
        <dl className="dmarc-detail-list dmarc-detail-list--stacked">
          <div>
            <dt>Payload report ID</dt>
            <dd>
              <code>{report.reportId}</code>
            </dd>
          </div>
          <div>
            <dt>Moosewave receipt ID</dt>
            <dd>
              <code>{report.id}</code>
            </dd>
          </div>
        </dl>
        <p className="dmarc-detail-footnote">
          The original XML and reporter contact address are not exposed in this
          tenant-facing detail view.
        </p>
      </section>
    </SlideoverShell>
  );
}
