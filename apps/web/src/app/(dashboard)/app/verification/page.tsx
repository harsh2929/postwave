// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Email verification — jobs, providers, policy, and a credit balance that is
 * allowed to be unknown.
 *
 * WHY THIS PAGE EXISTS. Eight `/api/v1/verification/*` paths were reached by
 * desktop and by nothing on web, so the primary surface could not tell an
 * operator whether an address was deliverable before sending to it.
 *
 * NULL BALANCE IS NOT ZERO BALANCE. The server answers `balance: null` with a
 * note explaining that no paid provider is configured and local checks are
 * free. Printing 0 there would read as "you are out of credits" and stop
 * somebody verifying when verification is available and costs nothing — the
 * precise inversion of the truth.
 */

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { Button } from "@/components/ui/button";
import { whoami } from "@/lib/auth-api";
import {
  getVerificationCache,
  getVerificationCredits,
} from "@/lib/verification-api";
import { base, STALE } from "@/lib/query-keys";

/**
 * Both data panels are gated on the browser's own whoami call, so a failed
 * identity check leaves them disabled — and a disabled TanStack query reports
 * `pending`, which would otherwise print "Loading…" forever with no error and
 * nothing to press. The dashboard layout's server-side whoami does not seed
 * this cache, so this request fails on its own.
 */
function IdentityUnavailable({
  what,
  retrying,
  onRetry,
}: {
  what: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mt-2 space-y-3">
      <p className="text-sm text-destructive" role="alert">
        Workspace identity could not be verified, so {what} was not requested.
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={onRetry}
        disabled={retrying}
      >
        {retrying ? "Retrying…" : "Retry identity check"}
      </Button>
    </div>
  );
}

function VerificationPanelFallback({ label }: { label: string }) {
  return (
    <section
      role="status"
      aria-busy="true"
      className="min-h-28 rounded-lg border border-dashed p-4 text-sm text-muted-foreground"
    >
      Loading {label}…
    </section>
  );
}

const VerificationAdminPanel = dynamic(
  () =>
    import("./verification-admin-panel").then(
      (module) => module.VerificationAdminPanel,
    ),
  {
    ssr: false,
    loading: () => <VerificationPanelFallback label="verification policy" />,
  },
);
const VerificationJobsPanel = dynamic(
  () =>
    import("./verification-jobs-panel").then(
      (module) => module.VerificationJobsPanel,
    ),
  {
    ssr: false,
    loading: () => <VerificationPanelFallback label="verification jobs" />,
  },
);
const VerifyAddressPanel = dynamic(
  () =>
    import("./verify-address-panel").then(
      (module) => module.VerifyAddressPanel,
    ),
  {
    ssr: false,
    loading: () => <VerificationPanelFallback label="address verifier" />,
  },
);

