// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { whoami } from "@/lib/auth-api";
import { base, qk, STALE } from "@/lib/query-keys";

import { loadMultiChannelOpsData } from "./product-panel-data";
import {
  errorMessage,
  humanizeStatus,
  LoadingLine,
  MetricBox,
  PanelError,
  statusVariant,
} from "./product-panel-primitives";

// Context-aware quick-links: the button for the route the panel is currently
// rendered on is hidden so it never self-links to the current page (LAND-028).
const QUICK_LINKS = [
  { href: "/app/forms", label: "Forms and surveys" },
  { href: "/app/landing-pages", label: "Landing pages" },
  { href: "/app/integrations", label: "Provider setup" },
] as const;

export function MultiChannelOpsPanel({ className = "" }: { className?: string }) {
  const pathname = usePathname();
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identityReady = Boolean(meQuery.data);
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data?.role ?? null;
  const integrationsBaseKey = useMemo(
    () => base("integrations", tenantId, role),
    [role, tenantId],
  );
  const multiChannelOpsKey = useMemo(
    () => [...integrationsBaseKey, "mailchimp-multi-channel-ops"] as const,
    [integrationsBaseKey],
  );
  const multiChannelOpsQuery = useQuery({
    queryKey: multiChannelOpsKey,
    queryFn: ({ signal }) => loadMultiChannelOpsData(signal),
    enabled: identityReady,
    staleTime: STALE.list,
  });
  const readiness = multiChannelOpsQuery.data?.readiness ?? null;
  const surveys = multiChannelOpsQuery.data?.surveys ?? null;
  const landing = multiChannelOpsQuery.data?.landing ?? null;
  const website = multiChannelOpsQuery.data?.website ?? null;
  const loading =
    meQuery.isLoading || (multiChannelOpsQuery.isPending && !multiChannelOpsQuery.data);
  const error =
    multiChannelOpsQuery.error || meQuery.error
      ? errorMessage(multiChannelOpsQuery.error ?? meQuery.error, "Could not load multi-channel readiness.")
      : null;
  const retrying = meQuery.isFetching || multiChannelOpsQuery.isFetching;

  function retryLoad() {
    void meQuery.refetch().then((auth) => {
      if (auth.data) {
        void multiChannelOpsQuery.refetch();
      }
    });
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Multi-channel readiness</CardTitle>
        <CardDescription>
          Social, ads, surveys, landing pages, polls, and website-builder compatibility in the live workflow.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? <LoadingLine /> : null}
        {error ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <div className="flex-1">
              <PanelError message={error} />
            </div>
            <Button variant="outline" size="sm" onClick={retryLoad} disabled={retrying}>
              {retrying ? "Retrying..." : "Retry"}
            </Button>
          </div>
        ) : null}
        {/* One rejected call in the Promise.all leaves readiness, surveys,
            landing and website all null. Rendered anyway, the boxes below state
            "No provider setup actions are pending" and "Surveys 0" — readings of
            the tenant's setup that nobody actually took. The error stands alone
            instead. */}
        {error ? null : (
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="rounded-md border p-3">
              <div className="text-sm font-medium">Channels</div>
              <div className="mt-2 space-y-2">
                {readiness?.channels?.slice(0, 6).map((channel) => (
                  <div key={channel.feature} className="rounded-md bg-muted/40 px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <span className="min-w-0 truncate font-medium">{channel.feature}</span>
                      <Badge
                        variant={statusVariant(channel.status)}
                        className="max-w-full shrink-0 whitespace-normal break-words"
                      >
                        {humanizeStatus(channel.status)}
                      </Badge>
                    </div>
                    <div className="mt-1 text-muted-foreground">{channel.detail}</div>
                  </div>
                ))}
                {!loading && !readiness?.channels?.length ? (
                  <div className="text-xs text-muted-foreground">No channel readiness has been reported yet.</div>
                ) : null}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-sm font-medium">Provider setup</div>
              <div className="mt-2 space-y-2">
                {readiness?.provider_setup?.slice(0, 5).map((provider) => (
                  <div key={provider.provider} className="rounded-md bg-muted/40 px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <span className="min-w-0 truncate font-medium">{provider.label}</span>
                      <Badge
                        variant={statusVariant(provider.status)}
                        className="max-w-full shrink-0 whitespace-normal break-words"
                      >
                        {humanizeStatus(provider.status)}
                      </Badge>
                    </div>
                    <div className="mt-1 text-muted-foreground">{provider.description}</div>
                  </div>
                ))}
                {!loading && !readiness?.provider_setup?.length ? (
                  <div className="text-xs text-muted-foreground">No provider setup actions are pending.</div>
                ) : null}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-sm font-medium">Hosted surveys and pages</div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <MetricBox label="Surveys" value={surveys?.total_items ?? 0} />
                <MetricBox label="Pages" value={landing?.counts?.pages ?? landing?.counts?.total ?? 0} />
                <MetricBox label="Landing status" value={humanizeStatus(landing?.status ?? "unknown")} />
                <MetricBox label="Website builder" value={humanizeStatus(website?.status ?? "not built")} />
              </div>
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {QUICK_LINKS.filter((link) => link.href !== pathname).map((link) => (
            <Button key={link.href} variant="outline" size="sm" asChild>
              <Link href={link.href}>{link.label}</Link>
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
