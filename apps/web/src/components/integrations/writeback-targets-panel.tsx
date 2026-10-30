// SPDX-License-Identifier: AGPL-3.0-only
//
// Operator UI for bidirectional integration write-back (reverse-ETL). The whole
// subsystem (4 platform adapters, runner, continuous scheduler, per-member trait
// mapping) was server-only and invokable only via raw HTTP until this panel.
// Lets an admin register a write-back Target (provider + vault credential ref +
// a source list/segment + tag/field/trait mapping), run it on demand, pause /
// disconnect it, and inspect run history.
"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { whoami } from "@/lib/auth-api";
import { listSegments } from "@/lib/segments-api";
import { base, qk, STALE } from "@/lib/query-keys";
import { useAdminGate } from "@/lib/use-admin-gate";
import { AdminGateNotice } from "@/components/admin-gate-notice";
import {
  writebackApi,
  type WritebackProvider,
  type WritebackRun,
  type WritebackRunSummary,
  type WritebackTarget,
} from "@/lib/writeback-api";
import { CreateWritebackForm } from "./writeback-create-form";
import {
  clip,
  errText,
  fmtDate,
  providerLabel,
  statusClass,
  writebackErrorMessage,
} from "./writeback-targets-utils";

function summaryToast(s: WritebackRunSummary) {
  const detail = `${s.matched}/${s.members_seen} matched · ${s.tags_written} tags · ${s.fields_written} fields`;
  if (s.status === "failed") {
    toast.error(`Write-back failed — ${clip(s.error_message || detail)}`);
  } else if (s.status === "partial" || s.rows_failed > 0) {
    toast.warning(`Write-back partial — ${detail} · ${s.rows_failed} failed`);
  } else {
    toast.success(`Write-back complete — ${detail}`);
  }
}

interface WritebackPanelData {
  providers: WritebackProvider[];
  items: WritebackTarget[];
  providersUnavailable: boolean;
}

async function loadWritebackPanelData(): Promise<WritebackPanelData> {
  const [providersResult, items] = await Promise.all([
    Promise.resolve(writebackApi.providers()).then(
      (providers) => ({ providers, unavailable: false }),
      () => ({ providers: [] as WritebackProvider[], unavailable: true }),
    ),
    writebackApi.list(),
  ]);
  return {
    providers: providersResult.providers,
    providersUnavailable: providersResult.unavailable,
    items,
  };
}