export default function VerificationPage() {
  const queryClient = useQueryClient();
  const [refreshRequested, setRefreshRequested] = useState(false);
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  // `isError` alone is not "identity unavailable": TanStack v5 keeps `data`
  // when a BACKGROUND refetch fails, and this app refetches identity on window
  // focus and reconnect. Reading the bare flag threw away a loaded credit
  // balance and cache summary after one blip, and printed "identity could not
  // be verified" while the panels below kept rendering off that same identity.
  // The repo idiom is `x.isError && !x.data` (custom-objects-client.tsx:379,
  // sms-quiet-hours-card.tsx:541, and this page's own Administration section).
  const identityUnavailable = meQuery.isError && !meQuery.data;
  const keyBase = useMemo(
    () =>
      base(
        "verification",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.viewer_mode
          ? "viewer"
          : (meQuery.data?.effective_role ?? meQuery.data?.role ?? null),
      ),
    [
      meQuery.data?.effective_role,
      meQuery.data?.role,
      meQuery.data?.tenant_id,
      meQuery.data?.viewer_mode,
    ],
  );
  const credits = useQuery({
    queryKey: [...keyBase, "credits"],
    queryFn: getVerificationCredits,
    enabled: Boolean(meQuery.data),
    staleTime: STALE.reference,
  });
  const cache = useQuery({
    queryKey: [...keyBase, "cache"],
    queryFn: getVerificationCache,
    enabled: Boolean(meQuery.data),
    staleTime: STALE.reference,
  });
  const cacheStatuses = Object.entries(cache.data?.by_status ?? {});
  const activeChecks = [credits, cache];
  const failedChecks = activeChecks.filter((query) => query.isError);
  const retryingFailedCheck = failedChecks.some((query) => query.isFetching);
  const activeVerificationFetches = useIsFetching({ queryKey: keyBase });
  const refreshing = refreshRequested || activeVerificationFetches > 0;

  const retryFailedChecks = () => {
    for (const query of failedChecks) void query.refetch();
  };

  const refreshAllChecks = async () => {
    setRefreshRequested(true);
    try {
      // whoami is not under keyBase, and while it is failing the credit and
      // cache queries are disabled — so invalidating keyBase alone would
      // refresh nothing at all and the button would look inert.
      await meQuery.refetch();
      await queryClient.invalidateQueries({
        queryKey: keyBase,
        refetchType: "active",
      });
    } finally {
      setRefreshRequested(false);
    }
  };

  return (
    <PageShell className="max-w-5xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Email verification
          </h1>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            Check addresses before you send to them — and see what it is
            costing.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void refreshAllChecks()}
          disabled={refreshing}
          aria-busy={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh data"}
        </Button>
      </header>

      {failedChecks.length > 0 ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4"
        >
          <p className="text-sm text-destructive">
            {failedChecks.length} verification{" "}
            {failedChecks.length === 1 ? "dataset is" : "datasets are"}{" "}
            unavailable. Unknown values are not being shown as zero.
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
        aria-labelledby="v-credits"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="v-credits" className="text-base font-medium">
          Credits
        </h2>
        {identityUnavailable ? (
          <IdentityUnavailable
            what="the credit balance"
            retrying={meQuery.isFetching}
            onRetry={() => void meQuery.refetch()}
          />
        ) : credits.isPending ? (
          <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
        ) : credits.isError ? (
          <p className="mt-2 text-sm text-destructive">
            Could not load the credit balance.
          </p>
        ) : credits.data ? (
          <div className="mt-2">
            <p className="text-3xl font-semibold tabular-nums">
              {/* NULL is rendered as an em-dash, never as 0: "no provider
                  configured" and "no credits left" are opposite situations. */}
              {credits.data.balance === null
                ? "—"
                : credits.data.balance === -1
                  ? "Unmetered"
                  : credits.data.balance.toLocaleString()}
            </p>
            {credits.data.note ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {credits.data.note}
              </p>
            ) : credits.data.provider ? (
              <p className="mt-1 text-sm text-muted-foreground">
                via {credits.data.provider}
              </p>
            ) : null}
            {credits.data.totals ? (
              <dl className="mt-4 grid gap-3 sm:grid-cols-3">
                {[
                  ["Cache hits", credits.data.totals.cache_hits],
                  ["Credits saved", credits.data.totals.credits_saved],
                  ["Credits spent", credits.data.totals.credits_spent],
                ].map(([label, value]) => (
                  <div
                    key={String(label)}
                    className="rounded-md bg-muted/40 p-3"
                  >
                    <dt className="text-xs uppercase text-muted-foreground">
                      {label}
                    </dt>
                    <dd className="text-sm tabular-nums">
                      {Number(value).toLocaleString()}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        ) : null}
      </section>

      {meQuery.data ? (
        <VerifyAddressPanel identity={meQuery.data} queryKeyBase={keyBase} />
      ) : null}

      {meQuery.data ? (
        <VerificationAdminPanel
          identity={meQuery.data}
          queryKeyBase={keyBase}
        />
      ) : (
        <section className="rounded-lg border p-4 sm:p-6">
          <h2 className="text-base font-medium">Administration</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {meQuery.isError
              ? "Authorization could not be verified. Admin configuration was not requested."
              : "Loading authorization…"}
          </p>
        </section>
      )}

      <section
        aria-labelledby="v-cache"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="v-cache" className="text-base font-medium">
          Cache
        </h2>
        {identityUnavailable ? (
          <IdentityUnavailable
            what="the cache summary"
            retrying={meQuery.isFetching}
            onRetry={() => void meQuery.refetch()}
          />
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            {cache.isPending
              ? "Loading…"
              : cache.isError
                ? "Could not load the verification cache."
                : cache.data
                  ? `${cache.data.total.toLocaleString()} cached result(s); ${cache.data.expiring_within_7d.toLocaleString()} expiring within 7 days.`
                  : "Not available."}
          </p>
        )}
        {cacheStatuses.length > 0 ? (
          <ul className="mt-2 divide-y rounded-lg border">
            {/* by_status is an OBJECT keyed by status, not an array. */}
            {cacheStatuses.map(([status, count]) => (
              <li
                key={status}
                className="flex items-center justify-between gap-4 p-3 text-sm"
              >
                <span className="min-w-0 break-all">{status}</span>
                <span className="text-muted-foreground tabular-nums">
                  {Number(count).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {meQuery.data ? (
        <VerificationJobsPanel identity={meQuery.data} queryKeyBase={keyBase} />
      ) : (
        <section className="rounded-lg border p-4 sm:p-6">
          <h2 className="text-base font-medium">Recent jobs</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Authorization is required before job history can be requested.
          </p>
        </section>
      )}
    </PageShell>
  );
}
