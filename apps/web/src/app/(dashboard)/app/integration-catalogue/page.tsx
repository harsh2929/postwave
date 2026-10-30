// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Integration catalogue — loyalty platforms and lead sources.
 *
 * Two provider catalogues desktop reached and web did not: 9 loyalty
 * providers and 48 lead sources.
 *
 * THE SAME FINDING AS THE ANALYTICS CATALOGUE, ON A LARGER SAMPLE. Every
 * loyalty provider and 47 of 48 lead providers report `partial`; the odd one
 * out is `delegated`, which means the work happens elsewhere rather than being
 * unfinished here — a distinction worth keeping, since "delegated" is not a
 * lesser state.
 *
 * 57 recognisable brand names in a grid with no status reads as 57 shipped
 * integrations. Each section states its position once, and every row carries
 * its own status.
 */

import { useMemo, useState } from "react";
import { Blocks, Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import {
  DataSection,
  DataSurfaceHeader,
  DataSurfaceShell,
  QueryError,
  SectionSkeleton,
  StatusPill,
} from "@/components/integrations/data-surface";
import { DocsLink } from "@/components/integrations/docs-link";
import { Input } from "@/components/ui/input";
import { whoami } from "@/lib/auth-api";
import {
  listLeadProviders,
  listLoyaltyProviders,
  listReviewProviders,
  listSubscriptionProviders,
  listSupportProviders,
  summariseStatuses,
  type CatalogueProvider,
} from "@/lib/integration-catalogue-api";
import { base, STALE } from "@/lib/query-keys";

const humanise = (value: string) => value.replaceAll("_", " ");

/**
 * The category/auth line under a provider name. Both fields are optional on
 * the wire — the release-held support catalogue sends neither — so the line
 * is built only from what the server sent, and a held row with nothing to
 * describe says why it cannot be connected instead.
 */
function ProviderDetail({ provider }: { provider: CatalogueProvider }) {
  const parts = [provider.category, provider.auth_mode]
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim() !== "",
    )
    .map(humanise);
  if (parts.length > 0) {
    return (
      <p className="mt-0.5 break-words text-xs text-muted-foreground">
        {parts.join(" · ")}
      </p>
    );
  }
  if (provider.runtime_status === "held") {
    return (
      <p className="mt-0.5 break-words text-xs text-muted-foreground">
        Connecting is paused in this release
      </p>
    );
  }
  return null;
}

