// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Analytics destinations — 31 of them, none fully certified.
 *
 * `/api/v1/analytics-integrations/providers` was reached by desktop and by
 * nothing on web.
 *
 * EVERY PROVIDER REPORTS `runtime_status: "partial"`, and four report a
 * `verification_mode` ending in `live_certification_pending` — meaning the
 * connector is written but has never been certified against the real provider.
 *
 * A catalogue of 31 names with Connect buttons and no status reads as 31
 * production integrations. That is the impression this page exists to avoid:
 * it states the position once at the top, and marks the uncertified four
 * individually.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { ContentQueryError } from "../_content-automation/content-query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { whoami } from "@/lib/auth-api";
import {
  allProvidersArePartial,
  awaitingLiveCertification,
  listAnalyticsProviders,
} from "@/lib/analytics-integrations-api";
import { base, qk, STALE } from "@/lib/query-keys";

export default function AnalyticsDestinationsPage() {
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
        "analytics-integrations",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  const providers = useQuery({
    queryKey: [...keyBase, "providers"],
    queryFn: listAnalyticsProviders,
    enabled: canLoad,
    staleTime: STALE.reference,
  });

  const rows = Array.isArray(providers.data) ? providers.data : [];
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredRows = normalizedSearch
    ? rows.filter((provider) =>
        [provider.name, provider.provider, provider.category].some((value) =>
          value.toLocaleLowerCase().includes(normalizedSearch),
        ),
      )
    : rows;
  const allPartial = allProvidersArePartial(rows);
  const pending = rows.filter(awaitingLiveCertification);

  if (!canLoad) {
    return (
      <PageShell className="max-w-5xl">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Analytics destinations
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
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Analytics destinations
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Where Moosewave can forward engagement and conversion events.
        </p>
      </header>

      {providers.isPending ? (
        <div role="status" aria-busy="true" className="space-y-3">
          <span className="sr-only">Loading analytics destinations…</span>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : providers.isError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4"
        >
          <p className="text-sm text-destructive">
            Could not load the destination catalogue. No destination is being
            presented as unavailable or certified.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void providers.refetch()}
            disabled={providers.isFetching}
          >
            {providers.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      ) : (
        <>
          {allPartial ? (
            <section className="rounded-lg border p-4 sm:p-6">
              <h2 className="text-base font-medium">
                All {rows.length} are partial
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Every destination in this catalogue reports <code>partial</code>{" "}
                runtime support — the connectors exist and are not fully
                production-certified.
                {pending.length > 0
                  ? ` ${pending.length} of them are additionally awaiting live certification against the real provider.`
                  : ""}
              </p>
            </section>
          ) : null}

          <section aria-labelledby="ad-list">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id="ad-list" className="text-base font-medium">
                  Catalogue
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {filteredRows.length} of {rows.length} destinations shown
                </p>
              </div>
              {rows.length > 0 ? (
                <div className="w-full space-y-1.5 sm:w-72">
                  <Label htmlFor="destination-search" className="sr-only">
                    Find a destination
                  </Label>
                  <Input
                    id="destination-search"
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Find a destination…"
                    autoComplete="off"
                  />
                </div>
              ) : null}
            </div>
            {rows.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                No destinations offered by this build.
              </p>
            ) : filteredRows.length === 0 ? (
              <p className="mt-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No destinations match “{search.trim()}”. Try a provider or
                category name.
              </p>
            ) : (
              <ul className="mt-2 divide-y rounded-lg border">
                {filteredRows.map((p) => (
                  <li
                    key={p.provider}
                    className="flex flex-col items-start justify-between gap-2 p-3 text-sm sm:flex-row sm:items-center"
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{p.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {p.category}
                      </span>
                    </span>
                    <Badge
                      variant={
                        awaitingLiveCertification(p) ? "warning" : "outline"
                      }
                    >
                      {awaitingLiveCertification(p)
                        ? "awaiting live certification"
                        : (p.runtime_status ?? "unknown")}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </PageShell>
  );
}
