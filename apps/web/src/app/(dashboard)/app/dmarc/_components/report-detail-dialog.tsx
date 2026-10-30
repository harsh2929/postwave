// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * One DMARC aggregate report, rendered from the list row it came from.
 *
 * Desktop opens this as a slideover (components/DmarcReportSlideover.tsx);
 * web has no sheet primitive, so the same fields sit in a Dialog. No extra
 * request is made: the list projection already carries everything the
 * tenant-facing detail is allowed to show. The original XML and the
 * reporter's contact address are deliberately not part of that projection.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DmarcReportRow } from "@/lib/dmarc-api";
import { cn } from "@/lib/utils";

export function formatDmarcDate(value: string): string {
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

export function formatDmarcPeriod(begin: string, end: string): string {
  return `${formatDmarcDate(begin)} – ${formatDmarcDate(end)}`;
}

/** The policy value carried INSIDE the report — evidence, not a DNS lookup. */
export function dmarcPolicyLabel(policy: string): string {
  if (policy === "none") return "p=none · monitoring";
  if (policy === "quarantine") return "p=quarantine";
  if (policy === "reject") return "p=reject";
  return "Not reported";
}

/** Aligned share as a percentage string, or null when there is no denominator. */
export function dmarcAlignedShare(report: DmarcReportRow): string | null {
  const total = report.passCount + report.failCount;
  if (total === 0) return null;
  const share = report.passCount / total;
  return `${(share * 100).toFixed(share >= 0.995 ? 2 : 1)}%`;
}

export function ReportDetailDialog({
  report,
  onClose,
}: {
  report: DmarcReportRow | null;
  onClose: () => void;
}) {
  const total = report ? report.passCount + report.failCount : 0;
  const share = report ? dmarcAlignedShare(report) : null;

  return (
    <Dialog
      open={report !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {report ? (
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Validated report receipt
            </p>
            <DialogTitle className="font-display">{report.domain}</DialogTitle>
            <DialogDescription>{report.orgName}</DialogDescription>
          </DialogHeader>

          <div className="rounded-md bg-muted/40 p-3 text-sm">
            <span className="text-xs uppercase text-muted-foreground">
              Report period
            </span>
            <p className="mt-0.5 font-medium">
              {formatDmarcPeriod(report.dateBegin, report.dateEnd)}
            </p>
          </div>

          <dl
            aria-label="Report message summary"
            className="grid grid-cols-3 gap-3"
          >
            <div className="rounded-md bg-muted/40 p-3">
              <dt className="text-xs uppercase text-muted-foreground">
                Messages
              </dt>
              <dd className="text-lg tabular-nums">
                {total.toLocaleString()}
              </dd>
            </div>
            <div className="rounded-md bg-muted/40 p-3">
              <dt className="text-xs uppercase text-muted-foreground">
                Aligned
              </dt>
              <dd className="text-lg tabular-nums">
                {report.passCount.toLocaleString()}
                <span className="ml-1 text-xs text-muted-foreground">
                  {share ?? "No denominator"}
                </span>
              </dd>
            </div>
            <div className="rounded-md bg-muted/40 p-3">
              <dt className="text-xs uppercase text-muted-foreground">
                Unaligned
              </dt>
              <dd
                className={cn(
                  "text-lg tabular-nums",
                  report.failCount > 0 && "text-destructive",
                )}
              >
                {report.failCount.toLocaleString()}
              </dd>
            </div>
          </dl>

          {total === 0 ? (
            <p role="note" className="text-sm text-muted-foreground">
              This report contains no messages. No alignment percentage is
              inferred.
            </p>
          ) : null}

          <section aria-labelledby="dmarc-report-policy" className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Policy evidence
            </p>
            <h3 id="dmarc-report-policy" className="text-base font-medium">
              {dmarcPolicyLabel(report.policyP)}
            </h3>
            <dl className="grid gap-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">
                  Legacy pct observation
                </dt>
                <dd>
                  {report.policyPct === null
                    ? "Not reported"
                    : `${report.policyPct}%`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Reporting organization
                </dt>
                <dd className="break-words">{report.orgName}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Ingested</dt>
                <dd>{formatDmarcDate(report.receivedAt)}</dd>
              </div>
            </dl>
            <p role="note" className="text-sm text-muted-foreground">
              This is the policy value carried by the aggregate-report payload.
              It is not a live DNS observation, a reporter-authenticity
              verdict, or a complete TXT record. The historical pct tag was
              removed from the current DMARC specification; retain it only as
              legacy report evidence.
            </p>
          </section>

          <section
            aria-labelledby="dmarc-report-provenance"
            className="space-y-2"
          >
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Provenance
            </p>
            <h3 id="dmarc-report-provenance" className="text-base font-medium">
              Report identifiers
            </h3>
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">
                  Payload report ID
                </dt>
                <dd>
                  <code className="break-all text-xs">{report.reportId}</code>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Moosewave receipt ID
                </dt>
                <dd>
                  <code className="break-all text-xs">{report.id}</code>
                </dd>
              </div>
            </dl>
            <p className="text-xs text-muted-foreground">
              The original XML and reporter contact address are not exposed in
              this tenant-facing detail view.
            </p>
          </section>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
