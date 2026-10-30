// SPDX-License-Identifier: AGPL-3.0-only
//
// Flows index: searchable / filterable / sortable list of the tenant's
// automation flows (FLOW-001), with per-card actions (FLOW-006), enriched cards
// (FLOW-022), pinning (FLOW-046), a starter gallery on create (FLOW-032/036),
// keyset pagination drained in full (FLOW-021), a Retry affordance (FLOW-011),
// and semantic status colours (FLOW-014).
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GitBranch, Search, SlidersHorizontal, X } from "lucide-react";
import { toast } from "sonner";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiErrorMessage } from "@/lib/api";
import {
  type Flow,
  type FlowInput,
  flowsApi,
  flowWebUrl,
} from "@/lib/flows-api";
import {
  FLOW_SORT_KEYS,
  FLOW_STATUS_FILTERS,
  type FlowSortKey,
  type FlowStatusFilter,
  countFlowStatuses,
  filterSortFlows,
} from "@/lib/flow-list";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  canWriteFlows,
  FLOW_READ_ONLY_MESSAGE,
  verifyFreshFlowWriteAuthority,
} from "@/lib/flow-write-authority";
import { flowKeys, qk, STALE } from "@/lib/query-keys";
import { copyToClipboard } from "@/lib/clipboard";
import { usePinnedFlows } from "@/lib/use-pinned-flows";
import { useFlowTags } from "@/lib/use-flow-tags";
import { enumParam, stringParam } from "@/lib/table-url-state";
import { useTableUrlState } from "@/lib/use-table-url-state";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

import { FlowCardSkeletonGrid } from "./_components/flow-card-skeleton";
import { FlowCreateDialog } from "./_components/flow-create-dialog";
import { FlowListCard } from "./_components/flow-list-card";

const listSchema = {
  q: stringParam(""),
  status: enumParam(FLOW_STATUS_FILTERS, "all"),
  sort: enumParam(FLOW_SORT_KEYS, "updated"),
  order: enumParam(["asc", "desc"] as const, "desc"),
  tag: stringParam(""),
} as const;

