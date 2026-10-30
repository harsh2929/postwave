// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * List hygiene — who stops receiving mail, and what would bring them back.
 *
 * Eight paths desktop reached and web did not.
 *
 * `automatic_reactivation_active` CHANGES THE MEANING OF EVERY OTHER NUMBER
 * on the soft-bounce panel. "40 eligible now" with automation off means forty
 * people are sitting recoverable and nothing will recover them — someone has
 * to act. With automation on, the same forty are already being handled.
 * Identical figure, opposite call to action, and only the flag distinguishes
 * them.
 *
 * A NULL SEND WINDOW IS THE PERMISSIVE CASE. `{"policy": null}` means sending
 * is unrestricted, which is worth stating rather than rendering as an empty
 * panel that reads like a missing feature.
 */

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { ContentQueryError } from "../_content-automation/content-query-error";
import { Button } from "@/components/ui/button";
import { whoami } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import {
  getSendWindow,
  getSoftBounceStats,
  getSpamTrapStats,
  listSunsetPolicies,
} from "@/lib/list-hygiene-api";
import { base, qk, STALE } from "@/lib/query-keys";
import {
  canManageSunsetPolicies,
  SunsetPoliciesCard,
} from "@/components/subscribers/SunsetPoliciesCard";

/** The same bordered section the page's own panels use while their read is pending. */
function HygienePanelLoading({ label }: { label: string }) {
  return (
    <section
      role="status"
      aria-live="polite"
      aria-label={label}
      className="rounded-lg border p-4 sm:p-6"
    >
      <p className="text-sm text-muted-foreground">Loading…</p>
    </section>
  );
}

// The two editors sit below the soft-bounce and spam-trap panels and carry
// their own admin APIs, so they load after first paint in their own chunks;
// the page stays under the dashboard bundle budget without changing what the
// operator sees once they are in.
const SendWindowPolicyCard = dynamic(
  () => import("./send-window-policy-card").then((m) => m.SendWindowPolicyCard),
  { loading: () => <HygienePanelLoading label="Loading send window" /> },
);
const FrequencyCapsPanel = dynamic(
  () => import("./frequency-caps-panel").then((m) => m.FrequencyCapsPanel),
  { loading: () => <HygienePanelLoading label="Loading frequency caps" /> },
);

