// SPDX-License-Identifier: AGPL-3.0-only
import { ChevronRight, ExternalLink, MailCheck, Settings } from "lucide-react";
import Link from "next/link";

import { AuthRow } from "@/components/inbox-reality/auth-row";
import { PageShell } from "@/components/dashboard/page-shell";
import { DmarcMonitoring } from "@/components/inbox-reality/dmarc-monitoring";
import { ReputationFreshness } from "@/components/inbox-reality/reputation-freshness";
import { ReputationTrend } from "@/components/inbox-reality/reputation-trend";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ServiceNotDeployedNotice } from "@/components/service-not-deployed-notice";
import { countCampaigns, listCampaigns } from "@/lib/campaigns-api";
import {
  isServiceNotDeployed,
  isSendingDomainNotConfigured,
} from "@/lib/service-availability";
import type { Campaign } from "@/lib/campaigns-api";
import {
  parseBlocklistHit,
  reputationSourceLabel,
} from "@/lib/inbox-reality-helpers";
import {
  getAuthChecks,
  getDmarcReport,
  getDmarcReports,
  getDmarcStats,
  getReputation,
  getReputationHistory,
} from "@/lib/inbox-reality-api";
import type {
  AuthCheck,
  DmarcStats,
  ReportDetail,
  Reputation,
  ReputationScore,
  ReputationSnapshot,
} from "@/lib/inbox-reality-types";
import { asRoute } from "@/lib/typed-routes";

const REP_LABEL: Record<ReputationScore, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};
const REP_VARIANT: Record<
  ReputationScore,
  "success" | "warning" | "destructive"
> = {
  high: "success",
  medium: "warning",
  low: "destructive",
};

function overallSummary(rep: Reputation): {
  label: string;
  variant: "success" | "warning" | "destructive" | "outline";
} {
  if (!rep.data_available) {
    return { label: "Monitoring unavailable", variant: "outline" };
  }
  const scores: ReputationScore[] = [
    rep.google_score,
    rep.microsoft_score,
  ].filter((score): score is ReputationScore => score !== null);
  if (scores.length === 0 && rep.sender_score === null) {
    return { label: "Partial monitoring", variant: "outline" };
  }
  if (rep.blacklist_hits.length > 0 || scores.includes("low")) {
    return { label: "Needs attention", variant: "destructive" };
  }
  if (scores.includes("medium")) {
    return { label: "Mostly healthy", variant: "warning" };
  }
  return { label: "Good", variant: "success" };
}

// Number of recent sent campaigns to surface as placement-report links.
const RECENT_CAMPAIGN_LIMIT = 6;

