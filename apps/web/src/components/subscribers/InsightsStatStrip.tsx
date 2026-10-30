// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery } from "@tanstack/react-query";

import { STALE } from "@/lib/query-keys";
import {
  getDirectoryInsights,
  getDirectoryViewTotal,
} from "@/lib/subscriber-directory-api";

import { useDirectoryIdentity, useDirectoryUrlState } from "./directory-context";

function Figure({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-base font-semibold tabular-nums">
        {value}
        {hint ? (
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

/**
 * Workspace total, the applied view's match total, and net new over 30 days
 * (added − unsubscribed, from the dashboard stats the analytics surface uses).
 * A figure that could not be read says so; it never renders as zero.
 */
export function InsightsStatStrip() {
  const identity = useDirectoryIdentity();
  const { view } = useDirectoryUrlState();
  const insights = useQuery({
    queryKey: [...identity.subscribersKey, "directory-insights"],
    queryFn: ({ signal }) => getDirectoryInsights(signal),
    enabled: identity.ready,
    staleTime: STALE.dashboard,
  });
  const viewTotal = useQuery({
    queryKey: [...identity.subscribersKey, "directory-view-total", view],
    queryFn: ({ signal }) => getDirectoryViewTotal(view, signal),
    enabled: identity.ready,
    staleTime: STALE.list,
  });

  const workspace = insights.isError
    ? "unavailable"
    : insights.data
      ? insights.data.workspaceTotal.toLocaleString()
      : "…";
  const matching = viewTotal.isError
    ? "unavailable"
    : viewTotal.data !== undefined
      ? viewTotal.data.toLocaleString()
      : "…";
  const added = insights.data?.added30d ?? null;
  const unsubscribed = insights.data?.unsubscribed30d ?? null;
  const net =
    added !== null && unsubscribed !== null ? added - unsubscribed : null;
  const netHint =
    added !== null && unsubscribed !== null
      ? `+${added.toLocaleString()} added · ${unsubscribed.toLocaleString()} unsubscribed`
      : undefined;
  const netText = insights.isError
    ? "unavailable"
    : !insights.data
      ? "…"
      : net === null
        ? "—"
        : `${net > 0 ? "+" : ""}${net.toLocaleString()}`;

  return (
    <dl
      aria-label="Directory insights"
      className="grid grid-cols-2 gap-3 rounded-md border bg-card px-4 py-2.5 sm:grid-cols-3"
    >
      <Figure label="Workspace total" value={workspace} />
      <Figure label="This view" value={matching} />
      <Figure
        label="Net new · 30 days"
        value={netText}
        hint={netHint}
      />
    </dl>
  );
}
