// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Aggregate evidence for one sending source (parity row deliverability-10).
 *
 * Desktop opens this as a slideover (components/dmarc/DmarcSourceSlideover.tsx);
 * web has no sheet primitive, so — like the report detail beside it — the
 * same evidence sits in a Dialog. Unlike the report detail this one makes a
 * request: GET /api/v1/deliverability/dmarc-sources?ip&domain&days, for the
 * scope that was on screen when the source was opened.
 *
 * THE SCOPE IS CAPTURED AT OPEN. The caller passes the domain, window and
 * refresh generation that produced the ranking the IP came from, and they are
 * part of the query key, so the evidence here can never belong to a different
 * domain or window than the row that was clicked.
 *
 * THE PER-REPORT LIST IS BOUNDED. The source totals cover the whole scope;
 * the per-report table stops at the server limit with no continuation cursor,
 * and `hasMore` is the only signal. It is rendered as a partial list when set.
 */

import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiErrorMessage } from "@/lib/api";
import {
  dmarcDispositionLabel,
  dmarcSourceAlignedShare,
  getDmarcSourceDetail,
} from "@/lib/dmarc-api";
import { STALE } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

import { formatDmarcDate } from "./report-detail-dialog";

/** The scope a source was opened from. */
export interface DmarcSourceScope {
  ip: string;
  /** "" = every domain with stored reports. */
  domain: string;
  days: number;
  /** The page's refresh generation, so "Refresh evidence" re-reads this too. */
  generation: number;
}

function formatDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function SourceDetailDialog({
  scope,
  keyBase,
  onClose,
}: {
  scope: DmarcSourceScope | null;
  /** The page's tenant/role-scoped key base. */
  keyBase: readonly unknown[];
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: [
      ...keyBase,
      "source",
      scope?.ip ?? "",
      scope?.domain || "*",
      scope?.days ?? 0,
      scope?.generation ?? 0,
    ],
    queryFn: () => {
      // `enabled` keeps this from running without a scope; the guard only
      // narrows the type.
      if (!scope) throw new Error("No DMARC source is selected.");
      return getDmarcSourceDetail({
        ip: scope.ip,
        ...(scope.domain ? { domain: scope.domain } : {}),
        days: scope.days,
      });
    },
    enabled: scope !== null,
    staleTime: STALE.dashboard,
  });

  const data = detail.data;
  const summary = data?.summary;
  const aligned = summary
    ? summary.dkimPass + summary.spfPass - summary.bothPass
    : 0;

  return (
    <Dialog
      open={scope !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {scope ? (
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Source evidence
            </p>
            <DialogTitle className="font-display">
              <code>{scope.ip}</code>
            </DialogTitle>
            <DialogDescription>
              {scope.domain || "All available domains"} · {scope.days}-day
              window
            </DialogDescription>
          </DialogHeader>

          <p role="note" className="text-sm text-muted-foreground">
            An IP and alignment result do not identify the sender or prove
            malicious intent. Confirm ownership and message flow before changing
            authentication.
          </p>

          {detail.isError ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3"
            >
              <p className="text-sm text-destructive">
                {apiErrorMessage(
                  detail.error,
                  "Source detail could not be loaded.",
                )}{" "}
                {data
                  ? "The last loaded snapshot for this source remains visible."
                  : "No source metrics have been inferred."}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void detail.refetch()}
                disabled={detail.isFetching}
              >
                {detail.isFetching ? "Retrying…" : "Retry"}
              </Button>
            </div>
          ) : null}

          {detail.isPending ? (
            <p role="status" aria-busy="true" className="text-sm">
              Validating source evidence…
            </p>
          ) : null}

          {data && summary ? (
            <>
              <p className="text-xs text-muted-foreground">
                {detail.isFetching ? "Refreshing snapshot" : "Snapshot"}{" "}
                <span className="font-medium text-foreground">
                  {formatDmarcDate(data.generatedAt)}
                </span>
              </p>

              <dl
                aria-label="Source message summary"
                className="grid grid-cols-1 gap-3 sm:grid-cols-3"
              >
                <div className="rounded-md bg-muted/40 p-3">
                  <dt className="text-xs uppercase text-muted-foreground">
                    Messages
                  </dt>
                  <dd className="text-lg tabular-nums">
                    {summary.messages.toLocaleString()}
                  </dd>
                </div>
                <div className="rounded-md bg-muted/40 p-3">
                  <dt className="text-xs uppercase text-muted-foreground">
                    Aligned
                  </dt>
                  <dd className="text-lg tabular-nums">
                    {dmarcSourceAlignedShare(
                      summary.alignedPct,
                      summary.messages,
                    ) ?? "Not observed"}
                    <span className="ml-1 text-xs text-muted-foreground">
                      {summary.messages === 0
                        ? "No denominator"
                        : `${aligned.toLocaleString()} ${aligned === 1 ? "message" : "messages"}`}
                    </span>
                  </dd>
                </div>
                <div className="rounded-md bg-muted/40 p-3">
                  <dt className="text-xs uppercase text-muted-foreground">
                    Primary action
                  </dt>
                  <dd
                    className={cn(
                      "text-lg",
                      summary.quarantined + summary.rejected > 0 &&
                        "text-destructive",
                    )}
                  >
                    {dmarcDispositionLabel(summary.primaryDisposition)}
                    <span className="block text-xs text-muted-foreground">
                      {summary.quarantined.toLocaleString()} quarantine ·{" "}
                      {summary.rejected.toLocaleString()} reject
                    </span>
                  </dd>
                </div>
              </dl>

              {summary.envelopeFromDomain ? (
                <section
                  aria-labelledby="dmarc-source-envelope"
                  className="space-y-1"
                >
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Observed identifier
                  </p>
                  <h3
                    id="dmarc-source-envelope"
                    className="text-base font-medium"
                  >
                    Envelope-from domain
                  </h3>
                  <code className="break-all text-sm">
                    {summary.envelopeFromDomain}
                  </code>
                  <p className="text-xs text-muted-foreground">
                    Only the canonical hostname is exposed. Mailbox local-parts
                    are intentionally withheld, and this is not a complete
                    identity inventory.
                  </p>
                </section>
              ) : null}

              <section
                aria-labelledby="dmarc-source-contributions"
                className="space-y-2"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3
                    id="dmarc-source-contributions"
                    className="text-base font-medium"
                  >
                    Per-report breakdown
                  </h3>
                  <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                    {data.hasMore ? "Partial list" : "Complete list"}
                  </span>
                </div>
                {data.hasMore ? (
                  <p role="note" className="text-sm text-muted-foreground">
                    Source totals cover the complete scope; this table stops at
                    the first {data.perReport.length.toLocaleString()} reports.
                    There is no continuation cursor, so it is not a complete
                    per-report inventory.
                  </p>
                ) : null}
                {data.perReport.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No report in this scope carried records for this source.
                  </p>
                ) : (
                  <TableContainer aria-labelledby="dmarc-source-contributions">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Reporting organization</TableHead>
                          <TableHead>Period</TableHead>
                          <TableHead className="text-right">Messages</TableHead>
                          <TableHead className="text-right">Aligned</TableHead>
                          <TableHead>Primary action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.perReport.map((report) => (
                          <TableRow key={report.reportId}>
                            <TableCell>
                              {report.orgName}
                              <span className="sr-only">
                                {` · report receipt ${report.reportId}`}
                              </span>
                            </TableCell>
                            <TableCell>
                              {formatDay(report.dateBegin)} –{" "}
                              {formatDay(report.dateEnd)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {report.messages.toLocaleString()}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {dmarcSourceAlignedShare(
                                report.alignedPct,
                                report.messages,
                              ) ?? "Not observed"}
                            </TableCell>
                            <TableCell>
                              {dmarcDispositionLabel(report.primaryDisposition)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}
              </section>
            </>
          ) : null}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
