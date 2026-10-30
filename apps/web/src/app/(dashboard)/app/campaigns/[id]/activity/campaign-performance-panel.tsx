// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Campaign performance — parity row campaigns-56 (desktop
 * CampaignDetailPanels.tsx::CampaignPerformancePanel).
 *
 * Web's campaign page showed no open/click performance at all: its "View
 * report" link goes to Inbox Reality, a seed-placement report, not engagement
 * totals. This panel reads `GET /api/v1/campaigns/{id}/report` through the
 * drill-down's own reader and cache key (`[...qk.campaign, "analytics",
 * "report"]`), so opening the full analytics report afterwards is served from
 * the same entry rather than a second request.
 *
 * UNITS: every `*_rate` on the report is PERCENT-unit (analytics.pct()), so
 * each passes through `fractionFromPercent` before the one rate formatter.
 *
 * LIVE: once the campaign has left draft the panel holds the
 * `/api/v1/campaigns/{id}/events` stream open; each frame is a whole report
 * and is painted over the cached one. The dot reports the connection, not the
 * traffic — an idle stream is "Live", a dropped one says it is reconnecting.
 *
 * HUMAN MODE is offered only when bot filtering produced genuine signal (a
 * human open, or a signature that fired). Otherwise the toggle is absent and
 * the raw numbers are shown as raw, never relabelled "human".
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BarChart3, Radio } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api";
import {
  getCampaignReport,
  type CampaignReport,
} from "@/lib/campaign-analytics-api";
import {
  subscribeCampaignReportStream,
  type ReportStreamStatus,
} from "@/lib/campaign-detail-panels-api";
import { STALE } from "@/lib/query-keys";

import {
  displayLinkDestination,
  formatCount,
  formatFractionRate,
  fractionFromPercent,
} from "../analytics/campaign-analytics-format";
import { PANEL_CLASS, type CampaignPanelScope } from "./campaign-panel-scope";

export type EngagementMode = "raw" | "human";

/** True when the report carries bot-filtered counts worth a "Human" view. */
export function reportHasHumanCounts(report: CampaignReport): boolean {
  return report.human_opens > 0 || report.bot_signatures_applied.length > 0;
}

function reportHasActivity(report: CampaignReport): boolean {
  return (
    report.sent > 0 ||
    report.delivered > 0 ||
    report.opens > 0 ||
    report.clicks > 0
  );
}

const LIVE_LABEL: Record<ReportStreamStatus, string> = {
  open: "Live",
  connecting: "Reconnecting…",
  closed: "Not live",
};

export function CampaignPerformancePanel({
  scope,
  status,
}: {
  scope: CampaignPanelScope;
  /** The campaign's status, or null while the campaign itself is loading. */
  status: string | null;
}) {
  const { campaignId, campaignKey, identityReady } = scope;
  const queryClient = useQueryClient();
  const reportKey = useMemo(
    () => [...campaignKey, "analytics", "report"] as const,
    [campaignKey],
  );
  const reportQuery = useQuery({
    queryKey: reportKey,
    queryFn: () => getCampaignReport(campaignId),
    enabled: identityReady && campaignId !== "",
    staleTime: STALE.detail,
  });
  const [mode, setMode] = useState<EngagementMode>("raw");
  const [liveStatus, setLiveStatus] = useState<ReportStreamStatus>("closed");

  const normalizedStatus = status?.toLowerCase() ?? null;
  const isDraft = normalizedStatus === "draft";
  const streamWanted =
    identityReady && campaignId !== "" && normalizedStatus !== null && !isDraft;

  useEffect(() => {
    if (!streamWanted) return undefined;
    return subscribeCampaignReportStream(campaignId, {
      onStatus: setLiveStatus,
      onReport: (report) => queryClient.setQueryData(reportKey, report),
    });
  }, [campaignId, queryClient, reportKey, streamWanted]);

  const report = reportQuery.data ?? null;
  const humanAvailable = report ? reportHasHumanCounts(report) : false;
  const effectiveMode: EngagementMode = humanAvailable ? mode : "raw";
  const topLinks = report
    ? effectiveMode === "human"
      ? report.human_top_links
      : report.top_links
    : [];

  return (
    <section
      className={PANEL_CLASS}
      aria-labelledby="campaign-performance-heading"
      data-testid="campaign-performance-panel"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <BarChart3 className="h-4 w-4" aria-hidden />
        <h2 id="campaign-performance-heading" className="text-base font-semibold">
          Performance
        </h2>
        {streamWanted ? (
          <span
            role="status"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground"
          >
            <Radio
              className={
                liveStatus === "open"
                  ? "h-3.5 w-3.5 text-success-emphasis"
                  : "h-3.5 w-3.5"
              }
              aria-hidden
            />
            {LIVE_LABEL[liveStatus]}
          </span>
        ) : null}
        <span className="flex-1" />
        {humanAvailable ? (
          <div
            role="group"
            aria-label="Engagement mode"
            className="inline-flex rounded-md border p-0.5"
          >
            <Button
              type="button"
              size="sm"
              variant={effectiveMode === "raw" ? "secondary" : "ghost"}
              aria-pressed={effectiveMode === "raw"}
              title="All opens and clicks, no bot filtering"
              onClick={() => setMode("raw")}
            >
              Raw
            </Button>
            <Button
              type="button"
              size="sm"
              variant={effectiveMode === "human" ? "secondary" : "ghost"}
              aria-pressed={effectiveMode === "human"}
              title="Excludes Apple MPP, Google Image Proxy, and link-scanner traffic"
              onClick={() => setMode("human")}
            >
              Human
            </Button>
          </div>
        ) : null}
      </div>

      {reportQuery.isPending ? (
        <div className="grid gap-2" role="status" aria-label="Loading performance">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : reportQuery.isError && !report ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load the performance report</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{apiErrorMessage(reportQuery.error)}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void reportQuery.refetch()}
            >
              Retry the performance report
            </Button>
          </AlertDescription>
        </Alert>
      ) : report && isDraft && !reportHasActivity(report) ? (
        <p className="text-sm text-muted-foreground">
          Performance metrics appear after the campaign sends.
        </p>
      ) : report ? (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Sent" value={formatCount(report.sent)} />
            <Stat label="Delivered" value={formatCount(report.delivered)} />
            <Stat
              label={effectiveMode === "human" ? "Human open rate" : "Open rate"}
              value={formatFractionRate(
                fractionFromPercent(
                  effectiveMode === "human"
                    ? report.human_open_rate
                    : report.open_rate,
                ),
              )}
            />
            <Stat
              label={
                effectiveMode === "human" ? "Human click rate" : "Click rate"
              }
              value={formatFractionRate(
                fractionFromPercent(
                  effectiveMode === "human"
                    ? report.human_click_rate
                    : report.click_rate,
                ),
              )}
            />
          </dl>
          {effectiveMode === "human" ? (
            <p className="text-xs text-muted-foreground">
              Bot-stripped
              {report.bot_signatures_applied.length > 0
                ? ` — signatures applied: ${report.bot_signatures_applied.join(", ")}`
                : ""}
              .
            </p>
          ) : null}

          {topLinks.length > 0 ? (
            <div>
              <h3 className="mb-1 text-sm font-medium">Top links</h3>
              <ul className="divide-y rounded-md border text-sm">
                {topLinks.slice(0, 5).map((link, index) => (
                  <li
                    key={`${link.url}-${index}`}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <span className="min-w-0 truncate" title={link.url}>
                      {displayLinkDestination(link.url)}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {formatCount(link.clicks)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <dl className="grid grid-cols-3 gap-3 text-sm">
            <Stat label="Bounces" value={formatCount(report.bounces)} />
            <Stat label="Complaints" value={formatCount(report.complaints)} />
            <Stat label="Unsubscribes" value={formatCount(report.unsubscribes)} />
          </dl>

          <Link
            href={`/app/campaigns/${encodeURIComponent(campaignId)}/analytics`}
            className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline"
          >
            Open the full analytics report
          </Link>
        </div>
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
