// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { ApiError } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import {
  getClickTracking,
  getEntitlement,
  getFeedbackHistory,
  getRoutingPolicy,
  getSoftBounceStats,
  listDomainSetups,
  listRetryEvents,
  runSoftBounceCleanup,
} from "@/lib/deliverability-operations-api";
import { retryQuery } from "@/lib/query-client";
import { STALE } from "@/lib/query-keys";
import { isServiceNotDeployed } from "@/lib/service-availability";

/**
 * What a sending-control read answers when the workspace has never saved that
 * policy: 404 with a code naming it. The control service is up (sending
 * domains answer from it), so this is a setup state, not a failed read —
 * shown as neutral text with no Retry, and never retried, because asking
 * again cannot change it.
 */
const NOT_CONFIGURED: Readonly<Record<string, string>> = {
  click_tracking_not_configured:
    "Not set up. No custom tracking domain is configured for this workspace.",
  ip_routing_not_configured:
    "Not set up. Sending uses the default IP pool assignment.",
  inbox_test_allowance_not_configured:
    "Not set up. No inbox-test allowance is recorded for this billing period.",
};
const NOT_DEPLOYED = "Not available in this environment.";

/** Neutral copy for a read that describes setup or environment, else null. */
function settledState(error: unknown): string | null {
  if (isServiceNotDeployed(error)) return NOT_DEPLOYED;
  if (
    error instanceof ApiError &&
    error.status === 404 &&
    Object.hasOwn(NOT_CONFIGURED, error.code)
  ) {
    return NOT_CONFIGURED[error.code] ?? null;
  }
  return null;
}

const retryUnlessSettled = (failureCount: number, error: unknown) =>
  settledState(error) === null && retryQuery(failureCount, error);

