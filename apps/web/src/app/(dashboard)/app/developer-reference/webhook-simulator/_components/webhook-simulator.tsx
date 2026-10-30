// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Webhook simulator — pick an outbound webhook and an event, review the JSON,
 * and fire ONE real signed POST at the destination. Port of desktop's
 * pages/WebhookSimulator.tsx.
 *
 * THE FIRE IS REAL. Environment labels do not create a sandbox: the receiver
 * gets the same signed bytes the live path sends and can execute real side
 * effects. So every fire is confirmed, carries one caller-minted identity
 * (fire id + Idempotency-Key), and is checkpointed locally BEFORE it leaves
 * (lib/webhook-playground-fire-recovery). If the outcome is not provably
 * known, a new identity stays blocked until the operator reconciles THIS one:
 *
 *   Check server receipt      GET  /playground/fires/{fire_id}   (no receiver call)
 *   Continue this same fire   POST /{id}/playground/fire  same key, same bytes
 *   Restore retained response POST /{id}/playground/fire  same key, same bytes
 *   Allow a new logical fire  local only, after the operator checked the receiver
 *   Clear local checkpoint    local only, for an identity the server consumed
 *
 * The fire route is rate-governed (10/min per tenant, 2 concurrent). A 429 is
 * a refusal BEFORE dispatch, so it releases the checkpoint and renders the
 * server's own sentence.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { RefreshCw, Send } from "lucide-react";

import {
  DataSection,
  QueryError,
  SectionSkeleton,
} from "@/components/integrations/data-surface";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage, isApiError } from "@/lib/api";
import type { AuthRole, MeResponse } from "@/lib/auth-api";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import {
  fireWebhookPlayground,
  getWebhookPlaygroundFire,
  getWebhookSampleEvents,
  listSimulatorTargets,
  MAX_SIMULATOR_PAYLOAD_BYTES,
  type PlaygroundFireRequest,
  type SimulatorTarget,
} from "@/lib/developer-reference-api";
import { base, STALE } from "@/lib/query-keys";
import {
  createWebhookPlaygroundFireRecoveryAuthority,
  webhookPlaygroundFireRecovery,
  webhookPlaygroundFireRecoveryHoldDetail,
  type WebhookPlaygroundFireRecoveryHoldReason,
} from "@/lib/webhook-playground-fire-recovery";
import {
  classifyFireFailure,
  isPlaceholderSample,
  mintSimulatorFire,
  receiptMatchesFire,
  signingAlgorithmLabel,
  simulatorPayloadBytes,
  validateSimulatorPayload,
  webhookFireReadinessReason,
} from "@/lib/webhook-simulator-model";

import {
  FireReconciliationNotice,
  FireResponsePanel,
  type FireReconciliation,
  type ShownResponse,
} from "./simulator-panels";

type RecoveryGate =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "held"; reason: WebhookPlaygroundFireRecoveryHoldReason };

type Busy = null | "firing" | "checking" | "settling";

type FireDisposition =
  | "resolved"
  | "unresolved"
  | "not_dispatched"
  | "identity_consumed";

interface PendingFire {
  request: PlaygroundFireRequest;
  targetLabel: string;
}

const RESTORED_TARGET_LABEL = "the retained webhook destination";

function targetLabel(target: SimulatorTarget): string {
  return target.description || target.url || target.id;
}

