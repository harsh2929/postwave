// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";

import { SinkCircuitLegend } from "@/components/settings/sink-circuit-legend";
import { SinkJwksCopyButton } from "@/components/settings/sink-jwks-copy-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  cancelAuditSinkReplayJob,
  createAuditSinkReplayJob,
  getAuditAuthority,
  listAuditSinkDLQ,
  listAuditSinkReplayJobs,
  listAuditSinkSigningKeys,
  listRecoverySinks,
  replayAuditSinkDLQBulk,
  replayAuditSinkDLQEntry,
  resetAuditSinkCircuit,
  rotateAuditSinkSigningKey,
  setRecoverySinkEnabled,
  testExistingAuditSink,
  type AuditDLQEntry,
  type AuditReplayJob,
  type AuditScope,
  type RecoverySink,
} from "@/lib/audit-operations-api";
import { effectiveAuthRole, whoamiFresh } from "@/lib/auth-api";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import { qk, STALE } from "@/lib/query-keys";

interface AuditSinkRecoveryPanelProps {
  tenantId: string;
  userId: string;
  role: string | null;
  identityReady: boolean;
  viewerMode?: boolean;
}

type Receipt = { id: number; title: string; detail: string; at: string };

export function AuditSinkRecoveryPanel({
  tenantId,
  userId,
  role,
  identityReady,
  viewerMode = false,
}: AuditSinkRecoveryPanelProps) {
  const queryClient = useQueryClient();
  const [active, setActive] = useState(false);
  const [selectedSinkId, setSelectedSinkId] = useState("");
  const [selectedDLQ, setSelectedDLQ] = useState<number[]>([]);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [replayConfirmOpen, setReplayConfirmOpen] = useState(false);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const busyRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const authorityKey = identityReady
    ? `${tenantId}:${userId}:${role ?? "none"}:${viewerMode ? "viewer" : "member"}`
    : "unverified";
  const authorityKeyRef = useRef(authorityKey);

  const baseKey = useMemo(
    () => [...qk.settings(tenantId, role, "audit-sink-recovery"), authorityKey],
    [authorityKey, role, tenantId],
  );
  const previousBaseKeyRef = useRef(baseKey);
  useEffect(() => {
    const previousBase = previousBaseKeyRef.current;
    previousBaseKeyRef.current = baseKey;
    authorityKeyRef.current = authorityKey;
    controllerRef.current?.abort();
    controllerRef.current = null;
    busyRef.current = false;
    setBusy(null);
    setActive(false);
    setSelectedSinkId("");
    setSelectedDLQ([]);
    setFromId("");
    setToId("");
    setReplayConfirmOpen(false);
    setBulkConfirmOpen(false);
    setFailure(null);
    setReceipts([]);
    if (previousBase !== baseKey) {
      void queryClient.cancelQueries({ queryKey: previousBase, exact: false });
      queryClient.removeQueries({ queryKey: previousBase, exact: false });
    }
    return () => controllerRef.current?.abort();
  }, [authorityKey, baseKey, queryClient]);
  const authorityQuery = useQuery({
    queryKey: [...baseKey, "authority"],
    queryFn: ({ signal }) => getAuditAuthority({ signal }),
    enabled: active && identityReady,
    staleTime: 0,
    retry: false,
  });
  const canRead = hasScope(authorityQuery.data?.auditScopes, "audit:read");
  const canConfigure = hasScope(
    authorityQuery.data?.auditScopes,
    "audit:configure_sinks",
  );
  const canExecute = hasScope(
    authorityQuery.data?.auditScopes,
    "audit:execute_actions",
  );

  const inventoryQuery = useQuery({
    queryKey: [...baseKey, "inventory"],
    queryFn: ({ signal }) => listRecoverySinks({ signal }),
    enabled: active && authorityQuery.isSuccess && canConfigure,
    staleTime: STALE.list,
    retry: false,
  });
  const dlqQuery = useQuery({
    queryKey: [...baseKey, "dlq"],
    queryFn: ({ signal }) => listAuditSinkDLQ({ signal }),
    enabled: active && authorityQuery.isSuccess && canRead,
    staleTime: STALE.list,
    retry: false,
  });
  const sinks = Array.isArray(inventoryQuery.data) ? inventoryQuery.data : [];
  const selectedSink =
    sinks.find((sink) => sink.id === selectedSinkId) ?? sinks[0] ?? null;
  const effectiveSinkId = selectedSink?.id ?? "";
  const jobsQuery = useInfiniteQuery({
    queryKey: [...baseKey, "replay-jobs", effectiveSinkId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      listAuditSinkReplayJobs(tenantId, effectiveSinkId, {
        limit: 25,
        ...(pageParam ? { cursor: pageParam } : {}),
        signal,
      }),
    getNextPageParam: (lastPage, _pages, _lastPageParam, pageParams) =>
      lastPage.nextCursor && !pageParams.includes(lastPage.nextCursor)
        ? lastPage.nextCursor
        : undefined,
    enabled:
      active && authorityQuery.isSuccess && canRead && Boolean(effectiveSinkId),
    staleTime: STALE.list,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.pages?.some((page) =>
        page.jobs.some((job) =>
          ["pending", "in_progress"].includes(job.status),
        ),
      )
        ? 5_000
        : false,
  });
  const keysQuery = useQuery({
    queryKey: [...baseKey, "signing-keys", effectiveSinkId],
    queryFn: ({ signal }) =>
      listAuditSinkSigningKeys(effectiveSinkId, { signal }),
    enabled:
      active &&
      canConfigure &&
      selectedSink?.kind === "http" &&
      selectedSink.webhookFormat === "standard_webhooks",
    staleTime: STALE.list,
    retry: false,
  });

  async function refreshAll(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: baseKey, exact: false });
  }

  function addReceipt(title: string, detail: string): void {
    setReceipts((current) =>
      [
        { id: Date.now(), title, detail, at: new Date().toISOString() },
        ...current,
      ].slice(0, 8),
    );
  }

  async function run(
    label: string,
    action: (context: {
      signal: AbortSignal;
      idempotencyKey: string;
    }) => Promise<string>,
  ): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    setFailure(null);
    const openedAuthority = authorityKey;
    const controller = new AbortController();
    controllerRef.current = controller;
    const context = {
      signal: controller.signal,
      idempotencyKey: `audit-recovery:${label}:${crypto.randomUUID()}`,
    };
    try {
      const detail = await action(context);
      if (
        controller.signal.aborted ||
        authorityKeyRef.current !== openedAuthority
      )
        return;
      addReceipt(label, detail);
      await refreshAll();
    } catch (error) {
      if (
        controller.signal.aborted ||
        authorityKeyRef.current !== openedAuthority
      )
        return;
      setFailure(
        error instanceof Error
          ? error.message
          : "The operation did not complete.",
      );
    } finally {
      busyRef.current = false;
      if (controllerRef.current === controller) controllerRef.current = null;
      setBusy(null);
    }
  }

  async function reauthorize(
    scope: AuditScope,
    signal: AbortSignal,
    expectedSink?: RecoverySink,
    expectedDLQ?: AuditDLQEntry,
  ): Promise<{ sink?: RecoverySink; dlq?: AuditDLQEntry }> {
    const [freshIdentity, authority] = await Promise.all([
      whoamiFresh(signal),
      getAuditAuthority({ cache: "no-store", signal }),
    ]);
    if (
      freshIdentity.tenant_id !== tenantId ||
      freshIdentity.user_id !== userId ||
      effectiveAuthRole(freshIdentity) !== role ||
      freshIdentity.viewer_mode !== viewerMode ||
      !authority.auditScopes.includes(scope)
    ) {
      throw new Error(
        "Workspace identity or audit authority changed. Reload before trying again.",
      );
    }
    let sink: RecoverySink | undefined;
    if (expectedSink) {
      sink = (await listRecoverySinks({ cache: "no-store", signal })).find(
        (candidate) => candidate.id === expectedSink.id,
      );
      if (!sink || sinkFingerprint(sink) !== sinkFingerprint(expectedSink)) {
        throw new Error(
          "The sink changed after this view loaded. Refresh and review its current state.",
        );
      }
    }
    let dlq: AuditDLQEntry | undefined;
    if (expectedDLQ) {
      dlq = (await listAuditSinkDLQ({ cache: "no-store", signal })).find(
        (candidate) => candidate.id === expectedDLQ.id,
      );
      if (!dlq || dlqFingerprint(dlq) !== dlqFingerprint(expectedDLQ)) {
        throw new Error(
          "The dead-letter entry changed after this view loaded. Refresh before replaying it.",
        );
      }
    }
    return { sink, dlq };
  }

  async function createReplay(context: {
    signal: AbortSignal;
    idempotencyKey: string;
  }): Promise<string> {
    if (!selectedSink) throw new Error("Select a current sink first.");
    const start = Number(fromId);
    const end = Number(toId);
    await reauthorize("audit:execute_actions", context.signal, selectedSink);
    const receipt = await createAuditSinkReplayJob(
      selectedSink.id,
      start,
      end,
      context,
    );
    setFromId("");
    setToId("");
    setReplayConfirmOpen(false);
    return `Replay job ${receipt.jobId} was accepted for rows ${receipt.fromId}–${receipt.toId}.`;
  }

  const dlq = Array.isArray(dlqQuery.data) ? dlqQuery.data : [];
  const replayJobs = Array.isArray(jobsQuery.data?.pages)
    ? jobsQuery.data.pages.flatMap((page) =>
        Array.isArray(page.jobs) ? page.jobs : [],
      )
    : [];
  const replayRangeValid = validReplayRange(fromId, toId);
  const allVisibleSelected =
    dlq.length > 0 && dlq.every((entry) => selectedDLQ.includes(entry.id));

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Delivery recovery and verification</CardTitle>
          <CardDescription className="mt-1">
            Probe current destinations, recover dead letters, control bounded
            backfills, and rotate Standard Webhooks keys. No destination
            credentials or upstream error bodies are rendered here.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={!identityReady || busy !== null}
          onClick={() => {
            if (active) void refreshAll();
            else setActive(true);
          }}
        >
          <RefreshCw aria-hidden />
          {active ? "Refresh recovery state" : "Load recovery console"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {!active ? (
          <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
            Recovery inventory is loaded only on request and is bound to the
            currently verified workspace identity.
          </div>
        ) : authorityQuery.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Verifying audit authority…
          </p>
        ) : authorityQuery.isError ? (
          <FailureNotice
            title="Audit authority could not be verified"
            detail="No recovery request has been sent."
            onRetry={() => void authorityQuery.refetch()}
          />
        ) : !canRead && !canConfigure && !canExecute ? (
          <Alert>
            <ShieldAlert aria-hidden />
            <AlertTitle>Audit recovery access is not granted</AlertTitle>
            <AlertDescription>
              This session has none of audit:read, audit:configure_sinks, or
              audit:execute_actions. Controls stay unavailable even if this
              route was opened directly.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {failure ? (
              <Alert variant="destructive">
                <AlertTriangle aria-hidden />
                <AlertTitle>Recovery operation did not complete</AlertTitle>
                <AlertDescription className="break-words">
                  {failure}
                </AlertDescription>
              </Alert>
            ) : null}

            <section
              aria-labelledby="sink-recovery-current"
              className="space-y-4"
            >
              <div>
                <h3 id="sink-recovery-current" className="font-medium">
                  Current sink state
                </h3>
                <p className="text-sm text-muted-foreground">
                  Every write re-checks identity, scope, and the selected sink
                  snapshot immediately before it is sent.
                </p>
              </div>
              {!canConfigure ? (
                <PermissionHold scope="audit:configure_sinks" />
              ) : inventoryQuery.isPending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading current sink inventory…
                </p>
              ) : inventoryQuery.isError ? (
                <FailureNotice
                  title="Sink inventory could not be loaded"
                  detail="Probe, pause, reset, and key-rotation controls remain locked."
                  onRetry={() => void inventoryQuery.refetch()}
                />
              ) : sinks.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  Verified empty: this workspace has no audit sinks to recover.
                </p>
              ) : (
                <>
                  <div className="max-w-xl space-y-1.5">
                    <Label htmlFor="audit-recovery-sink">Sink</Label>
                    <Select
                      id="audit-recovery-sink"
                      value={effectiveSinkId}
                      disabled={busy !== null}
                      onChange={(event) => {
                        setSelectedSinkId(event.target.value);
                        setFromId("");
                        setToId("");
                      }}
                    >
                      {sinks.map((sink) => (
                        <option key={sink.id} value={sink.id}>
                          {sink.name} · {sink.kind}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {selectedSink ? (
                    <>
                      <dl className="grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                        <Fact
                          label="Delivery"
                          value={selectedSink.enabled ? "running" : "paused"}
                        />
                        <Fact
                          label="Circuit"
                          value={selectedSink.circuitState}
                        />
                        <Fact
                          label="Failures"
                          value={String(selectedSink.consecutiveFailures)}
                        />
                        <Fact
                          label="Last result"
                          value={
                            selectedSink.hasLastError
                              ? "failed (details withheld)"
                              : "no recorded error"
                          }
                        />
                      </dl>
                      <SinkCircuitLegend sink={selectedSink} />
                      <div className="flex flex-wrap gap-2">
                        <ConfirmDialog
                          title="Send a canary audit event?"
                          description="This makes one real outbound delivery with the stored credentials. It does not reset the circuit or advance the live cursor."
                          confirmLabel="Send canary"
                          confirmVariant="default"
                          onConfirm={() =>
                            run("Canary delivered", async (context) => {
                              await reauthorize(
                                "audit:configure_sinks",
                                context.signal,
                                selectedSink,
                              );
                              const receipt = await testExistingAuditSink(
                                selectedSink.id,
                                context,
                              );
                              return `${receipt.kind} accepted ${receipt.action}. No credential was returned.`;
                            })
                          }
                          trigger={
                            <Button
                              type="button"
                              variant="outline"
                              disabled={busy !== null}
                            >
                              Test delivery
                            </Button>
                          }
                        />
                        <ConfirmDialog
                          title={
                            selectedSink.enabled
                              ? "Pause this sink?"
                              : "Resume this sink?"
                          }
                          description={
                            selectedSink.enabled
                              ? "New scheduled deliveries stop after the server applies this change. Pending evidence and recovery jobs remain visible."
                              : "Scheduled delivery resumes with the sink's current stored configuration."
                          }
                          confirmLabel={
                            selectedSink.enabled ? "Pause sink" : "Resume sink"
                          }
                          onConfirm={() =>
                            run(
                              selectedSink.enabled
                                ? "Sink paused"
                                : "Sink resumed",
                              async (context) => {
                                await reauthorize(
                                  "audit:configure_sinks",
                                  context.signal,
                                  selectedSink,
                                );
                                await setRecoverySinkEnabled(
                                  selectedSink.id,
                                  !selectedSink.enabled,
                                  context,
                                );
                                return `Server receipt confirmed delivery is ${selectedSink.enabled ? "paused" : "running"}.`;
                              },
                            )
                          }
                          trigger={
                            <Button
                              type="button"
                              variant="outline"
                              disabled={busy !== null}
                            >
                              {selectedSink.enabled ? "Pause" : "Resume"}
                            </Button>
                          }
                        />
                        {selectedSink.circuitState !== "closed" ? (
                          <ConfirmDialog
                            title="Reset this delivery circuit?"
                            description="Use this only after the upstream has recovered. Failure counters are cleared and the next scheduled delivery can run immediately."
                            confirmLabel="Reset circuit"
                            confirmationToken="RESET"
                            onConfirm={() =>
                              run("Circuit reset", async (context) => {
                                await reauthorize(
                                  "audit:configure_sinks",
                                  context.signal,
                                  selectedSink,
                                );
                                await resetAuditSinkCircuit(
                                  selectedSink.id,
                                  context,
                                );
                                return "The server confirmed the circuit is closed and failure counters were reset.";
                              })
                            }
                            trigger={
                              <Button
                                type="button"
                                variant="destructive"
                                disabled={busy !== null}
                              >
                                Reset circuit
                              </Button>
                            }
                          />
                        ) : null}
                      </div>
                    </>
                  ) : null}
                </>
              )}
            </section>

            {selectedSink?.kind === "http" &&
            selectedSink.webhookFormat === "standard_webhooks" &&
            canConfigure ? (
              <section
                aria-labelledby="sink-signing-keys"
                className="space-y-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 id="sink-signing-keys" className="font-medium">
                      Signing-key rotation
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Key IDs and status only. The authenticated JWKS contains
                      symmetric HMAC material and is intentionally not fetched
                      by this browser screen.
                    </p>
                  </div>
                  <ConfirmDialog
                    title="Rotate this signing key?"
                    description="A new HS256 key becomes active and the previous key enters its verification grace period. Receivers must refresh their protected verification material."
                    confirmLabel="Rotate key"
                    confirmationToken="ROTATE"
                    onConfirm={() =>
                      run("Signing key rotated", async (context) => {
                        await reauthorize(
                          "audit:configure_sinks",
                          context.signal,
                          selectedSink,
                        );
                        const receipt = await rotateAuditSinkSigningKey(
                          selectedSink.id,
                          context,
                        );
                        return `The server activated key ${receipt.kid}. No symmetric key material was returned to this UI.`;
                      })
                    }
                    trigger={
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy !== null}
                      >
                        Rotate key
                      </Button>
                    }
                  />
                </div>
                <SinkJwksCopyButton
                  sinkId={selectedSink.id}
                  disabled={busy !== null}
                />
                {keysQuery.isPending ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    Loading key history…
                  </p>
                ) : keysQuery.isError ? (
                  <FailureNotice
                    title="Signing-key history could not be loaded"
                    detail="Rotation remains available only after the current sink snapshot is reauthorized."
                    onRetry={() => void keysQuery.refetch()}
                  />
                ) : keysQuery.data?.length ? (
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {keysQuery.data.map((key) => (
                      <li
                        key={key.id}
                        className="rounded-lg border p-3 text-sm"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <code className="break-all text-xs">{key.kid}</code>
                          <Badge
                            variant={
                              key.status === "active" ? "success" : "secondary"
                            }
                          >
                            {key.status}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Rotated {formatTime(key.rotatedAt)}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    Verified empty: no signing-key history is recorded for this
                    sink.
                  </p>
                )}
              </section>
            ) : null}

            <section aria-labelledby="sink-replay-jobs" className="space-y-4">
              <div>
                <h3 id="sink-replay-jobs" className="font-medium">
                  Bounded historical replay
                </h3>
                <p className="text-sm text-muted-foreground">
                  Create one server-managed replay of at most 100,000 audit row
                  IDs. Customer-facing messages are not involved.
                </p>
              </div>
              {!canExecute ? (
                <PermissionHold scope="audit:execute_actions" />
              ) : !selectedSink ? (
                <p className="text-sm text-muted-foreground">
                  A current sink inventory is required before a replay can be
                  created.
                </p>
              ) : (
                <form
                  className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (replayRangeValid) setReplayConfirmOpen(true);
                  }}
                >
                  <div className="space-y-1.5">
                    <Label htmlFor="audit-replay-from">
                      First audit row ID
                    </Label>
                    <Input
                      id="audit-replay-from"
                      type="number"
                      min={0}
                      step={1}
                      value={fromId}
                      disabled={busy !== null}
                      onChange={(event) => setFromId(event.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="audit-replay-to">Last audit row ID</Label>
                    <Input
                      id="audit-replay-to"
                      type="number"
                      min={0}
                      step={1}
                      value={toId}
                      disabled={busy !== null}
                      onChange={(event) => setToId(event.target.value)}
                      required
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={!replayRangeValid || busy !== null}
                  >
                    Review replay
                  </Button>
                </form>
              )}
              <ConfirmDialog
                open={replayConfirmOpen}
                onOpenChange={setReplayConfirmOpen}
                title="Start this historical replay?"
                description={`Rows ${fromId || "—"} through ${toId || "—"} will be delivered again to ${selectedSink?.name ?? "the selected sink"}. This can duplicate events downstream.`}
                confirmLabel="Start replay"
                confirmationToken="REPLAY"
                onConfirm={() => run("Replay accepted", createReplay)}
              />
              {selectedSink && canRead ? (
                <ReplayJobsTable
                  jobs={replayJobs}
                  pending={jobsQuery.isPending}
                  failed={jobsQuery.isError}
                  hasNextPage={jobsQuery.hasNextPage}
                  fetchingNextPage={jobsQuery.isFetchingNextPage}
                  busy={busy}
                  onRetry={() => void jobsQuery.refetch()}
                  onLoadMore={() =>
                    void loadNextQueryPage(jobsQuery, jobsQuery.isEnabled)
                  }
                  onCancel={(job) =>
                    run("Replay cancelled", async (context) => {
                      await reauthorize(
                        "audit:execute_actions",
                        context.signal,
                        selectedSink,
                      );
                      const fresh = await listAuditSinkReplayJobs(
                        tenantId,
                        selectedSink.id,
                        { limit: 100, signal: context.signal },
                      );
                      const current = fresh.jobs.find(
                        (candidate) => candidate.id === job.id,
                      );
                      if (
                        !current ||
                        !["pending", "in_progress"].includes(current.status)
                      )
                        throw new Error(
                          "The replay job is no longer cancellable. Refresh its current status.",
                        );
                      await reauthorize(
                        "audit:execute_actions",
                        context.signal,
                        selectedSink,
                      );
                      await cancelAuditSinkReplayJob(
                        selectedSink.id,
                        job.id,
                        context,
                      );
                      return `The server confirmed replay job ${job.id} is cancelled.`;
                    })
                  }
                />
              ) : null}
            </section>

            <section aria-labelledby="sink-dlq" className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 id="sink-dlq" className="font-medium">
                    Dead-letter queue
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Pending failures only, capped by the server at 1,000
                    entries. Upstream error text is withheld because providers
                    may echo credentials.
                  </p>
                </div>
                {canExecute && selectedDLQ.length > 0 ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy !== null || selectedDLQ.length > 500}
                    onClick={() => setBulkConfirmOpen(true)}
                  >
                    Replay selected ({selectedDLQ.length})
                  </Button>
                ) : null}
              </div>
              {!canRead ? (
                <PermissionHold scope="audit:read" />
              ) : dlqQuery.isPending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading pending dead letters…
                </p>
              ) : dlqQuery.isError ? (
                <FailureNotice
                  title="Dead-letter queue could not be verified"
                  detail="An error is not presented as an empty queue."
                  onRetry={() => void dlqQuery.refetch()}
                />
              ) : dlq.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  Verified empty: the server reports no pending dead-letter
                  entries.
                </p>
              ) : (
                <TableContainer>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <Checkbox
                            aria-label="Select all visible dead letters"
                            checked={allVisibleSelected}
                            onChange={(event) =>
                              setSelectedDLQ(
                                event.target.checked
                                  ? dlq.slice(0, 500).map((entry) => entry.id)
                                  : [],
                              )
                            }
                          />
                        </TableHead>
                        <TableHead>Sink</TableHead>
                        <TableHead>Audit range</TableHead>
                        <TableHead>Attempts</TableHead>
                        <TableHead>First failed</TableHead>
                        {canExecute ? (
                          <TableHead className="text-right">Action</TableHead>
                        ) : null}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dlq.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell>
                            <Checkbox
                              aria-label={`Select dead-letter entry ${entry.id}`}
                              checked={selectedDLQ.includes(entry.id)}
                              onChange={(event) =>
                                setSelectedDLQ((current) =>
                                  event.target.checked
                                    ? [
                                        ...new Set([...current, entry.id]),
                                      ].slice(0, 500)
                                    : current.filter((id) => id !== entry.id),
                                )
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <code className="text-xs">
                              {sinkName(sinks, entry.sinkId)}
                            </code>
                          </TableCell>
                          <TableCell>
                            {entry.fromAuditId}–{entry.toAuditId}
                          </TableCell>
                          <TableCell>
                            {entry.attemptCount}
                            {entry.hasLastError ? " · failed" : ""}
                          </TableCell>
                          <TableCell>
                            {formatTime(entry.firstFailedAt)}
                          </TableCell>
                          {canExecute ? (
                            <TableCell className="text-right">
                              <ConfirmDialog
                                title="Replay this dead-letter entry?"
                                description={`Audit rows ${entry.fromAuditId}–${entry.toAuditId} will be delivered again. This can duplicate events downstream.`}
                                confirmLabel="Replay entry"
                                confirmVariant="default"
                                onConfirm={() =>
                                  run(
                                    "Dead letter replayed",
                                    async (context) => {
                                      await reauthorize(
                                        "audit:execute_actions",
                                        context.signal,
                                        undefined,
                                        entry,
                                      );
                                      const receipt =
                                        await replayAuditSinkDLQEntry(
                                          entry.id,
                                          context,
                                        );
                                      return `The server replayed ${receipt.rows} row${receipt.rows === 1 ? "" : "s"}${receipt.note ? ` (${receipt.note})` : ""}.`;
                                    },
                                  )
                                }
                                trigger={
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy !== null}
                                  >
                                    Replay
                                  </Button>
                                }
                              />
                            </TableCell>
                          ) : null}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
              <ConfirmDialog
                open={bulkConfirmOpen}
                onOpenChange={setBulkConfirmOpen}
                title="Replay selected dead letters?"
                description={`${selectedDLQ.length} current entries will be re-delivered. Results are recorded per entry; downstream systems can receive duplicates.`}
                confirmLabel="Replay selected"
                confirmationToken="REPLAY"
                onConfirm={() =>
                  run("Bulk replay completed", async (context) => {
                    const authority = await reauthorize(
                      "audit:execute_actions",
                      context.signal,
                    );
                    void authority;
                    const fresh = await listAuditSinkDLQ({
                      cache: "no-store",
                      signal: context.signal,
                    });
                    const freshIds = new Set(fresh.map((entry) => entry.id));
                    if (selectedDLQ.some((id) => !freshIds.has(id)))
                      throw new Error(
                        "The selected dead-letter inventory changed. Refresh and review the selection.",
                      );
                    await reauthorize("audit:execute_actions", context.signal);
                    const receipt = await replayAuditSinkDLQBulk(
                      [...selectedDLQ],
                      context,
                    );
                    setSelectedDLQ([]);
                    setBulkConfirmOpen(false);
                    return `${receipt.replayed} replayed, ${receipt.failed} failed, ${receipt.skipped} skipped.`;
                  })
                }
              />
            </section>

            <section
              aria-labelledby="sink-recovery-receipts"
              className="space-y-3"
            >
              <h3 id="sink-recovery-receipts" className="font-medium">
                Decision receipts
              </h3>
              {receipts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No recovery action has completed in this browser session.
                </p>
              ) : (
                <ol className="space-y-2" aria-live="polite">
                  {receipts.map((receipt) => (
                    <li
                      key={receipt.id}
                      className="flex gap-3 rounded-lg border p-3 text-sm"
                    >
                      <CheckCircle2
                        className="mt-0.5 size-4 shrink-0 text-success"
                        aria-hidden
                      />
                      <div>
                        <p className="font-medium">{receipt.title}</p>
                        <p className="break-words text-muted-foreground">
                          {receipt.detail}
                        </p>
                        <time
                          className="text-xs text-muted-foreground"
                          dateTime={receipt.at}
                        >
                          {formatTime(receipt.at)}
                        </time>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ReplayJobsTable({
  jobs,
  pending,
  failed,
  hasNextPage,
  fetchingNextPage,
  busy,
  onRetry,
  onLoadMore,
  onCancel,
}: {
  jobs: AuditReplayJob[];
  pending: boolean;
  failed: boolean;
  hasNextPage: boolean;
  fetchingNextPage: boolean;
  busy: string | null;
  onRetry: () => void;
  onLoadMore: () => void;
  onCancel: (job: AuditReplayJob) => Promise<void>;
}) {
  if (pending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading replay jobs…
      </p>
    );
  if (failed)
    return (
      <FailureNotice
        title="Replay jobs could not be loaded"
        detail="No terminal state is inferred from this error."
        onRetry={onRetry}
      />
    );
  if (jobs.length === 0)
    return (
      <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        Verified empty: this sink has no replay jobs.
      </p>
    );
  return (
    <div className="space-y-3">
      <TableContainer>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Range</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Progress</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => (
              <TableRow key={job.id}>
                <TableCell>
                  {job.fromAuditId}–{job.toAuditId}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      job.status === "completed"
                        ? "success"
                        : job.status === "failed"
                          ? "destructive"
                          : job.status === "cancelled"
                            ? "secondary"
                            : "warning"
                    }
                  >
                    {job.status.replace("_", " ")}
                  </Badge>
                  {job.hasLastError ? (
                    <span className="ml-2 text-xs text-destructive-emphasis">
                      failed details withheld
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  {job.rowsSent} sent · {job.rowsFailed} failed
                </TableCell>
                <TableCell>{formatTime(job.createdAt)}</TableCell>
                <TableCell className="text-right">
                  {["pending", "in_progress"].includes(job.status) ? (
                    <ConfirmDialog
                      title="Cancel this replay job?"
                      description="The worker stops after its current batch. Rows already delivered are not rolled back."
                      confirmLabel="Cancel replay"
                      onConfirm={() => onCancel(job)}
                      trigger={
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy !== null}
                        >
                          Cancel
                        </Button>
                      }
                    />
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          disabled={fetchingNextPage || busy !== null}
          onClick={onLoadMore}
        >
          {fetchingNextPage
            ? "Loading more replay jobs…"
            : "Load more replay jobs"}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          All loaded replay jobs are shown.
        </p>
      )}
    </div>
  );
}

function FailureNotice({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail: string;
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertTriangle aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{detail}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={onRetry}
        >
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function PermissionHold({ scope }: { scope: AuditScope }) {
  return (
    <Alert>
      <ShieldAlert aria-hidden />
      <AlertTitle>Capability held</AlertTitle>
      <AlertDescription>
        This session does not hold <code>{scope}</code>. The server remains
        authoritative and no related control is offered.
      </AlertDescription>
    </Alert>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words font-medium">{value}</dd>
    </div>
  );
}

function hasScope(
  scopes: readonly AuditScope[] | undefined,
  scope: AuditScope,
): boolean {
  return scopes?.includes(scope) === true;
}

function sinkFingerprint(sink: RecoverySink): string {
  return JSON.stringify([
    sink.id,
    sink.kind,
    sink.name,
    sink.enabled,
    sink.outputFormat,
    sink.webhookFormat,
    sink.consecutiveFailures,
    sink.autoDisableAfter,
    sink.circuitState,
    sink.cooldownUntil ?? "",
    sink.lastSuccessAt ?? "",
    sink.lastFailureAt ?? "",
    sink.hasLastError,
  ]);
}

function dlqFingerprint(entry: AuditDLQEntry): string {
  return JSON.stringify([
    entry.id,
    entry.sinkId,
    entry.fromAuditId,
    entry.toAuditId,
    entry.attemptCount,
    entry.firstFailedAt,
    entry.lastAttemptAt,
    entry.hasLastError,
  ]);
}

function validReplayRange(from: string, to: string): boolean {
  if (from.trim() === "" || to.trim() === "") return false;
  const start = Number(from);
  const end = Number(to);
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start <= end &&
    end - start + 1 <= 100_000
  );
}

function sinkName(sinks: RecoverySink[], id: string): string {
  const sink = sinks.find((candidate) => candidate.id === id);
  return sink ? sink.name : id;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}
