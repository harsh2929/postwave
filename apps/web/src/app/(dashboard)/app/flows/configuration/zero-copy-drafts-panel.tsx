// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Eye,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiErrorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import {
  createZeroCopyDraft,
  deleteZeroCopyDraft,
  draftMatchesInput,
  getZeroCopyAlerts,
  getZeroCopyDraft,
  listZeroCopyDLQ,
  listZeroCopyDrafts,
  listZeroCopyFires,
  newAutomationOperationKey,
  normalizeZeroCopyDraftInput,
  parseTriggerConfig,
  updateZeroCopyDraft,
  validateZeroCopyDraft,
  type ZeroCopyAlertKind,
  type ZeroCopyDLQReason,
  type ZeroCopyDraft,
  type ZeroCopyDraftInput,
  type ZeroCopyEditableStatus,
  type ZeroCopyProvider,
  type ZeroCopyStatusFilter,
  type ZeroCopyValidation,
} from "@/lib/automation-configuration-api";
import {
  AUTOMATION_CONFIGURATION_BOUNDARIES,
  AUTOMATIONS_RUNTIME_UNAVAILABLE_REASON,
  ZERO_COPY_ALERTING_AVAILABLE,
} from "@/lib/automation-operational-availability";
import {
  useAutomationReadAbort,
  verifyFreshAutomationAdmin,
} from "./automation-configuration-authority";

interface Props {
  me: MeResponse;
  queryScope: readonly unknown[];
  canAdmin: boolean;
}

type EditorState = { mode: "create" } | { mode: "edit"; draft: ZeroCopyDraft };
type OperationAttempt = { fingerprint: string; idempotencyKey: string };

