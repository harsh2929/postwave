// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  FileCheck2,
  FileWarning,
  History,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";

import {
  OperationsFailure,
  OperationsHeader,
  OperationsLoading,
  OperationsSection,
  OperationsShell,
} from "@/components/operations/operations-surface";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { newUUIDv7 } from "@/lib/http-fetch";
import {
  authorizePrivacyIncidentAdmin,
  getPrivacyIncident,
  isAmbiguousPrivacyIncidentMutation,
  listPrivacyIncidentEvents,
  PrivacyIncidentContractError,
  transitionPrivacyIncident,
  type PrivacyIncident,
  type PrivacyIncidentEvent,
  type PrivacyIncidentState,
  type PrivacyIncidentTransitionReceipt,
} from "@/lib/privacy-incidents-api";
import { base, qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";
import {
  formatIncidentTime,
  incidentDetail,
  incidentHeadline,
  SEVERITY_LABEL,
  severityVariant,
  STATE_LABEL,
  stateVariant,
} from "../incident-presenters";

const AVAILABLE_TRANSITIONS: Record<
  PrivacyIncidentState,
  PrivacyIncidentState[]
> = {
  open: ["contained", "notifications_pending"],
  contained: ["notifications_pending"],
  notifications_pending: ["contained"],
  closed: [],
};

function detailBoundary(
  mode: "loading" | "auth-error" | "forbidden",
  retry?: () => void,
  retrying = false,
) {
  return (
    <OperationsShell className="max-w-6xl">
      <Button asChild variant="ghost" className="w-fit">
        <Link href={asRoute("/app/privacy-incidents")}>
          <ArrowLeft aria-hidden /> Back to incident register
        </Link>
      </Button>
      <OperationsHeader
        icon={FileWarning}
        eyebrow="Governance"
        title="Privacy incident"
        description="Verified incident facts and operational activity."
      />
      {mode === "loading" ? (
        <OperationsLoading label="Checking incident access" rows={6} />
      ) : mode === "auth-error" ? (
        <OperationsFailure
          title="Incident access could not be verified"
          description="The current tenant and effective role are unknown. No incident data is shown."
          onRetry={retry}
          retrying={retrying}
        />
      ) : (
        <Alert variant="destructive">
          <AlertTitle>Admin access required</AlertTitle>
          <AlertDescription>
            Only the current workspace owner and admins may read or change the
            privacy incident register. Effective viewer/editor mode remains
            denied.
          </AlertDescription>
        </Alert>
      )}
    </OperationsShell>
  );
}

export function PrivacyIncidentDetailClient({
  incidentId,
}: {
  incidentId: string;
}) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<PrivacyIncidentState | null>(null);
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const canAccess =
    meQuery.data?.viewer_mode !== true &&
    (role === "owner" || role === "admin");
  const tenantId = meQuery.data?.tenant_id ?? "anonymous";
  const registerKey = useMemo(
    () => [...base("privacy-incidents", tenantId, role), "register"] as const,
    [role, tenantId],
  );
  const detailKey = useMemo(
    () =>
      [
        ...base("privacy-incidents", tenantId, role),
        "detail",
        incidentId,
      ] as const,
    [incidentId, role, tenantId],
  );
  const eventsKey = useMemo(
    () => [...detailKey, "events"] as const,
    [detailKey],
  );
  const detailQuery = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) =>
      getPrivacyIncident({ tenantId, incidentId, signal }),
    enabled: meQuery.isSuccess && canAccess,
    staleTime: STALE.detail,
    gcTime: 0,
    refetchOnWindowFocus: "always",
    retry: (count, error) =>
      !(error instanceof ApiError && [401, 403, 404].includes(error.status)) &&
      count < 2,
  });
  const eventsQuery = useQuery({
    queryKey: eventsKey,
    queryFn: ({ signal }) =>
      listPrivacyIncidentEvents({ tenantId, incidentId, signal }),
    enabled: meQuery.isSuccess && canAccess,
    staleTime: STALE.detail,
    gcTime: 0,
    refetchOnWindowFocus: "always",
    retry: (count, error) =>
      !(error instanceof ApiError && [401, 403, 404].includes(error.status)) &&
      count < 2,
  });

  if (meQuery.isPending) return detailBoundary("loading");
  if (meQuery.isError) {
    return detailBoundary(
      "auth-error",
      () => void meQuery.refetch(),
      meQuery.isFetching,
    );
  }
  if (!canAccess || !meQuery.data) return detailBoundary("forbidden");

  const incident = detailQuery.data;
  const status =
    detailQuery.error instanceof ApiError ? detailQuery.error.status : null;
  const refresh = async () => {
    await Promise.all([detailQuery.refetch(), eventsQuery.refetch()]);
  };
  const mutationInventoryReady = Boolean(
    incident &&
    detailQuery.isSuccess &&
    !detailQuery.isFetching &&
    detailQuery.dataUpdatedAt > 0,
  );
  // `refetchOnWindowFocus: "always"` re-reads the record every time the tab
  // regains focus, which drops mutationInventoryReady for the duration of that
  // read and greys out the only workflow action on the page. Without a stated
  // reason the operator reads that window as broken or permission-denied.
  const transitionLockReason = mutationInventoryReady
    ? undefined
    : detailQuery.isFetching
      ? "Re-reading the current incident. Transitions unlock when this read finishes."
      : "Transitions need a verified current record. Refresh the record first.";

  return (
    <OperationsShell className="max-w-6xl">
      <Button asChild variant="ghost" className="w-fit">
        <Link href={asRoute("/app/privacy-incidents")}>
          <ArrowLeft aria-hidden /> Back to incident register
        </Link>
      </Button>
      <OperationsHeader
        icon={FileWarning}
        eyebrow="Privacy incident"
        title={
          incident ? incidentHeadline(incident.summary) : "Incident record"
        }
        description={
          incident ? (
            <span className="break-all font-mono text-xs">{incident.id}</span>
          ) : (
            "Verified incident facts and operational activity."
          )
        }
        actions={
          <Button
            type="button"
            variant="outline"
            loading={detailQuery.isFetching || eventsQuery.isFetching}
            onClick={() => void refresh()}
          >
            {!detailQuery.isFetching && !eventsQuery.isFetching ? (
              <RefreshCw aria-hidden />
            ) : null}
            Refresh record
          </Button>
        }
      />

      {detailQuery.isPending && !incident ? (
        <OperationsLoading label="Loading privacy incident" rows={8} />
      ) : !incident ? (
        status === 404 ? (
          <Alert>
            <AlertTitle>Incident not found</AlertTitle>
            <AlertDescription className="break-all">
              No incident is available for {incidentId}. The tenant-scoped
              server returned a true 404; this may be a removed or incomplete
              link.
            </AlertDescription>
          </Alert>
        ) : (
          <OperationsFailure
            title={
              status === 403
                ? "Incident access was denied"
                : "Incident details could not be verified"
            }
            description="This failure is not evidence that the incident is absent. No state transition is available until a complete current record is verified."
            onRetry={() => void detailQuery.refetch()}
            retrying={detailQuery.isFetching}
          />
        )
      ) : (
        <>
          {detailQuery.isError ? (
            <OperationsFailure
              title="The latest incident refresh failed"
              description="The previously verified record remains visible below, but state transitions are locked until a current detail read succeeds."
              onRetry={() => void detailQuery.refetch()}
              retrying={detailQuery.isFetching}
            />
          ) : null}
          <Alert variant="warning">
            <ShieldAlert aria-hidden />
            <AlertTitle>
              Legal and delivery evidence remains release-held
            </AlertTitle>
            <AlertDescription>
              State changes record operator workflow context only. They do not
              prove containment, determine jurisdiction, authorize notification,
              prove delivery, or permit closure.
            </AlertDescription>
          </Alert>

          <OperationsSection
            id="privacy-incident-overview"
            title="Overview"
            description="Stored timestamps and scope fields exactly as returned by the current tenant-scoped record."
            aside={
              <div className="flex flex-wrap gap-2">
                <Badge variant={severityVariant(incident.severity)}>
                  {SEVERITY_LABEL[incident.severity]}
                </Badge>
                <Badge variant={stateVariant(incident.status)}>
                  {STATE_LABEL[incident.status]}
                </Badge>
              </div>
            }
          >
            <dl className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <DetailTerm
                label="Detected"
                value={formatIncidentTime(incident.detected_at)}
              />
              <DetailTerm
                label="Discovered"
                value={formatIncidentTime(incident.discovered_at)}
              />
              <DetailTerm
                label="Operational timer start"
                value={formatIncidentTime(incident.clock_started_at)}
              />
              <DetailTerm
                label="Stored 72-hour target"
                value={formatIncidentTime(incident.gdpr_72h_deadline)}
              />
              <DetailTerm
                label="Created"
                value={formatIncidentTime(incident.created_at)}
              />
              <DetailTerm
                label="Updated"
                value={formatIncidentTime(incident.updated_at)}
              />
              <DetailTerm
                label="Affected subjects"
                value={
                  incident.affected_subject_count?.toLocaleString() ??
                  "Not estimated"
                }
              />
              <DetailTerm
                label="Affected regions"
                value={incident.affected_regions.join(", ") || "None recorded"}
              />
              <DetailTerm
                label="Data categories"
                value={
                  incident.affected_data_categories.join(", ") ||
                  "None recorded"
                }
              />
              <DetailTerm
                label="Candidate jurisdictions"
                value={incident.jurisdictions.join(", ") || "None recorded"}
              />
              <DetailTerm
                label="Stored sign-off identity"
                value={incident.signoff_by || "No stored sign-off claim"}
              />
              <DetailTerm
                label="Stored sign-off time"
                value={formatIncidentTime(incident.counsel_signoff_at)}
              />
              <DetailTerm
                label="Draft template reference"
                value={incident.template_version}
                mono
              />
            </dl>
            <div className="mt-5 border-t pt-5">
              <h3 className="text-sm font-semibold">Description and scope</h3>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
                {incidentDetail(incident.summary) ?? incident.summary}
              </p>
            </div>
            <details className="mt-5 rounded-lg border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                Stored notification decisions and jurisdiction resolution
              </summary>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                These fields may be incomplete and are not a legal
                determination.
              </p>
              <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(
                  {
                    notification_decisions: incident.notification_decisions,
                    jurisdiction_resolution: incident.jurisdiction_resolution,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </OperationsSection>

          <OperationsSection
            id="privacy-incident-state"
            title="Operational state"
            description="Available non-terminal transitions use a fresh identity check, a current-record compare, a stable idempotency key, and the server's transactional expected-state lock."
            aside={
              <Badge variant={stateVariant(incident.status)}>
                {STATE_LABEL[incident.status]}
              </Badge>
            }
          >
            {AVAILABLE_TRANSITIONS[incident.status].length > 0 ? (
              <>
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  {AVAILABLE_TRANSITIONS[incident.status].map((next) => (
                    <Button
                      key={next}
                      type="button"
                      variant="outline"
                      disabled={!mutationInventoryReady}
                      title={transitionLockReason}
                      onClick={() => setTarget(next)}
                    >
                      Move to {STATE_LABEL[next]}
                    </Button>
                  ))}
                </div>
                {transitionLockReason ? (
                  <p
                    role="status"
                    className="mt-3 text-sm text-muted-foreground"
                  >
                    {transitionLockReason}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                This stored record is closed and has no available transition.
              </p>
            )}
            {incident.status !== "closed" ? (
              <Alert variant="warning" className="mt-4">
                <AlertTitle>Closure unavailable</AlertTitle>
                <AlertDescription>
                  Closure is release-held until jurisdiction-specific decisions,
                  distinct counsel identity, and authenticated delivery evidence
                  are durably bound to an atomic transition.
                </AlertDescription>
              </Alert>
            ) : null}
          </OperationsSection>

          <OperationsSection
            id="privacy-incident-evidence-holds"
            title="Evidence controls"
            description="The mounted desktop surface and backend deliberately hold these actions rather than accepting operator assertions as proof."
          >
            <div className="grid gap-3 md:grid-cols-3">
              <ReleaseHoldCard
                title="Counsel sign-off"
                body="Read-only stored legacy fields. New approval requires a distinct authenticated principal and durable verification receipt."
              />
              <ReleaseHoldCard
                title="Notification delivery"
                body="Loaded legacy notification rows are context only. Manual assertions cannot prove provider or regulator delivery."
              />
              <ReleaseHoldCard
                title="Evidence packets"
                body="Authority, customer, and data-subject packet generation/download remain held until every assertion derives from verified evidence."
              />
            </div>
          </OperationsSection>

          <IncidentEventsSection
            events={eventsQuery.data?.events ?? null}
            pending={eventsQuery.isPending}
            error={eventsQuery.isError}
            retrying={eventsQuery.isFetching}
            onRetry={() => void eventsQuery.refetch()}
          />

          <TransitionDialog
            key={`${incident.id}:${incident.updated_at}:${target ?? "none"}`}
            open={target !== null}
            target={target}
            incident={incident}
            tenantId={tenantId}
            userId={meQuery.data.user_id}
            inventoryReady={mutationInventoryReady}
            onOpenChange={(open) => {
              if (!open) setTarget(null);
            }}
            onCommitted={async () => {
              await queryClient.invalidateQueries({
                queryKey: registerKey,
                exact: true,
              });
              await refresh();
            }}
            onCurrentInventoryChanged={refresh}
          />
        </>
      )}
    </OperationsShell>
  );
}

function DetailTerm({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className={`mt-1 break-words text-sm${mono ? " font-mono" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

function ReleaseHoldCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border bg-muted/20 p-4">
      <div className="flex items-center gap-2">
        <FileCheck2 className="size-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <Badge variant="warning" className="mt-3">
        Release-held
      </Badge>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{body}</p>
    </div>
  );
}

function IncidentEventsSection({
  events,
  pending,
  error,
  retrying,
  onRetry,
}: {
  events: PrivacyIncidentEvent[] | null;
  pending: boolean;
  error: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const notifications =
    events?.filter((event) => event.kind === "notification") ?? [];
  return (
    <>
      <OperationsSection
        id="privacy-incident-notifications"
        title="Recorded notification context"
        description="Legacy/operator-authored rows only. These are not authenticated delivery receipts."
      >
        {pending ? (
          <OperationsLoading
            label="Loading recorded notification context"
            rows={3}
          />
        ) : error ? (
          <OperationsFailure
            title="Notification context could not be verified"
            description="A failed event-ledger request is not evidence that no notification rows exist."
            onRetry={onRetry}
            retrying={retrying}
          />
        ) : notifications.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No legacy notification rows appear in the complete loaded event
            response. Delivery remains unproven and recording is release-held.
          </p>
        ) : (
          <ul className="space-y-3" aria-label="Recorded notification context">
            {notifications.map((event) => (
              <li
                key={`${event.source}:${event.event_id}`}
                className="rounded-lg border p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">
                    {event.audience.replace(/_/gu, " ")}
                  </Badge>
                  <span>{formatIncidentTime(event.at)}</span>
                </div>
                <p className="mt-2 break-words text-muted-foreground">
                  Actor: {event.actor || "Not recorded"} · Template:{" "}
                  {event.template_key || "Not recorded"}
                </p>
                <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                  Body SHA-256: {event.body_sha256 || "Not recorded"} ·
                  Recipient reference: {event.recipient_ref || "Not recorded"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </OperationsSection>

      <OperationsSection
        id="privacy-incident-activity"
        title="Activity ledger"
        description="Merged state-transition and legacy notification rows in server-authored chronological order."
        aside={<History className="size-4 text-muted-foreground" aria-hidden />}
      >
        {pending ? (
          <OperationsLoading label="Loading incident activity" rows={5} />
        ) : error || events === null ? (
          <OperationsFailure
            title="Incident activity could not be verified"
            description="The overview remains available, but no empty-history claim is made while the independent ledger request is unavailable."
            onRetry={onRetry}
            retrying={retrying}
          />
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The complete loaded event response contains no rows. This is unusual
            because creation normally records an opening transition.
          </p>
        ) : (
          <ol className="space-y-3" aria-label="Privacy incident activity">
            {events.map((event) => (
              <li
                key={`${event.source}:${event.event_id}`}
                className="rounded-lg border p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={event.kind === "transition" ? "info" : "outline"}
                  >
                    {event.kind === "transition"
                      ? "State transition"
                      : "Notification context"}
                  </Badge>
                  <span className="text-sm">
                    {formatIncidentTime(event.at)}
                  </span>
                </div>
                {event.kind === "transition" ? (
                  <p className="mt-2 text-sm">
                    {event.from_state
                      ? STATE_LABEL[event.from_state]
                      : "Created"}{" "}
                    → {STATE_LABEL[event.to_state]}
                  </p>
                ) : (
                  <p className="mt-2 text-sm">
                    Audience: {event.audience.replace(/_/gu, " ")}
                  </p>
                )}
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {event.kind === "transition"
                    ? event.reason || "No reason recorded"
                    : `Legacy context recorded by ${event.actor || "an unknown actor"}`}
                </p>
                <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                  {event.event_id}
                </p>
              </li>
            ))}
          </ol>
        )}
      </OperationsSection>
    </>
  );
}

function TransitionDialog({
  open,
  target,
  incident,
  tenantId,
  userId,
  inventoryReady,
  onOpenChange,
  onCommitted,
  onCurrentInventoryChanged,
}: {
  open: boolean;
  target: PrivacyIncidentState | null;
  incident: PrivacyIncident;
  tenantId: string;
  userId: string;
  inventoryReady: boolean;
  onOpenChange: (open: boolean) => void;
  onCommitted: (receipt: PrivacyIncidentTransitionReceipt) => Promise<void>;
  onCurrentInventoryChanged: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const idempotencyKey = useRef(newUUIDv7());
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ambiguousFingerprint, setAmbiguousFingerprint] = useState<
    string | null
  >(null);
  const locked = ambiguousFingerprint !== null;
  const phrase = target ? `MOVE TO ${STATE_LABEL[target].toUpperCase()}` : "";

  const currentAuthority = async () => {
    const current = await whoami();
    queryClient.setQueryData(qk.authMe(), current);
    queryClient.setQueryData(["whoami"], current);
    return authorizePrivacyIncidentAdmin(current, tenantId, userId);
  };

  const submit = async () => {
    if (!target) return;
    setError(null);
    const trimmedReason = reason.trim();
    if (!trimmedReason || Array.from(trimmedReason).length > 2_000) {
      setError("Enter a transition reason of 2,000 characters or fewer.");
      return;
    }
    if (confirmation !== phrase) {
      setError(`Type ${phrase} exactly to confirm this durable audit event.`);
      return;
    }
    if (!inventoryReady) {
      setError(
        "Refresh the current incident before confirming. No request was sent.",
      );
      return;
    }
    const fingerprint = JSON.stringify({
      incidentId: incident.id,
      expectedFrom: incident.status,
      expectedUpdatedAt: incident.updated_at,
      to: target,
      reason: trimmedReason,
    });
    if (ambiguousFingerprint && ambiguousFingerprint !== fingerprint) {
      setError(
        "The prior outcome is unknown; only the exact locked request may be retried.",
      );
      return;
    }
    setSubmitting(true);
    let requestStarted = false;
    try {
      const authority = await currentAuthority();
      const current = await getPrivacyIncident({
        tenantId,
        incidentId: incident.id,
      });
      if (
        current.status !== incident.status ||
        current.updated_at !== incident.updated_at
      ) {
        await onCurrentInventoryChanged();
        setError(
          "This incident changed after the dialog opened. Current detail and activity were reloaded; review them before making a new confirmation.",
        );
        return;
      }
      requestStarted = true;
      const receipt = await transitionPrivacyIncident({
        authority,
        incidentId: incident.id,
        expectedFrom: incident.status,
        to: target,
        reason: trimmedReason,
        idempotencyKey: idempotencyKey.current,
      });
      try {
        await currentAuthority();
      } catch {
        await onCommitted(receipt);
        onOpenChange(false);
        toast.warning("State changed before your workspace identity changed", {
          description:
            "The exact transition receipt was verified, but the previous workspace view was retired.",
        });
        return;
      }
      await onCommitted(receipt);
      onOpenChange(false);
      toast.success(`Incident moved to ${STATE_LABEL[target]}`);
    } catch (cause) {
      const semanticConflict =
        cause instanceof ApiError &&
        [
          "stale_incident_state",
          "transition_conflict",
          "no_op",
          "invalid_transition",
        ].includes(cause.code);
      if (requestStarted && semanticConflict) {
        idempotencyKey.current = newUUIDv7();
        await onCurrentInventoryChanged();
        setConfirmation("");
        setError(
          "The server rejected the stale transition and current detail/activity were reloaded. Review the record and start a new confirmation.",
        );
      } else if (
        requestStarted &&
        (isAmbiguousPrivacyIncidentMutation(cause) ||
          cause instanceof PrivacyIncidentContractError)
      ) {
        setAmbiguousFingerprint(fingerprint);
        setError(
          "The transition may have committed, but no exact outcome could be verified. Fields and request key are locked. Refresh and inspect activity before discarding or retrying.",
        );
      } else {
        if (requestStarted) idempotencyKey.current = newUUIDv7();
        setError(
          requestStarted
            ? apiErrorMessage(cause, "The transition was not confirmed.")
            : `${apiErrorMessage(cause, "Reauthorization or current-record verification failed")} No write request was sent.`,
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeDisabled={submitting} aria-busy={submitting}>
        <DialogHeader>
          <DialogTitle>
            Move to {target ? STATE_LABEL[target] : "another state"}
          </DialogTitle>
          <DialogDescription>
            This records an operator-reported workflow transition and reason in
            the durable incident ledger. It is not independent evidence of
            containment.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Transition not confirmed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <fieldset disabled={submitting || locked} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="privacy-incident-transition-reason">Reason</Label>
            <Textarea
              id="privacy-incident-transition-reason"
              value={reason}
              maxLength={2_000}
              rows={5}
              autoFocus
              onChange={(event) => setReason(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {Math.max(0, 2_000 - Array.from(reason).length).toLocaleString()}{" "}
              characters remaining
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="privacy-incident-transition-confirmation">
              Type <span className="font-mono">{phrase}</span>
            </Label>
            <Input
              id="privacy-incident-transition-confirmation"
              value={confirmation}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>
        </fieldset>
        {locked ? (
          <Alert variant="warning">
            <AlertTitle>Exact retry lock active</AlertTitle>
            <AlertDescription>
              Refresh the record and activity first. Retry uses the same payload
              and idempotency key; discard only after checking whether it
              committed.
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          {locked ? (
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={async () => {
                await onCurrentInventoryChanged();
                if (
                  window.confirm(
                    "After reviewing the refreshed record and activity, discard this exact retry key?",
                  )
                ) {
                  onOpenChange(false);
                }
              }}
            >
              Refresh, then discard
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
          )}
          <Button
            type="button"
            loading={submitting}
            onClick={() => void submit()}
          >
            {locked ? "Retry exact transition" : "Record transition"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