export default function FlowsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { state, setState, reset } = useTableUrlState(listSchema);
  const { q, status, sort, order, tag } = state;

  const meQuery = useQuery({ queryKey: qk.authMe(), queryFn: whoami });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const canWrite = canWriteFlows(meQuery.data);
  const writeDisabledReason = meQuery.isLoading
    ? "Checking flow write access…"
    : FLOW_READ_ONLY_MESSAGE;

  const flowsKey = useMemo(
    () => flowKeys.list(tenantId, role),
    [tenantId, role],
  );
  const flowsQuery = useQuery({
    queryKey: flowsKey,
    queryFn: () => flowsApi.listAll(),
    staleTime: STALE.list,
  });
  const catalogQuery = useQuery({
    queryKey: flowKeys.catalog(),
    queryFn: () => flowsApi.catalog(),
    staleTime: STALE.reference,
  });

  const { isPinned, toggle } = usePinnedFlows(tenantId);
  const { tagsFor, setTags, allTags } = useFlowTags(tenantId);

  // Local search input, debounced into the URL state so filtering doesn't
  // router.replace on every keystroke.
  const [searchInput, setSearchInput] = useState(q);
  useEffect(() => setSearchInput(q), [q]);
  useEffect(() => {
    if (searchInput === q) return;
    const t = setTimeout(() => setState({ q: searchInput }), 250);
    return () => clearTimeout(t);
  }, [searchInput, q, setState]);

  const flows = useMemo(
    () => (Array.isArray(flowsQuery.data) ? flowsQuery.data : []),
    [flowsQuery.data],
  );
  const triggerCatalog = Array.isArray(catalogQuery.data?.triggers)
    ? catalogQuery.data?.triggers
    : [];
  const counts = useMemo(() => countFlowStatuses(flows), [flows]);

  const visible = useMemo(() => {
    const base = filterSortFlows(flows, { q, status, sort, order });
    // FLOW-046: narrow to a selected client-side tag when one is active.
    return tag ? base.filter((f) => tagsFor(f.id).includes(tag)) : base;
  }, [flows, q, status, sort, order, tag, tagsFor]);
  // Pinned flows float to the top (within the filtered/sorted result).
  const ordered = useMemo(() => {
    const pinnedFlows = visible.filter((f) => isPinned(f.id));
    const rest = visible.filter((f) => !isPinned(f.id));
    return [...pinnedFlows, ...rest];
  }, [visible, isPinned]);

  function invalidateList() {
    void queryClient.invalidateQueries({ queryKey: flowsKey });
  }

  const createMutation = useMutation({
    mutationFn: async (input: FlowInput) => {
      await verifyFreshFlowWriteAuthority(meQuery.data);
      return flowsApi.create(input);
    },
    onSuccess: (flow: Flow) => {
      invalidateList();
      router.push(`/app/flows/${encodeURIComponent(flow.id)}`);
    },
    onError: (err) =>
      toast.error(apiErrorMessage(err, "Could not create flow")),
  });

  const renameMutation = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      await verifyFreshFlowWriteAuthority(meQuery.data);
      return flowsApi.update(id, { name });
    },
    onSuccess: () => {
      invalidateList();
      toast.success("Flow renamed");
    },
    onError: (err) =>
      toast.error(apiErrorMessage(err, "Could not rename flow")),
  });

  const duplicateMutation = useMutation({
    mutationFn: async (flow: Flow) => {
      await verifyFreshFlowWriteAuthority(meQuery.data);
      return flowsApi.create({
        name: `${flow.name || "Untitled flow"} (copy)`,
        status: "draft",
        entry_id: flow.graph.entry_id,
        triggers: flow.graph.triggers,
        nodes: flow.graph.nodes,
        edges: flow.graph.edges,
        goals: flow.graph.goals,
        re_enrollment: flow.re_enrollment,
        ...(flow.re_enrollment === "cooldown"
          ? { re_enrollment_cooldown_hours: flow.re_enrollment_cooldown_hours }
          : {}),
      });
    },
    onSuccess: () => {
      invalidateList();
      toast.success("Flow duplicated");
    },
    onError: (err) =>
      toast.error(apiErrorMessage(err, "Could not duplicate flow")),
  });

  const setStatusMutation = useMutation({
    mutationFn: async ({ id, next }: { id: string; next: Flow["status"] }) => {
      await verifyFreshFlowWriteAuthority(meQuery.data);
      return flowsApi.update(id, { status: next });
    },
    onSuccess: () => invalidateList(),
    onError: (err) =>
      toast.error(apiErrorMessage(err, "Could not update flow")),
  });

  function handleArchive(flow: Flow) {
    setStatusMutation.mutate(
      { id: flow.id, next: "archived" },
      {
        onSuccess: () =>
          toast.success(`Archived "${flow.name || "Untitled flow"}"`, {
            action: {
              label: "Undo",
              onClick: () =>
                setStatusMutation.mutate({ id: flow.id, next: "draft" }),
            },
          }),
      },
    );
  }

  async function handleCopyLink(flow: Flow) {
    const result = await copyToClipboard(flowWebUrl(flow.id));
    if (result === "copied") toast.success("Flow link copied");
    else toast.error("Could not copy the link");
  }

  const filtersActive = q !== "" || status !== "all" || tag !== "";

  return (
    <div className="w-full min-w-0 space-y-6 px-4 py-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Flows</h1>
          <p className="text-sm text-muted-foreground">
            Author and validate stored journey definitions — triggers, waits,
            branches, email &amp; SMS. Enrollment, scheduling, and delivery are
            release-held in this build.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/app/flows/configuration">
              <SlidersHorizontal aria-hidden className="size-4" /> Draft
              configuration
            </Link>
          </Button>
          <FlowCreateDialog
            onCreate={(input) => createMutation.mutate(input)}
            pending={createMutation.isPending}
            disabled={!canWrite}
            disabledReason={writeDisabledReason}
          />
        </div>
      </div>

      {meQuery.isFetched && !canWrite ? (
        <div
          role="note"
          className="rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-emphasis"
        >
          {FLOW_READ_ONLY_MESSAGE}
        </div>
      ) : null}

      {/* Controls: search + status filter + sort */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search flows by name…"
            className="pl-8"
            aria-label="Search flows"
          />
        </div>
        <Select
          value={status}
          onChange={(e) =>
            setState({ status: e.target.value as FlowStatusFilter })
          }
          aria-label="Filter by status"
          className="sm:w-44"
        >
          {FLOW_STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All statuses" : s[0].toUpperCase() + s.slice(1)} (
              {counts[s] ?? 0})
            </option>
          ))}
        </Select>
        <Select
          value={`${sort}:${order}`}
          onChange={(e) => {
            const [nextSort, nextOrder] = e.target.value.split(":");
            setState({
              sort: nextSort as FlowSortKey,
              order: nextOrder as "asc" | "desc",
            });
          }}
          aria-label="Sort flows"
          className="sm:w-48"
        >
          <option value="updated:desc">Recently updated</option>
          <option value="updated:asc">Oldest updated</option>
          <option value="name:asc">Name (A–Z)</option>
          <option value="name:desc">Name (Z–A)</option>
        </Select>
        {allTags.length > 0 ? (
          <Select
            value={tag}
            onChange={(e) => setState({ tag: e.target.value })}
            aria-label="Filter by tag"
            className="sm:w-40"
          >
            <option value="">All tags</option>
            {allTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        ) : null}
        {filtersActive ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              reset();
              setSearchInput("");
            }}
          >
            <X className="mr-1 h-4 w-4" />
            Clear
          </Button>
        ) : null}
      </div>

      {catalogQuery.isError ? (
        <div className="rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-emphasis">
          Could not load the trigger catalog, so flows below show raw trigger
          keys instead of their names.
        </div>
      ) : null}

      {flowsQuery.isLoading ? (
        <FlowCardSkeletonGrid />
      ) : flowsQuery.isError ? (
        <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
          <p role="alert" className="text-sm font-medium text-foreground">
            Could not load flows.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void flowsQuery.refetch()}
            loading={flowsQuery.isFetching}
          >
            Retry
          </Button>
        </div>
      ) : flows.length === 0 ? (
        <EmptyState
          icon={GitBranch}
          title="No flows yet"
          description="Create your first automated journey to welcome, nurture, or win back subscribers."
          action={
            <FlowCreateDialog
              onCreate={(input) => createMutation.mutate(input)}
              pending={createMutation.isPending}
              disabled={!canWrite}
              disabledReason={writeDisabledReason}
            />
          }
        />
      ) : ordered.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No flows match"
          description="Try a different search or status filter."
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                reset();
                setSearchInput("");
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ordered.map((flow) => (
            <FlowListCard
              key={flow.id}
              flow={flow}
              triggerCatalog={triggerCatalog}
              pinned={isPinned(flow.id)}
              onTogglePin={toggle}
              onRename={(id, name) =>
                renameMutation.mutateAsync({ id, name }).then(() => undefined)
              }
              onDuplicate={(f) => duplicateMutation.mutate(f)}
              onArchive={handleArchive}
              onRestore={(flow) =>
                setStatusMutation.mutate(
                  { id: flow.id, next: "draft" },
                  { onSuccess: () => toast.success("Flow restored to draft") },
                )
              }
              onCopyLink={(f) => void handleCopyLink(f)}
              tags={tagsFor(flow.id)}
              onSetTags={setTags}
              canWrite={canWrite}
              writeDisabledReason={writeDisabledReason}
            />
          ))}
        </div>
      )}
    </div>
  );
}
