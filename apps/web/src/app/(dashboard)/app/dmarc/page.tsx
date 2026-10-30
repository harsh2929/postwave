// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * DMARC — what receivers reported, and what silence does not prove.
 *
 * Four `/api/v1/deliverability/dmarc-*` paths desktop reached and web did not.
 *
 * ZERO REPORTS IS NOT ZERO MAIL. The server's own suggestion for the empty case
 * says report cadence is controlled by participating receivers, "so this state
 * does not prove that the domain is configured or that no mail was sent". A
 * page that shows "0 reports · 0 messages" and stops invites exactly the two
 * conclusions that sentence rules out, so the suggestions are rendered verbatim
 * and lead the page when there is nothing else to show.
 *
 * EVIDENCE SCOPE. Insights and the report list are both read for ONE
 * (domain, window) slice — the same slice, so the rollup and the rows it was
 * rolled up from never disagree. The window is computed when the range is
 * chosen or the page is refreshed, not on every render: `from`/`to` are part
 * of the query key, and a key that moved every millisecond would never hit.
 *
 * THE LIST IS ONE BOUNDED PAGE. There is no continuation cursor; `hasMore` is
 * the only signal that rows were cut at the limit. Filter, search and export
 * therefore operate on the LOADED rows and say so, and the CSV carries a
 * receipt naming its scope, its snapshot and whether it is partial.
 *
 * SOURCES ARE THE SERVER'S RANKING, NOT AN INVENTORY. The insights payload
 * carries the top sources (and the top failing ones); each IP opens its
 * per-report evidence (GET dmarc-sources) for the scope that ranked it. While
 * a new scope is being read the previous ranking stays visible but cannot be
 * opened, for the same reason the report table dims.
 */

import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, Inbox } from "lucide-react";
import { toast } from "sonner";

import { PageShell } from "@/components/dashboard/page-shell";
import { ContentQueryError } from "../_content-automation/content-query-error";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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
import { whoami } from "@/lib/auth-api";
import {
  buildDmarcCsv,
  DMARC_RANGES,
  DMARC_REPORT_LIMIT,
  dmarcExportFilename,
  filterDmarcReports,
  getDmarcInsights,
  listDmarcReports,
  rangeDays,
  rangeStart,
  type DmarcRange,
  type DmarcReportFilter,
  type DmarcReportRow,
  type DmarcSource,
} from "@/lib/dmarc-api";
import { downloadTextFile } from "@/lib/download";
import { base, qk, STALE } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

import {
  dmarcPolicyLabel,
  formatDmarcPeriod,
  ReportDetailDialog,
} from "./_components/report-detail-dialog";
import {
  SourceDetailDialog,
  type DmarcSourceScope,
} from "./_components/source-detail-dialog";
import { DmarcTopSourcesTable } from "./_components/top-sources-table";

interface EvidenceWindow {
  range: DmarcRange;
  days: number;
  from: string;
  to: string;
  /** Bumped by an explicit refresh so the key changes even inside one ms. */
  generation: number;
}

function computeWindow(range: DmarcRange, generation: number): EvidenceWindow {
  const now = new Date();
  return {
    range,
    days: rangeDays(range),
    from: rangeStart(range, now),
    to: now.toISOString(),
    generation,
  };
}

const REPORT_FILTERS: ReadonlyArray<[DmarcReportFilter, string]> = [
  ["all", "All loaded"],
  ["aligned", "Fully aligned"],
  ["failed", "Has unaligned"],
];