const maskEmail = (email: string) => {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${email.slice(0, 1)}•••${email.slice(Math.max(1, at - 1))}`;
};
const message = (error: unknown) =>
  error instanceof Error && error.message.startsWith("Invalid ")
    ? "The server returned an invalid response."
    : "Evidence could not be verified.";

export function DeliverabilityOperationsPanel({
  identity,
}: {
  identity: MeResponse;
}) {
  const role = effectiveAuthRole(identity);
  const admin = !identity.viewer_mode && (role === "admin" || role === "owner");
  const identityKey = `${identity.tenant_id}:${identity.user_id}:${role}:${identity.viewer_mode ? "viewer" : "member"}`;
  const key = ["deliverability-operations", identityKey] as const;
  const domains = useQuery({
    queryKey: [...key, "domains"],
    queryFn: listDomainSetups,
    staleTime: STALE.reference,
  });
  const clicks = useQuery({
    queryKey: [...key, "clicks"],
    queryFn: getClickTracking,
    staleTime: STALE.reference,
    retry: retryUnlessSettled,
  });
  const routing = useQuery({
    queryKey: [...key, "routing"],
    queryFn: getRoutingPolicy,
    staleTime: STALE.reference,
    retry: retryUnlessSettled,
  });
  const entitlement = useQuery({
    queryKey: [...key, "entitlement"],
    queryFn: getEntitlement,
    staleTime: STALE.reference,
    retry: retryUnlessSettled,
  });
  const retry = useQuery({
    queryKey: [...key, "retry"],
    queryFn: () => listRetryEvents(identity.tenant_id),
    // Rows contain subscriber addresses and live queue state. The route is
    // exact-admin, so a viewer must not even dispatch the private read.
    enabled: admin,
    staleTime: STALE.dashboard,
  });
  const recovery = useQuery({
    queryKey: [...key, "recovery"],
    queryFn: getSoftBounceStats,
    staleTime: STALE.dashboard,
  });
  const qc = useQueryClient();
  const cleanup = useMutation({
    mutationFn: async () => {
      await verifyFreshAdminAuthority(identity);
      return runSoftBounceCleanup();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [...key, "recovery"] }),
  });
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [lookup, setLookup] = useState<string | null>(null);
  const feedback = useQuery({
    queryKey: [...key, "feedback", lookup],
    queryFn: async ({ signal }) => {
      await verifyFreshAdminAuthority(identity, signal);
      return getFeedbackHistory(lookup!, { signal });
    },
    enabled: admin && lookup !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = email.trim();
    if (!admin || !next) return;
    if (next === lookup) {
      void feedback.refetch();
      return;
    }
    setLookup(next);
  };
  const controls = [
    [
      "Sending domains",
      domains,
      domains.data
        ? domains.data.length
          ? `${domains.data.length} configured · ${domains.data.map((x) => `${x.domain}: ${x.status}`).join(", ")}`
          : "No sending domains configured."
        : "",
    ],
    [
      "Click tracking",
      clicks,
      clicks.data
        ? `${clicks.data.tracking_domain} · ${clicks.data.status} · SSL ${clicks.data.ssl_status}`
        : "",
    ],
    [
      "IP routing",
      routing,
      routing.data
        ? `${routing.data.strategy} · ${(routing.data.dedicated_percentage_bp / 100).toFixed(0)}% dedicated · ${routing.data.status}`
        : "",
    ],
    [
      "Inbox-test entitlement",
      entitlement,
      entitlement.data
        ? `${entitlement.data.plan_tier} · ${entitlement.data.inbox_tests_remaining} of ${entitlement.data.inbox_tests_monthly} inbox tests remaining`
        : "",
    ],
  ] as const;
  return (
    <div className="space-y-4">
      <section
        className="rounded-lg border p-4"
        aria-labelledby="delivery-control-title"
      >
        <h2 id="delivery-control-title" className="font-medium">
          Sending controls
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Authoritative configuration snapshots. Changes remain in their
          dedicated settings workflows.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {controls.map(([label, q, value]) => (
            <div key={label} className="rounded-md bg-muted/40 p-3">
              <h3 className="text-sm font-medium">{label}</h3>
              {q.isPending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading…
                </p>
              ) : q.isError && settledState(q.error) !== null ? (
                <p className="text-sm text-muted-foreground">
                  {settledState(q.error)}
                </p>
              ) : q.isError ? (
                <>
                  <p role="alert" className="text-sm text-destructive">
                    {message(q.error)}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void q.refetch()}
                  >
                    Retry
                  </Button>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{value}</p>
              )}
            </div>
          ))}
        </div>
      </section>
      <section className="rounded-lg border p-4" aria-labelledby="retry-title">
        <div className="flex flex-wrap justify-between gap-2">
          <div>
            <h2 id="retry-title" className="font-medium">
              Deferred recipients
            </h2>
            {admin ? (
              <p className="text-sm text-muted-foreground">
                Up to 50 recent queue records. These are operational evidence,
                not delivery promises.
              </p>
            ) : null}
          </div>
          {admin ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void retry.refetch()}
              disabled={retry.isFetching}
            >
              Refresh queue
            </Button>
          ) : null}
        </div>
        {!admin ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Workspace owner or admin access is required to read
            deferred-recipient evidence. It can include subscriber addresses and
            exact queue state.
          </p>
        ) : (
          <>
            <p className="mt-2 rounded-md bg-muted/40 p-3 text-sm">
              Mark ready only advances eligibility. The worker still
              re-evaluates frequency caps and subscriber pause/preferences; it
              does not force delivery.
            </p>
            {retry.isPending ? (
              <p role="status" className="mt-3 text-sm">
                Loading retry evidence…
              </p>
            ) : retry.isError ? (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {message(retry.error)}
              </p>
            ) : retry.data.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No deferred recipient event is recorded.
              </p>
            ) : (
              <ul className="mt-3 divide-y">
                {retry.data.map((row) => (
                  <li
                    key={row.id}
                    className="grid gap-1 py-2 text-sm sm:grid-cols-4"
                  >
                    <span>{maskEmail(row.subscriber_email)}</span>
                    <span>{row.reason.replaceAll("_", " ")}</span>
                    <span>{row.status}</span>
                    <span>{row.attempts} attempt(s)</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
      <section
        className="rounded-lg border p-4"
        aria-labelledby="recovery-title"
      >
        <h2 id="recovery-title" className="font-medium">
          Soft-bounce expiry
        </h2>
        <p className="text-sm text-muted-foreground">
          Removes only expired recovery-owned transient suppressions. It never
          changes subscriber lifecycle status.
        </p>
        {recovery.isPending ? (
          <p role="status">Loading cleanup evidence…</p>
        ) : recovery.isError ? (
          <p role="alert" className="text-destructive">
            Cleanup evidence could not be verified.
          </p>
        ) : (
          <p className="mt-2 text-sm">
            {recovery.data.eligible_suppressions_now} eligible ·{" "}
            {recovery.data.recovery_window_days}-day evidence window · automatic
            subscriber reactivation{" "}
            {recovery.data.automatic_reactivation_active ? "on" : "off"}
          </p>
        )}
        {admin ? (
          <ConfirmDialog
            title="Expire eligible transient suppressions?"
            description="Only already-expired soft-bounce-threshold suppressions are considered. Subscriber status is never changed."
            confirmationToken="EXPIRE TRANSIENT SUPPRESSIONS"
            confirmLabel="Run suppression cleanup"
            onConfirm={async () => {
              await cleanup.mutateAsync();
            }}
            trigger={
              <Button
                className="mt-3"
                variant="outline"
                disabled={!recovery.data || cleanup.isPending}
              >
                Review cleanup
              </Button>
            }
          />
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            Admin access is required to run cleanup; read-only evidence remains
            available.
          </p>
        )}
        {cleanup.isError ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            The cleanup was not confirmed.
          </p>
        ) : cleanup.data ? (
          <p role="status" className="mt-2 text-sm">
            Server confirmed {cleanup.data.expired_suppressions} expired
            suppression(s) removed. Subscriber lifecycle statuses were not
            changed.
          </p>
        ) : null}
      </section>
      <section
        className="rounded-lg border p-4"
        aria-labelledby="feedback-title"
      >
        <h2 id="feedback-title" className="font-medium">
          Recipient feedback evidence
        </h2>
        {!admin ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Admin access is required because this lookup handles subscriber PII.
          </p>
        ) : (
          <>
            <form
              className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
              onSubmit={submit}
            >
              <div className="flex-1">
                <Label htmlFor={emailId}>Subscriber email</Label>
                <Input
                  id={emailId}
                  type="email"
                  maxLength={254}
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <Button
                type="submit"
                disabled={!email.trim() || feedback.isFetching}
              >
                {feedback.isFetching ? "Looking up…" : "Look up evidence"}
              </Button>
            </form>
            <p className="mt-1 text-xs text-muted-foreground">
              The address is sent in a request body, never the URL. This screen
              does not cache the response.
            </p>
            {feedback.isError ? (
              <p role="alert" className="mt-3 text-sm text-destructive">
                Feedback could not be verified. No conclusion was drawn
                {lookup ? ` for ${maskEmail(lookup)}` : ""}.
              </p>
            ) : feedback.data ? (
              feedback.data.bounces.length + feedback.data.complaints.length ===
              0 ? (
                <p role="status" className="mt-3 text-sm">
                  No recorded feedback returned for {maskEmail(lookup!)}. This
                  is not proof of inbox placement, consent, or good standing.
                </p>
              ) : (
                <div className="mt-3 text-sm">
                  <p>
                    {feedback.data.bounces.length} bounce(s) ·{" "}
                    {feedback.data.complaints.length} complaint(s) for{" "}
                    {maskEmail(lookup!)}
                  </p>
                  <ul className="mt-2 divide-y">
                    {[
                      ...feedback.data.bounces,
                      ...feedback.data.complaints,
                    ].map((x, i) => (
                      <li
                        className="py-2"
                        key={`${x.id ?? i}-${x.received_at}`}
                      >
                        {x.kind} · {x.esp ?? "provider withheld"} ·{" "}
                        {new Date(x.received_at).toLocaleString()}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
