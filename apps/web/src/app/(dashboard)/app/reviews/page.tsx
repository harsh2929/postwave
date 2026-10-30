// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Star } from "lucide-react";

import { ReviewWidgetFilterBar } from "@/components/commerce/ReviewWidgetFilterBar";
import { PageShell } from "@/components/dashboard/page-shell";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { exactPrincipalKey } from "@/lib/exact-principal";
import { base, STALE } from "@/lib/query-keys";
import { getReviewsCatalog, listReviewWidgets } from "@/lib/reviews-api";
import {
  EngagementEmpty,
  EngagementIdentityGate,
  EngagementLoading,
  EngagementPageHeader,
  EngagementQueryError,
  EngagementSurface,
} from "../_engagement/engagement-ui";
import { ModerationInbox } from "./_components/moderation-inbox";
import { WidgetInstallation } from "./_components/widget-installation-dialog";

// The authoring form (its mutation, selects and the release-policy notice)
// sits below the inventory fold; loading it in its own chunk keeps this route
// under the dashboard bundle budget. The fallback holds a form-sized footprint.
const ReviewWidgetAuthoring = dynamic(
  () =>
    import("./_components/widget-authoring-form").then(
      (module) => module.ReviewWidgetAuthoring,
    ),
  {
    ssr: false,
    loading: () => (
      <EngagementLoading label="Loading widget authoring" rows={3} />
    ),
  },
);

