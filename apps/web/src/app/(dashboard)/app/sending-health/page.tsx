// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Sending health — timing, auto-suppression, reputation, spam traps.
 *
 * Five paths desktop reached and web did not.
 *
 * Two settings-versus-data gaps drive the copy:
 *
 *   - Per-recipient quiet hours is ON with zero recipient time buckets. The
 *     switch promises timing that cannot happen, so the page says the sends
 *     fall back to workspace time until buckets exist.
 *
 *   - `eligible_now` is a counterfactual while auto-suppression is off. It is
 *     labelled as "would be suppressed", never as a live figure, and the
 *     snapshot time is shown because this block is an observation rather than
 *     a live read.
 */

import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";

import { PageShell } from "@/components/dashboard/page-shell";
import { ContentQueryError } from "../_content-automation/content-query-error";
import { Button } from "@/components/ui/button";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import {
  eligibleIsCounterfactual,
  getAutoSuppress,
  getSenderReputation,
  getSendSettings,
  getSendingStatus,
  getSpamTrapHits,
  perRecipientTimingIsInert,
} from "@/lib/sending-reputation-api";
import { base, qk, STALE } from "@/lib/query-keys";
import { listSmsQuietHours } from "@/lib/sms-scheduling-api";
import { asRoute } from "@/lib/typed-routes";

/*
 * Reputation and trap reads answer for a fixed window and stop at a fixed row
 * count: `internal/sender_reputation` aggregates the last 7 days and returns
 * at most 50 domains; `internal/spam_trap_guard` defaults to the last 30 days
 * and returns at most 500 hits. Neither answer is workspace-wide, so an empty
 * one is a statement about the window — not about whether anything is being
 * tracked — and a full one is a floor rather than a total.
 */
const REPUTATION_WINDOW_DAYS = 7;
const REPUTATION_ROW_CAP = 50;
const TRAP_WINDOW_DAYS = 30;
const TRAP_ROW_CAP = 500;

