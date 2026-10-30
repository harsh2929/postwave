// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Source quality, gifts and paywall tiers.
 *
 * Five paths desktop reached and web did not.
 *
 * A 0% COMPLAINT RATE ON ZERO SENDS IS NOT A COMPLIMENT. `growth-source/quality`
 * reports engagement, bounce and complaint rates per acquisition source, and
 * with nothing sent yet all three are 0. Rendered as percentages beside a
 * subscriber count, that reads as a flawless source — when in fact nothing has
 * been measured. The page says which of the two it is looking at.
 *
 * This is the value of the endpoint: a source delivering volume AND complaints
 * is worse than one delivering nothing, and a growth screen showing only counts
 * cannot tell you that.
 */

import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Gift, Layers3, Store, TrendingUp } from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import { ContentQueryError } from "../_content-automation/content-query-error";
import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernanceMetrics,
  GovernancePageHeader,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { Badge } from "@/components/ui/badge";
import { whoami } from "@/lib/auth-api";
import {
  attributedPoints,
  getGiftStats,
  getGrowthSourceTimeseries,
  getSourceQuality,
  hasNoOutcomesYet,
  listCommerceCatalogs,
  listPaywallTiers,
} from "@/lib/monetisation-api";
import { base, qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";

/**
 * `listCommerceCatalogs` reads one cursor page and drops the cursor, and
 * `internal/commerce` defaults that page to 50 rows. A full page is therefore
 * a floor, not a workspace total, and must not be rendered as an exact count.
 * (Paywall tiers needs no such guard: that endpoint fails loud above its
 * 1000-row ceiling rather than returning a truncated set.)
 */
const CATALOG_PAGE_SIZE = 50;

export default function SourceQualityPage() {
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
        "source-quality",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  const quality = useQuery({
    queryKey: [...keyBase, "quality"],
    queryFn: getSourceQuality,
    enabled: canLoad,
    staleTime: STALE.dashboard,
  });
  const gifts = useQuery({
    queryKey: [...keyBase, "gifts"],
    queryFn: getGiftStats,
    enabled: canLoad,
    staleTime: STALE.dashboard,
  });
  const tiers = useQuery({
    queryKey: [...keyBase, "tiers"],
    queryFn: listPaywallTiers,
    enabled: canLoad,
    staleTime: STALE.reference,
  });
  const catalogs = useQuery({
    queryKey: [...keyBase, "catalogs"],
    queryFn: listCommerceCatalogs,
    enabled: canLoad,
    staleTime: STALE.reference,
  });

  const sources = Array.isArray(quality.data?.sources)
    ? quality.data.sources
    : [];
  const g = gifts.data;
  const tierRows = Array.isArray(tiers.data) ? tiers.data : [];
  const catalogRows = Array.isArray(catalogs.data) ? catalogs.data : [];

  const series = useQuery({
    queryKey: [...keyBase, "growth-timeseries"],
    queryFn: getGrowthSourceTimeseries,
    enabled: canLoad,
    staleTime: STALE.list,
  });
  const points = Array.isArray(series.data?.points) ? series.data.points : [];
  const attributed = attributedPoints(points);
  const refreshing =
    meQuery.isFetching ||
    quality.isFetching ||
    gifts.isFetching ||
    tiers.isFetching ||
    catalogs.isFetching ||
    series.isFetching;

  if (!canLoad) {
    return (
      <PageShell className="max-w-5xl">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Source quality
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
      <GovernancePageHeader
        icon={TrendingUp}
        eyebrow="Growth intelligence"
        title="Source quality"
        description="Not just where subscribers came from, but whether each source produced engagement, bounces, or complaints after arrival."
        refreshLabel="Refresh source data"
        refreshing={refreshing}
        onRefresh={() => {
          void quality.refetch();
          void gifts.refetch();
          void tiers.refetch();
          void catalogs.refetch();
          void series.refetch();
        }}
      />

      <GovernanceSection
        icon={BarChart3}
        title="By acquisition source"
        description="A zero rate with no measured outcomes is shown as unmeasured, never as perfect performance."
      >
        {quality.isPending ? (
          <GovernanceLoading
            label="Loading acquisition-source quality…"
            rows={4}
          />
        ) : quality.isError ? (
          <GovernanceError
            message="Could not load source quality. No source is being shown as healthy or unhealthy."
            retrying={quality.isFetching}
            onRetry={() => void quality.refetch()}
          />
        ) : sources.length === 0 ? (
          <GovernanceEmpty>No acquisition sources recorded.</GovernanceEmpty>
        ) : (
          <ul className="divide-y rounded-xl border">
            {sources.map((s) => (
              <li key={s.consent_source} className="min-w-0 p-4">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 break-words text-sm font-medium capitalize">
                    {s.consent_source.replace(/_/gu, " ") || "Source unknown"}
                  </span>
                  <Badge variant="secondary">
                    {s.total_subscribers.toLocaleString()}{" "}
                    {s.total_subscribers === 1 ? "subscriber" : "subscribers"}
                  </Badge>
                </div>
                {/* 0/0/0 with subscribers means unmeasured, not flawless. */}
                {hasNoOutcomesYet(s) ? (
                  <p className="mt-3 rounded-lg bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground">
                    No sends to these subscribers yet, so engagement, bounce,
                    and complaint rates are unmeasured rather than zero.
                  </p>
                ) : (
                  <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {[
                      ["Engaged", s.engagement_rate],
                      ["Bounced", s.bounce_rate],
                      ["Complained", s.complaint_rate],
                    ].map(([label, value]) => (
                      <div
                        key={String(label)}
                        className="rounded-lg bg-muted/30 p-2.5"
                      >
                        <dt className="text-xs text-muted-foreground">
                          {label}
                        </dt>
                        <dd className="mt-0.5 font-semibold tabular-nums">
                          {Number(value).toLocaleString()}%
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            ))}
          </ul>
        )}
        {quality.data?.window_days ? (
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            Measurement window: {quality.data.window_days.toLocaleString()}{" "}
            days.
          </p>
        ) : null}
      </GovernanceSection>

      <GovernanceSection
        icon={Gift}
        title="Gift subscriptions"
        description="Lifecycle totals keep paid, granted, cancelled, expired, and refunded gifts distinct."
      >
        {gifts.isPending ? (
          <GovernanceLoading
            label="Loading gift-subscription statistics…"
            rows={3}
          />
        ) : gifts.isError ? (
          <GovernanceError
            message="Could not load gift statistics. No zero total is being inferred."
            retrying={gifts.isFetching}
            onRetry={() => void gifts.refetch()}
          />
        ) : g ? (
          g.total === 0 ? (
            <GovernanceEmpty>No gift subscriptions yet.</GovernanceEmpty>
          ) : (
            <GovernanceMetrics
              columns={4}
              items={[
                { label: "Total gifts", value: g.total.toLocaleString() },
                {
                  label: "Paid / granted",
                  value: `${g.paid.toLocaleString()} / ${g.granted.toLocaleString()}`,
                },
                {
                  label: "Ended",
                  value: (g.canceled + g.expired + g.refunded).toLocaleString(),
                  detail: `${g.canceled} cancelled · ${g.expired} expired · ${g.refunded} refunded`,
                },
                {
                  label: "Conversion",
                  value: `${g.conversionRate.toLocaleString()}%`,
                },
              ]}
            />
          )
        ) : (
          <GovernanceEmpty>No gift statistics reported.</GovernanceEmpty>
        )}
        {/* The aggregate cannot say whether a row contradicts itself. */}
        <p className="mt-3 text-sm">
          <Link
            href={asRoute("/app/source-quality/gifts")}
            className="inline-flex min-h-11 items-center text-primary hover:underline sm:min-h-0"
          >
            Inspect the gift record archive
          </Link>
        </p>
      </GovernanceSection>

      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <GovernanceSection
          icon={Layers3}
          title="Paywall tiers"
          description="Tier definitions currently returned for paid access."
        >
          {tiers.isPending ? (
            <GovernanceLoading label="Loading paywall tiers…" />
          ) : tiers.isError ? (
            <GovernanceError
              message="Could not load paywall tiers. This is a failed request, not an empty result."
              retrying={tiers.isFetching}
              onRetry={() => void tiers.refetch()}
            />
          ) : tierRows.length === 0 ? (
            <GovernanceEmpty>No paywall tiers configured.</GovernanceEmpty>
          ) : (
            <GovernanceMetrics
              columns={2}
              items={[
                {
                  label: "Paywall tiers",
                  value: tierRows.length.toLocaleString(),
                },
              ]}
            />
          )}
        </GovernanceSection>

        <GovernanceSection
          icon={Store}
          title="Commerce catalogues"
          description="Catalogues available to commerce workflows."
        >
          {catalogs.isPending ? (
            <GovernanceLoading label="Loading commerce catalogues…" />
          ) : catalogs.isError ? (
            <GovernanceError
              message="Could not load commerce catalogues. This is a failed request, not an empty result."
              retrying={catalogs.isFetching}
              onRetry={() => void catalogs.refetch()}
            />
          ) : catalogRows.length === 0 ? (
            <GovernanceEmpty>
              No commerce catalogues configured.
            </GovernanceEmpty>
          ) : (
            <GovernanceMetrics
              columns={2}
              items={[
                {
                  label: "Catalogues",
                  value:
                    catalogRows.length >= CATALOG_PAGE_SIZE
                      ? `${catalogRows.length.toLocaleString()}+`
                      : catalogRows.length.toLocaleString(),
                  detail:
                    catalogRows.length >= CATALOG_PAGE_SIZE
                      ? `First page only — the read stops at ${CATALOG_PAGE_SIZE}`
                      : undefined,
                },
              ]}
            />
          )}
          <p className="mt-3 text-sm">
            <Link
              href={asRoute("/app/commerce?tab=catalogs")}
              className="inline-flex min-h-11 items-center text-primary hover:underline sm:min-h-0"
            >
              Manage catalogs and product feeds
            </Link>
          </p>
        </GovernanceSection>
      </div>

      <GovernanceSection
        icon={TrendingUp}
        title="Daily signups"
        description="Quiet-day placeholders are not mislabelled as unattributed acquisition."
      >
        {series.isPending ? (
          <GovernanceLoading label="Loading daily signup series…" rows={3} />
        ) : series.isError ? (
          <GovernanceError
            message="Could not load the signup series. No acquisition trend is being inferred."
            retrying={series.isFetching}
            onRetry={() => void series.refetch()}
          />
        ) : (
          <>
            <GovernanceMetrics
              columns={2}
              items={[
                {
                  label: "Attributed signup days",
                  value: attributed.length.toLocaleString(),
                  detail: `Across a ${Number(series.data?.window_days ?? 0).toLocaleString()}-day window`,
                },
                {
                  label: "Series points",
                  value: points.length.toLocaleString(),
                  detail: "Includes quiet-day placeholders",
                },
              ]}
            />
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Days with no signups carry no source at all. That is not the same
              as a signup whose source is unknown.
            </p>
          </>
        )}
      </GovernanceSection>
    </PageShell>
  );
}
