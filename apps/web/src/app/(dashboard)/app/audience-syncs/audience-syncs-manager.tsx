// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  History,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import {
  DataSection,
  QueryError,
  SectionSkeleton,
  StatusPill,
} from "@/components/integrations/data-surface";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
import { Select } from "@/components/ui/select";
import {
  authorizeAudienceActivationAdmin,
  type AudienceActivationAdminAuthority,
} from "@/lib/audience-activation-authority";
import { apiErrorMessage } from "@/lib/api";
import {
  createAudienceSync,
  deleteAudienceSync,
  getExclusionReceipt,
  listAudienceSyncRuns,
  listAudienceSyncs,
  previewAudienceSyncExclusions,
  runAudienceSync,
  updateAudienceSync,
  type AudienceSync,
  type AudienceSyncSchedule,
  type AudienceSyncSource,
} from "@/lib/audience-syncs-api";
import { whoami, type MeResponse } from "@/lib/auth-api";
import { downloadTextFile } from "@/lib/download";
import { listLists } from "@/lib/forms-api";
import { pluralizeCount } from "@/lib/pluralize";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { base, STALE } from "@/lib/query-keys";
import { listSegments } from "@/lib/segments-api";
import { useOnline } from "@/lib/use-online";

type PendingAction =
  | { kind: "run"; sync: AudienceSync; key: string }
  | { kind: "toggle"; sync: AudienceSync; key: string }
  | { kind: "delete"; sync: AudienceSync; key: string };

interface SyncDraft {
  name: string;
  sourceKind: "list" | "segment";
  sourceId: string;
  schedule: AudienceSyncSchedule;
  enabled: boolean;
  url: string;
  secret: string;
}

function roleOf(me: MeResponse): string {
  return me.effective_role ?? me.role;
}

function canAdmin(me: MeResponse): boolean {
  const role = roleOf(me);
  return !me.viewer_mode && (role === "owner" || role === "admin");
}

function mutationKey(kind: string, id = "new"): string {
  return `web:audience-sync:${kind}:${id}:${crypto.randomUUID()}`;
}

function draftFor(sync?: AudienceSync): SyncDraft {
  return {
    name: sync?.name ?? "",
    sourceKind: sync?.source.segment_id ? "segment" : "list",
    sourceId: sync?.source?.segment_id ?? sync?.source?.list_id ?? "",
    schedule: sync?.schedule ?? "manual",
    enabled: sync?.enabled ?? true,
    // Never round-trip a possibly redacted URL. Blank means keep on edit.
    url: "",
    secret: "",
  };
}

function sourceFor(draft: SyncDraft): AudienceSyncSource {
  return draft.sourceKind === "list"
    ? { list_id: draft.sourceId }
    : { segment_id: draft.sourceId };
}

function sourceLabel(sync: AudienceSync): string {
  if (sync.source.segment_id) {
    return `Segment · ${sync.source.segment_id.slice(0, 8)}…`;
  }
  if (sync.source.list_id) {
    return `List · ${sync.source.list_id.slice(0, 8)}…`;
  }
  return "Unknown source";
}

