// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Route as RouteIcon, Settings2, Webhook } from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import { WebhookAdministrationSummary } from "@/components/settings/WebhookAdministrationSummary";
import { Button } from "@/components/ui/button";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import {
  getInboundEmailEndpointStrict,
  inboundEndpointUrl,
  listInboundRoutesStrict,
} from "@/lib/inbound-routes-admin-api";
import { listOutboundWebhooksPage } from "@/lib/outbound-webhooks-api";
import { base, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";
import { roleCanWrite } from "@/lib/use-admin-gate";
import {
  EngagementEmpty,
  EngagementIdentityGate,
  EngagementLoading,
  EngagementPageHeader,
  EngagementQueryError,
  EngagementSurface,
} from "../_engagement/engagement-ui";

export default function RoutingPage() {
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const canLoad = Boolean(meQuery.data);
  const canWrite = roleCanWrite(
    meQuery.data ? effectiveAuthRole(meQuery.data) : null,
  );
  const keyBase = useMemo(
    () =>
      base(
        "routing",
        meQuery.data?.tenant_id ?? "pending",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  const endpoint = useQuery({
    queryKey: [...keyBase, "inbound-endpoint"],
    queryFn: ({ signal }) =>
      getInboundEmailEndpointStrict({
        tenantId: meQuery.data!.tenant_id,
        signal,
      }),
    staleTime: STALE.reference,
    enabled: canLoad && canWrite,
  });
  const routes = useQuery({
    queryKey: [...keyBase, "inbound-routes"],
    queryFn: ({ signal }) =>
      listInboundRoutesStrict({
        tenantId: meQuery.data!.tenant_id,
        retainHmacSecrets: false,
        signal,
      }),
    staleTime: STALE.list,
    enabled: canLoad && canWrite,
  });
  const webhooks = useQuery({
    // The key stays under base("routing", …): the destinations workspace
    // invalidates that prefix after every mutation, so this summary and list
    // follow its writes without a second invalidation contract.
    queryKey: [...keyBase, "outbound-webhooks"],
    // The strict parser in lib/outbound-webhooks-api rejects a malformed
    // record instead of counting it, and the widest server page (200) keeps
    // the summary's counts exact for all but the largest inventories.
    queryFn: ({ signal }) => listOutboundWebhooksPage({ limit: 200, signal }),
    staleTime: STALE.list,
    // GET /api/v1/outbound-webhooks carries session_minimum_role "admin", so
    // firing it for a non-admin buys a 403 that reads as a broken workspace
    // with a Retry that can never succeed. Match the two sibling panels.
    enabled: canLoad && canWrite,
  });

  const routeRows = Array.isArray(routes.data) ? routes.data : [];
  const hookRows = Array.isArray(webhooks.data?.webhooks)
    ? webhooks.data.webhooks
    : [];

  const createDialog = (
    <div className="flex flex-wrap gap-2">
      {canWrite ? (
        <Button asChild className="min-h-11">
          <Link href={asRoute("/app/routing/inbound-routes")}>
            <Settings2 aria-hidden /> Manage inbound routes
          </Link>
        </Button>
      ) : null}
      {/* The destination workspace is admin-gated by its own page, so the
          link stays visible for every role rather than hiding the surface. */}
      <Button asChild variant="outline" className="min-h-11">
        <Link href={asRoute("/app/routing/outbound-webhooks")}>
          <Webhook aria-hidden /> Manage outbound destinations
        </Link>
      </Button>
    </div>
  );

  return (
    <PageShell className="max-w-6xl">
      <EngagementPageHeader
        eyebrow="Channel infrastructure"
        title="Routing"
        description="See where inbound email arrives, which rules handle it, and which workspace events are delivered to external systems."
        icon={<RouteIcon aria-hidden />}
        actions={createDialog}
      />

      <EngagementIdentityGate
        pending={meQuery.isPending}
        error={meQuery.isError || !meQuery.data}
        retrying={meQuery.isFetching}
        onRetry={() => void meQuery.refetch()}
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <EngagementSurface
            id="rt-inbound"
            title="Inbound address"
            description="A 404 from this endpoint means no address has been provisioned; other failures remain errors."
          >
            {!canWrite ? (
              <EngagementEmpty
                title="Administrator access required"
                description="Endpoint metadata is admin-only and was not requested for this browser session."
              />
            ) : endpoint.isPending ? (
              <EngagementLoading label="Loading inbound email address" />
            ) : endpoint.isError ? (
              <EngagementQueryError
                title="Inbound address could not be read"
                description="This is a failure to ask for the endpoint, not confirmation that an address is absent."
                retrying={endpoint.isFetching}
                onRetry={() => void endpoint.refetch()}
              />
            ) : endpoint.data ? (
              <div className="rounded-lg border bg-background/60 p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Provisioned address
                </p>
                <p className="mt-1 break-all font-mono text-sm font-medium">
                  {inboundEndpointUrl(endpoint.data.slug)}
                </p>
              </div>
            ) : (
              <EngagementEmpty
                title="No inbound address provisioned"
                description="Replies are not being captured through an inbound endpoint. Provision an address before relying on routing rules."
              />
            )}
          </EngagementSurface>

          <EngagementSurface
            id="rt-webhooks"
            title="Outbound webhooks"
            description="Destinations receiving workspace events, including paused records."
          >
            {!canWrite ? (
              <EngagementEmpty
                title="Administrator access required"
                description="Outbound destinations are admin-only and were not requested for this browser session."
              />
            ) : webhooks.isPending ? (
              <EngagementLoading label="Loading outbound webhooks" />
            ) : webhooks.isError ? (
              <EngagementQueryError
                title="Outbound webhooks could not be loaded"
                description="A failed listing is not represented as a workspace with no external deliveries."
                retrying={webhooks.isFetching}
                onRetry={() => void webhooks.refetch()}
              />
            ) : hookRows.length === 0 ? (
              <EngagementEmpty
                title="No outbound webhooks configured"
                description="The listing completed successfully and returned no external destinations."
              />
            ) : (
              <>
                {webhooks.data ? (
                  <WebhookAdministrationSummary
                    page={webhooks.data}
                    className="mb-3"
                  />
                ) : null}
                <ul className="space-y-3" aria-label="Outbound webhooks">
                  {hookRows.map((hook, index) => {
                    const events = Array.isArray(hook.events)
                      ? hook.events
                      : [];
                    return (
                      <li
                        key={String(hook.id ?? index)}
                        className="min-w-0 rounded-lg border bg-background/60 p-3"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <code className="min-w-0 break-all text-xs">
                            {String(hook.url || "URL not returned")}
                          </code>
                          <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                            {hook.active === false ? "Paused" : "Active"}
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {events.length === 0
                            ? "No event subscriptions returned"
                            : `${events.length.toLocaleString()} event subscription${events.length === 1 ? "" : "s"}`}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </EngagementSurface>
        </div>

        <EngagementSurface
          id="rt-routes"
          title="Inbound routes"
          description="Rules are evaluated in priority order. A route with no actions can match and store mail, but does not yet run a pipeline."
        >
          {!canWrite ? (
            <EngagementEmpty
              title="Administrator access required"
              description="Inbound route definitions and action configuration are admin-only and were not requested for this browser session."
            />
          ) : routes.isPending ? (
            <EngagementLoading label="Loading inbound routing rules" rows={4} />
          ) : routes.isError ? (
            <EngagementQueryError
              title="Inbound routes could not be loaded"
              description="The failure is not being represented as an empty rule set."
              retrying={routes.isFetching}
              onRetry={() => void routes.refetch()}
            />
          ) : routeRows.length === 0 ? (
            <EngagementEmpty
              title="No inbound routes defined"
              description={
                canWrite
                  ? "Create a route to match inbound messages. It will store matching mail until an action pipeline is added."
                  : "The listing completed successfully and returned no routing rules."
              }
            />
          ) : (
            <ol
              className="grid gap-3 sm:grid-cols-2"
              aria-label="Inbound routes in evaluation order"
            >
              {routeRows.map((route, index) => {
                const actionCount = Array.isArray(route.actions)
                  ? route.actions.length
                  : 0;
                return (
                  <li
                    key={String(route.id ?? index)}
                    className="min-w-0 rounded-lg border bg-background/60 p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium">
                          {route.name || `Untitled route ${index + 1}`}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Priority {route.priority ?? index + 1}
                          {route.stopOnMatch ? " · Stops after match" : ""}
                        </p>
                      </div>
                      <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                        {route.enabled === false ? "Disabled" : "Enabled"}
                      </span>
                    </div>
                    <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">Recipient</dt>
                        <dd className="break-all font-mono">
                          {route.matchRecipient || "*"}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">Actions</dt>
                        <dd className="break-words">
                          {actionCount === 0
                            ? "No actions yet"
                            : `${actionCount} action${actionCount === 1 ? "" : "s"}`}
                        </dd>
                      </div>
                      {route.matchSubjectPrefix ? (
                        <div className="min-w-0">
                          <dt className="text-muted-foreground">
                            Subject prefix
                          </dt>
                          <dd className="break-words">
                            {route.matchSubjectPrefix}
                          </dd>
                        </div>
                      ) : null}
                      {route.matchFromDomain ? (
                        <div className="min-w-0">
                          <dt className="text-muted-foreground">From domain</dt>
                          <dd className="break-all">
                            {route.matchFromDomain}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {route.matchCount.toLocaleString()} matches · last{" "}
                      {formatWireTimestamp(
                        typeof route.lastMatchedAt === "string"
                          ? route.lastMatchedAt
                          : undefined,
                        "never",
                      )}
                    </p>
                  </li>
                );
              })}
            </ol>
          )}
        </EngagementSurface>
      </EngagementIdentityGate>
    </PageShell>
  );
}