function Vocabulary({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-lg border bg-background/60 p-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          None advertised by this build.
        </p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-2">
          {items.map((item) => (
            <li
              key={item}
              className="max-w-full break-words rounded-full border bg-card px-2.5 py-1 text-xs capitalize text-muted-foreground"
            >
              {item.replace(/_/gu, " ")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ReviewsPage() {
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const canLoad = Boolean(meQuery.data);
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const principalKey = exactPrincipalKey(meQuery.data);
  const keyBase = useMemo(
    () =>
      [
        ...base("reviews", meQuery.data?.tenant_id ?? "pending", role),
        principalKey,
      ] as const,
    [meQuery.data?.tenant_id, principalKey, role],
  );

  const catalog = useQuery({
    queryKey: [...keyBase, "catalog"],
    queryFn: getReviewsCatalog,
    staleTime: STALE.reference,
    enabled: canLoad,
  });
  const widgets = useQuery({
    queryKey: [...keyBase, "widgets"],
    queryFn: listReviewWidgets,
    staleTime: STALE.list,
    enabled: canLoad,
  });

  const vocabulary = catalog.data;
  const widgetRows = Array.isArray(widgets.data) ? widgets.data : [];
  // Publish / reject / reply are admin-mounted on the server
  // (reviews.go: `r.With(admin)`), so the same authority gates them here:
  // non-admins and viewer-mode sessions get a read-only inbox with the
  // reason stated, never a 403 surprise.
  const canAdmin =
    Boolean(meQuery.data) &&
    !meQuery.data?.viewer_mode &&
    (role === "owner" || role === "admin");

  return (
    <PageShell className="max-w-6xl">
      <EngagementPageHeader
        eyebrow="Customer proof"
        title="Reviews"
        description="Keep the public privacy contract, moderation vocabulary, and every published review surface visible from the same workspace."
        icon={<Star aria-hidden />}
      />

      <EngagementIdentityGate
        pending={meQuery.isPending}
        error={meQuery.isError || !meQuery.data}
        retrying={meQuery.isFetching}
        onRetry={() => void meQuery.refetch()}
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <EngagementSurface
            id="rv-public"
            title="Public data contract"
            description="This wording comes from the server and is shown verbatim so the privacy promise cannot drift in the client."
          >
            {catalog.isPending ? (
              <EngagementLoading label="Loading review privacy contract" />
            ) : catalog.isError || !vocabulary ? (
              <EngagementQueryError
                title="Review catalog could not be loaded"
                description="The public exposure contract and moderation vocabulary are unavailable; no privacy guarantee is being inferred."
                retrying={catalog.isFetching}
                onRetry={() => void catalog.refetch()}
              />
            ) : vocabulary.public_contract ? (
              <blockquote className="rounded-lg border-l-4 border-l-primary bg-muted/30 p-4 text-sm leading-relaxed text-muted-foreground">
                {vocabulary.public_contract}
              </blockquote>
            ) : (
              <EngagementEmpty
                title="No public contract stated"
                description="This build did not return a statement describing what public review widgets expose."
              />
            )}
          </EngagementSurface>

          <EngagementSurface
            id="rv-vocab"
            title="Moderation vocabulary"
            description="Server-advertised states and channels; new backend values appear here without a hard-coded client allowlist."
          >
            {catalog.isPending ? (
              <EngagementLoading
                label="Loading moderation vocabulary"
                rows={4}
              />
            ) : catalog.isError || !vocabulary ? (
              <EngagementQueryError
                title="Moderation vocabulary could not be loaded"
                description="Statuses, authenticity markers, request channels, and widget types are unknown."
                retrying={catalog.isFetching}
                onRetry={() => void catalog.refetch()}
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Vocabulary
                  title="Review statuses"
                  items={vocabulary.statuses}
                />
                <Vocabulary
                  title="Authenticity markers"
                  items={vocabulary.authenticity}
                />
                <Vocabulary
                  title="Request channels"
                  items={vocabulary.request_channels}
                />
                <Vocabulary
                  title="Widget types"
                  items={vocabulary.widget_types}
                />
                {vocabulary.schema_version ? (
                  <p className="break-all text-xs text-muted-foreground sm:col-span-2">
                    Catalog schema <code>{vocabulary.schema_version}</code>
                  </p>
                ) : null}
              </div>
            )}
          </EngagementSurface>
        </div>

        <EngagementSurface
          id="rv-inbox"
          title="Moderation inbox"
          description="Inspect the complete record before changing anything that customers can see."
        >
          <ModerationInbox
            identity={meQuery.data ?? null}
            statuses={vocabulary?.statuses ?? null}
            catalogUnavailable={catalog.isError}
            canAdmin={canAdmin}
            keyBase={keyBase}
          />
        </EngagementSurface>

        <EngagementSurface
          id="rv-widgets"
          title="Review widgets"
          description="Published and non-published widget records returned by the workspace API."
        >
          <ReviewWidgetAuthoring
            canAdmin={canAdmin}
            widgetTypes={vocabulary?.widget_types ?? null}
            keyBase={keyBase}
          />
          {widgets.isPending ? (
            <EngagementLoading label="Loading review widgets" rows={4} />
          ) : widgets.isError ? (
            <EngagementQueryError
              title="Review widgets could not be loaded"
              description="A failed listing is not represented as a workspace with no review surfaces."
              retrying={widgets.isFetching}
              onRetry={() => void widgets.refetch()}
            />
          ) : (
            <ReviewWidgetFilterBar
              widgets={widgetRows}
              refreshing={widgets.isFetching}
              onRefresh={() => void widgets.refetch()}
            >
              {(visibleWidgets) =>
                visibleWidgets.length === 0 ? (
                  <EngagementEmpty
                    title="No review widgets yet"
                    description="The widget request completed successfully and returned no configured surfaces."
                  />
                ) : (
                  <ul
                    className="grid gap-3 sm:grid-cols-2"
                    aria-label="Review widgets"
                  >
                    {visibleWidgets.map((widget, index) => (
                      <li
                        key={widget.id || index}
                        className="flex min-w-0 flex-col rounded-lg border bg-background/60 p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="break-words text-sm font-medium">
                              {widget.name || `Untitled widget ${index + 1}`}
                            </p>
                            <p className="mt-1 break-all text-xs text-muted-foreground">
                              {widget.slug || "No public slug"}
                            </p>
                          </div>
                          <span className="rounded-full border px-2 py-0.5 text-xs capitalize text-muted-foreground">
                            {widget.status.replace(/_/gu, " ")}
                          </span>
                        </div>
                        <p className="mt-3 text-xs capitalize text-muted-foreground">
                          {widget.widget_type.replace(/_/gu, " ")}
                          {widget.language ? ` · ${widget.language}` : ""}
                        </p>
                        {widget.public_url ? (
                          <a
                            href={widget.public_url}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-3 inline-flex min-h-11 items-center gap-2 self-start rounded-md px-2 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            Open public widget
                            <ExternalLink className="size-4" aria-hidden />
                            <span className="sr-only">
                              {" "}
                              (opens in a new tab)
                            </span>
                          </a>
                        ) : (
                          <p className="mt-3 text-xs text-muted-foreground">
                            No public URL is available for this widget.
                          </p>
                        )}
                        <WidgetInstallation widget={widget} keyBase={keyBase} />
                      </li>
                    ))}
                  </ul>
                )
              }
            </ReviewWidgetFilterBar>
          )}
        </EngagementSurface>
      </EngagementIdentityGate>
    </PageShell>
  );
}