export function AudienceSyncsManager({ me }: { me: MeResponse }) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const admin = canAdmin(me);
  const role = roleOf(me);
  const identity = `${me.tenant_id}:${me.user_id}:${roleOf(me)}:${me.viewer_mode === true}`;
  const generationRef = useRef(0);
  const controllersRef = useRef(new Set<AbortController>());
  const mutationRef = useRef(false);
  const [formTarget, setFormTarget] = useState<AudienceSync | null | undefined>(
    undefined,
  );
  const [historyFor, setHistoryFor] = useState<AudienceSync | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const keyBase = useMemo(
    () => base("audience-syncs", me.tenant_id, role),
    [me.tenant_id, role],
  );
  const listKey = [...keyBase, "inventory"] as const;

  useEffect(() => {
    const controllers = controllersRef.current;
    generationRef.current += 1;
    mutationRef.current = false;
    setBusy(null);
    setPending(null);
    setHistoryFor(null);
    setFormTarget(undefined);
    for (const controller of controllers) controller.abort();
    controllers.clear();
    return () => {
      generationRef.current += 1;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, [identity]);

  const inventory = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) => listAudienceSyncs({ signal }),
    staleTime: STALE.list,
    gcTime: 0,
  });

  const visible = useMemo(() => {
    const rows = Array.isArray(inventory.data) ? inventory.data : [];
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter(
      (sync) =>
        sync.name.toLowerCase().includes(query) ||
        sync.destination.url.toLowerCase().includes(query) ||
        sync.destination.type.includes(query),
    );
  }, [inventory.data, search]);

  async function authority(
    generation: number,
  ): Promise<AudienceActivationAdminAuthority> {
    const current = await whoami();
    if (generation !== generationRef.current) {
      throw new Error(
        "Workspace identity changed while the action was pending.",
      );
    }
    return authorizeAudienceActivationAdmin(current, me.tenant_id, me.user_id);
  }

  async function runMutation<T>(
    label: string,
    operation: (
      authority: AudienceActivationAdminAuthority,
      signal: AbortSignal,
    ) => Promise<T>,
    success: (receipt: T) => { message: string; warning?: string },
  ): Promise<T | undefined> {
    if (!admin || online !== "online" || mutationRef.current) return undefined;
    if (inventory.isError) {
      toast.error(
        "Refresh audience sync inventory successfully before making changes.",
      );
      return undefined;
    }
    const generation = generationRef.current;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    mutationRef.current = true;
    setBusy(label);
    try {
      const freshAuthority = await authority(generation);
      const receipt = await operation(freshAuthority, controller.signal);
      await authority(generation);
      if (generation !== generationRef.current) return undefined;
      const outcome = success(receipt);
      toast.success(outcome.message);
      if (outcome.warning) {
        toast.warning(outcome.warning, { duration: 12_000 });
      }
      await queryClient.invalidateQueries({ queryKey: listKey });
      return receipt;
    } catch (error) {
      if (controller.signal.aborted || generation !== generationRef.current) {
        return undefined;
      }
      toast.error(apiErrorMessage(error, "Audience sync action failed."));
      await queryClient.invalidateQueries({ queryKey: listKey });
      return undefined;
    } finally {
      controllersRef.current.delete(controller);
      if (generation === generationRef.current) {
        mutationRef.current = false;
        setBusy(null);
      }
    }
  }

  async function confirmAction(): Promise<void> {
    const action = pending;
    if (!action) return;
    if (action.kind === "run") {
      const receipt = await runMutation(
        `run:${action.sync.id}`,
        (freshAuthority, signal) =>
          runAudienceSync({
            authority: freshAuthority,
            current: action.sync,
            idempotencyKey: action.key,
            signal,
          }),
        (run) => ({
          message:
            run.status === "succeeded"
              ? `Run completed: ${pluralizeCount(run.rows_exported, "row")} in ${pluralizeCount(run.batches_sent, "batch", "batches")}.`
              : `Run closed as ${run.status.replace(/_/gu, " ")}.`,
          ...(run.status !== "succeeded"
            ? {
                warning:
                  "Review run history and exclusion evidence before retrying.",
              }
            : {}),
        }),
      );
      if (!receipt)
        throw new Error(
          "The run outcome was not verified. Refresh run history before retrying.",
        );
    } else if (action.kind === "toggle") {
      const enabled = !action.sync.enabled;
      const receipt = await runMutation(
        `toggle:${action.sync.id}`,
        (freshAuthority, signal) =>
          updateAudienceSync({
            authority: freshAuthority,
            current: action.sync,
            patch: { enabled },
            idempotencyKey: action.key,
            signal,
          }),
        () => ({
          message: `Audience sync ${enabled ? "enabled" : "disabled"}.`,
        }),
      );
      if (!receipt)
        throw new Error(
          "The enabled-state outcome was not verified. Refresh before retrying.",
        );
    } else {
      const receipt = await runMutation(
        `delete:${action.sync.id}`,
        (freshAuthority, signal) =>
          deleteAudienceSync({
            authority: freshAuthority,
            current: action.sync,
            idempotencyKey: action.key,
            signal,
          }),
        () => ({
          message: "Audience sync and local run history deleted.",
          warning:
            "Previously delivered receiver data was not recalled or deleted.",
        }),
      );
      if (!receipt)
        throw new Error(
          "The delete outcome was not verified. Refresh before retrying.",
        );
    }
    setPending(null);
  }

  return (
    <>
      <DataSection
        id="as-list"
        title="Configured syncs"
        description="Signed webhook delivery works end-to-end. Platform sync rows remain adapter- and provider-approval gated."
        aside={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {inventory.isFetching && inventory.data ? (
              <span className="text-xs text-muted-foreground" role="status">
                Refreshing verified inventory…
              </span>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={inventory.isFetching}
              onClick={() => void inventory.refetch()}
            >
              <RefreshCw aria-hidden className="size-4" />
              Refresh
            </Button>
            {admin ? (
              <Button
                type="button"
                size="sm"
                disabled={
                  online !== "online" || busy !== null || inventory.isError
                }
                onClick={() => setFormTarget(null)}
              >
                <Plus aria-hidden className="size-4" />
                New sync
              </Button>
            ) : null}
          </div>
        }
      >
        {online !== "online" ? (
          <Alert className="mb-4">
            <AlertTitle>Read-only while offline</AlertTitle>
            <AlertDescription>
              Cached rows may remain visible, but no sync can be created,
              changed, run, or deleted without a live verified server.
            </AlertDescription>
          </Alert>
        ) : null}
        {!admin ? (
          <Alert className="mb-4">
            <AlertTitle>Read-only access</AlertTitle>
            <AlertDescription>
              Only workspace owners and admins outside viewer mode can manage
              sync configuration or download receipts containing subscriber
              emails.
            </AlertDescription>
          </Alert>
        ) : null}
        {inventory.data ? (
          <div className="relative mb-4 max-w-md">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label="Search audience syncs"
              className="pl-9"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, destination, or type…"
            />
          </div>
        ) : null}
        {inventory.isError && inventory.data ? (
          <Alert variant="destructive" className="mb-4">
            <AlertTitle>Refresh failed; showing stale verified data</AlertTitle>
            <AlertDescription>
              Refresh successfully before changing or running a sync.
            </AlertDescription>
          </Alert>
        ) : null}
        {inventory.isLoading ? (
          <SectionSkeleton rows={3} />
        ) : inventory.isError && !inventory.data ? (
          <QueryError
            title="Audience sync inventory could not be verified"
            description="The list has not been represented as empty and all management actions remain unavailable."
            onRetry={() => void inventory.refetch()}
          />
        ) : visible.length === 0 ? (
          <div className="rounded-xl border border-dashed p-6 text-center">
            <p className="text-sm font-medium">
              {search ? "No matching syncs" : "Verified empty inventory"}
            </p>
            <p className="mx-auto mt-1 max-w-xl text-sm leading-5 text-muted-foreground">
              {search
                ? "Clear the search to inspect every verified sync."
                : "No list or segment is currently configured for outbound webhook delivery."}
            </p>
            {!search && admin ? (
              <Button
                type="button"
                className="mt-4"
                disabled={online !== "online" || inventory.isError}
                onClick={() => setFormTarget(null)}
              >
                <Plus aria-hidden className="size-4" />
                Configure webhook sync
              </Button>
            ) : null}
          </div>
        ) : (
          <ul className="space-y-3">
            {visible.map((sync) => (
              <li key={sync.id} className="rounded-xl border p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="break-words font-medium">{sync.name}</h3>
                      <StatusPill
                        status={sync.enabled ? "enabled" : "disabled"}
                      />
                      <span className="rounded-full border px-2 py-0.5 text-xs capitalize text-muted-foreground">
                        {sync.destination.type.replace(/_/gu, " ")}
                      </span>
                    </div>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      {sourceLabel(sync)} · {sync.schedule}
                      {sync.destination.url ? ` · ${sync.destination.url}` : ""}
                      {sync.destination.url_redacted
                        ? " · query/fragment redacted"
                        : ""}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {sync.last_run_at
                        ? `Last run ${formatWireTimestamp(sync.last_run_at, "unknown")} · ${sync.last_run_status ?? "unknown"}`
                        : "Never run"}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setHistoryFor(sync)}
                    >
                      <History aria-hidden className="size-4" />
                      History
                    </Button>
                    {admin ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={
                            !sync.enabled ||
                            online !== "online" ||
                            busy !== null ||
                            inventory.isError
                          }
                          onClick={() =>
                            setPending({
                              kind: "run",
                              sync,
                              key: mutationKey("run", sync.id),
                            })
                          }
                        >
                          <Play aria-hidden className="size-4" />
                          {busy === `run:${sync.id}` ? "Running…" : "Run now"}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={
                            online !== "online" ||
                            busy !== null ||
                            inventory.isError
                          }
                          onClick={() =>
                            setPending({
                              kind: "toggle",
                              sync,
                              key: mutationKey("toggle", sync.id),
                            })
                          }
                        >
                          {sync.enabled ? (
                            <Pause aria-hidden className="size-4" />
                          ) : (
                            <Play aria-hidden className="size-4" />
                          )}
                          {sync.enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={
                            online !== "online" ||
                            busy !== null ||
                            inventory.isError
                          }
                          onClick={() => setFormTarget(sync)}
                        >
                          <Settings2 aria-hidden className="size-4" />
                          Configure
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          disabled={
                            online !== "online" ||
                            busy !== null ||
                            inventory.isError
                          }
                          onClick={() =>
                            setPending({
                              kind: "delete",
                              sync,
                              key: mutationKey("delete", sync.id),
                            })
                          }
                        >
                          <Trash2 aria-hidden className="size-4" />
                          Delete
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DataSection>
      {formTarget !== undefined ? (
        <SyncFormDialog
          me={me}
          sync={formTarget}
          online={online === "online"}
          busy={busy !== null}
          runMutation={runMutation}
          onClose={() => setFormTarget(undefined)}
        />
      ) : null}
      {historyFor ? (
        <SyncHistoryDialog
          sync={historyFor}
          me={me}
          online={online === "online"}
          queryKeyBase={keyBase}
          onClose={() => setHistoryFor(null)}
        />
      ) : null}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && busy === null) setPending(null);
        }}
        title={
          pending?.kind === "run"
            ? "Run this audience sync now?"
            : pending?.kind === "delete"
              ? "Delete this audience sync?"
              : pending?.sync.enabled
                ? "Disable this audience sync?"
                : "Enable this audience sync?"
        }
        description={
          pending?.kind === "run"
            ? "The consent firewall will withhold ineligible profiles, then Moosewave will send eligible rows to the configured receiver. Receiver effects cannot be undone from Moosewave."
            : pending?.kind === "delete"
              ? "The sync and its local run history will be deleted. Previously delivered receiver data is retained and must be handled at the receiver."
              : "This changes whether manual and scheduled runs are allowed. It does not recall data from the receiver."
        }
        confirmLabel={
          pending?.kind === "run"
            ? "Run sync"
            : pending?.kind === "delete"
              ? "Delete sync"
              : pending?.sync.enabled
                ? "Disable"
                : "Enable"
        }
        confirmVariant={pending?.kind === "delete" ? "destructive" : "default"}
        confirmationToken={
          pending?.kind === "delete" ? pending.sync.name : undefined
        }
        onConfirm={confirmAction}
      />
    </>
  );
}

function SyncFormDialog({
  me,
  sync,
  online,
  busy,
  runMutation,
  onClose,
}: {
  me: MeResponse;
  sync: AudienceSync | null;
  online: boolean;
  busy: boolean;
  runMutation: <T>(
    label: string,
    operation: (
      authority: AudienceActivationAdminAuthority,
      signal: AbortSignal,
    ) => Promise<T>,
    success: (receipt: T) => { message: string; warning?: string },
  ) => Promise<T | undefined>;
  onClose: () => void;
}) {
  const editing = sync !== null;
  const [draft, setDraft] = useState(() => draftFor(sync ?? undefined));
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const operationKey = useRef(
    mutationKey(editing ? "edit" : "create", sync?.id),
  );
  const initial = useRef(JSON.stringify(draft));
  const dirty = JSON.stringify(draft) !== initial.current;
  const sources = useQuery({
    queryKey: ["audience-sync-sources", me.tenant_id],
    queryFn: async () => {
      const [lists, segments] = await Promise.all([
        listLists(),
        listSegments(),
      ]);
      return { lists, segments };
    },
    staleTime: STALE.list,
    gcTime: 0,
  });
  useEffect(() => {
    if (
      !editing ||
      draft.sourceKind !== "list" ||
      !draft.sourceId ||
      /^\d{1,19}$/u.test(draft.sourceId) ||
      !sources.data
    ) {
      return;
    }
    const resolved = sources.data.lists.find(
      (list) =>
        String((list as { uuid?: unknown }).uuid ?? "") === draft.sourceId,
    );
    if (!resolved) return;
    const numericId = String(resolved.id);
    setDraft((current) =>
      current.sourceKind === "list" && current.sourceId === draft.sourceId
        ? { ...current, sourceId: numericId }
        : current,
    );
    const baseline = JSON.parse(initial.current) as SyncDraft;
    initial.current = JSON.stringify({ ...baseline, sourceId: numericId });
  }, [draft.sourceId, draft.sourceKind, editing, sources.data]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    if (!draft.name.trim() || !draft.sourceId) {
      setError("Name and exactly one source are required.");
      return;
    }
    if (!editing && (!draft.url.trim() || !draft.secret)) {
      setError("An HTTPS receiver URL and signing secret are required.");
      return;
    }
    const result = await runMutation(
      editing ? `edit:${sync.id}` : "create",
      (freshAuthority, signal) =>
        editing
          ? updateAudienceSync({
              authority: freshAuthority,
              current: sync,
              patch: {
                name: draft.name,
                source: sourceFor(draft),
                schedule: draft.schedule,
                enabled: draft.enabled,
                ...(sync.destination.type === "webhook" &&
                (draft.url.trim() || draft.secret)
                  ? {
                      destination: {
                        type: "webhook",
                        ...(draft.url.trim() ? { url: draft.url.trim() } : {}),
                        ...(draft.secret ? { secret: draft.secret } : {}),
                      },
                    }
                  : {}),
              },
              idempotencyKey: operationKey.current,
              signal,
            })
          : createAudienceSync({
              authority: freshAuthority,
              sync: {
                name: draft.name,
                source: sourceFor(draft),
                destination: {
                  type: "webhook",
                  url: draft.url,
                  secret: draft.secret,
                },
                schedule: draft.schedule,
                enabled: draft.enabled,
              },
              idempotencyKey: operationKey.current,
              signal,
            }),
      () => ({
        message: editing ? "Audience sync updated." : "Audience sync created.",
      }),
    );
    if (result) onClose();
  }

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) {
            if (dirty) setDiscard(true);
            else onClose();
          }
        }}
      >
        <DialogContent className="max-w-2xl" closeDisabled={busy}>
          <DialogHeader>
            <DialogTitle>
              {editing
                ? "Configure audience sync"
                : "New webhook audience sync"}
            </DialogTitle>
            <DialogDescription>
              Webhook batches are HMAC-signed and pass the consent/suppression
              firewall first. Signing secrets are write-only and never returned
              to this page.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(event) => void submit(event)}>
            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Sync was not saved</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="sync-name">
                <Input
                  id="sync-name"
                  required
                  maxLength={200}
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label="Schedule" htmlFor="sync-schedule">
                <Select
                  id="sync-schedule"
                  value={draft.schedule}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      schedule: event.target.value as AudienceSyncSchedule,
                    }))
                  }
                >
                  <option value="manual">Manual</option>
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                </Select>
              </Field>
              <Field label="Source type" htmlFor="sync-source-kind">
                <Select
                  id="sync-source-kind"
                  value={draft.sourceKind}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      sourceKind: event.target.value as "list" | "segment",
                      sourceId: "",
                    }))
                  }
                >
                  <option value="list">List</option>
                  <option value="segment">Segment</option>
                </Select>
              </Field>
              <Field
                label={
                  draft.sourceKind === "list" ? "Source list" : "Source segment"
                }
                htmlFor="sync-source"
              >
                {sources.isError ? (
                  <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
                    Sources could not be loaded. Saving remains unavailable.
                  </p>
                ) : (
                  <Select
                    id="sync-source"
                    required
                    disabled={sources.isLoading}
                    value={draft.sourceId}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        sourceId: event.target.value,
                      }))
                    }
                  >
                    <option value="">
                      {sources.isLoading ? "Loading…" : "Select…"}
                    </option>
                    {draft.sourceKind === "list"
                      ? (Array.isArray(sources.data?.lists)
                          ? sources.data.lists
                          : []
                        ).map((list) => (
                          <option key={list.id} value={String(list.id)}>
                            {list.name}
                          </option>
                        ))
                      : (Array.isArray(sources.data?.segments)
                          ? sources.data.segments
                          : []
                        ).map((segment) => (
                          <option key={segment.id} value={segment.id}>
                            {segment.name}
                          </option>
                        ))}
                  </Select>
                )}
              </Field>
            </div>
            {editing && sync.destination.type !== "webhook" ? (
              <Alert>
                <AlertTitle>
                  Provider configuration is managed separately
                </AlertTitle>
                <AlertDescription>
                  This legacy platform sync row can still be renamed,
                  rescheduled, enabled, run, and deleted here. Configure
                  provider credentials on Audience destinations.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="HTTPS receiver URL"
                  htmlFor="sync-url"
                  hint={
                    editing
                      ? `Leave blank to keep the stored endpoint (${sync?.destination.url || "redacted"}).`
                      : undefined
                  }
                >
                  <Input
                    id="sync-url"
                    type="url"
                    required={!editing}
                    maxLength={2_048}
                    placeholder={
                      editing
                        ? sync?.destination.url
                        : "https://receiver.example/audience"
                    }
                    value={draft.url}
                    autoComplete="off"
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        url: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field
                  label="HMAC signing secret"
                  htmlFor="sync-secret"
                  hint={
                    editing
                      ? "Leave blank to keep the existing write-only secret."
                      : "At least 16 characters. Store the same secret at the receiver."
                  }
                >
                  <Input
                    id="sync-secret"
                    type="password"
                    required={!editing}
                    minLength={16}
                    maxLength={4_096}
                    value={draft.secret}
                    autoComplete="new-password"
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        secret: event.target.value,
                      }))
                    }
                  />
                </Field>
              </div>
            )}
            <label className="flex min-h-11 items-center gap-3 rounded-md border px-3 text-sm">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    enabled: event.target.checked,
                  }))
                }
              />
              Enable manual and scheduled runs
            </label>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => (dirty ? setDiscard(true) : onClose())}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!online || busy || sources.isError}
              >
                {busy ? "Saving…" : editing ? "Save changes" : "Create sync"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        title="Discard unsaved sync changes?"
        description="Any endpoint or signing-secret value entered in this dialog will be cleared from memory."
        confirmLabel="Discard changes"
        onConfirm={onClose}
      />
    </>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function SyncHistoryDialog({
  sync,
  me,
  online,
  queryKeyBase,
  onClose,
}: {
  sync: AudienceSync;
  me: MeResponse;
  online: boolean;
  queryKeyBase: readonly unknown[];
  onClose: () => void;
}) {
  const admin = canAdmin(me);
  const [downloading, setDownloading] = useState<string | null>(null);
  const receiptController = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      receiptController.current?.abort();
      receiptController.current = null;
    },
    [],
  );
  const runs = useQuery({
    queryKey: [...queryKeyBase, "runs", sync.id],
    queryFn: ({ signal }) => listAudienceSyncRuns(sync.id, { signal }),
    staleTime: STALE.list,
    gcTime: 0,
  });
  const preview = useQuery({
    queryKey: [...queryKeyBase, "preview", sync.id],
    queryFn: ({ signal }) =>
      previewAudienceSyncExclusions({ syncId: sync.id, signal }),
    staleTime: STALE.detail,
    gcTime: 0,
  });

  async function downloadReceipt(runId: string): Promise<void> {
    if (!admin || !online || downloading) return;
    const controller = new AbortController();
    receiptController.current = controller;
    setDownloading(runId);
    try {
      authorizeAudienceActivationAdmin(
        await whoami(),
        me.tenant_id,
        me.user_id,
      );
      if (controller.signal.aborted) return;
      const receipt = await getExclusionReceipt(runId, {
        signal: controller.signal,
      });
      authorizeAudienceActivationAdmin(
        await whoami(),
        me.tenant_id,
        me.user_id,
      );
      if (controller.signal.aborted) return;
      downloadTextFile(receipt.filename, receipt.csv, "text/csv;charset=utf-8");
      toast.success(
        `Downloaded signed receipt with ${receipt.excluded_rows.toLocaleString()} exclusion rows.`,
      );
    } catch (error) {
      if (!controller.signal.aborted) {
        toast.error(
          apiErrorMessage(error, "Signed receipt could not be downloaded."),
        );
      }
    } finally {
      if (receiptController.current === controller) {
        receiptController.current = null;
        setDownloading(null);
      }
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Run history · {sync.name}</DialogTitle>
          <DialogDescription>
            Run rows are closed execution receipts. Exclusion CSVs contain
            subscriber emails and are fetched only on an explicit admin
            download.
          </DialogDescription>
        </DialogHeader>
        {preview.isLoading ? (
          <SectionSkeleton rows={1} />
        ) : preview.isError ? (
          <QueryError
            title="Exclusion preview unavailable"
            description="No zero count has been inferred. Refresh before running this sync."
            onRetry={() => void preview.refetch()}
          />
        ) : preview.data && !preview.data.available ? (
          <Alert variant="destructive">
            <AlertTitle>Source counts unavailable</AlertTitle>
            <AlertDescription>
              The service returned its explicit unavailable sentinel. No
              audience or exclusion count is being shown as zero.
            </AlertDescription>
          </Alert>
        ) : preview.data ? (
          <div className="grid grid-cols-2 gap-2 rounded-xl border bg-muted/20 p-3 text-center text-sm sm:grid-cols-4">
            <div>
              <strong className="block text-lg">
                {preview.data.audience_count.toLocaleString()}
              </strong>
              audience
            </div>
            <div>
              <strong className="block text-lg">
                {preview.data.excluded_consent.toLocaleString()}
              </strong>
              consent
            </div>
            <div>
              <strong className="block text-lg">
                {preview.data.excluded_suppression.toLocaleString()}
              </strong>
              suppression
            </div>
            <div>
              <strong className="block text-lg">
                {preview.data.excluded_total.toLocaleString()}
              </strong>
              withheld
            </div>
          </div>
        ) : null}
        {runs.isLoading ? (
          <SectionSkeleton rows={3} />
        ) : runs.isError ? (
          <QueryError
            title="Run history could not be loaded"
            description="The sync still exists, but no empty run history has been inferred."
            onRetry={() => void runs.refetch()}
          />
        ) : runs.data?.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            Verified empty run history. A receipt will become available after a
            run records exclusions.
          </p>
        ) : (
          <ul className="space-y-2">
            {runs.data?.map((run) => (
              <li key={run.id} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={run.status} />
                      <span>{run.rows_exported.toLocaleString()} exported</span>
                      <span>
                        {run.excluded_count.toLocaleString()} excluded
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatWireTimestamp(run.started_at, "unknown")} ·{" "}
                      {run.batches_sent.toLocaleString()} batches
                    </p>
                    {run.error ? (
                      <p className="mt-2 break-words text-destructive">
                        {run.error}
                      </p>
                    ) : null}
                    {run.provider_status ? (
                      <p className="mt-1 text-muted-foreground">
                        Provider: {run.provider_status}
                      </p>
                    ) : null}
                  </div>
                  {admin ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!online || downloading !== null}
                      onClick={() => void downloadReceipt(run.id)}
                    >
                      <Download aria-hidden className="size-4" />
                      {downloading === run.id
                        ? "Downloading…"
                        : "Signed receipt"}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
