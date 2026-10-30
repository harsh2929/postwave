// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Revenue rollup sourced from the Mailchimp-compat ecommerce summary. Shown
// only when a commerce integration reports revenue (a purely-email tenant sees
// nothing rather than empty $0 tiles). Shared by the analytics Overview
// (ANL-015) and the home dashboard (OVR-033) so both surface commerce revenue
// identically.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getMailchimpCompatSummary } from "@/lib/mailchimp-compat-api";
import { base, STALE, type RoleKey } from "@/lib/query-keys";
import { formatCents } from "@/lib/analytics-format";

export function RevenueTiles({
  tenantId,
  role,
  userId,
  viewerMode,
}: {
  tenantId: string;
  role: RoleKey | null;
  userId: string;
  viewerMode: boolean;
}) {
  const query = useQuery({
    queryKey: [
      ...base("compat-summary", tenantId, role),
      userId,
      viewerMode ? "viewer" : "member",
    ],
    queryFn: ({ signal }) => getMailchimpCompatSummary({ signal }),
    enabled: tenantId !== "anon" && userId !== "unverified" && role !== null,
    staleTime: STALE.dashboard,
  });
  // "Nothing to show" and "we never found out" look identical once this
  // returns null, and the honest reading of a silent Revenue section is that
  // the workspace has no commerce integration — so an operator whose summary
  // 5xx'd goes hunting in integration settings instead of retrying. The three
  // states are kept apart: in flight, failed, answered.
  if (query.isLoading) {
    return (
      <RevenueSection>
        <div className="grid grid-cols-2 gap-3">
          {[0, 1].map((i) => (
            <div key={i} className="space-y-2 rounded-md border bg-card px-4 py-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-7 w-20" />
            </div>
          ))}
        </div>
      </RevenueSection>
    );
  }
  // Only when there is nothing to show. A failed background refetch keeps the
  // last figures on screen and says so under them, rather than replacing a
  // working section with an error.
  if (query.isError && !query.data) {
    return (
      <RevenueSection>
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
        >
          <span>
            Could not load revenue. This is a failed request, not a workspace
            without commerce data.
          </span>
          <Button
            size="sm"
            variant="outline"
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </div>
      </RevenueSection>
    );
  }
  const ecom = query.data?.ecommerce;
  if (
    !ecom ||
    (ecom.integrations === 0 &&
      ecom.revenue_cents === 0 &&
      ecom.attributed_revenue_cents === 0)
  ) {
    return null;
  }
  const tiles = [
    { label: "Revenue", value: ecom.revenue_cents },
    { label: "Attributed revenue", value: ecom.attributed_revenue_cents },
  ];
  return (
    <RevenueSection>
      <dl className="grid grid-cols-2 gap-3">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-md border bg-card px-4 py-3">
            <dt className="text-xs font-medium uppercase text-muted-foreground">
              {t.label}
            </dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">
              {formatCents(t.value)}
            </dd>
          </div>
        ))}
      </dl>
      {query.isError ? (
        <p role="alert" className="text-xs text-warning-emphasis">
          These are the last figures loaded — the most recent refresh failed.
        </p>
      ) : null}
    </RevenueSection>
  );
}

function RevenueSection({ children }: { children: ReactNode }) {
  return (
    <section aria-label="Revenue" className="space-y-3">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Revenue
      </h2>
      {children}
    </section>
  );
}
