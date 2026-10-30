// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Campaign activity & insights — the web home for the side panels desktop's
 * campaign slideover carries and web's campaign page did not:
 *
 *   performance (campaigns-56) · AI summary (58) · web version (57)
 *   feedback thread (60) · replies with intent filter (61)
 *   content remix (51) · lifecycle + audit-scoped activity (62)
 *
 * It is a sibling route of the campaign editor rather than a section inside
 * it: the editor shell is another session's work in progress, and these panels
 * are read-mostly evidence about a campaign that has (usually) already sent,
 * not part of authoring it. Linked from the campaign page's header.
 *
 * Identity resolves first and every panel waits for it, so no read is keyed to
 * `anon`. The campaign key is `qk.campaign(tenant, role, id)` with the same
 * role derivation as the editor, so the editor's cached campaign serves this
 * page and a save there invalidates the panels here.
 */

import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Route } from "next";
import { ArrowLeft } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { getCampaign } from "@/lib/campaigns-api";
import { qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";

import {
  CampaignActivityTimeline,
  CampaignAuditFeed,
} from "../campaign-activity-timeline";
import { CampaignFeedbackPanel } from "./campaign-feedback-panel";
import type { CampaignPanelScope } from "./campaign-panel-scope";
import { CampaignPerformancePanel } from "./campaign-performance-panel";
import { CampaignRemixCard } from "./campaign-remix-card";
import { CampaignRepliesPanel } from "./campaign-replies-panel";
import { CampaignSummaryCard } from "./campaign-summary-card";
import { CampaignWebVersionCard } from "./campaign-web-version-card";

export function CampaignActivityClient() {
  const params = useParams<{ id: string }>();
  const campaignId = params?.id ?? "";

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data ?? null;
  const tenantId = identity?.tenant_id ?? "anon";
  // Same derivation as the editor (campaign-detail-client.tsx) so both read
  // one cache entry for one campaign.
  const role = identity
    ? identity.viewer_mode
      ? "viewer"
      : effectiveAuthRole(identity)
    : null;
  const campaignKey = useMemo(
    () => qk.campaign(tenantId, role, campaignId),
    [campaignId, role, tenantId],
  );
  const identityReady = meQuery.isFetched;

  const campaignQuery = useQuery({
    queryKey: campaignKey,
    queryFn: () => getCampaign(campaignId),
    enabled: identityReady && campaignId !== "",
    staleTime: STALE.detail,
  });
  const campaign = campaignQuery.data ?? null;
  const status = campaign?.status ?? null;

  const scope: CampaignPanelScope = useMemo(
    () => ({ campaignId, campaignKey, identity, identityReady }),
    [campaignId, campaignKey, identity, identityReady],
  );

  const campaignName = campaignQuery.isError
    ? "Campaign (name failed to load)"
    : campaign?.name;
  const campaignHref =
    `/app/campaigns/${encodeURIComponent(campaignId)}` as const;

  return (
    <PageShell>
      <Breadcrumb
        items={[
          { label: "Campaigns", href: asRoute("/app/campaigns") },
          ...(campaignName
            ? [{ label: campaignName, href: asRoute(campaignHref) as Route }]
            : []),
          { label: "Activity & insights" },
        ]}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          asChild
          variant="ghost"
          size="icon"
          aria-label="Back to campaign"
          title="Back to campaign"
        >
          <Link href={campaignHref}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Activity &amp; insights
          </h1>
          {campaignName ? (
            <p className="break-words text-sm text-muted-foreground">
              {campaignName}
            </p>
          ) : null}
        </div>
      </div>

      {meQuery.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t confirm who you are</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{apiErrorMessage(meQuery.error)}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void meQuery.refetch()}
            >
              Retry sign-in check
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {campaignQuery.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load this campaign</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{apiErrorMessage(campaignQuery.error)}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void campaignQuery.refetch()}
            >
              Retry the campaign
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid content-start gap-4">
          <CampaignPerformancePanel scope={scope} status={status} />
          <CampaignSummaryCard
            scope={scope}
            status={campaignQuery.isError ? "unknown" : status}
          />
          {/* The web version is built from the campaign row; with no row
              (the alert above says why) there is nothing to build it from. */}
          {campaignQuery.isError ? null : (
            <CampaignWebVersionCard scope={scope} campaign={campaign} />
          )}
          <CampaignRemixCard scope={scope} />
        </div>
        <div className="grid content-start gap-4">
          <CampaignFeedbackPanel scope={scope} />
          <CampaignRepliesPanel scope={scope} />
          {campaign ? <CampaignActivityTimeline campaign={campaign} /> : null}
          <CampaignAuditFeed
            campaignId={campaignId}
            campaignKey={campaignKey}
            identity={identity}
            identityReady={identityReady}
          />
        </div>
      </div>
    </PageShell>
  );
}
