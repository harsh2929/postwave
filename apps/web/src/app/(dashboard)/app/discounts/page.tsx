// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Archive, Search, ShieldCheck } from "lucide-react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import {
  listDiscountHistory,
  type DiscountHistoryRecord,
} from "@/lib/discounts-api";
import { base, qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";

import { CouponPoolsCard, DiscountHistoryCard } from "./discount-cards";
import { RedemptionHistoryDialog } from "./discount-dialogs";

const RECORDS_PER_PAGE = 50;
const MAX_RECORD_PAGE = Math.floor(10_000 / RECORDS_PER_PAGE) + 1;

function isAccessDenied(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function recordPage(value: string | null): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(parsed, MAX_RECORD_PAGE) : 1;
}

export default function DiscountsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [eventRecord, setEventRecord] = useState<DiscountHistoryRecord | null>(
    null,
  );
  const eventTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [deniedScope, setDeniedScope] = useState<string | null>(null);

  const rawSearch = searchParams.get("q") ?? "";
  const urlSearch = rawSearch.trim().slice(0, 120);
  const rawPage = searchParams.get("page");
  const page = recordPage(rawPage);
  const [searchInput, setSearchInput] = useState(urlSearch);
  useEffect(() => setSearchInput(urlSearch), [urlSearch]);
  useEffect(() => {
    const nextSearch = searchInput.trim().slice(0, 120);
    if (nextSearch === urlSearch && rawSearch === urlSearch) return;
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams.toString());
      if (nextSearch) next.set("q", nextSearch);
      else next.delete("q");
      next.delete("page");
      const query = next.toString();
      router.replace(asRoute(query ? `${pathname}?${query}` : pathname), {
        scroll: false,
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [pathname, rawSearch, router, searchInput, searchParams, urlSearch]);
  useEffect(() => {
    if (rawPage === null || rawPage === String(page)) return;
    const next = new URLSearchParams(searchParams.toString());
    if (page === 1) next.delete("page");
    else next.set("page", String(page));
    const query = next.toString();
    router.replace(asRoute(query ? `${pathname}?${query}` : pathname), {
      scroll: false,
    });
  }, [page, pathname, rawPage, router, searchParams]);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data?.role ?? null;
  const discountsBaseKey = useMemo(
    () => base("discounts", tenantId, role),
    [role, tenantId],
  );
  const historyRootKey = useMemo(
    () => [...discountsBaseKey, "history"] as const,
    [discountsBaseKey],
  );
  const historyKey = useMemo(
    () => [...historyRootKey, page] as const,
    [historyRootKey, page],
  );
  const cacheScope = `${tenantId}:${role ?? "unknown"}`;
  const historyQuery = useQuery({
    queryKey: historyKey,
    queryFn: () =>
      listDiscountHistory({
        limit: RECORDS_PER_PAGE,
        offset: (page - 1) * RECORDS_PER_PAGE,
      }),
    enabled: meQuery.isSuccess && deniedScope !== cacheScope,
    retry: (failureCount, error) => !isAccessDenied(error) && failureCount < 2,
    staleTime: STALE.list,
  });

  const serverDenied = isAccessDenied(historyQuery.error);
  const accessDenied = serverDenied || deniedScope === cacheScope;
  useEffect(() => {
    if (!serverDenied) return;
    // A permission revocation must not leave the last readable snapshot in
    // either the rendered tree or this identity-scoped query cache.
    setDeniedScope(cacheScope);
    setEventRecord(null);
    eventTriggerRef.current = null;
    queryClient.removeQueries({ queryKey: discountsBaseKey, exact: false });
  }, [cacheScope, discountsBaseKey, queryClient, serverDenied]);

  const openEvents = useCallback(
    (record: DiscountHistoryRecord, trigger: HTMLButtonElement): void => {
      eventTriggerRef.current = trigger;
      setEventRecord(record);
    },
    [],
  );
  const closeEvents = useCallback((): void => {
    const trigger = eventTriggerRef.current;
    setEventRecord(null);
    window.requestAnimationFrame(() => {
      trigger?.focus();
      eventTriggerRef.current = null;
    });
  }, []);

  const records = accessDenied ? null : (historyQuery.data?.items ?? null);

  const changePage = useCallback(
    (nextPage: number): void => {
      const safePage = Math.max(1, Math.min(MAX_RECORD_PAGE, nextPage));
      const next = new URLSearchParams(searchParams.toString());
      if (safePage === 1) next.delete("page");
      else next.set("page", String(safePage));
      const query = next.toString();
      router.push(asRoute(query ? `${pathname}?${query}` : pathname), {
        scroll: false,
      });
    },
    [pathname, router, searchParams],
  );

  return (
    <PageShell className="max-w-6xl">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Archive className="h-4 w-4" aria-hidden />
            Monetization archive
          </div>
          <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight md:text-3xl">
            Discount history
          </h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
            Review sanitized historical terms and recorded use. Redeemable
            codes, subscriber identities, and provider identifiers never appear
            in this view.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 shrink-0 sm:min-h-9"
          loading={historyQuery.isFetching}
          disabled={!meQuery.isSuccess || accessDenied}
          onClick={() => void historyQuery.refetch()}
        >
          Refresh snapshot
        </Button>
      </header>

      <section
        aria-labelledby="discount-evidence-boundary"
        className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/[0.035] p-4 text-sm"
      >
        <ShieldCheck
          className="mt-0.5 h-4 w-4 shrink-0 text-primary"
          aria-hidden
        />
        <div>
          <h2 id="discount-evidence-boundary" className="font-medium">
            Historical, read-only evidence
          </h2>
          <p className="mt-1 max-w-3xl leading-5 text-muted-foreground">
            “Within stored rules” evaluates only the local expiry and recorded
            count. It does not check checkout availability, pricing,
            entitlements, or provider state. This route cannot create, edit,
            delete, redeem, export, or verify a discount.
          </p>
        </div>
      </section>

      {meQuery.isError ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 p-4"
        >
          <p className="font-medium text-destructive">
            Workspace access could not be verified
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Discount history was not requested because the current workspace
            could not be resolved.
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-4 min-h-11 sm:min-h-9"
            loading={meQuery.isFetching}
            onClick={() => void meQuery.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : (
        <>
          <div className="relative w-full max-w-md">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              className="pl-9"
              placeholder="Search this page’s labels, benefits, currency, or scope…"
              aria-label="Search this page of discount history"
              autoComplete="off"
              value={searchInput}
              maxLength={120}
              disabled={!meQuery.isSuccess || accessDenied}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && searchInput) {
                  event.preventDefault();
                  setSearchInput("");
                }
              }}
            />
          </div>

          <DiscountHistoryCard
            records={records}
            error={historyQuery.isError || accessDenied}
            accessDenied={accessDenied}
            retrying={historyQuery.isFetching}
            search={urlSearch}
            page={page}
            hasMore={historyQuery.data?.hasMore ?? false}
            reachedOffsetLimit={page === MAX_RECORD_PAGE}
            onPageChange={changePage}
            onClearSearch={() => setSearchInput("")}
            onRetry={() => void historyQuery.refetch()}
            onViewEvents={openEvents}
          />

          <CouponPoolsCard />

          {eventRecord ? (
            <RedemptionHistoryDialog
              recordId={eventRecord.id}
              recordLabel={eventRecord.label}
              discountsBaseKey={discountsBaseKey}
              onClose={closeEvents}
            />
          ) : null}
        </>
      )}
    </PageShell>
  );
}