function ProviderSection({
  id,
  title,
  rows,
  loading,
  errored,
  note,
  query,
  onRetry,
}: {
  id: string;
  title: string;
  rows: CatalogueProvider[];
  loading: boolean;
  errored: boolean;
  note?: string;
  query: string;
  onRetry: () => void;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const shown = normalizedQuery
    ? rows.filter((provider) =>
        [
          provider.name,
          provider.provider,
          provider.category,
          provider.auth_mode,
        ]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(normalizedQuery)),
      )
    : rows;

  return (
    <DataSection
      id={id}
      title={title}
      description={note}
      aside={
        !loading && !errored && rows.length > 0 ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {query ? `${shown.length} of ` : null}
            {rows.length} · {summariseStatuses(rows)}
          </span>
        ) : undefined
      }
    >
      {loading ? (
        <SectionSkeleton />
      ) : errored ? (
        <QueryError
          title={`${title} could not be loaded`}
          description="No providers are being shown as unavailable; this request failed."
          onRetry={onRetry}
        />
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-5 text-sm leading-6 text-muted-foreground">
          No {title.toLowerCase()} providers are offered by this build.
        </p>
      ) : shown.length === 0 ? (
        <p className="rounded-lg border border-dashed p-5 text-sm leading-6 text-muted-foreground">
          No {title.toLowerCase()} providers match “{query}”.
        </p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-background">
          {shown.map((p) => (
            <li
              key={p.provider}
              className="grid min-w-0 gap-3 p-3.5 text-sm transition-colors hover:bg-muted/30 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="min-w-0">
                <p className="break-words font-medium">{p.name}</p>
                <ProviderDetail provider={p} />
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <StatusPill status={p.runtime_status} />
                {p.docs_url ? <DocsLink href={p.docs_url} /> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </DataSection>
  );
}

export default function IntegrationCataloguePage() {
  const [query, setQuery] = useState("");
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const keyBase = useMemo(
    () =>
      base(
        "integration-catalogue",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  const loyalty = useQuery({
    queryKey: [...keyBase, "loyalty"],
    queryFn: listLoyaltyProviders,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });
  const leads = useQuery({
    queryKey: [...keyBase, "leads"],
    queryFn: listLeadProviders,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });

  const reviews = useQuery({
    queryKey: [...keyBase, "reviews"],
    queryFn: listReviewProviders,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });
  const support = useQuery({
    queryKey: [...keyBase, "support"],
    queryFn: listSupportProviders,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });
  const subscriptions = useQuery({
    queryKey: [...keyBase, "subscriptions"],
    queryFn: listSubscriptionProviders,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });

  const loyaltyRows = Array.isArray(loyalty.data) ? loyalty.data : [];
  const reviewRows = Array.isArray(reviews.data) ? reviews.data : [];
  const supportRows = Array.isArray(support.data) ? support.data : [];
  const subscriptionRows = Array.isArray(subscriptions.data)
    ? subscriptions.data
    : [];
  const leadRows = Array.isArray(leads.data) ? leads.data : [];

  if (meQuery.isLoading || meQuery.isError) {
    return (
      <DataSurfaceShell className="max-w-5xl">
        <DataSurfaceHeader
          icon={Blocks}
          eyebrow="Provider directory"
          title="Integration catalogue"
          description="Explore lead, support, subscription, loyalty, and review providers. Availability is reported per provider. A catalog row is not proof that its runtime is enabled."
        />
        {meQuery.isLoading ? (
          <SectionSkeleton rows={4} />
        ) : (
          <QueryError
            title="Workspace identity could not be loaded"
            description="Provider requests were not started without a verified workspace context."
            onRetry={() => void meQuery.refetch()}
          />
        )}
      </DataSurfaceShell>
    );
  }

  return (
    <DataSurfaceShell className="max-w-5xl">
      <DataSurfaceHeader
        icon={Blocks}
        eyebrow="Provider directory"
        title="Integration catalogue"
        description="Explore lead, support, subscription, loyalty, and review providers. Availability is reported per provider. A catalog row is not proof that its runtime is enabled."
      />

      <div className="sticky top-2 z-10 rounded-xl border bg-background/90 p-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search all providers, categories, or auth modes…"
            aria-label="Search provider catalogue"
            aria-describedby="catalog-search-hint"
            className="pl-9 text-base sm:text-sm"
          />
        </div>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p id="catalog-search-hint" className="text-xs text-muted-foreground">
            Search applies to every section below.
          </p>
          <nav
            aria-label="Provider categories"
            tabIndex={0}
            className="flex gap-1 overflow-x-auto pb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pb-0"
          >
            {[
              ["ic-leads", "Leads"],
              ["ic-support", "Support"],
              ["ic-subscriptions", "Subscriptions"],
              ["ic-loyalty", "Loyalty"],
              ["ic-reviews", "Reviews"],
            ].map(([href, label]) => (
              <a
                key={href}
                href={`#${href}`}
                className="inline-flex min-h-11 shrink-0 items-center rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
              >
                {label}
              </a>
            ))}
          </nav>
        </div>
      </div>

      <ProviderSection
        id="ic-leads"
        title="Lead sources"
        rows={leadRows}
        loading={leads.isLoading}
        errored={leads.isError}
        query={query}
        onRetry={() => void leads.refetch()}
      />

      <ProviderSection
        id="ic-support"
        title="Customer support"
        rows={supportRows}
        loading={support.isLoading}
        errored={support.isError}
        note="Support connection and run actions are release-held (support_integration_runtime_held)."
        query={query}
        onRetry={() => void support.refetch()}
      />

      <ProviderSection
        id="ic-subscriptions"
        title="Subscriptions and shipping"
        rows={subscriptionRows}
        loading={subscriptions.isLoading}
        errored={subscriptions.isError}
        query={query}
        onRetry={() => void subscriptions.refetch()}
      />

      <ProviderSection
        id="ic-loyalty"
        title="Loyalty"
        rows={loyaltyRows}
        loading={loyalty.isLoading}
        errored={loyalty.isError}
        query={query}
        onRetry={() => void loyalty.refetch()}
      />

      <ProviderSection
        id="ic-reviews"
        title="Reviews"
        rows={reviewRows}
        loading={reviews.isLoading}
        errored={reviews.isError}
        query={query}
        onRetry={() => void reviews.refetch()}
      />
    </DataSurfaceShell>
  );
}