export default function DmarcPage() {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const canLoad = Boolean(
    meQuery.isSuccess && meQuery.data?.tenant_id && meQuery.data?.user_id,
  );
  const keyBase = useMemo(
    () =>
      base(
        "dmarc",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  const [domain, setDomain] = useState("");
  const [evidence, setEvidence] = useState<EvidenceWindow>(() =>
    computeWindow("30d", 0),
  );
  const [filter, setFilter] = useState<DmarcReportFilter>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<DmarcReportRow | null>(null);
  const [sourceScope, setSourceScope] = useState<DmarcSourceScope | null>(null);

  const scopeKey = domain || "*";
  const insights = useQuery({
    queryKey: [
      ...keyBase,
      "insights",
      scopeKey,
      evidence.days,
      evidence.generation,
    ],
    queryFn: () =>
      getDmarcInsights({
        ...(domain ? { domain } : {}),
        days: evidence.days,
      }),
    enabled: canLoad,
    staleTime: STALE.dashboard,
    placeholderData: keepPreviousData,
  });
  const reports = useQuery({
    queryKey: [
      ...keyBase,
      "reports",
      scopeKey,
      evidence.from,
      evidence.to,
      evidence.generation,
    ],
    queryFn: () =>
      listDmarcReports({
        ...(domain ? { domain } : {}),
        from: evidence.from,
        to: evidence.to,
        limit: DMARC_REPORT_LIMIT,
      }),
    enabled: canLoad,
    staleTime: STALE.dashboard,
    placeholderData: keepPreviousData,
  });

  const refreshing = insights.isFetching || reports.isFetching;
  const refresh = () =>
    setEvidence((prev) => computeWindow(prev.range, prev.generation + 1));
  const selectRange = (range: DmarcRange) =>
    setEvidence((prev) => computeWindow(range, prev.generation));

  const d = insights.data;
  const hasReports = (d?.reportCount ?? 0) > 0;
  // A ranking held over from the previous scope must not open against the
  // newly selected one — the IP may not even appear there.
  const openSource = insights.isPlaceholderData
    ? undefined
    : (source: DmarcSource) =>
        setSourceScope({
          ip: source.sourceIp,
          domain,
          days: evidence.days,
          generation: evidence.generation,
        });
  const page = reports.data;

  // The inventory is tenant-wide on the server, so it does not collapse to the
  // selected domain; the selection is still added in case the inventory was
  // truncated at 500 and the chosen domain fell outside it.
  const domains = useMemo(() => {
    const set = new Set(page?.availableDomains ?? []);
    if (domain) set.add(domain);
    return [...set].sort();
  }, [page?.availableDomains, domain]);

  const rows = useMemo(
    () => (page ? filterDmarcReports(page.items, filter, search) : []),
    [page, filter, search],
  );
  // keepPreviousData holds the last scope's receipts on screen while a newly
  // chosen domain or window is read, but the selector already reads as the new
  // scope. Without this the table silently attributes one domain's evidence to
  // another — the same hazard the CSV receipt records as `stale`.
  const showingPreviousScope = reports.isPlaceholderData;

  const exportRows = () => {
    if (!page || rows.length === 0) return;
    const csv = buildDmarcCsv(rows, {
      exportedAt: new Date().toISOString(),
      snapshotGeneratedAt: page.generatedAt,
      scopeDomain: page.scope.domain ?? "",
      scopeFrom: page.scope.from ?? "",
      scopeTo: page.scope.to ?? "",
      scopeWindowDays: evidence.days,
      localFilter: filter,
      localQuery: search.trim(),
      totalReports: page.totalReports,
      partial: page.hasMore,
      // Placeholder rows belong to the previous scope while the new one loads.
      stale: reports.isPlaceholderData,
    });
    downloadTextFile(
      dmarcExportFilename(evidence.range, domain),
      csv,
      "text/csv;charset=utf-8",
    );
    toast.success("Download started with its evidence receipt.");
  };

  if (!canLoad) {
    return (
      <PageShell className="max-w-5xl">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          DMARC
        </h1>
        {meQuery.isPending ? (
          <p role="status">Loading workspace identity…</p>
        ) : (
          <ContentQueryError
            message="Workspace identity could not be loaded. No private data was requested."
            onRetry={() => meQuery.refetch()}
            retrying={meQuery.isFetching}
          />
        )}
      </PageShell>
    );
  }

  return (
    <PageShell className="max-w-5xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            DMARC
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What receiving mail servers reported about mail claiming to be from
            you.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={refresh}
          disabled={refreshing}
          aria-busy={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh evidence"}
        </Button>
      </header>

      <section
        aria-label="DMARC evidence scope"
        className="grid gap-4 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:p-6"
      >
        <div>
          <Label htmlFor="dmarc-domain">Sending domain</Label>
          <Select
            id="dmarc-domain"
            className="mt-1"
            value={domain}
            aria-describedby="dmarc-domain-hint"
            onChange={(event) => setDomain(event.currentTarget.value)}
          >
            <option value="">All available domains</option>
            {domains.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </Select>
          <p
            id="dmarc-domain-hint"
            className="mt-1 text-xs text-muted-foreground"
          >
            {page?.domainInventoryTruncated
              ? "Domains with stored aggregate reports. The inventory is cut at 500, so a domain can have reports without appearing here."
              : "Domains with stored aggregate reports. This is not a DNS inventory."}
          </p>
        </div>
        <fieldset>
          <legend className="text-sm font-medium">Evidence window</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {DMARC_RANGES.map((candidate) => {
              const pressed = candidate.value === evidence.range;
              return (
                <Button
                  key={candidate.value}
                  type="button"
                  size="sm"
                  variant={pressed ? "default" : "outline"}
                  aria-pressed={pressed}
                  onClick={() => selectRange(candidate.value)}
                >
                  {candidate.label}
                </Button>
              );
            })}
          </div>
        </fieldset>
      </section>

      {insights.isPending ? (
        <div role="status" aria-busy="true" className="space-y-3">
          <span className="sr-only">Loading DMARC insights…</span>
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : insights.isError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4"
        >
          <p className="text-sm text-destructive">
            {apiErrorMessage(insights.error, "Could not load DMARC insights.")}{" "}
            No quiet window is being presented as healthy.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void insights.refetch()}
            disabled={insights.isFetching}
          >
            {insights.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      ) : d ? (
        <>
          {d.suggestions.length > 0 ? (
            <section
              aria-labelledby="dm-suggestions"
              className="rounded-lg border p-4 sm:p-6"
            >
              <h2 id="dm-suggestions" className="text-base font-medium">
                What to do
              </h2>
              <ul className="mt-2 space-y-3">
                {d.suggestions.map((sug) => (
                  <li key={sug.code}>
                    <p className="text-sm font-medium">{sug.action}</p>
                    {/* The server's reasoning, verbatim — it is the part that
                        stops a reader drawing the wrong conclusion from a
                        quiet window. */}
                    <p className="mt-1 text-sm text-muted-foreground">
                      {sug.reason}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section
            aria-labelledby="dm-window"
            className="rounded-lg border p-4 sm:p-6"
          >
            <h2 id="dm-window" className="text-base font-medium">
              Last {d.periodDays} days
              {d.domain ? ` · ${d.domain}` : ""}
            </h2>
            <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Reports", d.reportCount],
                ["Messages", d.totalMessages],
                ["Sources", d.sourceCount],
                ["Days with a report", d.reportingDays],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-md bg-muted/40 p-3">
                  <dt className="text-xs uppercase text-muted-foreground">
                    {label}
                  </dt>
                  <dd className="text-lg tabular-nums">
                    {Number(value).toLocaleString()}
                  </dd>
                </div>
              ))}
            </dl>
            {d.sourceListTruncated ? (
              // A truncated list looks exactly like a complete one otherwise.
              <p className="mt-2 text-sm text-muted-foreground">
                The source list is truncated — there are more sending sources
                than shown.
              </p>
            ) : null}
          </section>

          <section
            aria-labelledby="dm-alignment"
            className="rounded-lg border p-4 sm:p-6"
          >
            <h2 id="dm-alignment" className="text-base font-medium">
              Alignment
            </h2>
            {hasReports ? (
              <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  ["Both pass", d.alignment.bothPass],
                  ["DKIM only", d.alignment.dkimOnlyPass],
                  ["SPF only", d.alignment.spfOnlyPass],
                  ["Neither", d.alignment.neitherPass],
                ].map(([label, value]) => (
                  <div
                    key={String(label)}
                    className="rounded-md bg-muted/40 p-3"
                  >
                    <dt className="text-xs uppercase text-muted-foreground">
                      {label}
                    </dt>
                    <dd className="text-lg tabular-nums">
                      {Number(value).toLocaleString()}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              // Four zeros here would read as "everything failed alignment".
              <p className="mt-1 text-sm text-muted-foreground">
                No alignment figures yet — they are derived from reports, and
                none have arrived in this window.
              </p>
            )}
          </section>

          <section
            aria-labelledby="dm-sources"
            aria-busy={insights.isPlaceholderData}
            className={cn(
              "rounded-lg border p-4 sm:p-6",
              insights.isPlaceholderData && "opacity-60",
            )}
          >
            <h2 id="dm-sources" className="text-base font-medium">
              Sending sources
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {insights.isPlaceholderData
                ? "Showing the previously loaded ranking while the new scope is read — its sources cannot be opened until it arrives."
                : `${d.sourceCount.toLocaleString()} ${d.sourceCount === 1 ? "source IP" : "source IPs"} observed. ${
                    d.sourceListTruncated
                      ? `This is the server's top ${d.topSources.length.toLocaleString()}, not a complete source inventory.`
                      : "All observed sources are ranked."
                  } Open a source for its per-report evidence.`}
            </p>
            {d.topFailingSources.length > 0 ? (
              <DmarcTopSourcesTable
                id="dm-sources-failing"
                title="Sources needing investigation"
                description="Ranked by unaligned volume. A failure is evidence to investigate, not proof of spoofing."
                sources={d.topFailingSources}
                emptyState=""
                onSelect={openSource}
              />
            ) : null}
            <DmarcTopSourcesTable
              id="dm-sources-top"
              title="Top observed sources"
              description="Ranked by message volume. DMARC evidence does not identify who operates an IP or why it sent."
              sources={d.topSources}
              emptyState={
                hasReports
                  ? "No source IPs were present in this snapshot."
                  : "No sources yet — they are derived from reports, and none have arrived in this window."
              }
              onSelect={openSource}
            />
          </section>
        </>
      ) : null}

      <section
        aria-labelledby="dm-reports"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="dm-reports" className="text-base font-medium">
          Report receipts
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {showingPreviousScope
            ? "Showing the previously loaded scope while the new one is read — these rows do not belong to the selected domain and window yet."
            : page
              ? page.hasMore
                ? `Showing the first ${page.returned.toLocaleString()} of ${page.totalReports.toLocaleString()} reports in this window. The list has no continuation cursor, so an export from it is partial and its receipt says so.`
                : `${page.totalReports.toLocaleString()} ${page.totalReports === 1 ? "report" : "reports"} in this window, all loaded.`
              : "Stored aggregate reports for the selected domain and window."}
        </p>

        {reports.isPending ? (
          <div role="status" aria-busy="true" className="mt-3 space-y-3">
            <span className="sr-only">Loading DMARC reports…</span>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : reports.isError ? (
          <div
            role="alert"
            className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4"
          >
            <p className="text-sm text-destructive">
              {apiErrorMessage(reports.error, "Could not load DMARC reports.")}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void reports.refetch()}
              disabled={reports.isFetching}
            >
              {reports.isFetching ? "Retrying…" : "Retry"}
            </Button>
          </div>
        ) : page ? (
          <>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div className="min-w-[14rem] flex-1">
                <Label htmlFor="dmarc-search">Find a loaded report</Label>
                <Input
                  id="dmarc-search"
                  type="search"
                  className="mt-1"
                  value={search}
                  maxLength={256}
                  placeholder="Domain, organization, or report ID"
                  onChange={(event) => setSearch(event.currentTarget.value)}
                />
              </div>
              <div
                role="group"
                aria-label="Filter loaded reports by alignment result"
                className="flex flex-wrap gap-2"
              >
                {REPORT_FILTERS.map(([value, label]) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={filter === value ? "default" : "outline"}
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={exportRows}
                disabled={rows.length === 0}
              >
                <Download aria-hidden className="mr-2 h-4 w-4" />
                Export {rows.length.toLocaleString()} loaded{" "}
                {rows.length === 1 ? "row" : "rows"}
              </Button>
            </div>

            {rows.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title={
                  page.items.length === 0
                    ? "No reports in this window"
                    : "No loaded report matches"
                }
                description={
                  page.items.length === 0
                    ? "No aggregate reports are stored for this scope and window. Receivers control report cadence, so an empty window is not evidence that no mail was sent."
                    : "Clear the search or choose a different alignment filter. Only the loaded rows are searched."
                }
              />
            ) : (
              <TableContainer
                aria-labelledby="dm-reports"
                aria-busy={showingPreviousScope}
                className={cn("mt-4", showingPreviousScope && "opacity-60")}
              >
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Report period</TableHead>
                      <TableHead>Sending domain</TableHead>
                      <TableHead>Reporting organization</TableHead>
                      <TableHead className="text-right">Messages</TableHead>
                      <TableHead className="text-right">Aligned</TableHead>
                      <TableHead className="text-right">Unaligned</TableHead>
                      <TableHead>Policy</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((report) => (
                      <TableRow key={report.id}>
                        <TableCell>
                          <button
                            type="button"
                            className="text-left underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => setSelected(report)}
                            aria-label={`Open ${formatDmarcPeriod(report.dateBegin, report.dateEnd)} report from ${report.orgName} for ${report.domain}`}
                          >
                            {formatDmarcPeriod(
                              report.dateBegin,
                              report.dateEnd,
                            )}
                          </button>
                        </TableCell>
                        <TableCell>{report.domain}</TableCell>
                        <TableCell>{report.orgName}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {(
                            report.passCount + report.failCount
                          ).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {report.passCount.toLocaleString()}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right tabular-nums",
                            report.failCount > 0 && "text-destructive",
                          )}
                        >
                          {report.failCount.toLocaleString()}
                        </TableCell>
                        <TableCell>
                          {dmarcPolicyLabel(report.policyP)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </>
        ) : null}
      </section>

      <ReportDetailDialog report={selected} onClose={() => setSelected(null)} />
      <SourceDetailDialog
        scope={sourceScope}
        keyBase={keyBase}
        onClose={() => setSourceScope(null)}
      />
    </PageShell>
  );
}