export default function ListHygienePage() {
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
        "list-hygiene",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  const traps = useQuery({
    queryKey: [...keyBase, "spam-traps"],
    queryFn: getSpamTrapStats,
    enabled: canLoad,
    staleTime: STALE.dashboard,
  });
  const bounces = useQuery({
    queryKey: [...keyBase, "soft-bounces"],
    queryFn: getSoftBounceStats,
    enabled: canLoad,
    staleTime: STALE.dashboard,
  });
  // The sunset LIST is ScopeAdmin, so it is only requested for owner/admin
  // outside viewer mode; everyone else gets the card's reason, not a 403.
  // Named because the card below observes the same key.
  const canManageSunset = canLoad && canManageSunsetPolicies(meQuery.data);
  const sunsetKey = useMemo(() => [...keyBase, "sunset"], [keyBase]);
  const sunset = useQuery({
    queryKey: sunsetKey,
    queryFn: listSunsetPolicies,
    enabled: canLoad && canManageSunset,
    staleTime: STALE.list,
  });
  // Named because the editor card below observes the same key.
  const sendWindowKey = useMemo(() => [...keyBase, "send-window"], [keyBase]);
  const window_ = useQuery({
    queryKey: sendWindowKey,
    queryFn: getSendWindow,
    enabled: canLoad,
    staleTime: STALE.reference,
  });

  const t = traps.data;
  const b = bounces.data;
  // `refetch()` ignores `enabled`, so the admin-only sunset read is left out
  // of the page-wide refresh for everyone the card withholds it from.
  const checks = canManageSunset
    ? [traps, bounces, sunset, window_]
    : [traps, bounces, window_];
  const failedChecks = checks.filter((query) => query.isError);
  const refreshing = checks.some((query) => query.isFetching);
  const retryingFailedCheck = failedChecks.some((query) => query.isFetching);

  const retryFailedChecks = () => {
    for (const query of failedChecks) void query.refetch();
  };

  const refreshAllChecks = () => {
    for (const query of checks) {
      void query.refetch();
    }
  };

  if (!canLoad) {
    return (
      <PageShell className="max-w-5xl">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          List hygiene
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
            List hygiene
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Who has stopped receiving mail, what would bring them back, and the
            limits on how often you send.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={refreshAllChecks}
          disabled={refreshing}
          aria-busy={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh hygiene"}
        </Button>
      </header>

      {failedChecks.length > 0 ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4"
        >
          <p className="text-sm text-destructive">
            {failedChecks.length} list-hygiene{" "}
            {failedChecks.length === 1 ? "check is" : "checks are"} unavailable.
            No failed result is being shown as zero.
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
        aria-labelledby="lh-bounce"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="lh-bounce" className="text-base font-medium">
          Soft-bounce recovery
        </h2>
        {bounces.isPending ? (
          <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
        ) : bounces.isError ? (
          <p className="mt-2 text-sm text-destructive">
            Could not load soft-bounce recovery.
          </p>
        ) : b ? (
          <>
            <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Disabled", b.disabled_count],
                ["Eligible now", b.eligible_now],
                ["Suppressions eligible", b.eligible_suppressions_now],
                ["Window", `${b.recovery_window_days}d`],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-md bg-muted/40 p-3">
                  <dt className="text-xs uppercase text-muted-foreground">
                    {label}
                  </dt>
                  <dd className="text-lg tabular-nums">
                    {typeof value === "number" ? value.toLocaleString() : value}
                  </dd>
                </div>
              ))}
            </dl>
            {/* The flag that decides what "eligible" implies. */}
            <p className="mt-3 text-sm text-muted-foreground">
              {b.automatic_reactivation_active
                ? "Automatic reactivation is on — eligible addresses are being recovered without you."
                : b.eligible_now > 0
                  ? "Automatic reactivation is OFF, so nothing will act on the eligible addresses above. They stay disabled until someone reactivates them."
                  : "Automatic reactivation is off. Nothing is currently eligible."}
            </p>
          </>
        ) : null}
      </section>

      <section
        aria-labelledby="lh-traps"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="lh-traps" className="text-base font-medium">
          Spam-trap guard
        </h2>
        {traps.isPending ? (
          <p className="mt-1 text-sm text-muted-foreground">Loading…</p>
        ) : traps.isError ? (
          <p className="mt-1 text-sm text-destructive">
            Could not load spam-trap statistics.
          </p>
        ) : t ? (
          <>
            <p className="mt-1 text-sm text-muted-foreground">
              {t.hits_last_30_days.toLocaleString()} hit(s) in the last 30 days;{" "}
              {t.blocklisted_count.toLocaleString()} blocklisted;{" "}
              {t.eligible_now.toLocaleString()} eligible for action now.
            </p>
            {t.observed_at ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Observed{" "}
                {formatWireTimestamp(t.observed_at, "at an unknown time")}.
              </p>
            ) : null}
          </>
        ) : null}
      </section>

      {/* The card observes the SAME query key as `window_` above, so the two
          share one fetch and one cache entry: the failed-check aggregation
          keeps counting the read, and a save from inside the card updates this
          page's copy without a second round trip. */}
      <SendWindowPolicyCard
        identity={meQuery.data ?? null}
        queryKey={sendWindowKey}
      />

      {meQuery.isSuccess ? (
        <FrequencyCapsPanel identity={meQuery.data} />
      ) : meQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Workspace identity could not be verified, so frequency-cap controls
          were not requested.
        </p>
      ) : null}

      {/* Shares `sunsetKey` with the `sunset` query above: one fetch, and the
          failed-check banner keeps counting a failed policy read. */}
      <SunsetPoliciesCard
        identity={meQuery.data ?? null}
        queryKey={sunsetKey}
      />
    </PageShell>
  );
}
