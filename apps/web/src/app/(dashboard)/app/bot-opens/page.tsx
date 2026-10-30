// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Machine opens — how much of your open rate is a person.
 *
 * Two `/api/v1/bot-opens/*` paths desktop reached and web did not.
 *
 * Since Apple Mail Privacy Protection a large share of "opens" are prefetches,
 * not reads. The server splits total opens into bot and human against 18
 * detection signatures, and reports the TOTAL separately from the two parts —
 * so an unclassified remainder is visible rather than silently folded into one
 * side. This page shows that remainder for the same reason the human-reach
 * page shows its unclassified band: allocating it, even by omission, is the
 * one thing the classifier refuses to do.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { ContentQueryError } from "../_content-automation/content-query-error";
import { Button } from "@/components/ui/button";
import { whoami } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import {
  getBotOpenStats,
  listBotSignatures,
  unclassifiedOpens,
} from "@/lib/bot-opens-api";
import { base, qk, STALE } from "@/lib/query-keys";

export default function BotOpensPage() {
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
        "bot-opens",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  const stats = useQuery({
    queryKey: [...keyBase, "stats"],
    queryFn: getBotOpenStats,
    enabled: canLoad,
    staleTime: STALE.dashboard,
  });
  const signatures = useQuery({
    queryKey: [...keyBase, "signatures"],
    queryFn: listBotSignatures,
    enabled: canLoad,
    staleTime: STALE.reference,
  });

  const s = stats.data;
  const sigs = Array.isArray(signatures.data) ? signatures.data : [];
  const enabled = sigs.filter((x) => x.enabled);
  const failedChecks = [stats, signatures].filter((query) => query.isError);
  const refreshing = [stats, signatures].some((query) => query.isFetching);
  const retryingFailedCheck = failedChecks.some((query) => query.isFetching);

  const retryFailedChecks = () => {
    for (const query of failedChecks) void query.refetch();
  };

  const refreshAllChecks = () => {
    void stats.refetch();
    void signatures.refetch();
  };

  if (!canLoad) {
    return (
      <PageShell className="max-w-5xl">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Machine opens
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
            Machine opens
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            How much of your open rate is a person, and how much is a mail
            client prefetching.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={refreshAllChecks}
          disabled={refreshing}
          aria-busy={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh opens"}
        </Button>
      </header>

      {failedChecks.length > 0 ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4"
        >
          <p className="text-sm text-destructive">
            {failedChecks.length} machine-open{" "}
            {failedChecks.length === 1 ? "dataset is" : "datasets are"}{" "}
            unavailable. Missing results are not being classified as human.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={retryFailedChecks}
            disabled={retryingFailedCheck}
          >
            {retryingFailedCheck ? "Retrying…" : "Retry failed checks"}
          </Button>
        </div>
      ) : null}

      <section
        aria-labelledby="bo-split"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="bo-split" className="text-base font-medium">
          Open split
        </h2>
        {stats.isPending ? (
          <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
        ) : stats.isError ? (
          <p className="mt-2 text-sm text-destructive">
            Could not load the open split.
          </p>
        ) : s ? (
          <>
            <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Total opens", s.total_opens],
                ["Human", s.human_opens],
                ["Machine", s.bot_opens],
                // Shown rather than folded into either side.
                ["Unclassified", unclassifiedOpens(s)],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-md bg-muted/40 p-3">
                  <dt className="text-xs uppercase text-muted-foreground">
                    {label}
                  </dt>
                  <dd className="text-lg tabular-nums">
                    {Number(value).toLocaleString()}
                  </dd>
                </div>
              ))}
            </dl>
            {s.since ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Since{" "}
                {formatWireTimestamp(s.since, "an unknown date", (d) =>
                  d.toLocaleDateString(),
                )}
                .
              </p>
            ) : null}
            {s.total_opens === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                No opens recorded in this window, so there is nothing to
                classify yet.
              </p>
            ) : null}
          </>
        ) : null}
      </section>

      <section
        aria-labelledby="bo-sigs"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="bo-sigs" className="text-base font-medium">
          Detection signatures
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {signatures.isPending
            ? "Loading…"
            : signatures.isError
              ? "Could not load signatures."
              : `${enabled.length} of ${sigs.length} enabled.`}
        </p>
        {sigs.length > 0 ? (
          <ul className="mt-2 divide-y rounded-lg border">
            {sigs.map((sig) => (
              <li
                key={sig.id}
                className="flex flex-col items-start justify-between gap-1 p-3 text-sm sm:flex-row sm:items-center"
              >
                <span className="truncate" title={sig.pattern}>
                  {sig.label || sig.pattern}
                </span>
                <span className="text-muted-foreground">
                  {sig.enabled ? "on" : "off"}
                  {sig.is_default ? " · built-in" : " · custom"}
                </span>
              </li>
            ))}
          </ul>
        ) : signatures.isSuccess ? (
          <p className="mt-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No machine-open signatures are configured in this build.
          </p>
        ) : null}
      </section>
    </PageShell>
  );
}