export default function SendingHealthPage() {
  const queryClient = useQueryClient();
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
        "sending-health",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );
  const effectiveRole = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const smsCanRequest = Boolean(
    canLoad &&
    meQuery.data &&
    !meQuery.data.viewer_mode &&
    (effectiveRole === "owner" || effectiveRole === "admin"),
  );
  const smsKey = useMemo(
    () =>
      [
        "sms",
        "sending-health",
        meQuery.data?.tenant_id ?? null,
        meQuery.data?.user_id ?? null,
        effectiveRole,
        meQuery.data?.viewer_mode ?? null,
      ] as const,
    [effectiveRole, meQuery.data],
  );

  useEffect(() => {
    if (!smsCanRequest) {
      void queryClient.cancelQueries({ queryKey: smsKey, exact: false });
      queryClient.removeQueries({ queryKey: smsKey, exact: false });
    }
    return () => {
      void queryClient.cancelQueries({ queryKey: smsKey, exact: false });
      queryClient.removeQueries({ queryKey: smsKey, exact: false });
    };
  }, [queryClient, smsCanRequest, smsKey]);

  const status = useQuery({
    queryKey: [...keyBase, "status"],
    queryFn: getSendingStatus,
    enabled: canLoad,
    staleTime: STALE.reference,
  });
  const settings = useQuery({
    queryKey: [...keyBase, "send-settings"],
    queryFn: getSendSettings,
    enabled: canLoad,
    staleTime: STALE.reference,
  });
  const suppress = useQuery({
    queryKey: [...keyBase, "auto-suppress"],
    queryFn: getAutoSuppress,
    enabled: canLoad,
    staleTime: STALE.list,
  });
  const reputation = useQuery({
    queryKey: [...keyBase, "reputation"],
    queryFn: getSenderReputation,
    enabled: canLoad,
    staleTime: STALE.list,
  });
  const traps = useQuery({
    queryKey: [...keyBase, "spam-traps"],
    queryFn: getSpamTrapHits,
    enabled: canLoad,
    staleTime: STALE.list,
  });

  const smsQuietHours = useQuery({
    queryKey: [...smsKey, "quiet-hours"],
    enabled: smsCanRequest,
    queryFn: ({ signal }) => {
      const tenantId = meQuery.data?.tenant_id;
      if (!tenantId) throw new Error("SMS tenant identity is unavailable");
      return listSmsQuietHours(tenantId, { signal });
    },
    staleTime: STALE.reference,
  });
  const smsQuiet = Array.isArray(smsQuietHours.data) ? smsQuietHours.data : [];

  const st = status.data;
  const inertTiming = st ? perRecipientTimingIsInert(st) : false;
  const sup = suppress.data;
  const counterfactual = sup ? eligibleIsCounterfactual(sup) : false;
  const domains = Array.isArray(reputation.data) ? reputation.data : [];
  const trapRows = Array.isArray(traps.data?.hits) ? traps.data.hits : [];
  const failedHealthQueries = [
    status,
    settings,
    suppress,
    reputation,
    traps,
  ].filter((query) => query.isError);
  const smsHealthFailed = smsCanRequest && smsQuietHours.isError;
  const failedHealthCount =
    failedHealthQueries.length + (smsHealthFailed ? 1 : 0);
  const retryingHealth =
    failedHealthQueries.some((query) => query.isFetching) ||
    (smsHealthFailed && smsQuietHours.isFetching);

  const retryFailedHealth = () => {
    for (const query of failedHealthQueries) void query.refetch();
    if (smsHealthFailed) void smsQuietHours.refetch();
  };

  if (!canLoad) {
    return (
      <PageShell className="max-w-5xl">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Sending health
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
    <PageShell className="max-w-4xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Sending health
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          When your mail goes out, what gets held back, and how receivers see
          you.
        </p>
      </header>

      {failedHealthCount > 0 ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4"
        >
          <p className="text-sm text-destructive">
            {failedHealthCount} sending-health{" "}
            {failedHealthCount === 1 ? "check is" : "checks are"} unavailable.
            Missing results are not being treated as healthy.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={retryFailedHealth}
            disabled={retryingHealth}
          >
            {retryingHealth ? "Retrying…" : "Retry failed checks"}
          </Button>
        </div>
      ) : null}

      <section
        aria-labelledby="sh-timing"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="sh-timing" className="text-base font-medium">
          Send timing
        </h2>
        {status.isPending || settings.isPending ? (
          <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
        ) : status.isError || settings.isError || !st ? (
          <p className="mt-2 text-sm text-destructive">
            Could not load send timing.
          </p>
        ) : (
          <>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-muted-foreground">Quiet hours</dt>
                <dd className="text-sm font-medium">
                  {st.quiet_hours_per_recipient
                    ? "Per recipient"
                    : "Workspace time"}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">
                  Recipient time buckets
                </dt>
                <dd className="text-sm font-medium tabular-nums">
                  {st.bucket_count.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">
                  Default send-time strategy
                </dt>
                <dd className="text-sm font-medium">
                  {settings.data?.default_sto_strategy === "none" ||
                  !settings.data?.default_sto_strategy
                    ? "Off"
                    : settings.data.default_sto_strategy}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">
                  Newsletters forced per recipient
                </dt>
                <dd className="text-sm font-medium">
                  {settings.data?.newsletters_force_per_recipient
                    ? "Yes"
                    : "No"}
                </dd>
              </div>
            </dl>
            {inertTiming ? (
              // The setting promises something the data cannot deliver.
              <p className="mt-3 text-sm text-muted-foreground">
                Quiet hours are set to follow each recipient&rsquo;s local time,
                but no recipient time buckets exist yet — until they do, every
                send uses workspace time regardless of this setting.
              </p>
            ) : null}
            <Button
              asChild
              variant="outline"
              className="mt-4 min-h-11 sm:min-h-9"
            >
              <Link href={asRoute("/app/settings/send-time")}>
                Configure send timing
              </Link>
            </Button>
          </>
        )}
      </section>

      <section
        aria-labelledby="sh-suppress"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="sh-suppress" className="text-base font-medium">
          Automatic suppression
        </h2>
        {suppress.isPending ? (
          <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
        ) : suppress.isError || !sup ? (
          <p className="mt-2 text-sm text-destructive">
            Could not load suppression state.
          </p>
        ) : (
          <>
            <dl className="mt-3 grid gap-3 sm:grid-cols-3">
              <div>
                <dt className="text-sm text-muted-foreground">
                  Automatic suppression
                </dt>
                <dd className="text-sm font-medium">
                  {sup.auto_suppress ? "On" : "Off"}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">
                  Currently suppressed
                </dt>
                <dd className="text-sm font-medium tabular-nums">
                  {sup.active_suppressions.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">
                  {/* Never label a counterfactual as a live figure. */}
                  {counterfactual ? "Would be suppressed" : "Eligible now"}
                </dt>
                <dd className="text-sm font-medium tabular-nums">
                  {sup.eligible_now.toLocaleString()}
                </dd>
              </div>
            </dl>
            {counterfactual ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Automatic suppression is off, so{" "}
                {sup.eligible_now.toLocaleString()} is the number of addresses
                that <em>would</em> be suppressed if you turned it on — none of
                them are being held back today.
              </p>
            ) : null}
            <p className="mt-2 text-sm text-muted-foreground">
              Observed{" "}
              {formatWireTimestamp(sup.observed_at, "at an unrecorded time")}.
              This is a snapshot, not a live count.
            </p>
            <Button
              asChild
              variant="outline"
              className="mt-4 min-h-11 sm:min-h-9"
            >
              <Link href={asRoute("/app/suppressions")}>
                Manage suppressions
              </Link>
            </Button>
          </>
        )}
      </section>

      <section
        aria-labelledby="sh-reputation"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="sh-reputation" className="text-base font-medium">
          Domain reputation
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {reputation.isPending
            ? "Loading…"
            : reputation.isError
              ? "Could not load sender reputation."
              : domains.length === 0
                ? `No sending domain recorded any activity in the last ${REPUTATION_WINDOW_DAYS} days. Reputation is only computed from that window, so this is not a claim that nothing is being tracked.`
                : domains.length >= REPUTATION_ROW_CAP
                  ? `${domains.length} domain(s) active in the last ${REPUTATION_WINDOW_DAYS} days. The read stops at ${REPUTATION_ROW_CAP} domains, so more may exist.`
                  : `${domains.length} domain(s) active in the last ${REPUTATION_WINDOW_DAYS} days.`}
        </p>
        <Button asChild variant="outline" className="mt-4 min-h-11 sm:min-h-9">
          <Link href={asRoute("/app/inbox-reality")}>Open Inbox Reality</Link>
        </Button>
      </section>

      <section
        aria-labelledby="sh-traps"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="sh-traps" className="text-base font-medium">
          Spam trap hits
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {traps.isPending
            ? "Loading…"
            : traps.isError
              ? "Could not load spam trap hits."
              : trapRows.length === 0
                ? `No spam trap hits in the last ${TRAP_WINDOW_DAYS} days. Earlier hits are outside what this read answers for.`
                : trapRows.length >= TRAP_ROW_CAP
                  ? `${trapRows.length} hit(s) in the last ${TRAP_WINDOW_DAYS} days. The read stops at ${TRAP_ROW_CAP} addresses, so more may exist.`
                  : `${trapRows.length} hit(s) in the last ${TRAP_WINDOW_DAYS} days.`}
        </p>
      </section>

      <section
        aria-labelledby="sh-sms"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="sh-sms" className="text-base font-medium">
          SMS timing and dispatch
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {!smsCanRequest
            ? "Owner or admin access is required. No SMS timing data was requested."
            : smsQuietHours.isPending
              ? "Loading…"
              : smsQuietHours.isError
                ? "Could not load SMS quiet hours."
                : smsQuiet.length === 0
                  ? "No stored SMS quiet-hours rule is configured. This is not a recipient-local jurisdiction or live-delivery claim."
                  : `${smsQuiet.length} stored SMS quiet-hours rule(s). Country labels are not recipient-local jurisdiction proof, and no live hold or delivery outcome is inferred.`}
        </p>
        <p className="mt-2 text-sm font-medium">
          SMS broadcast dispatch is release-held (
          <code>sms_broadcast_dispatch_release_held</code>). No broadcast
          history was requested by this page.
        </p>
      </section>
    </PageShell>
  );
}
