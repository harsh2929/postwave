// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * One campaign's UTM tagging — the web half of desktop's CampaignDetailHeader
 * "UTM" button (composer/UTMTemplatesView). The editor lists the workspace
 * default and every override, saves this campaign's override, and previews a
 * link through the template this campaign would actually send with.
 */
import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Route } from "next";
import { ArrowLeft } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { UtmTemplatesEditor } from "@/components/campaigns/utm-templates-editor";
import { PageShell } from "@/components/dashboard/page-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { getCampaign } from "@/lib/campaigns-api";
import { qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";

export function CampaignUtmClient() {
  const params = useParams<{ id: string }>();
  const campaignId = params.id;

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data ?? null;
  const role = identity ? effectiveAuthRole(identity) : null;
  const campaignKey = useMemo(
    () => qk.campaign(identity?.tenant_id ?? "anon", role, campaignId),
    [campaignId, identity?.tenant_id, role],
  );
  // Only the name is read here, for the breadcrumb; the editor never depends
  // on it, so a failed read degrades to an unnamed breadcrumb.
  const campaignQuery = useQuery({
    queryKey: campaignKey,
    queryFn: () => getCampaign(campaignId),
    enabled: meQuery.isSuccess,
    staleTime: STALE.detail,
  });
  const campaignName = campaignQuery.isError
    ? ""
    : (campaignQuery.data?.name ?? "");

  return (
    <PageShell>
      <Breadcrumb
        items={[
          { label: "Campaigns", href: asRoute("/app/campaigns") },
          ...(campaignName
            ? [
                {
                  label: campaignName,
                  href: asRoute(
                    `/app/campaigns/${encodeURIComponent(campaignId)}`,
                  ) as Route,
                },
              ]
            : []),
          { label: "UTM tracking" },
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
          <Link
            href={asRoute(`/app/campaigns/${encodeURIComponent(campaignId)}`)}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            UTM tracking
          </h1>
          <p className="break-words text-sm text-muted-foreground">
            {campaignName
              ? `${campaignName} — review UTM templates and preview link parameters.`
              : "Review UTM templates and preview link parameters."}
          </p>
        </div>
      </div>

      {meQuery.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Verifying workspace access…
        </p>
      ) : meQuery.isError || !identity ? (
        <Alert variant="destructive">
          <AlertTitle>Workspace access could not be verified</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            UTM templates are not loaded until your access is known.
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={meQuery.isFetching}
              onClick={() => void meQuery.refetch()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <section className="rounded-lg border bg-card p-4 sm:p-6">
          <UtmTemplatesEditor identity={identity} campaignId={campaignId} />
        </section>
      )}
    </PageShell>
  );
}
