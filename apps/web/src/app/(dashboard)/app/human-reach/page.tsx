// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Human-engaged reach — a floor, and the server's own words about why.
 *
 * `/api/v1/analytics/human-engaged-reach` was reached by desktop and by nothing
 * on web.
 *
 * THE SERVER REFUSES TO CALL THIS AN ESTIMATE, AND SO DOES THIS PAGE. It ships
 * a finished `headline` sentence and a `methodology` paragraph whose argument
 * is that recipients delivered to but never observed interacting are NOT
 * counted, because "absence of evidence is not evidence" — so the figure is a
 * lower bound. Rendering `human_engaged_reach_floor` under a label like "Reach"
 * would convert that deliberate floor into an apparent measurement: the exact
 * claim the server went to the trouble of not making.
 *
 * The unclassified band is shown as its own number for the same reason. It is
 * never allocated to human or machine upstream, and allocating it here — even
 * by omission, by letting the reader assume it is zero — would undo that.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { ContentQueryError } from "../_content-automation/content-query-error";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { whoami } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { getHumanEngagedReach } from "@/lib/human-reach-api";
import { REACH_UNAVAILABLE_MESSAGE } from "@/lib/human-engaged-reach";
import { base, qk, STALE } from "@/lib/query-keys";

export default function HumanReachPage() {
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
        "human-reach",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  const reach = useQuery({
    queryKey: [...keyBase, "reach"],
    queryFn: getHumanEngagedReach,
    enabled: canLoad,
    staleTime: STALE.dashboard,
  });

  const r = reach.data;

  if (!canLoad) {
    return (
      <PageShell className="max-w-5xl">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Human-engaged reach
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
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Human-engaged reach
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A lower bound from calibrated interaction classification. It does
            not prove a recipient read or understood the message.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void reach.refetch()}
          disabled={reach.isFetching}
          aria-busy={reach.isFetching}
        >
          {reach.isFetching ? "Refreshing…" : "Refresh reach"}
        </Button>
      </header>

      {reach.isPending ? (
        <div role="status" aria-busy="true" className="space-y-3">
          <span className="sr-only">Loading human-engaged reach…</span>
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : reach.isError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4"
        >
          <p className="text-sm text-destructive">
            {reach.error instanceof Error && reach.error.message.trim() !== ""
              ? reach.error.message
              : REACH_UNAVAILABLE_MESSAGE}{" "}
            No reach estimate is being inferred.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void reach.refetch()}
            disabled={reach.isFetching}
          >
            {reach.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      ) : r ? (
        <>
          <section
            aria-labelledby="hr-headline"
            className="rounded-lg border p-4 sm:p-6"
          >
            <h2 id="hr-headline" className="text-base font-medium">
              This window
            </h2>
            {/* The server writes this sentence. Rendered verbatim so the two
                surfaces cannot describe the same figure differently. */}
            <p className="mt-2 text-lg">
              {r.headline || "No headline reported."}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatWireTimestamp(r.window_start, "unknown", (d) =>
                d.toLocaleDateString(),
              )}{" "}
              –{" "}
              {formatWireTimestamp(r.window_end, "unknown", (d) =>
                d.toLocaleDateString(),
              )}
            </p>
            {r.shadow_mode ? (
              <p className="mt-2 text-sm text-muted-foreground">
                The classifier is in shadow mode — it is scoring but not
                affecting anything.
              </p>
            ) : null}
            {r.mixed_classifier_versions ? (
              <p className="mt-2 text-sm text-muted-foreground">
                More than one classifier version contributed to this window, so
                the figures are not strictly comparable across it.
              </p>
            ) : null}
          </section>

          <section aria-labelledby="hr-bands">
            <h2 id="hr-bands" className="text-base font-medium">
              Where recipients landed
            </h2>
            <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[
                ["Delivered", r.provider_accepted_recipients],
                ["Human-classified floor", r.human_engaged_reach_floor],
                ["Classified upper bound", r.human_engaged_reach_upper_bound],
                // Shown, never folded away: the server keeps this band out of
                // both totals on purpose.
                ["Unclassified", r.unknown_band],
                ["Machine only", r.machine_only_recipients],
                ["No interaction", r.no_interaction_recipients],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-md border p-3">
                  <dt className="text-xs uppercase text-muted-foreground">
                    {label}
                  </dt>
                  <dd className="text-lg tabular-nums">
                    {Number(value).toLocaleString()}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {r.methodology ? (
            <section aria-labelledby="hr-method">
              <h2 id="hr-method" className="text-base font-medium">
                How this is counted
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {r.methodology}
              </p>
              {r.classifier_version ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Classifier <code>{r.classifier_version}</code>
                </p>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </PageShell>
  );
}