export function WebhookSimulator({
  identity,
  role,
}: {
  identity: MeResponse;
  role: AuthRole | null;
}) {
  const tenantId = identity.tenant_id;
  const userId = identity.user_id;
  const authority = useMemo(
    () =>
      createWebhookPlaygroundFireRecoveryAuthority({
        tenant_id: tenantId,
        user_id: userId,
      }),
    [tenantId, userId],
  );
  const keyBase = useMemo(
    () => base("webhook-simulator", tenantId, role),
    [tenantId, role],
  );

  // Catalog reads. Window-focus refetches are off: the target list is the
  // snapshot a confirmation is reviewed against, and it must not shift under
  // an open confirm dialog.
  const events = useQuery({
    queryKey: [...keyBase, "events"],
    queryFn: getWebhookSampleEvents,
    staleTime: STALE.reference,
    refetchOnWindowFocus: false,
  });
  const targets = useInfiniteQuery({
    queryKey: [...keyBase, "targets"],
    queryFn: ({ pageParam, signal }) =>
      listSimulatorTargets(pageParam, { signal }),
    initialPageParam: "",
    // A repeated cursor would page forever; stop instead.
    getNextPageParam: (last, _pages, lastParam) =>
      last.next_cursor && last.next_cursor !== lastParam
        ? last.next_cursor
        : undefined,
    staleTime: STALE.list,
    refetchOnWindowFocus: false,
  });

  const targetRows = useMemo(() => {
    const seen = new Set<string>();
    const rows: SimulatorTarget[] = [];
    const loaded = targets.data?.pages;
    const pages = Array.isArray(loaded) ? loaded : [];
    for (const page of pages) {
      for (const target of page.webhooks) {
        if (seen.has(target.id)) continue;
        seen.add(target.id);
        rows.push(target);
      }
    }
    return rows;
  }, [targets.data]);
  const eventRows = useMemo(
    () => (Array.isArray(events.data) ? events.data : []),
    [events.data],
  );

  // Selection is DERIVED: an explicit pick when it still exists, else the
  // first row. `editedPayload === null` means "the selected event's sample".
  const [pickedWebhookId, setPickedWebhookId] = useState("");
  const [pickedEventType, setPickedEventType] = useState("");
  const [editedPayload, setEditedPayload] = useState<string | null>(null);
  const selectedTarget =
    targetRows.find((target) => target.id === pickedWebhookId) ?? targetRows[0];
  const selectedEvent =
    eventRows.find((event) => event.event_type === pickedEventType) ??
    eventRows[0];
  const eventType = selectedEvent?.event_type ?? "";
  const samplePayload = selectedEvent
    ? JSON.stringify(selectedEvent.sample_payload, null, 2)
    : "";
  const payload = editedPayload ?? samplePayload;
  const payloadBytes = simulatorPayloadBytes(payload);
  const samplePlaceholder =
    editedPayload === null &&
    !!selectedEvent &&
    isPlaceholderSample(selectedEvent.sample_payload);

  const [gate, setGate] = useState<RecoveryGate>({ status: "loading" });
  const [checkpoint, setCheckpoint] = useState<PlaygroundFireRequest | null>(
    null,
  );
  const [reconciliation, setReconciliation] =
    useState<FireReconciliation | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusyState] = useState<Busy>(null);
  const busyRef = useRef<Busy>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [fireError, setFireError] = useState<string | null>(null);
  const [fireRequiresRefresh, setFireRequiresRefresh] = useState(false);
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [response, setResponse] = useState<ShownResponse | null>(null);
  const [pendingFire, setPendingFire] = useState<PendingFire | null>(null);
  const [pendingEvent, setPendingEvent] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const payloadRef = useRef<HTMLTextAreaElement>(null);
  const targetSelectId = useId();
  const eventSelectId = useId();
  const payloadId = useId();
  const fireReasonId = useId();
  const payloadMetaId = useId();

  const setBusy = (next: Busy) => {
    busyRef.current = next;
    setBusyState(next);
  };

  function fence(
    request: PlaygroundFireRequest,
    label: string,
    phase: FireReconciliation["phase"],
    detail: string,
  ) {
    setAcknowledged(false);
    setReconciliation({
      request,
      targetLabel: label,
      phase,
      detail,
      receipt: null,
    });
  }

  // Read this tab's checkpoint before any new identity may be minted.
  const loadCheckpoint = useCallback(() => {
    const result = webhookPlaygroundFireRecovery.load(authority);
    if (result.status === "held") {
      setGate({ status: "held", reason: result.reason });
      return;
    }
    setGate({ status: "ready" });
    if (result.status === "clear") {
      setCheckpoint(null);
      return;
    }
    const restored = result.snapshot;
    setCheckpoint(restored);
    setPickedWebhookId(restored.webhookId);
    setPickedEventType(restored.eventType);
    setEditedPayload(restored.payloadJSON);
    setAcknowledged(false);
    setReconciliation((current) =>
      current?.request.fireId === restored.fireId
        ? current
        : {
            request: restored,
            targetLabel: RESTORED_TARGET_LABEL,
            phase: "unknown",
            detail:
              "A fire started earlier in this tab never recorded a trustworthy outcome. Check the server receipt before doing anything else.",
            receipt: null,
          },
    );
  }, [authority]);

  useEffect(() => {
    loadCheckpoint();
  }, [loadCheckpoint]);

  /** Remove the checkpoint for a fire whose outcome is settled. */
  function settleCheckpoint(request: PlaygroundFireRequest, label: string) {
    const result = webhookPlaygroundFireRecovery.settle(authority, request);
    if (result.status === "held") {
      fence(
        request,
        label,
        "checkpoint_cleanup",
        `${webhookPlaygroundFireRecoveryHoldDetail(result.reason)} Retry the local cleanup before creating another fire identity.`,
      );
      setFireError(
        "The receiver outcome is known, but the local recovery checkpoint could not be cleared.",
      );
      return false;
    }
    setCheckpoint(null);
    setReconciliation(null);
    setAcknowledged(false);
    return true;
  }

  /**
   * Send one fire. `recovering` re-sends an EXISTING checkpointed identity
   * (same Idempotency-Key, same bytes) and never writes a new checkpoint.
   */
  async function executeFire(
    request: PlaygroundFireRequest,
    label: string,
    recovering: boolean,
  ) {
    if (busyRef.current) return;
    setBusy("firing");
    setFireError(null);
    setFireRequiresRefresh(false);
    setResponse(null);
    try {
      if (!recovering) {
        const prepared = webhookPlaygroundFireRecovery.prepare(
          authority,
          request,
        );
        if (prepared.status === "held") {
          setFireError(
            webhookPlaygroundFireRecoveryHoldDetail(prepared.reason),
          );
          return;
        }
        setCheckpoint(prepared.snapshot);
      }
      const controller = new AbortController();
      abortRef.current = controller;
      let disposition: FireDisposition;
      try {
        const data = await fireWebhookPlayground(request, {
          signal: controller.signal,
        });
        if (!data) {
          fence(
            request,
            label,
            "unknown",
            "The server accepted the fire but returned no trustworthy receipt for this identity. Reconcile this exact fire before proceeding.",
          );
          disposition = "unresolved";
        } else if (data.ambiguous) {
          setResponse({ data, request, targetLabel: label });
          fence(
            request,
            label,
            "ambiguous",
            "Moosewave reached the outbound transport boundary but received no receiver status. Check the receiver's logs for this fire ID before proceeding.",
          );
          disposition = "unresolved";
        } else {
          setResponse({ data, request, targetLabel: label });
          setStatus(
            data.filtered
              ? `${request.eventType} was filtered before delivery to ${label}; no receiver request was made.`
              : `${request.eventType} fired to ${label}; receiver responded ${data.status_code}.`,
          );
          disposition = "resolved";
        }
      } catch (error) {
        const failure = classifyFireFailure(error, request.fireId);
        if (failure.kind === "receipt_expired") {
          setFireError(failure.message);
          disposition = "identity_consumed";
        } else if (failure.kind === "pending") {
          setFireError(failure.message);
          fence(
            request,
            label,
            "pending",
            "The server reserved this fire and has not recorded a terminal receiver outcome yet.",
          );
          disposition = "unresolved";
        } else if (failure.kind === "ambiguous") {
          setFireError(failure.message);
          fence(
            request,
            label,
            "unknown",
            failure.cancelled
              ? "The browser stopped waiting, but cancelling cannot recall a receiver request that may already have crossed the network boundary."
              : "The browser did not receive trustworthy proof of whether the receiver was contacted.",
          );
          disposition = "unresolved";
        } else {
          const stale = failure.code === "webhook_changed";
          setFireRequiresRefresh(stale);
          setFireError(
            stale
              ? "The destination changed since this catalog snapshot. Refresh the targets and review the destination before firing again."
              : failure.message,
          );
          setStatus(`The fire was refused before dispatch. ${failure.message}`);
          disposition = "not_dispatched";
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
      if (disposition === "unresolved") return;
      if (recovering && disposition === "not_dispatched") {
        // This refusal proves only that THIS retry did not dispatch. The
        // checkpoint may represent an earlier request that crossed the
        // receiver boundary, so its fence stays until the receipt resolves it.
        fence(
          request,
          label,
          "unknown",
          "The server refused this retry before dispatch, but that does not resolve whether the earlier request crossed the receiver boundary. Check the server receipt before proceeding.",
        );
        return;
      }
      settleCheckpoint(request, label);
    } finally {
      setBusy(null);
    }
  }

  async function checkReceipt() {
    const current = reconciliation;
    if (!current || busyRef.current) return;
    setBusy("checking");
    const controller = new AbortController();
    abortRef.current = controller;
    const fireId = current.request.fireId;
    const update = (next: Partial<FireReconciliation>) =>
      setReconciliation((latest) =>
        latest?.request.fireId === fireId ? { ...latest, ...next } : latest,
      );
    try {
      const receipt = await getWebhookPlaygroundFire(fireId, {
        signal: controller.signal,
      });
      if (!receiptMatchesFire(receipt, current.request)) {
        update({
          detail:
            "The server receipt did not match this fire's identity. The recovery fence stays in place and no terminal action is available.",
          receipt: null,
        });
        return;
      }
      if (receipt.state === "pending") {
        update({
          phase: "pending",
          detail:
            "The server reserved this fire and is still waiting to record a terminal receiver outcome. Check again; do not create another identity.",
          receipt,
        });
      } else if (receipt.state === "receipt_expired") {
        setAcknowledged(false);
        update({
          phase: "receipt_expired",
          detail:
            "The server permanently fences this fire identity from redispatch, but its private retained payload and response have expired. Clearing the local checkpoint finishes recovery and does not contact the receiver.",
          receipt,
        });
      } else if (receipt.state === "ambiguous") {
        setAcknowledged(false);
        update({
          phase: "ambiguous",
          detail:
            "The durable receipt confirms a transport-ambiguous outcome. Check the receiver for this fire or delivery ID before proceeding.",
          receipt,
        });
      } else {
        update({
          phase: "recoverable",
          detail:
            "The server retained a terminal response. Restore it with the exact same request identity; this does not contact the receiver again.",
          receipt,
        });
      }
      setStatus(`Server receipt for fire ${fireId}: ${receipt.state}.`);
    } catch (error) {
      if (isApiError(error) && error.kind === "aborted") {
        setStatus(
          `Receipt check stopped for fire ${fireId}; the reconciliation fence remains in place.`,
        );
      } else if (isApiError(error) && error.status === 404) {
        update({
          phase: "not_registered",
          detail:
            "No durable receipt is registered yet. Continue only with this same fire identity; doing so is idempotent even if the original request is still arriving.",
          receipt: null,
        });
      } else {
        update({
          detail: `Receipt lookup failed: ${apiErrorMessage(error, "network unavailable")}`,
        });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(null);
    }
  }

  function settleFromNotice(release: boolean) {
    const current = reconciliation;
    if (!current || busyRef.current) return;
    if (release && (current.phase !== "ambiguous" || !acknowledged)) return;
    if (
      !release &&
      current.phase !== "receipt_expired" &&
      current.phase !== "checkpoint_cleanup"
    ) {
      return;
    }
    setBusy("settling");
    try {
      if (settleCheckpoint(current.request, current.targetLabel)) {
        setFireError(null);
        setStatus(
          release
            ? `Ambiguous fire ${current.request.fireId} was acknowledged after receiver verification. A new logical fire is now available.`
            : `The local recovery checkpoint for fire ${current.request.fireId} was cleared. No receiver request was sent.`,
        );
      }
    } finally {
      setBusy(null);
    }
  }

  const catalogReady =
    events.isSuccess &&
    targets.isSuccess &&
    !events.isRefetching &&
    !targets.isRefetching;
  const recoveryReason =
    gate.status === "held"
      ? webhookPlaygroundFireRecoveryHoldDetail(gate.reason)
      : gate.status === "loading"
        ? "Moosewave is checking this tab's fire checkpoint before enabling a new live request."
        : null;
  const targetReadiness = webhookFireReadinessReason(selectedTarget);
  const fireUnavailableReason =
    busy === "checking"
      ? "Wait for the current receipt check to finish."
      : busy
        ? "Wait for the current test delivery to finish."
        : reconciliation || checkpoint
          ? "Resolve the previous logical fire before creating another."
          : recoveryReason
            ? recoveryReason
            : !catalogReady
              ? "Refresh the simulator catalog successfully before firing."
              : targetReadiness
                ? targetReadiness
                : !eventType
                  ? "Choose an event type before firing."
                  : !payload.trim()
                    ? "Enter a JSON object in the payload editor before firing."
                    : payloadBytes > MAX_SIMULATOR_PAYLOAD_BYTES
                      ? "Reduce the payload to 262,144 UTF-8 bytes or fewer before firing."
                      : null;

  function requestFire() {
    if (fireUnavailableReason || !selectedTarget) return;
    const validation = validateSimulatorPayload(payload);
    if (!validation.ok) {
      setPayloadError(validation.error);
      payloadRef.current?.focus();
      return;
    }
    setPayloadError(null);
    setPendingFire({
      request: mintSimulatorFire(selectedTarget, eventType, payload),
      targetLabel: targetLabel(selectedTarget),
    });
  }

  function confirmFire() {
    const pending = pendingFire;
    if (!pending) return;
    const current = targetRows.find(
      (target) => target.id === pending.request.webhookId,
    );
    setPendingFire(null);
    if (
      !catalogReady ||
      !current ||
      current.config_version !== pending.request.expectedWebhookConfigVersion
    ) {
      setFireError(
        "The target changed after confirmation opened. Refresh the catalog, review the current destination, and fire again.",
      );
      setFireRequiresRefresh(true);
      return;
    }
    // The review is complete. The dialog closes before the network wait so
    // "Stop waiting" stays reachable.
    void executeFire(pending.request, pending.targetLabel, false);
  }

  function refreshCatalog() {
    if (busyRef.current) return;
    setFireRequiresRefresh(false);
    setFireError(null);
    void events.refetch();
    void targets.refetch();
  }

  function changeEvent(next: string) {
    if (busyRef.current || next === eventType) return;
    if (editedPayload !== null && editedPayload !== samplePayload) {
      setPendingEvent(next);
      return;
    }
    setPickedEventType(next);
    setEditedPayload(null);
    setResponse(null);
    setPayloadError(null);
  }

  const catalogError = events.isError
    ? events.error
    : targets.isError
      ? targets.error
      : null;
  const catalogLoading = events.isPending || targets.isPending;
  const inputsLocked = busy !== null || !catalogReady;

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>

      <Alert>
        <AlertTitle>Use synthetic data only.</AlertTitle>
        <AlertDescription className="leading-5">
          A simulator fire makes one real, signed receiver request marked with a
          test header. The marker is advisory: your handler receives the same
          signed bytes as a live delivery and can run real side effects. The
          inspectable request and a bounded receiver response are kept in a
          private server receipt under your webhook-delivery retention policy.
        </AlertDescription>
      </Alert>

      {gate.status === "held" ? (
        <Alert variant="warning" role="alert" aria-label="Fire recovery">
          <AlertTitle>Fire recovery is not ready.</AlertTitle>
          <AlertDescription className="space-y-2 leading-5">
            <p>{webhookPlaygroundFireRecoveryHoldDetail(gate.reason)}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={loadCheckpoint}
            >
              Retry recovery check
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <DataSection
        id="ws-fire"
        title="Fire a synthetic event"
        description="Choose a destination and an event, review the JSON, then send exactly one signed request."
        aside={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={refreshCatalog}
            disabled={busy !== null || events.isFetching || targets.isFetching}
          >
            <RefreshCw aria-hidden />
            Refresh catalog
          </Button>
        }
      >
        {catalogLoading ? (
          <SectionSkeleton rows={3} />
        ) : catalogError ? (
          <QueryError
            title="Simulator catalog could not be loaded"
            description={`${apiErrorMessage(catalogError, "The destination or event list is unavailable.")} Firing stays unavailable until both load.`}
            onRetry={refreshCatalog}
          />
        ) : (
          <div className="space-y-4">
            {targetRows.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                No outbound webhooks are configured yet. Add one under Settings,
                then refresh the catalog to fire a signed request.
              </p>
            ) : null}
            {eventRows.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                No event samples are available from the server catalog, so
                firing is unavailable.
              </p>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={targetSelectId}>Target webhook</Label>
                <Select
                  id={targetSelectId}
                  value={selectedTarget?.id ?? ""}
                  disabled={inputsLocked || targetRows.length === 0}
                  onChange={(event) => {
                    setPickedWebhookId(event.target.value);
                    setResponse(null);
                    setFireError(null);
                    setFireRequiresRefresh(false);
                  }}
                >
                  {targetRows.length === 0 ? (
                    <option value="">No webhooks configured</option>
                  ) : null}
                  {targetRows.map((target) => (
                    <option key={target.id} value={target.id}>
                      {targetLabel(target)}
                    </option>
                  ))}
                </Select>
                {targets.hasNextPage ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={inputsLocked || targets.isFetchingNextPage}
                    onClick={() =>
                      void loadNextQueryPage(targets, targets.isEnabled)
                    }
                  >
                    {targets.isFetchingNextPage
                      ? "Fetching more targets"
                      : targets.isFetchNextPageError
                        ? "Retry more targets"
                        : "Load more targets"}
                  </Button>
                ) : null}
                {targets.isFetchNextPageError ? (
                  <p role="alert" className="text-xs text-destructive-emphasis">
                    Couldn&apos;t load more webhook targets:{" "}
                    {apiErrorMessage(targets.error, "request failed")}
                  </p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={eventSelectId}>Event type</Label>
                <Select
                  id={eventSelectId}
                  value={eventType}
                  disabled={inputsLocked || eventRows.length === 0}
                  onChange={(event) => changeEvent(event.target.value)}
                >
                  {eventRows.map((event) => (
                    <option key={event.event_type} value={event.event_type}>
                      {event.event_type}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            {selectedTarget ? (
              <p className="break-all text-xs text-muted-foreground">
                Target: <code>{selectedTarget.url}</code>
                {" · "}Signing:{" "}
                {signingAlgorithmLabel(selectedTarget.signing_algorithm)}
                {" · "}
                {selectedTarget.active ? "Active" : "Paused"}
              </p>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor={payloadId}>Payload (JSON)</Label>
              <Textarea
                id={payloadId}
                ref={payloadRef}
                rows={14}
                spellCheck={false}
                className="font-mono text-xs sm:text-xs"
                value={payload}
                disabled={busy !== null}
                aria-invalid={payloadError ? true : undefined}
                aria-describedby={payloadMetaId}
                onChange={(event) => {
                  setEditedPayload(event.target.value);
                  setPayloadError(null);
                  setFireError(null);
                  setResponse(null);
                }}
              />
              <div id={payloadMetaId} className="space-y-1">
                <p className="text-xs tabular-nums text-muted-foreground">
                  {payloadBytes.toLocaleString()} /{" "}
                  {MAX_SIMULATOR_PAYLOAD_BYTES.toLocaleString()} UTF-8 bytes
                </p>
                {payloadError ? (
                  <p role="alert" className="text-sm text-destructive-emphasis">
                    Payload can&apos;t be fired: {payloadError}
                  </p>
                ) : null}
                {samplePlaceholder ? (
                  <p className="text-xs text-amber-800">
                    No representative sample is registered for{" "}
                    <code>{eventType}</code> yet. The pre-filled body is a
                    placeholder, not what your handler receives in production.
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={requestFire}
                aria-disabled={fireUnavailableReason ? true : undefined}
                aria-describedby={fireReasonId}
                loading={busy === "firing"}
              >
                <Send aria-hidden />
                {busy === "firing" ? "Firing" : "Fire event"}
              </Button>
              {busy === "firing" || busy === "checking" ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => abortRef.current?.abort()}
                >
                  {busy === "checking"
                    ? "Stop receipt check"
                    : "Stop waiting & reconcile"}
                </Button>
              ) : null}
            </div>
            <p id={fireReasonId} className="text-xs text-muted-foreground">
              {fireUnavailableReason ??
                `Fires one real ${signingAlgorithmLabel(selectedTarget?.signing_algorithm ?? "")}-signed POST. The receiver may execute real side effects.`}
            </p>
          </div>
        )}
      </DataSection>

      {reconciliation ? (
        <FireReconciliationNotice
          reconciliation={reconciliation}
          acknowledged={acknowledged}
          busy={busy !== null}
          checking={busy === "checking"}
          onCheck={() => void checkReceipt()}
          onRecover={() =>
            void executeFire(
              reconciliation.request,
              reconciliation.targetLabel,
              true,
            )
          }
          onSettle={() => settleFromNotice(false)}
          onAcknowledgedChange={setAcknowledged}
          onRelease={() => settleFromNotice(true)}
        />
      ) : null}

      {fireError ? (
        <Alert variant="destructive" aria-label="Fire failure">
          <AlertTitle>Test delivery failed</AlertTitle>
          <AlertDescription className="space-y-2 leading-5">
            <p>{fireError}</p>
            {fireRequiresRefresh ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={refreshCatalog}
              >
                Refresh targets
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {response ? <FireResponsePanel shown={response} /> : null}

      <ConfirmDialog
        open={pendingFire !== null}
        onOpenChange={(open) => {
          if (!open) setPendingFire(null);
        }}
        title="Send a real signed webhook request?"
        description={
          pendingFire
            ? `This makes one real signed POST for ${pendingFire.request.eventType} to ${pendingFire.targetLabel}. The destination's environment label does not create a sandbox: your handler can trigger orders, notifications, billing, or other side effects. Fire ID ${pendingFire.request.fireId} stays fixed for reconciliation.`
            : ""
        }
        confirmLabel="Send this one logical fire"
        onConfirm={confirmFire}
      />
      <ConfirmDialog
        open={pendingEvent !== null}
        onOpenChange={(open) => {
          if (!open) setPendingEvent(null);
        }}
        title="Replace the edited payload?"
        description={
          pendingEvent
            ? `The ${pendingEvent} sample will replace the JSON currently in the editor. Your edits are not saved anywhere.`
            : ""
        }
        confirmLabel="Replace payload"
        confirmVariant="default"
        onConfirm={() => {
          if (pendingEvent) setPickedEventType(pendingEvent);
          setEditedPayload(null);
          setResponse(null);
          setPayloadError(null);
          setPendingEvent(null);
        }}
      />
    </>
  );
}
