// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Copy, Download, ExternalLink, Info } from "lucide-react";
import { toast } from "sonner";

import { CopyEntityLink } from "@/components/copy-entity-link";
import { PageShell } from "@/components/dashboard/page-shell";
import { DiagnosisCard } from "@/components/inbox-reality/diagnosis-card";
import { PlacementBar } from "@/components/inbox-reality/placement-bar";
import { ProviderTile } from "@/components/inbox-reality/provider-tile";
import { RecordLastViewed } from "@/components/record-last-viewed";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { copyToClipboard } from "@/lib/clipboard";
import { downloadTextFile } from "@/lib/download";
import { toCsv } from "@/lib/analytics-format";
import {
  diagnose,
  getAuthChecks,
  getCampaignReport,
  getReputation,
  type DiagnosisSignals,
} from "@/lib/inbox-reality-api";
import {
  isPlacementReportEmpty,
  normalizePredictedImpact,
  overallPlacementSummary,
} from "@/lib/inbox-reality-helpers";
import {
  ALL_PROVIDERS,
  PROVIDER_LABEL,
  summarizePlacement,
  type CampaignReport,
  type Diagnosis,
  type Placement,
  type Provider,
  type ProviderBreakdown,
} from "@/lib/inbox-reality-types";
import { asRoute } from "@/lib/typed-routes";

interface PageProps {
  params: Promise<{ id: string }>;
}

function emptyBreakdown(provider: Provider): ProviderBreakdown {
  return { provider, total: 0, placements: {} };
}

// Placement badge colors for the per-mailbox seed detail (INBOX-033).
const PLACEMENT_VARIANT: Record<
  Placement,
  "success" | "warning" | "destructive" | "outline"
> = {
  primary: "success",
  updates: "success",
  social: "success",
  promotions: "warning",
  spam: "destructive",
  blocked: "destructive",
  missing: "outline",
};

function diagnosisStorageKey(id: string): string {
  return `inbox-diagnosis:${id}`;
}

