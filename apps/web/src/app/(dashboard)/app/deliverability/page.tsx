// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Deliverability hub — the score, and whether the score means anything.
 *
 * WHY THIS PAGE EXISTS. Web reached ONE `/api/v1/deliverability/*` path
 * (suppressions) while desktop reached twelve. On a product whose job is
 * landing in the inbox, the primary surface had no view of its own sending
 * reputation.
 *
 * THE GRADE IS WITHHELD WHEN THE SAMPLE CANNOT SUPPORT IT. The server sends
 * `score: 100, grade: "A"` for a workspace that has never sent anything, and
 * says so in the same payload via `sample_qualified: false` plus a written
 * `sample_reason`. Mobile shipped that A as fact and had to be corrected;
 * desktop reads the flag but never shows the reason. Here the number is
 * replaced by an em-dash and the server's own sentence, because a fabricated
 * A on a reputation screen is the most damaging thing this page could render —
 * it tells an operator their sending is healthy when nothing has been measured.
 */

import dynamic from "next/dynamic";
import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { BreachFixCta } from "@/components/deliverability/BreachFixCta";
import {
  DELIVERABILITY_HUB_SURFACES,
  DeliverabilityHubRefresh,
  type DeliverabilityHubRefreshReceipt,
} from "@/components/deliverability/DeliverabilityHubRefresh";
import { HygienePlaybooks } from "@/components/deliverability/HygienePlaybooks";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  getBlocklistHits,
  getBounceClassBreakdown,
  getDeliverabilityHub,
  getDnsHealth,
  getWebhookErrors,
  clearRepairOverride,
  type DeliverabilityBreach,
  type DeliverabilityHubSummary,
} from "@/lib/deliverability-hub-api";
import { base, STALE } from "@/lib/query-keys";

const BlocklistContainmentPanel = dynamic(
  () =>
    import("./blocklist-containment-panel").then(
      (mod) => mod.BlocklistContainmentPanel,
    ),
  {
    ssr: false,
    loading: () => <DeferredDeliverabilityPanel label="blocklist controls" />,
  },
);
const ProviderConfigPanel = dynamic(
  () =>
    import("./provider-config-panel").then((mod) => mod.ProviderConfigPanel),
  {
    ssr: false,
    loading: () => <DeferredDeliverabilityPanel label="provider settings" />,
  },
);
const ReplyMailboxManager = dynamic(
  () =>
    import("./reply-mailbox-manager").then((mod) => mod.ReplyMailboxManager),
  {
    ssr: false,
    loading: () => <DeferredDeliverabilityPanel label="reply mailbox" />,
  },
);
const DeliverabilityOperationsPanel = dynamic(
  () =>
    import("./operations-panel").then(
      (mod) => mod.DeliverabilityOperationsPanel,
    ),
  {
    ssr: false,
    loading: () => <DeferredDeliverabilityPanel label="operations evidence" />,
  },
);

function DeferredDeliverabilityPanel({ label }: { label: string }) {
  return (
    <section
      className="min-h-28 animate-pulse rounded-lg border bg-muted/30 p-4 motion-reduce:animate-none"
      role="status"
      aria-live="polite"
      aria-label={`Loading ${label}`}
    >
      <span className="sr-only">Loading {label}…</span>
    </section>
  );
}

/**
 * Terminate the server's sentence before ours begins.
 *
 * `sample_reason` arrives without trailing punctuation ("fewer than 1,000
 * successful campaign sends in the 30-day model window"), so concatenating it
 * with the next sentence produced "...model window Needs at least..." on
 * screen. Rendered verbatim otherwise — the wording is the server's to own.
 */
function endSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function pct(value: number): string {
  return `${(Number.isFinite(value) ? value : 0).toFixed(2)}%`;
}

/**
 * The hub serialises a breach as `title` plus an optional `detail`
 * (deliverability_hub.ThresholdBreach). It has never sent the `message` field
 * the shared client type still declares, so reading that alone showed every
 * operator a raw machine code — "campaign_sample_insufficient" — where the
 * server had written a sentence. Same rule as `endSentence`: the wording is
 * the server's to own, so both strings are rendered verbatim.
 */
function breachText(breach: DeliverabilityBreach): {
  headline: string;
  detail: string;
} {
  const wire = breach as DeliverabilityBreach & {
    title?: unknown;
    detail?: unknown;
  };
  const title = typeof wire.title === "string" ? wire.title.trim() : "";
  const detail = typeof wire.detail === "string" ? wire.detail.trim() : "";
  const headline = title || breach.message?.trim() || detail;
  return {
    headline: headline || breach.code,
    // Don't repeat the sentence under itself when detail was the headline.
    detail: headline === detail ? "" : detail,
  };
}

