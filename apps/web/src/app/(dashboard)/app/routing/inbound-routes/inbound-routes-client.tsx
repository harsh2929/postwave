// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CopyPlus,
  Eye,
  GripVertical,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { PageShell } from "@/components/dashboard/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  clearInboundRouteSecretVault,
  createInboundRouteStrict,
  deleteInboundRouteStrict,
  duplicateInboundRouteDraft,
  inboundRouteConfigurationEqual,
  inboundRouteEnabledDraft,
  inboundRouteMatchesDraft,
  inboundRouteWriteFingerprint,
  listInboundRoutesStrict,
  newInboundRouteOperationKey,
  reorderInboundRoutesStrict,
  updateInboundRouteStrict,
  type InboundRoute,
  type InboundRouteDraft,
} from "@/lib/inbound-routes-admin-api";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { cn } from "@/lib/utils";
import { InboundEndpointPanel } from "./inbound-endpoint-panel";
import {
  InboundRouteEditor,
  type InboundRouteEditorState,
} from "./inbound-route-editor";
import { verifyFreshInboundRouteAdmin } from "./inbound-route-authority";
import { InboundRouteMatchHistory } from "./inbound-route-match-history";
import { InboundRoutePreviewPanel } from "./inbound-route-preview";

type StatusFilter = "all" | "enabled" | "disabled";

function formatDate(value?: string) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function findRoute(rows: InboundRoute[], id: string): InboundRoute {
  const route = rows.find((candidate) => candidate.id === id);
  if (!route)
    throw new Error("The route no longer exists in the fresh catalogue.");
  return route;
}

function sameOrder(left: InboundRoute[], right: InboundRoute[]): boolean {
  return (
    left.length === right.length &&
    left.every((route, index) => route.id === right[index]?.id)
  );
}