export default function CampaignReportPage({ params }: PageProps) {
  const { id } = use(params);
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [loadingDiagnosis, setLoadingDiagnosis] = useState(false);
  const [diagnosisError, setDiagnosisError] = useState<string | null>(null);
  const [signalsOpen, setSignalsOpen] = useState(false);
  const [seedOpen, setSeedOpen] = useState(false);
  const [diagnosisSignals, setDiagnosisSignals] =
    useState<DiagnosisSignals | null>(null);
  // Track load lifecycle so a failed fetch is visually distinct from a
  // still-pending one (otherwise a 404/proxy-down leaves a permanent skeleton).
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped by the Retry button to re-run the fetch effect after a failure.
  const [reloadKey, setReloadKey] = useState(0);

  // Rehydrate a previously-run diagnosis so it survives navigation/refresh
  // within the session (INBOX-028). The server has no GET-diagnosis-by-id
  // route, so cross-device/server persistence remains a backend gap.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.sessionStorage.getItem(diagnosisStorageKey(id));
      if (raw) {
        const parsed = JSON.parse(raw) as {
          diagnosis: Diagnosis;
          signals?: DiagnosisSignals;
        };
        if (parsed?.diagnosis) {
          setDiagnosis(parsed.diagnosis);
          if (parsed.signals) setDiagnosisSignals(parsed.signals);
        }
      }
    } catch {
      /* corrupt cache — ignore, user can re-run */
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCampaignReport(id)
      .then((r) => {
        if (!cancelled) {
          setReport(r);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          // Persist the failure into an error state (a toast is transient and
          // would otherwise leave the user on an infinite skeleton).
          setError(message);
          setLoading(false);
          toast.error("Failed to load campaign report", {
            description: message,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  // Tab title reflects the campaign so multiple open reports are
  // distinguishable (INBOX-038).
  useEffect(() => {
    if (!report) return;
    const previous = document.title;
    document.title = `${report.campaign_name || report.campaign_id} · Inbox Reality`;
    return () => {
      document.title = previous;
    };
  }, [report]);

  async function runDiagnostician() {
    if (!report) {
      toast.error("Campaign report is still loading.");
      return;
    }
    setLoadingDiagnosis(true);
    setDiagnosisError(null);
    try {
      const [reputation, authChecks] = await Promise.all([
        getReputation(),
        getAuthChecks(),
      ]);
      const auth = authChecks[0];
      if (!auth)
        throw new Error("No sender authentication check is available.");
      const signals: DiagnosisSignals = {
        campaign_id: id,
        domain: reputation.domain,
        ip: reputation.ip,
        auth,
        reputation,
        seedlist: report,
      };
      setDiagnosisSignals(signals);
      const d = await diagnose(id, signals);
      setDiagnosis(d);
      // Persist so it survives navigation/refresh (INBOX-028).
      try {
        window.sessionStorage.setItem(
          diagnosisStorageKey(id),
          JSON.stringify({ diagnosis: d, signals }),
        );
      } catch {
        /* storage full / unavailable — non-fatal */
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setDiagnosisError(message);
      toast.error("Diagnostician unavailable", { description: message });
    } finally {
      setLoadingDiagnosis(false);
    }
  }

  const actual = report
    ? overallPlacementSummary(report.overall_pct)
    : { primary: 0, promotions: 0, spam: 0 };
  const reportEmpty = report ? isPlacementReportEmpty(report) : true;
  const projected = diagnosis
    ? normalizePredictedImpact(diagnosis.predicted_impact)
    : null;
  const hasProjection =
    projected != null &&
    projected.primary + projected.promotions + projected.spam > 0;

  // Provider tiles: measured providers first (worst spam share first) so real
  // signal leads; untested providers sink to the end (INBOX-019).
  const providerTiles = useMemo(() => {
    const map = new Map<Provider, ProviderBreakdown>();
    for (const pb of report?.providers ?? []) map.set(pb.provider, pb);
    return ALL_PROVIDERS.map((p) => map.get(p) ?? emptyBreakdown(p)).sort(
      (a, b) => {
        const am = a.total > 0 ? 1 : 0;
        const bm = b.total > 0 ? 1 : 0;
        if (am !== bm) return bm - am;
        if (am === 0) return 0;
        return summarizePlacement(b).spam - summarizePlacement(a).spam;
      },
    );
  }, [report]);

  function downloadReportJson() {
    if (!report) return;
    downloadTextFile(
      `inbox-reality-${id}.json`,
      JSON.stringify(report, null, 2),
      "application/json;charset=utf-8",
    );
  }

  function downloadReportCsv() {
    if (!report) return;
    const cols: Placement[] = [
      "primary",
      "promotions",
      "updates",
      "social",
      "spam",
      "blocked",
      "missing",
    ];
    // Through the shared toCsv: pb.provider is a server-supplied string, so it
    // needs RFC-4180 quoting and the spreadsheet formula guard rather than a
    // bare join(",").
    downloadTextFile(
      `inbox-reality-${id}.csv`,
      `${toCsv([
        ["provider", "total", ...cols],
        ...report.providers.map((pb) => [
          pb.provider,
          pb.total,
          ...cols.map((c) => pb.placements[c] ?? 0),
        ]),
      ])}\r\n`,
      "text/csv;charset=utf-8",
    );
  }

  async function copyReportLink() {
    const result = await copyToClipboard(window.location.href);
    if (result === "copied") toast.success("Report link copied");
    else toast.error("Could not copy the report link.");
  }

  const signalsJson = useMemo(
    () =>
      JSON.stringify(
        diagnosisSignals ?? (report ? { seedlist: report } : {}),
        null,
        2,
      ),
    [diagnosisSignals, report],
  );

  async function copySignals() {
    const result = await copyToClipboard(signalsJson);
    if (result === "copied") toast.success("Signals JSON copied");
    else toast.error("Could not copy the signals.");
  }

  // Failed load: surface a recoverable error card instead of an endless
  // skeleton, with a Retry and a way back to the index.
  if (error && !report) {
    return (
      <PageShell className="[&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
        <header className="space-y-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Campaign report unavailable
          </h1>
          <p className="text-sm text-muted-foreground">
            The report could not be retrieved. Your campaign has not been
            changed.
          </p>
        </header>
        <Card role="alert">
          <CardHeader>
            <CardTitle>Couldn’t load this campaign report</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Button onClick={() => setReloadKey((k) => k + 1)}>Retry</Button>
            <Link
              href="/app/inbox-reality"
              className="inline-flex min-h-11 items-center rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
            >
              ← Back to Inbox Reality
            </Link>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  // Only show the skeleton while a request is genuinely in flight.
  if (loading || !report) {
    return (
      <PageShell className="[&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
        <div role="status" aria-busy="true" className="space-y-4">
          <h1 className="sr-only">Campaign placement report</h1>
          <span className="sr-only">Loading campaign placement report…</span>
          <Skeleton className="h-10 w-1/2" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </PageShell>
    );
  }

  const seedReports = report.reports ?? [];

  return (
    <PageShell className="[&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <RecordLastViewed entity="campaign" id={id} />

      {/* Shared detail-page header pattern: ArrowLeft back, deep-link copy,
          recently-viewed, and cross-links (INBOX-017 / INBOX-018). */}
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-3">
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
            aria-label="Back to Inbox Reality"
            title="Back to Inbox Reality"
          >
            <Link href="/app/inbox-reality">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              {report.campaign_name || report.campaign_id}
            </h1>
            <p className="text-sm text-muted-foreground">
              Sent{" "}
              {report.sent_at
                ? new Date(report.sent_at).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })
                : "(unknown)"}{" "}
              · {report.total_inboxes.toLocaleString()} seedlist mailboxes
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopyEntityLink
            entity="campaign"
            id={id}
            label="Copy campaign link"
            className="min-h-11 sm:min-h-8"
          />
          <Button
            asChild
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
          >
            <Link href={asRoute(`/app/campaigns/${id}`)}>
              <ExternalLink className="h-4 w-4" />
              Open campaign &amp; analytics
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            onClick={() => void copyReportLink()}
          >
            <Copy className="h-4 w-4" />
            Copy report link
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            onClick={downloadReportCsv}
          >
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            onClick={downloadReportJson}
          >
            <Download className="h-4 w-4" />
            Export JSON
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-1.5">
            <CardTitle>Overall placement</CardTitle>
            <Tooltip label="Primary includes updates + social. Spam includes blocked + missing.">
              <button
                type="button"
                className="inline-flex h-11 w-11 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8"
                aria-label="How the three placement buckets are grouped"
              >
                <Info className="h-4 w-4" aria-hidden />
              </button>
            </Tooltip>
          </div>
          <CardDescription>
            Aggregated across all seedlist providers.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {reportEmpty ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No placements were measured for this campaign yet. Once seedlist
              mailboxes report back, the distribution will appear here.
            </div>
          ) : (
            <>
              <div className="space-y-1">
                {hasProjection ? (
                  <p className="text-xs font-medium text-muted-foreground">
                    Actual
                  </p>
                ) : null}
                <PlacementBar
                  primary={actual.primary}
                  promotions={actual.promotions}
                  spam={actual.spam}
                  showLabels
                />
              </div>

              {/* Forecast-vs-actual: project post-fix placement beside the
                  realized numbers to close the loop (INBOX-035). */}
              {hasProjection && projected ? (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    Projected after applying the Diagnostician’s fixes
                  </p>
                  <PlacementBar
                    primary={projected.primary}
                    promotions={projected.promotions}
                    spam={projected.spam}
                    showLabels
                  />
                </div>
              ) : null}

              <p className="text-xs text-muted-foreground">
                Primary folds in updates + social; Spam folds in blocked +
                missing.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <section>
        <h2 className="text-lg font-semibold mb-3">Provider breakdown</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {providerTiles.map((bd) => (
            <ProviderTile key={bd.provider} breakdown={bd} />
          ))}
        </div>
      </section>

      {/* Per-mailbox seed detail — the exact mailboxes that landed in
          spam/blocked/missing (INBOX-033). Only when reports[] is present. */}
      {seedReports.length > 0 ? (
        <Card>
          <CardHeader>
            <button
              type="button"
              onClick={() => setSeedOpen((s) => !s)}
              className="flex min-h-11 w-full items-center justify-between rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={seedOpen}
            >
              <div>
                <CardTitle>Seed mailbox detail</CardTitle>
                <CardDescription>
                  Placement for each of the{" "}
                  {seedReports.length.toLocaleString()} seed mailboxes tested.
                </CardDescription>
              </div>
              <span className="text-muted-foreground text-sm">
                {seedOpen ? "▲ Hide" : "▼ Show"}
              </span>
            </button>
          </CardHeader>
          {seedOpen ? (
            <CardContent>
              <div
                role="region"
                aria-label="Seed mailbox detail"
                tabIndex={0}
                className="overflow-x-auto rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Provider
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Mailbox
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Placement
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Checked
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {seedReports.map((row, i) => (
                      <tr key={`${row.mailbox_id}-${i}`}>
                        <td className="px-3 py-2">
                          {PROVIDER_LABEL[row.provider] ?? row.provider}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {row.mailbox_id}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={PLACEMENT_VARIANT[row.placement]}>
                            {row.placement}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          <RelativeTime iso={row.checked_at} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          ) : null}
        </Card>
      ) : null}

      {!diagnosis && (
        <Card>
          <CardHeader>
            <CardTitle>AI Diagnostician</CardTitle>
            <CardDescription>
              Generate a plain-English diagnosis with ranked fixes for this
              campaign.
              {report.diagnostic_id ? (
                <>
                  {" "}
                  A diagnosis was generated earlier — run it again to view or
                  regenerate.
                </>
              ) : null}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={runDiagnostician}
              disabled={loadingDiagnosis}
              loading={loadingDiagnosis}
            >
              {loadingDiagnosis ? "Running…" : "Run AI Diagnostician"}
            </Button>
            {diagnosisError ? (
              <p role="alert" className="mt-3 text-sm text-destructive">
                The Diagnostician could not run: {diagnosisError}
              </p>
            ) : null}
            {/* Skeleton preview of the diagnosis/fix area during the (possibly
                multi-second) AI call (INBOX-021). */}
            {loadingDiagnosis ? (
              <div className="mt-4 space-y-3" data-testid="diagnosis-skeleton">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      {diagnosis && <DiagnosisCard diagnosis={diagnosis} campaignId={id} />}

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <button
              type="button"
              onClick={() => setSignalsOpen((s) => !s)}
              className="flex min-h-11 flex-1 items-center justify-between rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={signalsOpen}
            >
              <div>
                <CardTitle>All signals</CardTitle>
                <CardDescription>
                  Raw layer-1 to layer-4 inputs the Diagnostician sees.
                </CardDescription>
              </div>
              <span className="text-muted-foreground text-sm">
                {signalsOpen ? "▲ Hide" : "▼ Show"}
              </span>
            </button>
          </div>
        </CardHeader>
        {signalsOpen && (
          <CardContent className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void copySignals()}
              >
                <Copy className="h-3.5 w-3.5" />
                Copy JSON
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  downloadTextFile(
                    `inbox-reality-signals-${id}.json`,
                    signalsJson,
                    "application/json;charset=utf-8",
                  )
                }
              >
                <Download className="h-3.5 w-3.5" />
                Download JSON
              </Button>
            </div>
            <pre
              tabIndex={0}
              role="group"
              aria-label="Raw deliverability signals"
              className="text-xs bg-muted rounded p-3 overflow-x-auto font-mono max-h-[480px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {signalsJson}
            </pre>
          </CardContent>
        )}
      </Card>
    </PageShell>
  );
}