export function WritebackTargetsPanel() {
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [runsForId, setRunsForId] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  // `busyId` names one row, but the handlers clear it unconditionally, so a
  // second target's request settling would re-enable a first target's still
  // in-flight buttons. One lock across all rows is what stops a second
  // writebackApi.run pushing the same audience into the CRM twice — the CRM
  // lifecycle panel next door holds the same lock for the same reason.
  const operationLockRef = useRef(false);
  // Every write-back mutation (create/run/pause/disconnect) is ScopeAdmin on the
  // server; mirror that gate client-side so read-only members don't see buttons
  // that would only 403.
  const adminGate = useAdminGate();
  const { canWrite } = adminGate;

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data?.role ?? null;
  const integrationsBaseKey = useMemo(
    () => base("integrations", tenantId, role),
    [role, tenantId],
  );
  const writebackKey = useMemo(
    () => [...integrationsBaseKey, "writeback"] as const,
    [integrationsBaseKey],
  );
  const segmentsKey = useMemo(
    () => qk.segments(tenantId, role, { surface: "writeback-create" }),
    [role, tenantId],
  );
  const runsKey = useMemo(
    () => [...writebackKey, "runs", runsForId] as const,
    [runsForId, writebackKey],
  );
  const writebackQuery = useQuery({
    queryKey: writebackKey,
    queryFn: loadWritebackPanelData,
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
  });
  const segmentsQuery = useQuery({
    queryKey: segmentsKey,
    queryFn: listSegments,
    enabled: meQuery.isSuccess && showCreate,
    staleTime: STALE.list,
  });
  const runsQuery = useQuery({
    queryKey: runsKey,
    queryFn: () => writebackApi.runs(runsForId ?? ""),
    enabled: meQuery.isSuccess && Boolean(runsForId),
    staleTime: STALE.list,
  });
  const providers = Array.isArray(writebackQuery.data?.providers)
    ? writebackQuery.data?.providers
    : [];
  const items = Array.isArray(writebackQuery.data?.items)
    ? writebackQuery.data?.items
    : [];
  const providersUnavailable =
    writebackQuery.data?.providersUnavailable ?? false;
  const loading =
    meQuery.isLoading || (writebackQuery.isPending && !writebackQuery.data);
  const error =
    writebackQuery.error || meQuery.error
      ? writebackErrorMessage(writebackQuery.error ?? meQuery.error)
      : null;

  const invalidateWriteback = (): Promise<void> =>
    queryClient
      .invalidateQueries({
        queryKey: writebackKey,
        exact: false,
      })
      .then(() => undefined);

  async function onRun(id: string) {
    if (operationLockRef.current) return;
    operationLockRef.current = true;
    setBusyId(id);
    try {
      const summary = await writebackApi.run(id);
      summaryToast(summary);
      // The just-completed run is now the newest; refresh its history if open.
      if (runsForId === id) {
        await queryClient.invalidateQueries({
          queryKey: runsKey,
          exact: false,
        });
      }
      await invalidateWriteback();
    } catch (e) {
      toast.error(errText(e, "Run failed"));
    } finally {
      operationLockRef.current = false;
      setBusyId(null);
    }
  }

  async function onPause(id: string) {
    if (operationLockRef.current) return;
    operationLockRef.current = true;
    setBusyId(id);
    try {
      await writebackApi.pause(id);
      toast.success("Target paused");
      await invalidateWriteback();
    } catch (e) {
      toast.error(errText(e, "Pause failed"));
    } finally {
      operationLockRef.current = false;
      setBusyId(null);
    }
  }

  async function onResume(id: string) {
    if (operationLockRef.current) return;
    operationLockRef.current = true;
    setBusyId(id);
    try {
      await writebackApi.resume(id);
      toast.success("Target resumed");
      await invalidateWriteback();
    } catch (e) {
      toast.error(errText(e, "Resume failed"));
    } finally {
      operationLockRef.current = false;
      setBusyId(null);
    }
  }

  async function onDisconnect(id: string) {
    if (operationLockRef.current) return;
    operationLockRef.current = true;
    setBusyId(id);
    try {
      await writebackApi.disconnect(id);
      toast.success("Target disconnected");
      if (runsForId === id) setRunsForId(null);
      // Drop cached runs so a later target reusing this id can't show stale runs.
      queryClient.removeQueries({
        queryKey: [...writebackKey, "runs", id],
        exact: false,
      });
      await invalidateWriteback();
    } catch (e) {
      toast.error(errText(e, "Disconnect failed"));
    } finally {
      operationLockRef.current = false;
      setBusyId(null);
    }
  }

  function onToggleRuns(id: string) {
    if (runsForId === id) {
      setRunsForId(null);
      return;
    }
    setRunsForId(id);
  }

  return (
    <section
      className="mt-8 border-t border-border pt-6"
      data-testid="writeback-targets"
    >
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Two-way sync (write-back)</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Push a list or segment&apos;s membership and each subscriber&apos;s
            computed traits back into Shopify, WooCommerce, HubSpot, Salesforce,
            Pipedrive or Klaviyo.
          </p>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
          {canWrite && !providersUnavailable && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowCreate((v) => !v)}
              aria-expanded={showCreate}
            >
              {showCreate ? "Cancel" : "New write-back"}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void meQuery.refetch();
              void writebackQuery.refetch();
            }}
          >
            Refresh
          </Button>
        </div>
      </div>

      {providersUnavailable ? (
        <div
          className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
          role="alert"
        >
          Existing write-back targets are shown below, but provider adapters
          could not be loaded. New-target controls are paused until a refresh
          succeeds.
        </div>
      ) : null}

      <AdminGateNotice
        gate={adminGate}
        className="mb-3"
        readOnlyMessage="You have read-only access. Ask a workspace admin to configure write-back targets."
      />

      {canWrite && showCreate && (
        <CreateWritebackForm
          providers={providers}
          segments={Array.isArray(segmentsQuery.data) ? segmentsQuery.data : []}
          segmentsLoaded={segmentsQuery.isFetched}
          segmentsError={segmentsQuery.isError}
          onCreated={async () => {
            setShowCreate(false);
            await invalidateWriteback();
          }}
        />
      )}

      {error && (
        <div className="mb-3 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}
      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
      {/* `!error` matters: a failed list read leaves items empty, and without
          this an admin would read "no targets configured" as fact and register
          a duplicate target for a provider that already has one. */}
      {!loading && !error && items.length === 0 && !showCreate && (
        <EmptyState
          icon={ArrowRightLeft}
          title="No write-back targets"
          description="Connect a target to push a list or segment's membership and computed traits back into Shopify, HubSpot, Salesforce, Pipedrive, or Klaviyo."
        />
      )}

      <div className="space-y-3">
        {items.map((item) => {
          const busy = busyId === item.id;
          const lifecycleBusy = busyId !== null;
          const paused = item.status.toLowerCase() === "paused";
          const runsOpen = runsForId === item.id;
          const interval = item.sync_interval_minutes;
          return (
            <div
              key={item.id}
              className="border border-border rounded-md bg-card p-4"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-sm truncate">
                      {item.name || providerLabel(item.provider)}
                    </span>
                    <span
                      className={`text-[11px] px-2 py-0.5 rounded-full ${statusClass(item.status)}`}
                    >
                      {item.status || "unknown"}
                    </span>
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted-foreground/15 text-muted-foreground">
                      {providerLabel(item.provider)}
                    </span>
                  </div>
                  {item.error_message && (
                    <div
                      className="mt-2 break-words text-xs text-destructive"
                      title={item.error_message}
                    >
                      {item.error_message}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground mt-2">
                    last run {fmtDate(item.last_run_at)} ·{" "}
                    {interval > 0
                      ? `auto every ${interval} min`
                      : "manual runs only"}
                  </div>
                </div>
                {canWrite && (
                  <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:flex-wrap sm:justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      loading={busy}
                      disabled={lifecycleBusy}
                      onClick={() => void onRun(item.id)}
                    >
                      Run now
                    </Button>
                    {!paused && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={lifecycleBusy}
                        onClick={() => void onPause(item.id)}
                      >
                        Pause
                      </Button>
                    )}
                    {paused && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={lifecycleBusy}
                        onClick={() => void onResume(item.id)}
                      >
                        Resume
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      disabled={lifecycleBusy}
                      onClick={() =>
                        setDisconnectTarget({
                          id: item.id,
                          name: item.name || providerLabel(item.provider),
                        })
                      }
                    >
                      Disconnect
                    </Button>
                  </div>
                )}
              </div>

              <div className="mt-3 border-t border-border pt-2">
                <button
                  type="button"
                  onClick={() => onToggleRuns(item.id)}
                  className="inline-flex min-h-11 items-center rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                  aria-expanded={runsOpen}
                >
                  {runsOpen ? "Hide run history" : "Run history"}
                </button>
                {runsOpen && (
                  <RunHistory
                    runs={runsQuery.data}
                    loading={runsQuery.isPending}
                    error={
                      runsQuery.error instanceof Error
                        ? runsQuery.error.message
                        : null
                    }
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={disconnectTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDisconnectTarget(null);
        }}
        title="Disconnect this write-back target?"
        description={
          disconnectTarget
            ? `Moosewave will stop writing audience membership and traits back to ${disconnectTarget.name}. This cannot be undone.`
            : ""
        }
        confirmLabel="Disconnect"
        onConfirm={async () => {
          if (disconnectTarget) await onDisconnect(disconnectTarget.id);
          setDisconnectTarget(null);
        }}
      />
    </section>
  );
}

function RunHistory({
  runs,
  loading,
  error,
}: {
  runs?: WritebackRun[];
  loading: boolean;
  error?: string | null;
}) {
  if (loading)
    return (
      <div className="text-xs text-muted-foreground mt-2">Loading runs…</div>
    );
  if (error)
    return (
      <div className="mt-2 text-xs text-destructive" role="alert">
        {error}
      </div>
    );
  if (!runs)
    return (
      <div className="text-xs text-muted-foreground mt-2">No runs loaded.</div>
    );
  if (runs.length === 0)
    return (
      <div className="text-xs text-muted-foreground mt-2">No runs yet.</div>
    );
  return (
    <div className="mt-2 space-y-1">
      {runs.map((run) => (
        <div
          key={run.id}
          className="grid gap-2 md:grid-cols-[140px_90px_1fr] items-start text-xs"
        >
          <div className="text-muted-foreground tabular-nums">
            {fmtDate(run.started_at)}
          </div>
          <span
            className={`justify-self-start text-[11px] px-2 py-0.5 rounded-full ${statusClass(run.status)}`}
          >
            {run.status}
          </span>
          <div className="text-muted-foreground tabular-nums">
            {run.matched}/{run.members_seen} matched · {run.tags_written} tags ·{" "}
            {run.fields_written} fields
            {run.rows_failed > 0 ? (
              <span className="text-destructive">
                {" "}
                · {run.rows_failed} failed
              </span>
            ) : null}
            <span className="text-muted-foreground"> · {run.run_mode}</span>
            {run.error_message ? (
              <div
                className="break-words text-destructive"
                title={run.error_message}
              >
                {run.error_message}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