export function InboundRoutesClient() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["whoami"], queryFn: whoami });
  const identity = me.data;
  const role = identity ? effectiveAuthRole(identity) : "pending";
  const canAdmin = Boolean(
    identity && !identity.viewer_mode && ["owner", "admin"].includes(role),
  );
  const queryScope = useMemo(
    () =>
      [
        "inbound-route-control-plane",
        identity?.tenant_id ?? "pending",
        identity?.user_id ?? "pending",
        role,
        Boolean(identity?.viewer_mode),
      ] as const,
    [identity?.tenant_id, identity?.user_id, identity?.viewer_mode, role],
  );
  const routesKey = [...queryScope, "catalogue"] as const;
  const routes = useQuery({
    queryKey: routesKey,
    queryFn: ({ signal }) =>
      listInboundRoutesStrict({ tenantId: identity!.tenant_id, signal }),
    enabled: canAdmin,
    retry: false,
  });
  const routeRows = Array.isArray(routes.data) ? routes.data : [];
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [editor, setEditor] = useState<InboundRouteEditorState | null>(null);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<InboundRoute | null>(null);
  const [duplicateTarget, setDuplicateTarget] = useState<InboundRoute | null>(
    null,
  );
  const [operationNotice, setOperationNotice] = useState<string | null>(null);
  const [mutationActive, setMutationActive] = useState(false);
  const [verbError, setVerbError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    before: boolean;
  } | null>(null);
  const activeRef = useRef(false);
  const attemptsRef = useRef(
    new Map<string, { fingerprint: string; key: string }>(),
  );
  useUnsavedChangesGuard(mutationActive && !editor);

  const detail = useQuery({
    queryKey: [...queryScope, "fresh-detail", inspectId ?? "none"],
    queryFn: async ({ signal }) =>
      findRoute(
        await listInboundRoutesStrict({
          tenantId: identity!.tenant_id,
          signal,
        }),
        inspectId!,
      ),
    enabled: canAdmin && Boolean(inspectId),
    retry: false,
  });

  useEffect(
    () => () => {
      if (identity?.tenant_id) clearInboundRouteSecretVault(identity.tenant_id);
    },
    [identity?.tenant_id],
  );

  function operationKey(scope: string, fingerprint: string): string {
    const current = attemptsRef.current.get(scope);
    if (current?.fingerprint === fingerprint) return current.key;
    const next = {
      fingerprint,
      key: newInboundRouteOperationKey(scope),
    };
    attemptsRef.current.set(scope, next);
    return next.key;
  }

  async function loadFresh(signal?: AbortSignal): Promise<InboundRoute[]> {
    if (!identity) throw new Error("Workspace identity is unavailable.");
    return listInboundRoutesStrict({ tenantId: identity.tenant_id, signal });
  }

  function publishVerified(rows: InboundRoute[]) {
    qc.setQueryData(routesKey, rows);
    setOperationNotice(null);
    setVerbError(null);
  }

  function committedButUnverified(message: string) {
    qc.removeQueries({ queryKey: routesKey, exact: true });
    setOperationNotice(message);
    toast.warning(message);
  }

  async function saveRoute(draft: InboundRouteDraft) {
    if (!identity) throw new Error("Workspace identity is unavailable.");
    if (activeRef.current)
      throw new Error("Another inbound-route mutation is still running.");
    activeRef.current = true;
    setMutationActive(true);
    const controller = new AbortController();
    let committed = false;
    try {
      await verifyFreshInboundRouteAdmin(identity, controller.signal);
      let baseline: InboundRoute | undefined;
      if (editor?.mode === "edit") {
        const freshRoutes = await loadFresh(controller.signal);
        baseline = findRoute(freshRoutes, editor.route.id);
        if (!inboundRouteConfigurationEqual(baseline, editor.route)) {
          if (inboundRouteMatchesDraft(baseline, draft)) {
            const scope = `inbound-route-update-${editor.route.id}`;
            attemptsRef.current.delete(scope);
            setEditor(null);
            publishVerified(freshRoutes);
            toast.success("Inbound route update confirmed by fresh readback");
            return;
          }
          throw new Error(
            "This route changed on the server. Nothing was written; close the editor and review the fresh definition.",
          );
        }
      }
      controller.signal.throwIfAborted();
      const routeId = editor?.mode === "edit" ? editor.route.id : undefined;
      const fingerprint = await inboundRouteWriteFingerprint({
        tenantId: identity.tenant_id,
        ...(routeId ? { routeId } : {}),
        ...(baseline ? { expectedUpdatedAt: baseline.updatedAt } : {}),
        draft,
      });
      const scope = routeId
        ? `inbound-route-update-${routeId}`
        : "inbound-route-create";
      const idempotencyKey = operationKey(scope, fingerprint);
      let writtenId: string;
      if (routeId) {
        await updateInboundRouteStrict({
          tenantId: identity.tenant_id,
          routeId,
          expectedUpdatedAt: baseline!.updatedAt,
          draft,
          idempotencyKey,
        });
        writtenId = routeId;
      } else {
        writtenId = await createInboundRouteStrict({
          tenantId: identity.tenant_id,
          draft,
          idempotencyKey,
        });
      }
      committed = true;
      attemptsRef.current.delete(scope);
      try {
        const fresh = await loadFresh();
        const receipt = findRoute(fresh, writtenId);
        if (!inboundRouteMatchesDraft(receipt, draft))
          throw new Error(
            "The stored route did not match the requested definition.",
          );
        publishVerified(fresh);
        toast.success(
          routeId ? "Inbound route updated" : "Inbound route created",
        );
      } catch {
        committedButUnverified(
          `${routeId ? "The route update" : "The route creation"} committed, but its fresh representation could not be verified. Refresh the catalogue; do not submit the mutation again.`,
        );
      }
    } catch (cause) {
      if (committed) return;
      throw new Error(
        `${apiErrorMessage(cause, "The route request did not complete")} The outcome was not assumed; retrying the unchanged draft reuses its operation identity.`,
      );
    } finally {
      controller.abort();
      activeRef.current = false;
      setMutationActive(false);
    }
  }

  async function duplicateRoute() {
    if (!identity || !duplicateTarget) return;
    if (activeRef.current)
      throw new Error("Another inbound-route mutation is still running.");
    activeRef.current = true;
    setMutationActive(true);
    const target = duplicateTarget;
    const controller = new AbortController();
    let committed = false;
    try {
      await verifyFreshInboundRouteAdmin(identity, controller.signal);
      const current = findRoute(await loadFresh(controller.signal), target.id);
      if (!inboundRouteConfigurationEqual(current, target))
        throw new Error(
          "This route changed on the server. Nothing was duplicated; inspect the fresh definition.",
        );
      const draft = duplicateInboundRouteDraft(current);
      const fingerprint = await inboundRouteWriteFingerprint({
        tenantId: identity.tenant_id,
        draft,
      });
      const scope = `inbound-route-duplicate-${target.id}`;
      const createdId = await createInboundRouteStrict({
        tenantId: identity.tenant_id,
        draft,
        idempotencyKey: operationKey(scope, fingerprint),
      });
      committed = true;
      attemptsRef.current.delete(scope);
      setDuplicateTarget(null);
      try {
        const fresh = await loadFresh();
        const receipt = findRoute(fresh, createdId);
        if (!inboundRouteMatchesDraft(receipt, draft) || receipt.enabled)
          throw new Error(
            "The duplicate receipt was not a disabled exact copy.",
          );
        publishVerified(fresh);
        toast.success(
          "Disabled route copy created without stored HMAC secrets",
        );
      } catch {
        committedButUnverified(
          "The disabled copy committed, but its fresh representation could not be verified. Refresh the catalogue; do not duplicate it again.",
        );
      }
    } catch (cause) {
      if (committed) return;
      throw new Error(
        `${apiErrorMessage(cause, "The route could not be duplicated")} The unchanged retry reuses its operation identity.`,
      );
    } finally {
      controller.abort();
      activeRef.current = false;
      setMutationActive(false);
    }
  }

  async function deleteRoute() {
    if (!identity || !deleteTarget) return;
    if (activeRef.current)
      throw new Error("Another inbound-route mutation is still running.");
    activeRef.current = true;
    setMutationActive(true);
    const target = deleteTarget;
    const controller = new AbortController();
    let committed = false;
    try {
      await verifyFreshInboundRouteAdmin(identity, controller.signal);
      const freshRoutes = await loadFresh(controller.signal);
      const current = freshRoutes.find((route) => route.id === target.id);
      const scope = `inbound-route-delete-${target.id}`;
      if (!current) {
        attemptsRef.current.delete(scope);
        clearInboundRouteSecretVault(identity.tenant_id, target.id);
        setDeleteTarget(null);
        if (inspectId === target.id) setInspectId(null);
        publishVerified(freshRoutes);
        toast.success("Inbound route deletion confirmed by fresh readback");
        return;
      }
      if (!inboundRouteConfigurationEqual(current, target))
        throw new Error(
          "This route changed on the server. Nothing was deleted; inspect the fresh definition.",
        );
      const fingerprint = JSON.stringify([current.id, current.updatedAt]);
      await deleteInboundRouteStrict({
        routeId: target.id,
        idempotencyKey: operationKey(scope, fingerprint),
      });
      committed = true;
      attemptsRef.current.delete(scope);
      clearInboundRouteSecretVault(identity.tenant_id, target.id);
      setDeleteTarget(null);
      if (inspectId === target.id) setInspectId(null);
      try {
        const fresh = await loadFresh();
        if (fresh.some((route) => route.id === target.id))
          throw new Error("The deleted route remained in the catalogue.");
        publishVerified(fresh);
        toast.success("Inbound route deleted");
      } catch {
        committedButUnverified(
          "The delete committed, but absence could not be verified with a fresh catalogue. Refresh; do not repeat the delete.",
        );
      }
    } catch (cause) {
      if (committed) return;
      throw new Error(
        `${apiErrorMessage(cause, "The route could not be deleted")} The outcome was not assumed; retrying reuses the same operation identity.`,
      );
    } finally {
      controller.abort();
      activeRef.current = false;
      setMutationActive(false);
    }
  }

  async function toggleRoute(target: InboundRoute) {
    if (!identity) return;
    if (activeRef.current) {
      setVerbError("Another inbound-route mutation is still running.");
      return;
    }
    activeRef.current = true;
    setMutationActive(true);
    const nextEnabled = !target.enabled;
    const verb = nextEnabled ? "enable" : "disable";
    const controller = new AbortController();
    let committed = false;
    try {
      await verifyFreshInboundRouteAdmin(identity, controller.signal);
      const current = findRoute(await loadFresh(controller.signal), target.id);
      if (!inboundRouteConfigurationEqual(current, target))
        throw new Error(
          "This route changed on the server. Nothing was written; refresh and review the fresh definition before switching it.",
        );
      // The mounted PATCH is not a safe partial update (see
      // inboundRouteEnabledDraft), so the switch re-sends the reviewed
      // definition under the fresh configuration revision.
      const draft = inboundRouteEnabledDraft(current, nextEnabled);
      const fingerprint = await inboundRouteWriteFingerprint({
        tenantId: identity.tenant_id,
        routeId: current.id,
        expectedUpdatedAt: current.updatedAt,
        draft,
      });
      const scope = `inbound-route-toggle-${current.id}`;
      await updateInboundRouteStrict({
        tenantId: identity.tenant_id,
        routeId: current.id,
        expectedUpdatedAt: current.updatedAt,
        draft,
        idempotencyKey: operationKey(scope, fingerprint),
      });
      committed = true;
      attemptsRef.current.delete(scope);
      try {
        const fresh = await loadFresh();
        const receipt = findRoute(fresh, current.id);
        if (
          receipt.enabled !== nextEnabled ||
          !inboundRouteMatchesDraft(receipt, draft)
        )
          throw new Error(
            "The stored route did not reflect the requested switch.",
          );
        publishVerified(fresh);
        toast.success(
          nextEnabled ? "Inbound route enabled" : "Inbound route disabled",
        );
      } catch {
        committedButUnverified(
          `The route ${verb} committed, but its fresh representation could not be verified. Refresh the catalogue; do not switch it again.`,
        );
      }
    } catch (cause) {
      if (committed) return;
      const message = `${apiErrorMessage(cause, `The route could not be ${verb}d`)} The outcome was not assumed; retrying the same switch reuses its operation identity.`;
      setVerbError(message);
      toast.error(message);
    } finally {
      controller.abort();
      activeRef.current = false;
      setMutationActive(false);
    }
  }

  async function persistOrder(next: InboundRoute[], reviewed: InboundRoute[]) {
    if (!identity) return;
    if (activeRef.current) {
      setVerbError("Another inbound-route mutation is still running.");
      return;
    }
    activeRef.current = true;
    setMutationActive(true);
    const controller = new AbortController();
    let committed = false;
    const routeIds = next.map((route) => route.id);
    try {
      await verifyFreshInboundRouteAdmin(identity, controller.signal);
      const fresh = await loadFresh(controller.signal);
      if (!sameOrder(fresh, reviewed))
        throw new Error(
          "The route order changed on the server. Nothing was reordered; review the fresh catalogue before moving routes.",
        );
      const scope = "inbound-route-reorder";
      await reorderInboundRoutesStrict({
        routeIds,
        idempotencyKey: operationKey(scope, JSON.stringify(routeIds)),
      });
      committed = true;
      attemptsRef.current.delete(scope);
      try {
        const readback = await loadFresh();
        if (!sameOrder(readback, next))
          throw new Error(
            "The stored order did not match the requested order.",
          );
        publishVerified(readback);
        toast.success("Inbound route order updated");
      } catch {
        committedButUnverified(
          "The reorder committed, but the fresh evaluation order could not be verified. Refresh the catalogue; do not repeat the move.",
        );
      }
    } catch (cause) {
      if (committed) return;
      const message = `${apiErrorMessage(cause, "The routes could not be reordered")} The outcome was not assumed; retrying the same move reuses its operation identity.`;
      setVerbError(message);
      toast.error(message);
    } finally {
      controller.abort();
      activeRef.current = false;
      setMutationActive(false);
    }
  }

  function moveRoute(route: InboundRoute, direction: -1 | 1): Promise<void> {
    const index = routeRows.findIndex((candidate) => candidate.id === route.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= routeRows.length)
      return Promise.resolve();
    const next = [...routeRows];
    [next[index], next[target]] = [next[target]!, next[index]!];
    return persistOrder(next, routeRows);
  }

  function dropRoute(
    sourceId: string,
    targetId: string,
    placeBefore: boolean,
  ): Promise<void> {
    if (sourceId === targetId) return Promise.resolve();
    const source = routeRows.find((candidate) => candidate.id === sourceId);
    const withoutSource = routeRows.filter(
      (candidate) => candidate.id !== sourceId,
    );
    const targetIndex = withoutSource.findIndex(
      (candidate) => candidate.id === targetId,
    );
    if (!source || targetIndex < 0) return Promise.resolve();
    const insertAt = placeBefore ? targetIndex : targetIndex + 1;
    return persistOrder(
      [
        ...withoutSource.slice(0, insertAt),
        source,
        ...withoutSource.slice(insertAt),
      ],
      routeRows,
    );
  }

  if (me.isPending)
    return (
      <PageShell>
        <p role="status">Loading inbound-route authority…</p>
      </PageShell>
    );
  if (me.isError || !identity)
    return (
      <PageShell>
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-destructive p-4"
        >
          <p>
            {apiErrorMessage(
              me.error,
              "Workspace authority could not be loaded",
            )}
          </p>
          <Button variant="outline" onClick={() => void me.refetch()}>
            <RefreshCw aria-hidden className="size-4" /> Retry
          </Button>
        </div>
      </PageShell>
    );

  if (!canAdmin)
    return (
      <PageShell>
        <Button asChild variant="ghost" className="w-fit">
          <Link href="/app/routing">
            <ArrowLeft aria-hidden className="size-4" /> Back to routing
          </Link>
        </Button>
        <div role="note" className="rounded-lg border p-5">
          <h1 className="text-xl font-semibold">Inbound routes</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Administrator access is required. Route actions, endpoint metadata,
            and signing configuration were not requested or placed in this
            browser cache.
          </p>
        </div>
      </PageShell>
    );

  const visible = routeRows.filter((route) => {
    if (status === "enabled" && !route.enabled) return false;
    if (status === "disabled" && route.enabled) return false;
    const needle = search.trim().toLowerCase();
    return (
      !needle ||
      route.name.toLowerCase().includes(needle) ||
      route.matchRecipient.toLowerCase().includes(needle) ||
      route.matchFromDomain.toLowerCase().includes(needle)
    );
  });
  const filterActive = search.trim().length > 0 || status !== "all";
  const reorderReason = mutationActive
    ? "Wait for the running inbound-route mutation to finish."
    : filterActive
      ? "Clear the search and state filter to reorder; moves apply to the complete evaluation order."
      : routeRows.length < 2
        ? "Reordering needs at least two routes."
        : null;
  const canReorder = reorderReason === null;

  return (
    <PageShell className="max-w-7xl">
      <header className="space-y-3">
        <Button asChild variant="ghost" className="w-fit">
          <Link href="/app/routing">
            <ArrowLeft aria-hidden className="size-4" /> Back to routing
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">
              Inbound route control plane
            </h1>
            <p className="text-sm text-muted-foreground">
              Administer the signed endpoint, ordered matcher definitions, and
              pure dry-run preview backed by the mounted inbound-email service.
            </p>
          </div>
          <Button onClick={() => setEditor({ mode: "create" })}>
            <Plus aria-hidden className="size-4" /> New disabled route
          </Button>
        </div>
      </header>

      <div
        role="note"
        className="flex gap-2 rounded-lg border bg-muted/30 p-4 text-sm"
      >
        <ShieldCheck aria-hidden className="mt-0.5 size-5 shrink-0" />
        <p>
          Every mutation rechecks the exact user, workspace, effective role, and
          viewer mode. Update, duplicate, and delete also compare a fresh
          catalogue configuration with the record you reviewed (runtime counters
          are excluded). Action replacements and clears also carry the exact
          configuration revision into a locked server write, so a simultaneous
          reorder or edit fails closed instead of preserving signing material by
          a stale index.
        </p>
      </div>

      {operationNotice ? (
        <div
          role="alert"
          className="rounded-lg border border-warning/50 bg-warning/10 p-4 text-sm"
        >
          {operationNotice}
        </div>
      ) : null}

      <InboundEndpointPanel me={identity} queryScope={queryScope} />

      <section
        aria-labelledby="inbound-routes-heading"
        className="space-y-4 rounded-lg border p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="inbound-routes-heading" className="text-lg font-semibold">
              Route catalogue
            </h2>
            <p className="text-sm text-muted-foreground">
              The backend exposes one complete ordered catalogue, not a
              singleton detail or paged list. Web refuses responses over 500
              rows.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={routes.isFetching}
            onClick={() => void routes.refetch()}
          >
            <RefreshCw aria-hidden className="size-4" />
            {routes.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-[minmax(14rem,1fr)_12rem]">
          <Input
            aria-label="Search inbound routes"
            placeholder="Search name, recipient, or sender domain"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            aria-label="Filter inbound routes by enabled state"
            value={status}
            onChange={(event) => setStatus(event.target.value as StatusFilter)}
          >
            <option value="all">All states</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </Select>
        </div>

        {verbError ? (
          <div
            role="alert"
            className="rounded-md border border-destructive p-3 text-sm"
          >
            {verbError}
          </div>
        ) : null}
        {filterActive && routeRows.length > 1 ? (
          <p role="note" className="text-xs text-muted-foreground">
            {reorderReason}
          </p>
        ) : null}

        {routes.isPending ? (
          <p role="status" className="py-8 text-sm text-muted-foreground">
            Loading the verified route catalogue…
          </p>
        ) : routes.isError ? (
          <div
            role="alert"
            className="space-y-3 rounded-md border border-destructive p-4"
          >
            <p>
              {apiErrorMessage(
                routes.error,
                "Inbound routes could not be loaded",
              )}
            </p>
            <Button variant="outline" onClick={() => void routes.refetch()}>
              Retry
            </Button>
          </div>
        ) : (routes.data?.length ?? 0) === 0 ? (
          <div className="rounded-md border p-6 text-center">
            <p className="text-sm text-muted-foreground">
              The verified catalogue contains no inbound routes.
            </p>
            <Button
              className="mt-3"
              onClick={() => setEditor({ mode: "create" })}
            >
              Create a disabled route
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <p className="rounded-md border p-5 text-center text-sm text-muted-foreground">
            No verified routes match the current local filters.
          </p>
        ) : (
          <TableContainer aria-label="Inbound route catalogue">
            <Table>
              <caption className="sr-only">
                Inbound routes in server evaluation order
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Matcher</TableHead>
                  <TableHead>Actions</TableHead>
                  <TableHead>Runtime summary</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((route) => {
                  const label = route.name || "route";
                  const position = routeRows.indexOf(route);
                  const first = position <= 0;
                  const last = position >= routeRows.length - 1;
                  const indicator =
                    dropTarget?.id === route.id ? dropTarget.before : null;
                  return (
                  <TableRow
                    key={route.id}
                    className={cn(
                      dragId === route.id && "opacity-50",
                      indicator === true && "border-t-2 border-t-primary",
                      indicator === false && "border-b-2 border-b-primary",
                    )}
                    onDragOver={(event) => {
                      if (!canReorder || !dragId || dragId === route.id)
                        return;
                      event.preventDefault();
                      const bounds =
                        event.currentTarget.getBoundingClientRect();
                      setDropTarget({
                        id: route.id,
                        before:
                          event.clientY - bounds.top < bounds.height / 2,
                      });
                    }}
                    onDrop={(event) => {
                      if (!canReorder || !dragId) return;
                      event.preventDefault();
                      const target = dropTarget;
                      setDragId(null);
                      setDropTarget(null);
                      if (target && dragId !== target.id)
                        void dropRoute(dragId, target.id, target.before);
                    }}
                  >
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <span
                          aria-hidden
                          draggable={canReorder}
                          className={cn(
                            "text-muted-foreground",
                            canReorder ? "cursor-grab" : "opacity-40",
                          )}
                          onDragStart={(event) => {
                            if (!canReorder) {
                              event.preventDefault();
                              return;
                            }
                            if (event.dataTransfer) {
                              event.dataTransfer.setData(
                                "text/plain",
                                route.id,
                              );
                              event.dataTransfer.effectAllowed = "move";
                            }
                            setDragId(route.id);
                          }}
                          onDragEnd={() => {
                            setDragId(null);
                            setDropTarget(null);
                          }}
                        >
                          <GripVertical className="size-4" />
                        </span>
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={!canReorder || first}
                          aria-label={`Move ${label} earlier`}
                          title={
                            reorderReason ??
                            (first
                              ? `${label} is already first.`
                              : "Move earlier in evaluation order")
                          }
                          onClick={() => void moveRoute(route, -1)}
                        >
                          <ArrowUp aria-hidden className="size-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={!canReorder || last}
                          aria-label={`Move ${label} later`}
                          title={
                            reorderReason ??
                            (last
                              ? `${label} is already last.`
                              : "Move later in evaluation order")
                          }
                          onClick={() => void moveRoute(route, 1)}
                        >
                          <ArrowDown aria-hidden className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">
                        {route.name || "Untitled route"}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Checkbox
                          role="switch"
                          checked={route.enabled}
                          disabled={mutationActive}
                          aria-label={
                            route.enabled
                              ? `Disable ${label}`
                              : `Enable ${label}`
                          }
                          onChange={() => void toggleRoute(route)}
                        />
                        <Badge
                          variant={route.enabled ? "outline" : "secondary"}
                        >
                          {route.enabled ? "enabled" : "disabled"}
                        </Badge>
                        <span>Priority {route.priority}</span>
                        {route.stopOnMatch ? (
                          <span>· stops on match</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-64 text-xs">
                      <div className="break-all font-mono">
                        {route.matchRecipient}
                      </div>
                      {route.matchSubjectPrefix ? (
                        <div>Subject: {route.matchSubjectPrefix}</div>
                      ) : null}
                      {route.matchFromDomain ? (
                        <div>From: {route.matchFromDomain}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">
                      {route.actions.length === 0
                        ? "None · storage only"
                        : route.actions
                            .map((action) => action.kind)
                            .join(" → ")}
                    </TableCell>
                    <TableCell className="text-xs">
                      <div>{route.matchCount.toLocaleString()} matches</div>
                      <div className="text-muted-foreground">
                        Last: {formatDate(route.lastMatchedAt)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Inspect ${route.name || "route"}`}
                          onClick={() => setInspectId(route.id)}
                        >
                          <Eye aria-hidden className="size-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Edit ${route.name || "route"}`}
                          onClick={() => setEditor({ mode: "edit", route })}
                        >
                          <Pencil aria-hidden className="size-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Duplicate ${route.name || "route"}`}
                          onClick={() => setDuplicateTarget(route)}
                        >
                          <CopyPlus aria-hidden className="size-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Delete ${route.name || "route"}`}
                          onClick={() => setDeleteTarget(route)}
                        >
                          <Trash2 aria-hidden className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </section>

      <InboundRoutePreviewPanel me={identity} />

      <RouteDetailDialog
        open={Boolean(inspectId)}
        route={detail.data}
        pending={detail.isPending}
        error={detail.error}
        queryScope={queryScope}
        onRetry={() => void detail.refetch()}
        onClose={() => setInspectId(null)}
      />
      {editor ? (
        <InboundRouteEditor
          aria-label={
            editor.mode === "create"
              ? "Create inbound route configuration"
              : `Edit ${editor.route.name || "inbound route"} configuration`
          }
          state={editor}
          onClose={() => setEditor(null)}
          onSave={saveRoute}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(duplicateTarget)}
        onOpenChange={(open) => !open && setDuplicateTarget(null)}
        title="Create a disabled route copy?"
        description="The copy preserves matchers and ordered actions, starts disabled, and deliberately omits every stored webhook HMAC secret."
        confirmLabel="Create disabled copy"
        confirmVariant="default"
        onConfirm={duplicateRoute}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete inbound route?"
        description="This permanently removes the rule. Future inbound mail will continue to later rules or fall through without these actions. Type the exact route name to continue."
        confirmationToken={
          deleteTarget?.name || `route ${deleteTarget?.id?.slice(0, 8)}`
        }
        confirmLabel="Delete route"
        onConfirm={deleteRoute}
      />
    </PageShell>
  );
}

function RouteDetailDialog({
  open,
  route,
  pending,
  error,
  queryScope,
  onRetry,
  onClose,
}: {
  open: boolean;
  route?: InboundRoute;
  pending: boolean;
  error: unknown;
  queryScope: readonly unknown[];
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Fresh route detail</DialogTitle>
          <DialogDescription>
            The backend has no singleton route GET, so this detail is selected
            from a fresh full-catalogue response. Stored HMAC plaintext is never
            rendered.
          </DialogDescription>
        </DialogHeader>
        {pending ? (
          <p role="status">Loading a fresh catalogue…</p>
        ) : error ? (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-destructive p-3"
          >
            <p>
              {apiErrorMessage(error, "Fresh route detail could not be loaded")}
            </p>
            <Button variant="outline" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : route ? (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge variant={route.enabled ? "outline" : "secondary"}>
                {route.enabled ? "enabled" : "disabled"}
              </Badge>
              <Badge variant="outline">Priority {route.priority}</Badge>
              <Badge variant="outline">
                {route.stopOnMatch ? "stops on match" : "continues evaluation"}
              </Badge>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Name</dt>
                <dd>{route.name || "Untitled route"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Recipient glob
                </dt>
                <dd className="break-all font-mono text-xs">
                  {route.matchRecipient}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Subject prefix
                </dt>
                <dd>{route.matchSubjectPrefix || "Any"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Sender domain</dt>
                <dd>{route.matchFromDomain || "Any"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Retry policy</dt>
                <dd>
                  {route.actionRetryMax} extra attempts ·{" "}
                  {route.actionRetryBackoffSeconds}s base
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Runtime summary
                </dt>
                <dd>
                  {route.matchCount.toLocaleString()} matches · last{" "}
                  {formatDate(route.lastMatchedAt)}
                </dd>
              </div>
            </dl>
            <div>
              <h3 className="font-medium">Ordered actions</h3>
              {route.actions.length === 0 ? (
                <p className="mt-1 text-muted-foreground">
                  No actions; matching mail is only stored.
                </p>
              ) : (
                <ol className="mt-2 space-y-2">
                  {route.actions.map((action, index) => (
                    <li
                      key={`${action.sourceIndex}-${action.kind}`}
                      className="rounded-md border p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <strong>
                          {index + 1}. {action.kind}
                        </strong>
                        {action.hasStoredHmacSecret ? (
                          <Badge variant="secondary">
                            HMAC configured · value withheld
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 break-all text-xs text-muted-foreground">
                        {action.tag ??
                          action.eventType ??
                          action.url ??
                          action.to ??
                          "No additional field"}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <InboundRouteMatchHistory
              routeId={route.id}
              queryScope={queryScope}
            />
          </div>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