function stableOperationKey(
  attempts: Map<string, OperationAttempt>,
  slot: string,
  fingerprint: string,
  prefix: string,
): string {
  const existing = attempts.get(slot);
  if (existing?.fingerprint === fingerprint) return existing.idempotencyKey;
  const idempotencyKey = newAutomationOperationKey(prefix);
  attempts.set(slot, { fingerprint, idempotencyKey });
  return idempotencyKey;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function ZeroCopyDraftsPanel({ me, queryScope, canAdmin }: Props) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ZeroCopyStatusFilter>("all");
  const key = [...queryScope, "zero-copy-drafts", status] as const;
  const catalogue = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) =>
      listZeroCopyDrafts({
        tenantId: me.tenant_id,
        status,
        cursor: pageParam ?? undefined,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page, _pages, previous) =>
      page.nextCursor && page.nextCursor !== previous
        ? page.nextCursor
        : undefined,
    enabled: canAdmin,
  });
  const pages = Array.isArray(catalogue.data?.pages)
    ? catalogue.data.pages
    : [];
  const allRows = pages.flatMap((page) =>
    Array.isArray(page.items) ? page.items : [],
  );
  const duplicate = allRows.find(
    (row, index) =>
      allRows.findIndex((candidate) => candidate.id === row.id) !== index,
  );
  const rows = duplicate ? [] : allRows;
  const [inspectId, setInspectId] = useState<string | null>(null);
  const inspect = useQuery({
    queryKey: [...queryScope, "zero-copy-draft", inspectId ?? "none"],
    queryFn: ({ signal }) => getZeroCopyDraft(me.tenant_id, inspectId!, signal),
    enabled: canAdmin && Boolean(inspectId),
  });
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [removing, setRemoving] = useState<ZeroCopyDraft | null>(null);
  const mutationAttempts = useRef(new Map<string, OperationAttempt>());
  const nextRead = useAutomationReadAbort();

  async function saveDraft(value: ZeroCopyDraftInput) {
    const state = editor;
    if (!state) throw new Error("The trigger editor is no longer open.");
    const controller = nextRead();
    await verifyFreshAutomationAdmin(me, controller.signal);
    let confirmedReceipt: ZeroCopyDraft | null = null;
    if (state.mode === "edit") {
      const current = await getZeroCopyDraft(
        me.tenant_id,
        state.draft.id,
        controller.signal,
      );
      if (draftMatchesInput(current, value)) {
        // A prior request may have committed even though its response was
        // lost. A fresh exact readback is stronger evidence than replaying the
        // write and avoids clobbering a change made after that request.
        confirmedReceipt = current;
      } else if (JSON.stringify(current) !== JSON.stringify(state.draft)) {
        throw new Error(
          "This definition changed on the server. Nothing was written; close the editor and review the fresh record.",
        );
      }
    }
    const validation = await validateZeroCopyDraft(value, controller.signal);
    if (!validation.valid)
      throw new Error(
        validation.errors.join(" ") || "The server rejected this draft.",
      );
    controller.signal.throwIfAborted();
    const slot = state.mode === "edit" ? `update:${state.draft.id}` : "create";
    const fingerprint = JSON.stringify([
      me.tenant_id,
      state.mode,
      state.mode === "edit" ? state.draft.id : null,
      value,
    ]);
    const receipt =
      confirmedReceipt ??
      (state.mode === "edit"
        ? await updateZeroCopyDraft({
            tenantId: me.tenant_id,
            id: state.draft.id,
            value,
            idempotencyKey: stableOperationKey(
              mutationAttempts.current,
              slot,
              fingerprint,
              "zero-copy-update",
            ),
            signal: controller.signal,
          })
        : await createZeroCopyDraft({
            tenantId: me.tenant_id,
            value,
            idempotencyKey: stableOperationKey(
              mutationAttempts.current,
              slot,
              fingerprint,
              "zero-copy-create",
            ),
            signal: controller.signal,
          }));
    if (!draftMatchesInput(receipt, value))
      throw new Error(
        "The server returned a definition receipt that did not match the saved draft. Refresh before retrying.",
      );
    mutationAttempts.current.delete(slot);
    setEditor(null);
    toast.success(
      state.mode === "edit" ? "Trigger draft updated" : "Trigger draft created",
    );
    await qc.invalidateQueries({
      queryKey: [...queryScope, "zero-copy-drafts"],
    });
  }

  async function destroyDraft() {
    const target = removing;
    if (!target) throw new Error("The delete confirmation expired.");
    const controller = nextRead();
    await verifyFreshAutomationAdmin(me, controller.signal);
    const slot = `delete:${target.id}`;
    let current: ZeroCopyDraft;
    try {
      current = await getZeroCopyDraft(
        me.tenant_id,
        target.id,
        controller.signal,
      );
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 404)) throw cause;
      // A DELETE can commit while its response is lost. A fresh, tenant-bound
      // 404 proves the requested end state and must close the uncertain retry
      // instead of trapping the operator in a permanently failing dialog.
      mutationAttempts.current.delete(slot);
      setRemoving(null);
      if (inspectId === target.id) setInspectId(null);
      toast.success("Trigger draft is already deleted");
      await qc.invalidateQueries({
        queryKey: [...queryScope, "zero-copy-drafts"],
      });
      return;
    }
    if (JSON.stringify(current) !== JSON.stringify(target))
      throw new Error(
        "This definition changed on the server. Nothing was deleted; inspect the fresh record.",
      );
    controller.signal.throwIfAborted();
    await deleteZeroCopyDraft({
      id: target.id,
      idempotencyKey: stableOperationKey(
        mutationAttempts.current,
        slot,
        JSON.stringify(target),
        "zero-copy-delete",
      ),
      signal: controller.signal,
    });
    mutationAttempts.current.delete(slot);
    setRemoving(null);
    if (inspectId === target.id) setInspectId(null);
    toast.success("Trigger draft deleted");
    await qc.invalidateQueries({
      queryKey: [...queryScope, "zero-copy-drafts"],
    });
  }

  if (!canAdmin) {
    return (
      <section aria-labelledby="zero-copy-access-heading" className="space-y-3">
        <h2 id="zero-copy-access-heading" className="text-lg font-semibold">
          Warehouse trigger drafts
        </h2>
        <div role="note" className="rounded-lg border p-4 text-sm">
          Administrator access is required. Warehouse SQL, provider config, and
          connection references were not requested or placed in this browser
          cache.
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="zero-copy-heading" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="zero-copy-heading" className="text-lg font-semibold">
            Warehouse trigger drafts
          </h2>
          <p className="text-sm text-muted-foreground">
            Store and validate inert cursor-query definitions. No warehouse
            query is executed here.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select
            aria-label="Filter trigger drafts by stored status"
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as ZeroCopyStatusFilter)
            }
            className="w-44"
          >
            <option value="all">All stored statuses</option>
            <option value="draft">Draft</option>
            <option value="paused">Paused</option>
            <option value="active">Legacy active (blocked)</option>
            <option value="error">Legacy error</option>
          </Select>
          <Button
            variant="outline"
            disabled={catalogue.isFetching}
            onClick={() => void catalogue.refetch()}
          >
            <RefreshCw aria-hidden className="size-4" /> Refresh
          </Button>
          <Button onClick={() => setEditor({ mode: "create" })}>
            <Plus aria-hidden className="size-4" /> New trigger draft
          </Button>
        </div>
      </div>

      <div
        role="note"
        className="grid gap-2 rounded-lg border bg-muted/30 p-4 text-sm md:grid-cols-2"
      >
        <div>
          <strong className="block">Available</strong>
          {AUTOMATION_CONFIGURATION_BOUNDARIES.warehouseDrafts.available}
        </div>
        <div>
          <strong className="block text-destructive">Release-held</strong>
          {AUTOMATION_CONFIGURATION_BOUNDARIES.warehouseDrafts.unavailable}
        </div>
        <p className="md:col-span-2 text-muted-foreground">
          The API exposes no definition version or mutation precondition. Web
          performs a fresh identity and exact-record comparison before update or
          delete; a simultaneous write after that comparison cannot be excluded.
        </p>
      </div>

      {duplicate ? (
        <div role="alert" className="rounded-lg border border-destructive p-4">
          The server returned overlapping trigger pages. Results are withheld;
          refresh before continuing.
        </div>
      ) : catalogue.isError ? (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-destructive p-4"
        >
          <p>
            {apiErrorMessage(
              catalogue.error,
              "Trigger drafts could not be loaded",
            )}
          </p>
          <Button variant="outline" onClick={() => void catalogue.refetch()}>
            Retry
          </Button>
        </div>
      ) : catalogue.isPending ? (
        <p role="status" className="py-8 text-sm text-muted-foreground">
          Loading trigger drafts…
        </p>
      ) : rows.length === 0 ? (
        <div className="space-y-3 rounded-lg border p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {status === "all"
              ? "No trigger drafts are stored."
              : `No ${status} definitions are stored.`}
          </p>
          <Button onClick={() => setEditor({ mode: "create" })}>
            Create an inert draft
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <TableContainer aria-label="Warehouse trigger drafts">
            <Table>
              <caption className="sr-only">
                Stored warehouse trigger definitions; statuses are not execution
                evidence
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Intended cadence</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((draft) => (
                  <TableRow key={draft.id}>
                    <TableCell className="font-medium">{draft.name}</TableCell>
                    <TableCell>{draft.provider}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          draft.status === "active" ? "warning" : "outline"
                        }
                      >
                        {draft.status === "active"
                          ? "active · runtime blocked"
                          : draft.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {draft.pollingIntervalSeconds.toLocaleString()} seconds
                      (configuration only)
                    </TableCell>
                    <TableCell>{formatDate(draft.updatedAt)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Inspect ${draft.name}`}
                          onClick={() => setInspectId(draft.id)}
                        >
                          <Eye aria-hidden className="size-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Edit ${draft.name}`}
                          onClick={() => setEditor({ mode: "edit", draft })}
                        >
                          <Pencil aria-hidden className="size-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Delete ${draft.name}`}
                          onClick={() => setRemoving(draft)}
                        >
                          <Trash2 aria-hidden className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {catalogue.hasNextPage ? (
            <Button
              variant="outline"
              disabled={catalogue.isFetchingNextPage}
              onClick={() =>
                void loadNextQueryPage(catalogue, catalogue.isEnabled)
              }
            >
              {catalogue.isFetchingNextPage
                ? "Loading…"
                : "Load more definitions"}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              All verified definitions for this filter are loaded.
            </p>
          )}
        </div>
      )}

      <TriggerInspectDialog
        // Keyed so a newly inspected draft opens on its definition tab.
        key={inspectId ?? "closed"}
        open={Boolean(inspectId)}
        onClose={() => setInspectId(null)}
        triggerId={inspectId}
        queryScope={queryScope}
        pending={inspect.isPending}
        error={inspect.error}
        draft={inspect.data}
        retry={() => void inspect.refetch()}
      />
      {editor ? (
        <TriggerEditorDialog
          state={editor}
          onClose={() => setEditor(null)}
          onSave={saveDraft}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Delete trigger definition?"
        description="This permanently removes the stored configuration. It does not prove that any historical runtime work was cancelled. Type the exact draft name to continue."
        confirmationToken={removing?.name}
        confirmLabel="Delete definition"
        onConfirm={destroyDraft}
      />
    </section>
  );
}

type InspectTab = "definition" | "fires" | "alerts" | "dlq";

function inspectTab(value: string): InspectTab {
  return value === "fires" || value === "alerts" || value === "dlq"
    ? value
    : "definition";
}

function TriggerInspectDialog({
  open,
  onClose,
  triggerId,
  queryScope,
  pending,
  error,
  draft,
  retry,
}: {
  open: boolean;
  onClose: () => void;
  triggerId: string | null;
  queryScope: readonly unknown[];
  pending: boolean;
  error: unknown;
  draft?: ZeroCopyDraft;
  retry: () => void;
}) {
  const [tab, setTab] = useState<InspectTab>("definition");
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Inspect stored trigger definition</DialogTitle>
          <DialogDescription>
            Configuration plus read-only operational records. Raw cursor,
            profile-key, subscriber, payload, and error values never reach this
            browser; only their presence is reported.
          </DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(next) => setTab(inspectTab(next))}>
          <TabsList aria-label="Trigger definition details">
            <TabsTrigger value="definition">Definition</TabsTrigger>
            <TabsTrigger value="fires">Enqueue log</TabsTrigger>
            <TabsTrigger value="alerts">Alert config</TabsTrigger>
            <TabsTrigger value="dlq">Recovery</TabsTrigger>
          </TabsList>
          <TabsContent value="definition">
            {pending ? (
              <p role="status">Loading fresh definition…</p>
            ) : error ? (
              <div role="alert" className="space-y-2">
                <p>
                  {apiErrorMessage(
                    error,
                    "The definition could not be inspected",
                  )}
                </p>
                <Button variant="outline" onClick={retry}>
                  Retry
                </Button>
              </div>
            ) : draft ? (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">{draft.provider}</Badge>
                  <Badge
                    variant={draft.status === "active" ? "warning" : "outline"}
                  >
                    {draft.status === "active"
                      ? "active · blocked"
                      : draft.status}
                  </Badge>
                </div>
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">Name</dt>
                    <dd>{draft.name}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Updated</dt>
                    <dd>{formatDate(draft.updatedAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Connection reference
                    </dt>
                    <dd className="font-mono text-xs">
                      {draft.connectionId ?? "Not set"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Journey reference
                    </dt>
                    <dd className="font-mono text-xs">
                      {draft.journeyId ?? "Not set"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Cursor column
                    </dt>
                    <dd>{draft.cursorColumn}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Profile-key column
                    </dt>
                    <dd>{draft.profileKeyColumn}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Intended interval
                    </dt>
                    <dd>{draft.pollingIntervalSeconds} seconds</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Intended row bound
                    </dt>
                    <dd>{draft.maxRowsPerTick}</dd>
                  </div>
                </dl>
                <div>
                  <h3 className="text-sm font-medium">Read-only query</h3>
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">
                    {draft.query}
                  </pre>
                </div>
                <div>
                  <h3 className="text-sm font-medium">Provider config</h3>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">
                    {JSON.stringify(draft.config, null, 2)}
                  </pre>
                </div>
                <div
                  role="note"
                  className="flex gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm"
                >
                  <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <p>
                    {AUTOMATIONS_RUNTIME_UNAVAILABLE_REASON} Server status:{" "}
                    {draft.runtime.runtimeStatus}.
                  </p>
                </div>
              </div>
            ) : null}
          </TabsContent>
          <TabsContent value="fires">
            {triggerId ? (
              <TriggerFiresTab triggerId={triggerId} queryScope={queryScope} />
            ) : null}
          </TabsContent>
          <TabsContent value="alerts">
            {triggerId ? (
              <TriggerAlertsTab triggerId={triggerId} queryScope={queryScope} />
            ) : null}
          </TabsContent>
          <TabsContent value="dlq">
            {triggerId ? (
              <TriggerRecoveryTab
                triggerId={triggerId}
                queryScope={queryScope}
              />
            ) : null}
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ *
 * Read-only operational inspection tabs.
 *
 * Each tab is one read-scoped GET rendered as records, not as evidence: an
 * enqueue row is a stored hand-off, a threshold is a stored number, and a
 * recovery entry is a scaffold row. Poll-now, alert editing, and DLQ retry
 * are withheld behind the ZERO_COPY_* flags and are not rendered here.
 * ------------------------------------------------------------------ */

interface InspectionQuery<T> {
  data: T | undefined;
  isPending: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: () => unknown;
}

function InspectionFrame<T>({
  note,
  query,
  refreshLabel,
  unavailableTitle,
  children,
}: {
  note: ReactNode;
  query: InspectionQuery<T>;
  refreshLabel: string;
  unavailableTitle: string;
  children: (data: T) => ReactNode;
}) {
  // The server's own sentence — a 503 `alerts_disabled` / `dlq_disabled`
  // explains itself better than anything invented here.
  const message = query.error
    ? apiErrorMessage(query.error, unavailableTitle)
    : null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div role="note" className="max-w-xl text-sm text-muted-foreground">
          {note}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw aria-hidden className="size-4" />{" "}
          {query.isFetching ? "Refreshing…" : refreshLabel}
        </Button>
      </div>
      {query.data === undefined && query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading records…
        </p>
      ) : null}
      {query.data === undefined && message ? (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-destructive p-3 text-sm"
        >
          <p>
            <strong className="block">{unavailableTitle}</strong>
            {message}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {query.data !== undefined && message ? (
        <p
          role="status"
          className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm"
        >
          Showing the last loaded records. Refresh failed: {message}
        </p>
      ) : null}
      {query.data !== undefined ? children(query.data) : null}
    </div>
  );
}

function InspectionEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-lg border p-4 text-sm">
      <strong className="block">{title}</strong>
      <span className="text-muted-foreground">{detail}</span>
    </div>
  );
}

function presenceLabel(flags: ReadonlyArray<readonly [boolean, string]>) {
  const present = flags.filter(([flag]) => flag).map(([, label]) => label);
  return present.length > 0 ? present.join(", ") : "None reported";
}

function formatSeconds(total: number): string {
  if (!Number.isFinite(total) || total < 0) return "—";
  if (total === 0) return "0s";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  return [
    hours ? `${hours}h` : null,
    minutes ? `${minutes}m` : null,
    seconds ? `${seconds}s` : null,
  ]
    .filter((part) => part !== null)
    .join(" ");
}

function fireStatusVariant(
  status: string,
): "success" | "destructive" | "warning" | "outline" {
  const normalized = status.toLowerCase();
  if (["delivered", "ok", "success"].includes(normalized)) return "success";
  if (["failed", "error", "dead"].includes(normalized)) return "destructive";
  if (["pending", "queued", "retrying"].includes(normalized)) return "warning";
  return "outline";
}

function alertKindLabel(kind: ZeroCopyAlertKind | undefined): string {
  switch (kind) {
    case "failures":
      return "Consecutive failures";
    case "lag":
      return "Polling lag";
    case "fires_burst":
      return "Rows-per-poll burst";
    default:
      return "Not recorded";
  }
}

function dlqReasonLabel(reason: ZeroCopyDLQReason): string {
  switch (reason) {
    case "unresolved_subscriber":
      return "Subscriber unresolved";
    case "enqueue_failed":
      return "Enqueue failed";
    case "driver_partial_row":
      return "Incomplete warehouse row";
  }
}

function TriggerFiresTab({
  triggerId,
  queryScope,
}: {
  triggerId: string;
  queryScope: readonly unknown[];
}) {
  const fires = useQuery({
    queryKey: [...queryScope, "zero-copy-draft", triggerId, "fires"],
    queryFn: ({ signal }) => listZeroCopyFires(triggerId, signal),
  });
  return (
    <InspectionFrame
      note="The API returns the newest 100 enqueue records. “Fired” is a stored hand-off record; it does not confirm that a journey ran."
      query={fires}
      refreshLabel="Refresh enqueue log"
      unavailableTitle="Enqueue records are unavailable"
    >
      {(rows) =>
        rows.length === 0 ? (
          <InspectionEmpty
            title="No enqueue records returned"
            detail="This does not prove that polling ran or that no failures occurred."
          />
        ) : (
          <TableContainer aria-label="Trigger enqueue records">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Recorded</TableHead>
                  <TableHead>Stored status</TableHead>
                  <TableHead>Related data present</TableHead>
                  <TableHead>Outcome marker</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((fire) => (
                  <TableRow key={fire.id}>
                    <TableCell>{formatDate(fire.firedAt)}</TableCell>
                    <TableCell>
                      <Badge variant={fireStatusVariant(fire.status)}>
                        {fire.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {presenceLabel([
                        [fire.hasCursor, "cursor"],
                        [fire.hasProfileKey, "profile key"],
                        [fire.hasSubscriber, "subscriber"],
                        [fire.hasPayload, "payload"],
                        [fire.hasFlowRun, "flow run"],
                      ])}
                    </TableCell>
                    <TableCell>
                      {fire.errorCategory
                        ? "Execution error recorded · details hidden"
                        : "No error category reported"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )
      }
    </InspectionFrame>
  );
}

function TriggerAlertsTab({
  triggerId,
  queryScope,
}: {
  triggerId: string;
  queryScope: readonly unknown[];
}) {
  const noteId = useId();
  const alerts = useQuery({
    queryKey: [...queryScope, "zero-copy-draft", triggerId, "alerts"],
    queryFn: ({ signal }) => getZeroCopyAlerts(triggerId, signal),
  });
  return (
    <InspectionFrame
      note={
        <span id={noteId}>
          Effective defaults or stored thresholds can be inspected. Evaluator
          and notifier readiness is not qualified, so editing is release-held.
        </span>
      }
      query={alerts}
      refreshLabel="Refresh alert config"
      unavailableTitle="Alert configuration is unavailable"
    >
      {(config) => (
        <div className="space-y-3">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {(
              [
                [
                  "Failure threshold",
                  config.consecutiveFailuresThreshold.toLocaleString(),
                ],
                ["Lag threshold", formatSeconds(config.lagSecondsThreshold)],
                [
                  "Rows-per-poll threshold",
                  config.firesPerTickThreshold.toLocaleString(),
                ],
                ["Cooldown", formatSeconds(config.cooldownSeconds)],
                [
                  "Webhook destination",
                  config.webhookConfigured
                    ? "Configured (hidden)"
                    : "Not configured",
                ],
                [
                  "Last alert record",
                  config.lastAlertFiredAt
                    ? formatDate(config.lastAlertFiredAt)
                    : "Never",
                ],
                ["Last alert kind", alertKindLabel(config.lastAlertKind)],
                [
                  "Alert message",
                  config.hasLastAlertMessage
                    ? "Recorded (hidden)"
                    : "Not recorded",
                ],
                ["Server runtime status", config.runtime.runtimeStatus],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <Button
            variant="outline"
            disabled={!ZERO_COPY_ALERTING_AVAILABLE}
            aria-describedby={noteId}
          >
            Saving unavailable
          </Button>
        </div>
      )}
    </InspectionFrame>
  );
}

function TriggerRecoveryTab({
  triggerId,
  queryScope,
}: {
  triggerId: string;
  queryScope: readonly unknown[];
}) {
  const entries = useQuery({
    queryKey: [...queryScope, "zero-copy-draft", triggerId, "dlq"],
    queryFn: ({ signal }) => listZeroCopyDLQ(triggerId, signal),
  });
  return (
    <InspectionFrame
      note="Recovery is release-held. This endpoint is an inspection scaffold: it is not proven to capture every failed row, no retry control is offered, and only the newest 100 records are returned without a total or pagination signal."
      query={entries}
      refreshLabel="Refresh recovery records"
      unavailableTitle="Recovery records are unavailable"
    >
      {(rows) =>
        rows.length === 0 ? (
          <InspectionEmpty
            title="No recovery rows returned"
            detail="An empty response is not evidence that every row succeeded."
          />
        ) : (
          <TableContainer aria-label="Trigger recovery records">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Entry</TableHead>
                  <TableHead>Reason category</TableHead>
                  <TableHead>Stored status</TableHead>
                  <TableHead>Related data present</TableHead>
                  <TableHead>Retries</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="tabular-nums">#{entry.id}</TableCell>
                    <TableCell>
                      {dlqReasonLabel(entry.reason)}
                      {entry.lastErrorCategory
                        ? " · execution error recorded"
                        : ""}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{entry.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {presenceLabel([
                        [entry.hasCursor, "cursor"],
                        [entry.hasProfileKey, "profile key"],
                        [entry.hasPayload, "payload"],
                      ])}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {entry.retryCount.toLocaleString()}
                    </TableCell>
                    <TableCell>{formatDate(entry.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )
      }
    </InspectionFrame>
  );
}

interface EditorDraft {
  name: string;
  description: string;
  status: ZeroCopyEditableStatus;
  provider: ZeroCopyProvider;
  connectionId: string;
  journeyId: string;
  query: string;
  cursorColumn: string;
  profileKeyColumn: string;
  interval: string;
  rowLimit: string;
  config: string;
}

function editorDraft(state: EditorState): EditorDraft {
  if (state.mode === "create")
    return {
      name: "",
      description: "",
      status: "draft",
      provider: "snowflake",
      connectionId: "",
      journeyId: "",
      query: "",
      cursorColumn: "updated_at",
      profileKeyColumn: "email",
      interval: "300",
      rowLimit: "500",
      config: "{}",
    };
  const draft = state.draft;
  return {
    name: draft.name,
    description: draft.description,
    status:
      draft.status === "draft" || draft.status === "paused"
        ? draft.status
        : "paused",
    provider: draft.provider,
    connectionId: draft.connectionId ?? "",
    journeyId: draft.journeyId ?? "",
    query: draft.query,
    cursorColumn: draft.cursorColumn,
    profileKeyColumn: draft.profileKeyColumn,
    interval: String(draft.pollingIntervalSeconds),
    rowLimit: String(draft.maxRowsPerTick),
    config: JSON.stringify(draft.config, null, 2),
  };
}

function TriggerEditorDialog({
  state,
  onClose,
  onSave,
}: {
  state: EditorState;
  onClose: () => void;
  onSave: (input: ZeroCopyDraftInput) => Promise<void>;
}) {
  const id = useId();
  const initialDraft = useRef(editorDraft(state));
  const [draft, setDraft] = useState(() => initialDraft.current);
  const [validation, setValidation] = useState<{
    result: ZeroCopyValidation;
    fingerprint: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const savingRef = useRef(false);
  const validationAbort = useRef<AbortController | null>(null);
  useEffect(() => () => validationAbort.current?.abort(), []);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initialDraft.current);
  useUnsavedChangesGuard(dirty || saving);

  function requestClose() {
    if (saving) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  }

  function build(): ZeroCopyDraftInput {
    let config: unknown;
    try {
      config = JSON.parse(draft.config);
    } catch {
      throw new Error("Provider config must be valid JSON.");
    }
    return normalizeZeroCopyDraftInput({
      connection_id: draft.connectionId || undefined,
      journey_id: draft.journeyId || undefined,
      name: draft.name,
      description: draft.description,
      status: draft.status,
      provider: draft.provider,
      query: draft.query,
      cursor_column: draft.cursorColumn,
      profile_key_column: draft.profileKeyColumn,
      polling_interval_seconds: Number(draft.interval),
      max_rows_per_tick: Number(draft.rowLimit),
      config: parseTriggerConfig(config),
    });
  }
  function fingerprint(input: ZeroCopyDraftInput) {
    return JSON.stringify(input);
  }
  function change(next: Partial<EditorDraft>) {
    setDraft((current) => ({ ...current, ...next }));
    setValidation(null);
    setError(null);
    setValidating(false);
    validationAbort.current?.abort();
  }
  async function validate() {
    setError(null);
    let input: ZeroCopyDraftInput;
    try {
      input = build();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Review the draft fields"));
      return;
    }
    validationAbort.current?.abort();
    const controller = new AbortController();
    validationAbort.current = controller;
    setValidating(true);
    try {
      const result = await validateZeroCopyDraft(input, controller.signal);
      setValidation({ result, fingerprint: fingerprint(input) });
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(apiErrorMessage(cause, "Validation did not complete"));
    } finally {
      if (!controller.signal.aborted) setValidating(false);
    }
  }
  async function save() {
    if (savingRef.current) return;
    setError(null);
    let input: ZeroCopyDraftInput;
    try {
      input = build();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Review the draft fields"));
      return;
    }
    if (
      !validation?.result.valid ||
      validation.fingerprint !== fingerprint(input)
    ) {
      setError("Validate the current draft before saving.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await onSave(input);
    } catch (cause) {
      setError(apiErrorMessage(cause, "The trigger draft could not be saved"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  const legacy =
    state.mode === "edit" && !["draft", "paused"].includes(state.draft.status);
  return (
    <>
      <Dialog open onOpenChange={(open) => !open && requestClose()}>
        <DialogContent closeDisabled={saving} className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {state.mode === "create"
                ? "New warehouse trigger draft"
                : "Edit warehouse trigger draft"}
            </DialogTitle>
            <DialogDescription>
              Validation checks input shape and read-only SQL policy. It does
              not connect to or poll the warehouse.
            </DialogDescription>
          </DialogHeader>
          {legacy ? (
            <div
              role="note"
              className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm"
            >
              This legacy definition is stored as {state.draft.status}. Saving
              converts it to paused; activation is not offered.
            </div>
          ) : null}
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset
              disabled={saving}
              aria-label="Warehouse trigger draft fields"
              className="grid gap-3 sm:grid-cols-2"
            >
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor={`${id}-name`}>Name</Label>
                <Input
                  id={`${id}-name`}
                  maxLength={200}
                  required
                  value={draft.name}
                  onChange={(event) => change({ name: event.target.value })}
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor={`${id}-description`}>Description</Label>
                <Textarea
                  id={`${id}-description`}
                  maxLength={2000}
                  value={draft.description}
                  onChange={(event) =>
                    change({ description: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-provider`}>Provider</Label>
                <Select
                  id={`${id}-provider`}
                  value={draft.provider}
                  onChange={(event) =>
                    change({ provider: event.target.value as ZeroCopyProvider })
                  }
                >
                  <option value="snowflake">Snowflake</option>
                  <option value="bigquery">BigQuery</option>
                  <option value="redshift">Redshift</option>
                  <option value="postgres">Postgres</option>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-status`}>Stored inert status</Label>
                <Select
                  id={`${id}-status`}
                  value={draft.status}
                  onChange={(event) =>
                    change({
                      status: event.target.value as ZeroCopyEditableStatus,
                    })
                  }
                >
                  <option value="draft">Draft</option>
                  <option value="paused">Paused</option>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-connection`}>
                  Warehouse connection UUID (optional)
                </Label>
                <Input
                  id={`${id}-connection`}
                  maxLength={36}
                  spellCheck={false}
                  value={draft.connectionId}
                  onChange={(event) =>
                    change({ connectionId: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-journey`}>
                  Intended journey UUID (optional)
                </Label>
                <Input
                  id={`${id}-journey`}
                  maxLength={36}
                  spellCheck={false}
                  value={draft.journeyId}
                  onChange={(event) =>
                    change({ journeyId: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor={`${id}-query`}>
                  Read-only SELECT / CTE query
                </Label>
                <Textarea
                  id={`${id}-query`}
                  rows={8}
                  required
                  spellCheck={false}
                  value={draft.query}
                  onChange={(event) => change({ query: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-cursor`}>Cursor column</Label>
                <Input
                  id={`${id}-cursor`}
                  maxLength={128}
                  required
                  value={draft.cursorColumn}
                  onChange={(event) =>
                    change({ cursorColumn: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-profile`}>Profile-key column</Label>
                <Input
                  id={`${id}-profile`}
                  maxLength={128}
                  required
                  value={draft.profileKeyColumn}
                  onChange={(event) =>
                    change({ profileKeyColumn: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-interval`}>
                  Intended interval (15–86,400 seconds)
                </Label>
                <Input
                  id={`${id}-interval`}
                  type="number"
                  min={15}
                  max={86400}
                  step={1}
                  required
                  value={draft.interval}
                  onChange={(event) => change({ interval: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-rows`}>
                  Intended max rows (1–1,000)
                </Label>
                <Input
                  id={`${id}-rows`}
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  required
                  value={draft.rowLimit}
                  onChange={(event) => change({ rowLimit: event.target.value })}
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor={`${id}-config`}>Provider config JSON</Label>
                <Textarea
                  id={`${id}-config`}
                  rows={6}
                  spellCheck={false}
                  value={draft.config}
                  onChange={(event) => change({ config: event.target.value })}
                />
              </div>
            </fieldset>
            {error ? (
              <div
                role="alert"
                tabIndex={-1}
                className="rounded-md border border-destructive p-3 text-sm"
              >
                {error}
              </div>
            ) : null}
            {validation ? (
              <div
                role="status"
                className={`rounded-md border p-3 text-sm ${validation.result.valid ? "border-success/50" : "border-destructive"}`}
              >
                <strong>
                  {validation.result.valid
                    ? "Draft input is valid"
                    : "Draft input is invalid"}
                </strong>
                {validation.result.errors.length ? (
                  <ul className="mt-1 list-disc pl-5">
                    {validation.result.errors.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                ) : null}
                {validation.result.warnings.length ? (
                  <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                    {validation.result.warnings.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                ) : null}
                <p className="mt-2 text-xs text-muted-foreground">
                  This is configuration validation, not a live warehouse dry
                  run.
                </p>
              </div>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saving || validating}
                onClick={requestClose}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={saving || validating}
                onClick={() => void validate()}
              >
                {validating ? "Validating…" : "Validate draft"}
              </Button>
              <Button
                type="submit"
                disabled={saving || validating || !validation?.result.valid}
              >
                {saving ? "Saving…" : "Save inert draft"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard trigger draft changes?"
        description="Unsaved SQL, provider configuration, and trigger settings will be lost."
        confirmLabel="Discard trigger draft"
        onConfirm={async () => {
          setDiscardOpen(false);
          onClose();
        }}
      />
    </>
  );
}