// Sort by send time (newest first), falling back to created_at so undated
// rows still order sensibly.
function campaignSortKey(c: Campaign): number {
  const ts = c.sent_at ?? c.created_at;
  const parsed = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function fetchOverview(): Promise<{
  reputation: Reputation | null;
  // null means the history request failed; [] is a verified empty series.
  reputationHistory: ReputationSnapshot[] | null;
  auth: AuthCheck | null;
  // recentCampaigns === null means the campaigns fetch failed (its own
  // partial error, surfaced in `errors`); [] means it succeeded but the
  // tenant has no sent campaigns yet.
  recentCampaigns: Campaign[] | null;
  // Total sent campaigns (from the count endpoint) so the overview can show a
  // count + "View all" beyond the recent slice (INBOX-023). null on failure.
  sentTotal: number | null;
  // DMARC aggregate-report monitoring (INBOX-032). null on failure; the
  // per-source-IP detail is the latest report (a second round trip).
  dmarcStats: DmarcStats | null;
  dmarcDetail: ReportDetail | null;
  // The deliverability service is not deployed in this environment: its reads
  // answered 503 service_not_deployed. Not a partial outage.
  deliverabilityNotDeployed: boolean;
  sendingDomainRequired: boolean;
  errors: string[];
}> {
  const [
    reputationResult,
    authChecksResult,
    campaignsResult,
    countResult,
    dmarcStatsResult,
    dmarcReportsResult,
    reputationHistoryResult,
  ] = await Promise.allSettled([
    getReputation(),
    getAuthChecks(),
    listCampaigns({ limit: RECENT_CAMPAIGN_LIMIT }),
    countCampaigns(),
    getDmarcStats(),
    getDmarcReports(),
    getReputationHistory({ days: 90 }),
  ]);
  const deliverabilityNotDeployed = [
    reputationResult,
    authChecksResult,
    dmarcStatsResult,
    dmarcReportsResult,
    reputationHistoryResult,
  ].some(
    (result) =>
      result.status === "rejected" && isServiceNotDeployed(result.reason),
  );
  const sendingDomainRequired = [reputationResult, authChecksResult].some(
    (result) =>
      result.status === "rejected" &&
      isSendingDomainNotConfigured(result.reason),
  );
  const errors: string[] = [];
  if (
    reputationResult.status === "rejected" &&
    !deliverabilityNotDeployed &&
    !isSendingDomainNotConfigured(reputationResult.reason)
  ) {
    errors.push("Could not load domain reputation monitoring.");
  }
  if (
    authChecksResult.status === "rejected" &&
    !deliverabilityNotDeployed &&
    !isSendingDomainNotConfigured(authChecksResult.reason)
  ) {
    errors.push(
      "Could not load authentication checks for the configured sending domain.",
    );
  }
  // A campaigns-list failure gets its OWN partial-error entry so it never
  // wipes the already-loaded reputation/auth cards above.
  if (campaignsResult.status === "rejected") {
    errors.push("Could not load recent campaigns.");
  }
  // A DMARC failure likewise gets its OWN partial error so it can never blank
  // the reputation/auth cards.
  if (
    !deliverabilityNotDeployed &&
    (dmarcStatsResult.status === "rejected" ||
      dmarcReportsResult.status === "rejected")
  ) {
    errors.push("Could not load DMARC monitoring.");
  }
  // Only sent campaigns have a placement report behind campaigns/{id}.
  const recentCampaigns =
    campaignsResult.status === "fulfilled"
      ? campaignsResult.value
          .filter((c) => c.status === "sent")
          .sort((a, b) => campaignSortKey(b) - campaignSortKey(a))
          .slice(0, RECENT_CAMPAIGN_LIMIT)
      : null;
  const sentTotal =
    countResult.status === "fulfilled"
      ? (countResult.value.by_status?.sent ?? 0)
      : null;
  const dmarcStats =
    dmarcStatsResult.status === "fulfilled" ? dmarcStatsResult.value : null;
  const dmarcReports =
    dmarcReportsResult.status === "fulfilled" ? dmarcReportsResult.value : null;
  // The per-source-IP records need a second round trip for the latest report.
  // A failure here must be SURFACED (not silently swallowed): otherwise the
  // card would render its empty state while the aggregate stats prove reports
  // exist. The component still shows the aggregate tiles when detail is null.
  const latestId = dmarcReports?.[0]?.id;
  let dmarcDetail: ReportDetail | null = null;
  if (latestId) {
    try {
      dmarcDetail = await getDmarcReport(latestId);
    } catch {
      errors.push("Could not load the latest DMARC report detail.");
    }
  }
  return {
    reputation:
      reputationResult.status === "fulfilled" ? reputationResult.value : null,
    reputationHistory:
      reputationHistoryResult.status === "fulfilled"
        ? reputationHistoryResult.value
        : null,
    auth:
      authChecksResult.status === "fulfilled"
        ? (authChecksResult.value[0] ?? null)
        : null,
    recentCampaigns,
    sentTotal,
    dmarcStats,
    dmarcDetail,
    deliverabilityNotDeployed,
    sendingDomainRequired,
    errors,
  };
}

export default async function InboxRealityPage() {
  const {
    reputation,
    reputationHistory,
    auth,
    recentCampaigns,
    sentTotal,
    dmarcStats,
    dmarcDetail,
    deliverabilityNotDeployed,
    sendingDomainRequired,
    errors,
  } = await fetchOverview();
  const overall = reputation ? overallSummary(reputation) : null;
  const succeeded = reputation?.sources_succeeded ?? [];
  const failed = reputation?.sources_failed ?? [];
  const blocklistMeasured = succeeded.some((source) =>
    ["dnsbl", "blocklist", "blocklists", "blacklist", "blacklists"].includes(
      source.toLowerCase(),
    ),
  );

  return (
    <PageShell className="[&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Inbox Reality
        </h1>
        <p className="text-sm text-muted-foreground">
          What actually happens to your campaigns after you hit send.
        </p>
      </header>

      {deliverabilityNotDeployed ? (
        <ServiceNotDeployedNotice title="Deliverability monitoring isn't set up in this environment">
          Domain reputation, authentication and DMARC results won&apos;t appear
          on this page. Your campaign results still do.
        </ServiceNotDeployedNotice>
      ) : null}

      {sendingDomainRequired ? (
        <Alert>
          <AlertTitle>Set up your sending domain</AlertTitle>
          <AlertDescription>
            Add a sending domain to see its reputation and authentication
            checks.{" "}
            <Link
              href="/app/settings/sender"
              className="font-medium underline underline-offset-4"
            >
              Set up sending identity
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}

      {errors.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>Inbox Reality data is partially unavailable</AlertTitle>
          <AlertDescription>{errors.join(" ")}</AlertDescription>
        </Alert>
      ) : null}

      {reputation && overall ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>Domain reputation: {overall.label}</CardTitle>
                <CardDescription>
                  {reputation.domain || "Domain unavailable"} ·{" "}
                  {reputation.ip || "IP unavailable"}
                </CardDescription>
              </div>
              <div className="flex flex-col items-end gap-2">
                <Badge variant={overall.variant} className="text-sm">
                  {overall.label}
                </Badge>
                <ReputationFreshness checkedAt={reputation.checked_at} />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {!reputation.data_available ? (
              <Alert variant="warning">
                <AlertTitle>Reputation sources are not connected</AlertTitle>
                <AlertDescription className="space-y-3">
                  <p>
                    No Google Postmaster, Microsoft SNDS, SenderScore, or
                    blocklist measurement succeeded. No neutral scores are being
                    inferred.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild size="sm">
                      <Link href={asRoute("/app/settings/domain")}>
                        <Settings className="h-3.5 w-3.5" />
                        Configure sending domain
                      </Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <a
                        href="https://postmaster.google.com/"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        How to connect reputation sources
                      </a>
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-3">
              {reputation.google_score ? (
                <Badge variant={REP_VARIANT[reputation.google_score]}>
                  Google: {REP_LABEL[reputation.google_score]}
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  title="Google Postmaster did not report"
                >
                  Google: Unavailable
                </Badge>
              )}
              {reputation.microsoft_score ? (
                <Badge variant={REP_VARIANT[reputation.microsoft_score]}>
                  Microsoft: {REP_LABEL[reputation.microsoft_score]}
                </Badge>
              ) : (
                <Badge variant="outline" title="Microsoft SNDS did not report">
                  Microsoft: Unavailable
                </Badge>
              )}
              <Badge variant="outline">
                SenderScore:{" "}
                {reputation.sender_score === null
                  ? "Unavailable"
                  : `${reputation.sender_score}/100`}
              </Badge>
              {reputation.blacklist_hits.length === 0 ? (
                blocklistMeasured ? (
                  <Badge variant="success">No blocklist hits</Badge>
                ) : (
                  <Badge variant="outline">Blocklist status unavailable</Badge>
                )
              ) : null}
            </div>

            {/* SenderScore trend over time (INBOX-031). Only shown once
                reputation monitoring is connected — the series is captured
                per-fetch, so a freshly-connected tenant sees a "collecting
                data" hint until a second check lands. */}
            {reputation.data_available ? (
              reputationHistory === null ? (
                <p role="status" className="text-sm text-muted-foreground">
                  SenderScore history could not be loaded; the trend is
                  unavailable.
                </p>
              ) : (
                <ReputationTrend snapshots={reputationHistory} />
              )
            ) : null}

            {/* Which reputation sources actually measured vs failed (INBOX-013),
                so "Partial monitoring" / "Unavailable" states are explained. */}
            {succeeded.length > 0 || failed.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">Sources:</span>{" "}
                {[
                  ...succeeded.map((s) => `${reputationSourceLabel(s)} ✓`),
                  ...failed.map((s) => `${reputationSourceLabel(s)} ✗`),
                ].join(" · ")}
              </p>
            ) : null}

            {/* Blocklist hits as actionable rows (INBOX-012): zone, IP/domain,
                and a delisting link where the operator is recognized. */}
            {reputation.blacklist_hits.length > 0 ? (
              <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <p className="text-sm font-semibold text-destructive">
                  Blocklist hits ({reputation.blacklist_hits.length})
                </p>
                <ul className="space-y-1.5">
                  {reputation.blacklist_hits.map((raw, i) => {
                    const hit = parseBlocklistHit(raw);
                    return (
                      <li
                        key={`${i}-${hit.raw}`}
                        className="flex flex-wrap items-center justify-between gap-2 text-sm"
                      >
                        <span className="flex items-center gap-2">
                          <span className="font-mono">{hit.zone}</span>
                          <Badge variant="outline" className="text-[10px]">
                            {hit.containsIp ? "IP" : "domain"}
                          </Badge>
                        </span>
                        {hit.delistingUrl ? (
                          <a
                            href={hit.delistingUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex min-h-11 items-center gap-1 rounded px-2 text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                          >
                            <ExternalLink className="h-3 w-3" aria-hidden />
                            Delisting / removal
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            No known delisting portal
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {auth && (
        <Card>
          <CardHeader>
            <CardTitle>Authentication health</CardTitle>
            <CardDescription>
              SPF / DKIM / DMARC / BIMI / PTR for {auth.domain}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AuthRow label="SPF" record={auth.spf} domain={auth.domain} />
            <AuthRow label="DKIM" record={auth.dkim} domain={auth.domain} />
            <AuthRow label="DMARC" record={auth.dmarc} domain={auth.domain} />
            <AuthRow label="BIMI" record={auth.bimi} domain={auth.domain} />
            <AuthRow label="PTR" record={auth.ptr} domain={auth.domain} />
          </CardContent>
        </Card>
      )}

      {deliverabilityNotDeployed ? null : (
        <DmarcMonitoring stats={dmarcStats} detail={dmarcDetail} />
      )}

      {/* Recent campaigns — surfaces the per-campaign placement report +
          AI Diagnostician route (campaigns/{id}), which was otherwise
          unreachable from the UI. Only rendered when the campaigns fetch
          succeeded (recentCampaigns !== null); a failure is shown via the
          partial-error Alert above instead. */}
      {recentCampaigns !== null ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>Recent campaigns</CardTitle>
                <CardDescription>
                  Open the placement report and AI Diagnostician for a sent
                  campaign.
                  {sentTotal !== null && sentTotal > 0
                    ? ` ${sentTotal.toLocaleString()} sent in total.`
                    : ""}
                </CardDescription>
              </div>
              {sentTotal !== null && sentTotal > recentCampaigns.length ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={asRoute("/app/campaigns?status=sent")}>
                    View all sent campaigns
                    <ChevronRight className="h-4 w-4" aria-hidden />
                  </Link>
                </Button>
              ) : null}
            </div>
          </CardHeader>
          <CardContent>
            {recentCampaigns.length === 0 ? (
              <EmptyState
                icon={MailCheck}
                title="No sent campaigns yet"
                description="Once you send a campaign, its inbox-placement report and AI Diagnostician will appear here."
              />
            ) : (
              <ul className="divide-y divide-border rounded-md border">
                {recentCampaigns.map((campaign) => (
                  <li key={campaign.id}>
                    <Link
                      href={`/app/inbox-reality/campaigns/${campaign.id}`}
                      className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/60"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {campaign.name || campaign.subject || campaign.id}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {campaign.sent_at
                            ? `Sent ${new Date(
                                campaign.sent_at,
                              ).toLocaleDateString(undefined, {
                                dateStyle: "medium",
                              })}`
                            : "Sent"}
                          {campaign.subject && campaign.name
                            ? ` · ${campaign.subject}`
                            : ""}
                        </p>
                      </div>
                      <span className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
                        View report
                        <ChevronRight className="h-4 w-4" aria-hidden />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card className="bg-muted/40">
        <CardHeader>
          <CardTitle>Pre-send checker</CardTitle>
          <CardDescription>
            Run a draft through Inbox Reality before sending — catch placement
            risk while you can still edit.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href="/app/inbox-reality/predict">
              Run a draft through Inbox Reality →
            </Link>
          </Button>
        </CardContent>
      </Card>
    </PageShell>
  );
}