const SUMMARY_SURFACE_LABEL =
  DELIVERABILITY_HUB_SURFACES.find((surface) => surface.key === "summary")
    ?.label ?? "Reputation score";

export default function DeliverabilityPage() {
  const queryClient = useQueryClient();
  // The throttle-reset dialog's focus fallback: the evidence refresh button,
  // which the refresh component owns, so it is found inside its wrapper.
  const healthRefreshRef = useRef<HTMLElement | null>(null);
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const keyBase = useMemo(
    () =>
      base(
        "deliverability-hub",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  const hub = useQuery({
    queryKey: [...keyBase, "summary"],
    queryFn: getDeliverabilityHub,
    enabled: meQuery.isSuccess,
    staleTime: STALE.dashboard,
  });
  const dns = useQuery({
    queryKey: [...keyBase, "dns"],
    queryFn: getDnsHealth,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });
  const blocklist = useQuery({
    queryKey: [...keyBase, "blocklist"],
    queryFn: getBlocklistHits,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });
  const webhooks = useQuery({
    queryKey: [...keyBase, "webhook-errors"],
    queryFn: getWebhookErrors,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });
  const bounces = useQuery({
    queryKey: [...keyBase, "bounce-classes"],
    queryFn: getBounceClassBreakdown,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });

  const summary = hub.data;
  const qualified = summary?.sample_qualified === true;
  const failedChecks = [hub, dns, blocklist, webhooks, bounces].filter(
    (query) => query.isError,
  );
  const retryingFailedCheck = failedChecks.some((query) => query.isFetching);
  const identityVerified = meQuery.isSuccess;
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const canClearOverride = Boolean(
    meQuery.data &&
    !meQuery.data.viewer_mode &&
    (role === "admin" || role === "owner"),
  );
  const [repairMessage, setRepairMessage] = useState<{
    tone: "status" | "warning";
    text: string;
  } | null>(null);
  // Any possibly committed outcome is never permission to send the POST again.
  // Keep the control latched until a canonical health read succeeds; even an
  // exact committed receipt can leave this screen rendering a stale active
  // override when the follow-up GET fails.
  const [repairRetryHeld, setRepairRetryHeld] = useState(false);

  const retryFailedChecks = () => {
    if (!identityVerified) return;
    for (const query of failedChecks) void query.refetch();
  };

  // A held repair review is released only by a refresh whose reputation-score
  // read verified; the refresh writes through the page's own query keys, so
  // the fresh summary is read back from the cache it just filled.
  const onEvidenceRefreshed = (receipt: DeliverabilityHubRefreshReceipt) => {
    if (!repairRetryHeld || receipt.failed.includes(SUMMARY_SURFACE_LABEL)) {
      return;
    }
    const freshHub = queryClient.getQueryData<DeliverabilityHubSummary>([
      ...keyBase,
      "summary",
    ]);
    setRepairRetryHeld(false);
    setRepairMessage({
      tone: "status",
      text: freshHub?.auto_throttled
        ? "Fresh health still shows an active repair override. Review the current cap before deciding whether to try again."
        : "Fresh health no longer shows an active repair override. No second restoration was sent.",
    });
  };

  return (
    <PageShell className="max-w-5xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Deliverability
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your sending reputation, the DNS behind it, and what is currently
            going wrong.
          </p>
        </div>
        <div
          ref={(node) => {
            healthRefreshRef.current = node?.querySelector("button") ?? null;
          }}
        >
          <DeliverabilityHubRefresh
            keyBase={keyBase}
            enabled={identityVerified}
            onRefreshed={onEvidenceRefreshed}
          />
        </div>
      </header>

      {failedChecks.length > 0 ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4"
        >
          <p className="text-sm text-destructive">
            {failedChecks.length} deliverability{" "}
            {failedChecks.length === 1 ? "check is" : "checks are"} unavailable.
            Missing results are not being treated as healthy.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={retryFailedChecks}
            disabled={!identityVerified || retryingFailedCheck}
          >
            {retryingFailedCheck ? "Retrying…" : "Retry failed checks"}
          </Button>
        </div>
      ) : null}

      {repairMessage ? (
        <p
          role={repairMessage.tone === "warning" ? "alert" : "status"}
          aria-live="polite"
          className={
            repairMessage.tone === "warning"
              ? "rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-emphasis"
              : "text-sm text-muted-foreground"
          }
        >
          {repairMessage.text}
        </p>
      ) : null}

      <section
        aria-labelledby="dh-score"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="dh-score" className="text-base font-medium">
          Reputation score
        </h2>
        {hub.isPending && !summary ? (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            Loading reputation score…
          </p>
        ) : summary ? (
          <div className="mt-2">
            {hub.isError ? (
              <p
                role="alert"
                className="mb-3 rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-emphasis"
              >
                Showing the last known score because the fresh health read
                failed. Treat this state as stale, not healthy.
              </p>
            ) : null}
            <p className="text-3xl font-semibold tabular-nums">
              {qualified ? summary.score : "—"}
              {qualified ? (
                <span className="ml-2 text-base font-normal text-muted-foreground">
                  grade {summary.grade}
                </span>
              ) : null}
            </p>
            {qualified ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {summary.status} · {summary.trend} over {summary.window_days}{" "}
                days
              </p>
            ) : (
              // The server's own sentence, verbatim. It knows why the sample
              // does not qualify; inventing our own wording here would drift.
              <p className="mt-1 text-sm text-muted-foreground">
                Not scored yet — {endSentence(summary.sample_reason)} Needs at
                least {summary.minimum_sample_sends.toLocaleString()} sends in
                the window.
              </p>
            )}
            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Bounce rate", summary.bounce_rate],
                ["Complaint rate", summary.complaint_rate],
                ["Engagement", summary.engagement_rate],
                ["Machine opens", summary.opens_machine_pct],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-md bg-muted/40 p-3">
                  <dt className="text-xs uppercase text-muted-foreground">
                    {label}
                  </dt>
                  <dd className="text-sm tabular-nums">
                    {qualified ? pct(Number(value)) : "—"}
                  </dd>
                </div>
              ))}
            </dl>
            {summary.auto_throttled ? (
              <p
                role="alert"
                className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
              >
                Sending is being auto-throttled.
              </p>
            ) : null}
            {canClearOverride ? (
              <div className="mt-3" aria-live="polite">
                <ConfirmDialog
                  title="Clear automatic throttle override?"
                  description="Only continue after the underlying deliverability issue is fixed. The server will refuse if the sending cap changed since throttling began."
                  confirmLabel="Clear throttle override"
                  confirmVariant="destructive"
                  fallbackFocusRef={healthRefreshRef}
                  trigger={
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!summary.auto_throttled || repairRetryHeld}
                    >
                      {repairRetryHeld
                        ? "Refresh evidence before another review"
                        : summary.auto_throttled
                          ? "Review throttle reset"
                          : "No throttle override active"}
                    </Button>
                  }
                  onConfirm={async () => {
                    if (!meQuery.data) return;
                    if (repairRetryHeld) {
                      throw new Error(
                        "The prior restoration is held for verification. Use Refresh evidence before reviewing another attempt.",
                      );
                    }
                    setRepairMessage(null);
                    try {
                      await verifyFreshAdminAuthority(meQuery.data);
                      const outcome = await clearRepairOverride();
                      if (outcome.kind !== "nothing-to-clear") {
                        setRepairRetryHeld(true);
                      }
                      const refreshed = await hub.refetch();
                      if (outcome.kind === "committed") {
                        if (refreshed.isError) {
                          setRepairMessage({
                            tone: "warning",
                            text: "The clear committed, but fresh health could not confirm the current repair state. No retry was sent; use Refresh evidence before another review.",
                          });
                          return;
                        }
                        if (refreshed.data?.auto_throttled) {
                          setRepairMessage({
                            tone: "warning",
                            text: "The clear committed, but fresh health still shows automatic throttling. This may be a new repair or delayed projection; review a later refresh before any new attempt.",
                          });
                          return;
                        }
                        setRepairRetryHeld(false);
                        setRepairMessage({
                          tone: "status",
                          text: "Throttle override cleared and confirmed by a fresh health read.",
                        });
                        return;
                      }
                      if (outcome.kind === "nothing-to-clear") {
                        if (refreshed.isError) setRepairRetryHeld(true);
                        setRepairMessage({
                          tone: "status",
                          text: refreshed.isError
                            ? "No active throttle remained, but fresh health could not be loaded. No write was repeated."
                            : "No active throttle override remained; fresh health was reconciled.",
                        });
                        return;
                      }

                      setRepairRetryHeld(true);
                      if (outcome.kind === "committed-conservatively-fenced") {
                        setRepairMessage({
                          tone: "warning",
                          text: "The override was cleared, but sending remains conservatively fenced while shared cap authority converges. No retry was sent; use Refresh evidence to verify current state.",
                        });
                        return;
                      }

                      setRepairMessage({
                        tone: "warning",
                        text: refreshed.isError
                          ? "The database commit outcome could not be proven, sending remains conservatively fenced, and the reconciliation read also failed. No retry was sent; use Refresh evidence before any new review."
                          : refreshed.data?.auto_throttled
                            ? "The database commit outcome could not be proven and fresh health still shows the repair override. Sending remains conservatively fenced. No retry was sent; use Refresh evidence before any new review."
                            : "The database commit outcome could not be proven. Fresh health no longer shows the override, but sending remains conservatively fenced until shared cap authority converges. No retry was sent.",
                      });
                    } catch (error) {
                      throw new Error(
                        apiErrorMessage(
                          error,
                          "Could not safely clear the throttle override.",
                        ),
                      );
                    }
                  }}
                />
              </div>
            ) : summary.auto_throttled ? (
              <p className="mt-2 text-sm text-muted-foreground">
                An owner or admin outside viewer mode must review and clear this
                override.
              </p>
            ) : null}
            {summary.breaches.length > 0 ? (
              <ul className="mt-3 space-y-1.5">
                {summary.breaches.map((b) => {
                  const { headline, detail } = breachText(b);
                  return (
                    <li key={b.code} className="text-sm text-muted-foreground">
                      {headline} <span className="text-xs">({b.severity})</span>
                      {detail ? (
                        <span className="mt-0.5 block text-xs">{detail}</span>
                      ) : null}
                      <BreachFixCta breach={b} />
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        ) : hub.isError ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            Could not load the score. It has not been shown as healthy — an
            unknown reputation is not a good one.
          </p>
        ) : null}
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <section aria-labelledby="dh-dns" className="rounded-lg border p-4">
          <h2 id="dh-dns" className="text-base font-medium">
            DNS health
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {dns.isPending
              ? "Loading DNS checks…"
              : dns.isError
                ? "Could not load DNS health."
                : dns.data && dns.data.length > 0
                  ? `${dns.data.length} sending identity/identities checked.`
                  : "No sending identities configured yet."}
          </p>
        </section>

        <section
          aria-labelledby="dh-blocklist"
          className="rounded-lg border p-4"
        >
          <h2 id="dh-blocklist" className="text-base font-medium">
            Blocklist hits
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {blocklist.isPending
              ? "Loading blocklist checks…"
              : blocklist.isError
                ? "Could not load blocklist hits."
                : blocklist.data && blocklist.data.length > 0
                  ? `${blocklist.data.length} listing(s) in the window.`
                  : "No blocklist hits in the window."}
          </p>
        </section>

        <section
          aria-labelledby="dh-webhooks"
          className="rounded-lg border p-4"
        >
          <h2 id="dh-webhooks" className="text-base font-medium">
            Webhook errors
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {webhooks.isPending
              ? "Loading webhook health…"
              : webhooks.isError
                ? "Could not load webhook errors."
                : webhooks.data && webhooks.data.length > 0
                  ? `${webhooks.data.length} failing endpoint(s).`
                  : "No webhook errors in the window."}
          </p>
        </section>

        <section aria-labelledby="dh-bounces" className="rounded-lg border p-4">
          <h2 id="dh-bounces" className="text-base font-medium">
            Bounce classes
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {bounces.isPending
              ? "Loading bounce classes…"
              : bounces.isError
                ? "Could not load the bounce breakdown."
                : (() => {
                    const days = Array.isArray(bounces.data)
                      ? bounces.data
                      : [];
                    const withBounces = days.filter(
                      (d) => Object.keys(d.counts ?? {}).length > 0,
                    );
                    return withBounces.length > 0
                      ? `${withBounces.length} of ${days.length} days had bounces.`
                      : `No bounces across ${days.length} days.`;
                  })()}
          </p>
        </section>
      </div>

      <HygienePlaybooks />

      {meQuery.isSuccess ? (
        <>
          <BlocklistContainmentPanel identity={meQuery.data} />
          <ProviderConfigPanel identity={meQuery.data} />
          <ReplyMailboxManager identity={meQuery.data} />
          <DeliverabilityOperationsPanel
            key={`${meQuery.data.tenant_id}:${effectiveAuthRole(meQuery.data)}:${meQuery.data.viewer_mode ? "viewer" : "member"}`}
            identity={meQuery.data}
          />
        </>
      ) : meQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Workspace identity could not be verified, so operational and
          subscriber data was not requested.
        </p>
      ) : null}
    </PageShell>
  );
}
