// SPDX-License-Identifier: AGPL-3.0-only
//
// The visual flow-builder editor. Owns the canonical AST (entry / triggers /
// nodes / edges) as local state seeded from the backend flow, renders it on the
// canvas, and edits it through the palette + config panel. Graph edits run
// through a bounded undo/redo history (FLOW-005). Validate calls the backend
// graph validator; Save persists via PATCH (always the COMPLETE graph — the
// backend treats a non-nil graph field as a FULL REPLACE). Activation and flow
// execution are release-held; publishing only promotes stored configuration.
"use client";

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, MoreHorizontal, Redo2, Undo2 } from "lucide-react";

import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

import {
  type CatalogItem,
  type Flow,
  type FlowGraph,
  type FlowNode,
  type FlowTrigger,
  type GraphValidateResponse,
  type ReEnrollment,
  flowsApi,
} from "@/lib/flows-api";
import { apiErrorMessage } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import {
  getCampaignTemplate,
  listTemplates,
} from "@/lib/campaign-templates-api";
import {
  errorNodeIds,
  type FlowEditableState,
  flowStatusBadgeVariant,
  hasTrigger,
  nodesRequiringReview,
  removeFlowNode,
  serializeFlowState,
} from "@/lib/flow-graph";
import {
  formatMetricNumber,
  formatPercent,
  formatRevenueCents,
  hasFlowMetrics,
  readFlowMetrics,
  readNodeDropOff,
} from "@/lib/flow-analytics";
import {
  canRedo,
  canUndo,
  type History,
  initHistory,
  pushHistory,
  redo,
  undo,
} from "@/lib/flow-history";
import { timeAgo } from "@/lib/relative-time";
import {
  canWriteFlows,
  FLOW_READ_ONLY_MESSAGE,
  verifyFreshFlowWriteAuthority,
} from "@/lib/flow-write-authority";
import { qk, STALE } from "@/lib/query-keys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { FlowActivationStatus } from "./flow-activation-status";
import { FlowJourneyPreview } from "./flow-journey-preview";
import { CopyFlowLink } from "./copy-flow-link";
import { PICKABLE_FIELDS, type PickerEntity } from "./entity-picker-config";
import { FlowCanvas } from "./flow-canvas";
import { buildFlowMutationInput } from "./flow-mutation-input";

const EntityPicker = lazy(() =>
  import("./entity-picker").then((module) => ({
    default: module.EntityPicker,
  })),
);

const NodeConfigPanel = lazy(() =>
  import("./node-config-panel").then((module) => ({
    default: module.NodeConfigPanel,
  })),
);

const VersionHistory = lazy(() =>
  import("./version-history").then((module) => ({
    default: module.VersionHistory,
  })),
);

const FlowRunsPanel = lazy(() =>
  import("./flow-runs-panel").then((module) => ({
    default: module.FlowRunsPanel,
  })),
);

function FlowRailLoading({ label }: { label: string }) {
  return (
    <aside
      className="w-full shrink-0 space-y-3 border-t border-border p-3 md:w-80 md:border-l md:border-t-0"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">{label}</span>
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-20 w-full" />
    </aside>
  );
}

function FlowPanelLoading({ label }: { label: string }) {
  return (
    <div className="space-y-3 p-3" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

function EntityPickerLoading({
  entity,
  value,
  className,
  ariaLabel,
}: {
  entity: PickerEntity;
  value: string;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <Select
      value={value}
      className={className}
      aria-label={ariaLabel}
      aria-busy="true"
      disabled
    >
      <option value={value}>Loading {entity}s…</option>
    </Select>
  );
}

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

const EMPTY_GRAPH: FlowGraph = { nodes: [] };

// On an active row Save writes a DRAFT VERSION, and a version carries the graph
// ONLY — name, re-enrollment and cooldown live on the journey row, which the
// backend refuses to PATCH while the status is active (UpdateFlow returns
// ErrFlowRuntimeUnavailable) and which Publish never touches either. Left
// editable, those inputs would accept a rename, report "Draft saved", clear the
// dirty flag, and lose the edit on the next load. Hold them read-only instead.
const ACTIVE_FLOW_METADATA_LOCKED =
  "Mark the configuration paused to rename it or change re-enrollment.";

export function FlowEditor({ flowId }: { flowId: string }) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const canWrite = canWriteFlows(meQuery.data);

  const flowQuery = useQuery({
    queryKey: ["flow", flowId],
    queryFn: () => flowsApi.get(flowId),
  });
  const catalogQuery = useQuery({
    queryKey: ["flow-catalog"],
    queryFn: () => flowsApi.catalog(),
    staleTime: 5 * 60 * 1000,
  });

  const [name, setName] = useState("");
  const [reEnrollment, setReEnrollment] = useState<ReEnrollment>("once");
  const [cooldownHours, setCooldownHours] = useState(72);
  // Graph lives in a bounded undo/redo history; `graph` is the present.
  const [history, setHistory] = useState<History<FlowGraph>>(() =>
    initHistory(EMPTY_GRAPH),
  );
  const graph = history.present;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [validation, setValidation] = useState<GraphValidateResponse | null>(
    null,
  );
  const [seeded, setSeeded] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // Dirty tracking (FLOW-002/012): the serialized state at the last save.
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  // A single entry point for graph mutations so every edit records history.
  const setGraph = useCallback(
    (updater: FlowGraph | ((g: FlowGraph) => FlowGraph)) => {
      if (!canWrite) return;
      setHistory((h) =>
        pushHistory(
          h,
          typeof updater === "function"
            ? (updater as (g: FlowGraph) => FlowGraph)(h.present)
            : updater,
        ),
      );
    },
    [canWrite],
  );

  // Re-seed the editable AST from a flow returned by a restore/promote. Pushes
  // onto history so the restore itself is undoable.
  function replaceFromFlow(flow: Flow) {
    setName(flow.name);
    setReEnrollment(flow.re_enrollment ?? "once");
    setCooldownHours(flow.re_enrollment_cooldown_hours || 72);
    setGraph({
      entry_id: flow.graph.entry_id,
      triggers: flow.graph.triggers ?? [],
      nodes: flow.graph.nodes ?? [],
      edges: flow.graph.edges ?? [],
      goals: flow.graph.goals ?? [],
    });
    setSelectedId(null);
    setValidation(null);
  }

  // Seed local editable state once the flow arrives, resetting history and the
  // saved-state baseline.
  useEffect(() => {
    if (flowQuery.data && !seeded) {
      const g: FlowGraph = {
        entry_id: flowQuery.data.graph.entry_id,
        triggers: flowQuery.data.graph.triggers ?? [],
        nodes: flowQuery.data.graph.nodes ?? [],
        edges: flowQuery.data.graph.edges ?? [],
        goals: flowQuery.data.graph.goals ?? [],
      };
      const re = flowQuery.data.re_enrollment ?? "once";
      const cd = flowQuery.data.re_enrollment_cooldown_hours || 72;
      setName(flowQuery.data.name);
      setReEnrollment(re);
      setCooldownHours(cd);
      setHistory(initHistory(g));
      setSavedSnapshot(
        serializeFlowState({
          name: flowQuery.data.name,
          reEnrollment: re,
          cooldownHours: cd,
          graph: g,
        }),
      );
      setSeeded(true);
    }
  }, [flowQuery.data, seeded]);

  const catalog = catalogQuery.data;
  const status = flowQuery.data?.status ?? "draft";
  const cooldownIsValid =
    reEnrollment !== "cooldown" ||
    (Number.isInteger(cooldownHours) && cooldownHours > 0);

  const currentSnapshot = useMemo(
    () => serializeFlowState({ name, reEnrollment, cooldownHours, graph }),
    [name, reEnrollment, cooldownHours, graph],
  );
  const isDirty =
    seeded && savedSnapshot !== null && currentSnapshot !== savedSnapshot;

  const selectedNode = useMemo(
    () => graph.nodes.find((n) => n.id === selectedId) ?? null,
    [graph.nodes, selectedId],
  );

  const flaggedNodeIds = useMemo(
    () =>
      validation
        ? errorNodeIds(validation.errors, graph.nodes)
        : new Set<string>(),
    [validation, graph.nodes],
  );

  const graphHasTrigger = hasTrigger(graph);
  const reviewNodes = useMemo(
    () => (catalog ? nodesRequiringReview(graph.nodes, catalog.nodes) : []),
    [catalog, graph.nodes],
  );
  const metrics = useMemo(
    () => readFlowMetrics(flowQuery.data?.analytics),
    [flowQuery.data?.analytics],
  );
  const nodeDropOff = useMemo(
    () => readNodeDropOff(flowQuery.data?.analytics),
    [flowQuery.data?.analytics],
  );

  // FLOW-016: resolve each referenced template_id to its human name so node
  // cards read "Welcome email" not "Template ct_a1b2". Only the ids actually
  // used in this flow are fetched (a handful), cached, and never retried — an
  // unresolved id gracefully falls back to the raw id in nodeSummary().
  const templateIds = useMemo(() => {
    const ids = new Set<string>();
    for (const n of graph.nodes) {
      if (
        n.type === "send_email" &&
        typeof n.template_id === "string" &&
        n.template_id
      ) {
        ids.add(n.template_id);
      }
    }
    return [...ids];
  }, [graph.nodes]);
  // One id+name request covers the whole library page (`listTemplates` reuses
  // the search surface, 100 rows). The previous shape was one FULL template GET
  // per email node — body_html, MJML, variables and preview assets downloaded
  // to read `.name` — which also serialized past the browser's 6-connection cap
  // on larger flows.
  const templateListQuery = useQuery({
    queryKey: ["flow-template-names"],
    queryFn: listTemplates,
    staleTime: 300_000,
    retry: false,
  });
  const listedTemplateNames = useMemo(() => {
    const m = new Map<string, string>();
    const rows = Array.isArray(templateListQuery.data)
      ? templateListQuery.data
      : [];
    for (const t of rows) m.set(t.id, t.name);
    return m;
  }, [templateListQuery.data]);
  // Anything the list did not carry (an older template beyond the first page,
  // or one referenced from an archived record) still resolves individually, so
  // no node regresses to showing a raw id.
  const unlistedTemplateIds = useMemo(
    () =>
      templateListQuery.isFetched
        ? templateIds.filter((id) => !listedTemplateNames.has(id))
        : [],
    [listedTemplateNames, templateIds, templateListQuery.isFetched],
  );
  const templateNameQueries = useQueries({
    queries: unlistedTemplateIds.map((id) => ({
      queryKey: ["flow-template-name", id],
      queryFn: () => getCampaignTemplate(id),
      staleTime: 300_000,
      retry: false,
    })),
  });
  const templateNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const id of templateIds) {
      const name = listedTemplateNames.get(id);
      if (name) m.set(id, name);
    }
    unlistedTemplateIds.forEach((id, i) => {
      const name = templateNameQueries[i]?.data?.name;
      if (name) m.set(id, name);
    });
    return m;
  }, [
    listedTemplateNames,
    templateIds,
    templateNameQueries,
    unlistedTemplateIds,
  ]);
  const resolveTemplateName = useCallback(
    (id: string) => templateNames.get(id),
    [templateNames],
  );
  // A name not known yet is loading until its lookups settle: the template
  // list first, then the individual fetch for an id the list did not carry.
  const templateNamePending = useCallback(
    (id: string) => {
      if (listedTemplateNames.has(id)) return false;
      if (!templateListQuery.isFetched) return true;
      const index = unlistedTemplateIds.indexOf(id);
      return index >= 0 && Boolean(templateNameQueries[index]?.isPending);
    },
    [
      listedTemplateNames,
      templateListQuery.isFetched,
      templateNameQueries,
      unlistedTemplateIds,
    ],
  );

  // `sent` is the editor state that actually went to the server. Callers MUST
  // pass it: onSuccess runs after the round-trip, so defaulting to the current
  // state marks edits made *during* the request as saved. That cleared the
  // dirty flag (and with it the beforeunload guard) while the server still had
  // the older graph, so those edits were lost silently on the next navigation.
  function markSaved(sent: FlowEditableState) {
    setSavedSnapshot(serializeFlowState(sent));
    setLastSavedAt(Date.now());
  }

  // Snapshot taken synchronously in onMutate, which React Query runs in the
  // same tick as mutate() — so it matches exactly what mutationFn sends.
  const editorState = (): FlowEditableState => ({
    name,
    reEnrollment,
    cooldownHours,
    graph,
  });

  // ---- AST mutations (through history) ------------------------------------

  function addNode(type: string, extra: Partial<FlowNode> = {}) {
    const id = genId("n");
    setGraph((g) => ({
      ...g,
      nodes: [...g.nodes, { id, type, ...extra }],
      entry_id: g.entry_id ?? id,
    }));
    setSelectedId(id);
    setValidation(null);
  }

  function updateNode(id: string, patch: Partial<FlowNode>) {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    }));
    setValidation(null);
  }

  function moveNode(id: string, x: number, y: number) {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === id ? { ...n, position: { x, y } } : n,
      ),
    }));
  }

  function autoArrange() {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((node) => {
        const unpinned = { ...node };
        delete unpinned.position;
        return unpinned;
      }),
    }));
  }

  function setNext(fromId: string, toId: string) {
    setGraph((g) => {
      const edges = (g.edges ?? []).filter((e) => e.from !== fromId);
      if (toId) edges.push({ from: fromId, to: toId });
      return { ...g, edges };
    });
    setValidation(null);
  }

  // FLOW-033: canvas drag-to-connect reuses the existing edge mutations — a
  // branch leg patches true_next/false_next, everything else sets the linear
  // next. Same persistence path as the config-panel dropdowns.
  function connectNodes(fromId: string, toId: string, leg?: "true" | "false") {
    if (!toId || fromId === toId) return;
    if (leg === "true") updateNode(fromId, { true_next: toId });
    else if (leg === "false") updateNode(fromId, { false_next: toId });
    else setNext(fromId, toId);
  }

  const deleteNode = useCallback(
    (id: string) => {
      setGraph((g) => removeFlowNode(g, id));
      setSelectedId(null);
      setValidation(null);
    },
    [setGraph],
  );

  // Delete + an Undo affordance (leans on the history stack). Used by the
  // Delete key on the canvas and the config-panel Delete button.
  const deleteNodeWithUndo = useCallback(
    (id: string) => {
      if (!canWrite) return;
      deleteNode(id);
      toast("Step deleted", {
        action: { label: "Undo", onClick: () => setHistory(undo) },
      });
    },
    [canWrite, deleteNode],
  );

  function addTrigger(type: string) {
    setGraph((g) => ({ ...g, triggers: [...(g.triggers ?? []), { type }] }));
    setValidation(null);
  }

  function updateTrigger(index: number, patch: Partial<FlowTrigger>) {
    setGraph((g) => ({
      ...g,
      triggers: (g.triggers ?? []).map((t, i) =>
        i === index ? { ...t, ...patch } : t,
      ),
    }));
    setValidation(null);
  }

  function removeTrigger(index: number) {
    setGraph((g) => ({
      ...g,
      triggers: (g.triggers ?? []).filter((_, i) => i !== index),
    }));
    setValidation(null);
  }

  // ---- Server actions ------------------------------------------------------

  function invalidateList() {
    // Prefix-match invalidation reaches the tenant/role-scoped ["flows", …] key.
    void queryClient.invalidateQueries({ queryKey: ["flows"] });
  }

  // FLOW-008: saving a legacy-active row stores a DRAFT version without
  // replacing its published configuration. Publish promotes that stored draft;
  // it does not start enrollment, scheduling, or delivery while runtime is held.
  // Non-active rows edit in place as before.
  const isActiveFlow = flowQuery.data?.status === "active";

  const saveMutation = useMutation({
    onMutate: editorState,
    mutationFn: async (): Promise<Flow> => {
      await verifyFreshFlowWriteAuthority(meQuery.data);
      if (isActiveFlow) {
        await flowsApi.createVersion(flowId, { graph, generated_by: "human" });
        // Refetch so the response carries the new latest_version (draft).
        return flowsApi.get(flowId);
      }
      return flowsApi.update(
        flowId,
        buildFlowMutationInput({ name, reEnrollment, cooldownHours, graph }),
      );
    },
    onSuccess: (updated: Flow, _vars, sent) => {
      queryClient.setQueryData(["flow", flowId], updated);
      void queryClient.invalidateQueries({
        queryKey: ["flow-versions", flowId],
      });
      invalidateList();
      markSaved(sent);
      toast.success(
        isActiveFlow ? "Draft saved — not yet published" : "Flow saved",
      );
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Could not save flow")),
  });

  const publishMutation = useMutation({
    onMutate: editorState,
    mutationFn: async () => {
      await verifyFreshFlowWriteAuthority(meQuery.data);
      return flowsApi.publish(flowId);
    },
    onSuccess: (updated: Flow, _vars, sent) => {
      queryClient.setQueryData(["flow", flowId], updated);
      void queryClient.invalidateQueries({
        queryKey: ["flow-versions", flowId],
      });
      invalidateList();
      markSaved(sent);
      toast.success("Configuration published — execution remains release-held");
    },
    onError: (err) =>
      toast.error(apiErrorMessage(err, "Could not publish flow")),
  });

  const validateMutation = useMutation({
    mutationFn: async () => {
      await verifyFreshFlowWriteAuthority(meQuery.data);
      return flowsApi.validate({
        entry_id: graph.entry_id,
        triggers: graph.triggers,
        nodes: graph.nodes,
        edges: graph.edges,
      });
    },
    onSuccess: (result) => {
      setValidation(result);
      if (result.valid) toast.success("Graph is valid");
      else toast.error("Graph has validation errors");
    },
    onError: (err) =>
      toast.error(apiErrorMessage(err, "Could not validate flow")),
  });

  const pauseMutation = useMutation({
    onMutate: editorState,
    mutationFn: async () => {
      await verifyFreshFlowWriteAuthority(meQuery.data);
      return flowsApi.update(
        flowId,
        buildFlowMutationInput({
          status: "paused",
          name,
          reEnrollment,
          cooldownHours,
          graph,
        }),
      );
    },
    onSuccess: (updated: Flow, _vars, sent) => {
      queryClient.setQueryData(["flow", flowId], updated);
      invalidateList();
      markSaved(sent);
      toast.success("Configuration marked paused — no execution was running");
    },
    onError: (err) =>
      toast.error(apiErrorMessage(err, "Could not mark configuration paused")),
  });

  const canSave =
    canWrite && isDirty && cooldownIsValid && !saveMutation.isPending;

  // Keyboard: ⌘S save, ⌘Z / ⌘⇧Z undo-redo, Esc to deselect / close the rail.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);

      if (e.key === "Escape") {
        if (showVersions) setShowVersions(false);
        else if (selectedId) setSelectedId(null);
        return;
      }

      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        if (canSave) saveMutation.mutate();
        return;
      }
      if (typing) return; // don't hijack native text undo/redo
      if (!canWrite) return;
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        setHistory(undo);
        setSelectedId(null);
        setValidation(null);
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        setHistory(redo);
        setSelectedId(null);
        setValidation(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canSave, canWrite, saveMutation, showVersions, selectedId]);

  // Warn on browser navigation / refresh / close when there are unsaved edits.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const loadError = flowQuery.error ?? catalogQuery.error;
  if (loadError) {
    return (
      <div className="space-y-3 p-6 text-sm">
        <h1 className="text-xl font-semibold text-foreground">
          Couldn&apos;t load this flow
        </h1>
        <p role="alert" className="text-muted-foreground">
          {flowQuery.isError
            ? "Could not load this flow."
            : "Could not load the flow catalog."}{" "}
          {loadError instanceof Error ? loadError.message : "Try again."}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            if (flowQuery.isError) void flowQuery.refetch();
            if (catalogQuery.isError || !catalog) void catalogQuery.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (!flowQuery.data || !catalog) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-[480px] w-full" />
      </div>
    );
  }
  const currentNext =
    selectedNode && selectedNode.type !== "branch"
      ? ((graph.edges ?? []).find((e) => e.from === selectedNode.id)?.to ?? "")
      : "";

  const inboundCount = selectedNode
    ? (graph.edges ?? []).filter((e) => e.to === selectedNode.id).length +
      graph.nodes.filter(
        (n) =>
          n.true_next === selectedNode.id ||
          n.false_next === selectedNode.id ||
          (Array.isArray(n.variants) &&
            n.variants.some(
              (variant: Record<string, unknown>) =>
                variant.next === selectedNode.id,
            )),
      ).length
    : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <h1 className="sr-only">Edit flow: {name || "Untitled flow"}</h1>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        {/* Back to flows (FLOW-028), guarding unsaved edits. */}
        {isDirty ? (
          <ConfirmDialog
            trigger={
              <Button type="button" variant="ghost" size="sm">
                <ArrowLeft className="mr-1 h-4 w-4" />
                Flows
              </Button>
            }
            title="Discard unsaved changes?"
            description="You have unsaved edits to this flow. Leaving now will discard them."
            confirmLabel="Discard & leave"
            confirmVariant="destructive"
            onConfirm={() => router.push("/app/flows")}
          />
        ) : (
          <Button type="button" variant="ghost" size="sm" asChild>
            <Link href="/app/flows">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Flows
            </Link>
          </Button>
        )}

        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-9 w-full font-medium sm:w-56"
          aria-label="Flow name"
          disabled={!canWrite || isActiveFlow}
          title={
            !canWrite
              ? FLOW_READ_ONLY_MESSAGE
              : isActiveFlow
                ? ACTIVE_FLOW_METADATA_LOCKED
                : undefined
          }
        />
        <Badge variant={flowStatusBadgeVariant(status)}>{status}</Badge>
        {isActiveFlow && flowQuery.data?.latest_version ? (
          <Badge
            variant={
              flowQuery.data.latest_version.status === "draft"
                ? "warning"
                : "success"
            }
            title={
              flowQuery.data.latest_version.status === "draft"
                ? "You have saved edits that are not published yet. Publish to promote the stored configuration; execution remains release-held."
                : "The published configuration is up to date; execution remains release-held."
            }
          >
            {flowQuery.data.latest_version.status === "draft"
              ? "Draft changes · unpublished"
              : "Configuration · published"}
          </Badge>
        ) : null}
        <SavedIndicator
          saving={saveMutation.isPending}
          dirty={isDirty}
          lastSavedAt={lastSavedAt}
        />

        {/* Secondary actions collapse behind "More" on small screens. */}
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          className="ml-auto inline-flex min-h-11 items-center gap-1 rounded-md border border-input px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:hidden"
          aria-expanded={moreOpen}
          aria-controls="flow-editor-more-actions"
        >
          <MoreHorizontal className="h-4 w-4" />
          More
        </button>
        <div
          id="flow-editor-more-actions"
          className={cn(
            "flex-wrap items-center gap-2 md:ml-auto md:flex",
            moreOpen ? "flex w-full" : "hidden",
          )}
        >
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="whitespace-nowrap">Re-enrollment</span>
            <Select
              value={reEnrollment}
              onChange={(e) => setReEnrollment(e.target.value as ReEnrollment)}
              aria-label="Re-enrollment policy"
              className="h-9 w-auto text-xs"
              disabled={!canWrite || isActiveFlow}
              title={
                !canWrite
                  ? FLOW_READ_ONLY_MESSAGE
                  : isActiveFlow
                    ? ACTIVE_FLOW_METADATA_LOCKED
                    : undefined
              }
            >
              <option value="once">Once — enter at most once</option>
              <option value="always">Every time — e.g. abandoned cart</option>
              <option value="cooldown">After a cooldown — e.g. win-back</option>
            </Select>
          </label>
          {reEnrollment === "cooldown" ? (
            <div className="flex flex-col">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="whitespace-nowrap">Cooldown (hours)</span>
                <Input
                  type="number"
                  min={1}
                  value={cooldownHours}
                  onChange={(e) =>
                    setCooldownHours(e.currentTarget.valueAsNumber)
                  }
                  aria-invalid={!cooldownIsValid}
                  aria-describedby={
                    !cooldownIsValid ? "cooldown-error" : undefined
                  }
                  aria-label="Re-enrollment cooldown hours"
                  className="h-9 w-20"
                  disabled={!canWrite || isActiveFlow}
                  title={
                    !canWrite
                      ? FLOW_READ_ONLY_MESSAGE
                      : isActiveFlow
                        ? ACTIVE_FLOW_METADATA_LOCKED
                        : undefined
                  }
                />
              </label>
              {!cooldownIsValid ? (
                <span
                  id="cooldown-error"
                  className="mt-0.5 text-[11px] text-destructive"
                >
                  Enter a positive whole number of hours.
                </span>
              ) : null}
            </div>
          ) : null}
          {canWrite && isActiveFlow ? (
            <span className="text-[11px] text-muted-foreground">
              {ACTIVE_FLOW_METADATA_LOCKED}
            </span>
          ) : null}

          <div className="flex items-center gap-1">
            <Tooltip label="Undo (⌘Z)" className="[&[aria-hidden=true]]:hidden">
              <IconButton
                size="sm"
                aria-label="Undo"
                disabled={!canWrite || !canUndo(history)}
                onClick={() => {
                  setHistory(undo);
                  setSelectedId(null);
                  setValidation(null);
                }}
              >
                <Undo2 className="h-4 w-4" />
              </IconButton>
            </Tooltip>
            <Tooltip
              label="Redo (⌘⇧Z)"
              className="[&[aria-hidden=true]]:hidden"
            >
              <IconButton
                size="sm"
                aria-label="Redo"
                disabled={!canWrite || !canRedo(history)}
                onClick={() => {
                  setHistory(redo);
                  setSelectedId(null);
                  setValidation(null);
                }}
              >
                <Redo2 className="h-4 w-4" />
              </IconButton>
            </Tooltip>
          </div>

          {graph.nodes.some((n) => n.position) ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={autoArrange}
              disabled={!canWrite}
              title={
                canWrite
                  ? "Drop manual positions and re-layout the graph automatically"
                  : FLOW_READ_ONLY_MESSAGE
              }
            >
              Auto-arrange
            </Button>
          ) : null}
          <CopyFlowLink flowId={flowId} variant="ghost" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowVersions((v) => !v);
              setShowRuns(false);
            }}
          >
            Versions
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowRuns((v) => !v);
              setShowVersions(false);
            }}
          >
            Runs
          </Button>
          {/* FLOW-010: inspect the stored journey definition without execution. */}
          <FlowJourneyPreview
            graph={graph}
            catalog={catalog}
            resolveTemplateName={resolveTemplateName}
            templateNamePending={templateNamePending}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => validateMutation.mutate()}
            loading={validateMutation.isPending}
            disabled={!canWrite}
            title={!canWrite ? FLOW_READ_ONLY_MESSAGE : undefined}
          >
            Validate
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => saveMutation.mutate()}
            loading={saveMutation.isPending}
            disabled={!canSave}
            title={
              !canWrite
                ? FLOW_READ_ONLY_MESSAGE
                : !cooldownIsValid
                  ? "Fix the cooldown value to save"
                  : !isDirty
                    ? "No changes to save"
                    : undefined
            }
          >
            Save
          </Button>
          {isActiveFlow ? (
            <Button
              type="button"
              size="sm"
              onClick={() => publishMutation.mutate()}
              loading={publishMutation.isPending}
              disabled={
                !canWrite || flowQuery.data?.latest_version?.status !== "draft"
              }
              title={
                !canWrite
                  ? FLOW_READ_ONLY_MESSAGE
                  : flowQuery.data?.latest_version?.status !== "draft"
                    ? "No draft changes to publish"
                    : "Promote the saved draft to published configuration"
              }
            >
              Publish
            </Button>
          ) : null}
          {status === "active" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => pauseMutation.mutate()}
              loading={pauseMutation.isPending}
              disabled={!canWrite || !cooldownIsValid}
              title={
                canWrite
                  ? "Changes only the stored status; no execution is running"
                  : FLOW_READ_ONLY_MESSAGE
              }
            >
              Mark configuration paused
            </Button>
          ) : null}
          <FlowActivationStatus />
        </div>
      </div>

      {/* Persistent warnings */}
      {meQuery.isFetched && !canWrite ? (
        <div
          role="note"
          className="border-b border-warning/40 bg-warning-subtle px-4 py-2 text-xs text-warning-emphasis"
        >
          {FLOW_READ_ONLY_MESSAGE} Reads, history, run evidence, copy-link, and
          journey inspection remain available.
        </div>
      ) : null}
      {status === "active" && isDirty ? (
        <div className="border-b border-warning/40 bg-warning-subtle px-4 py-2 text-xs text-warning-emphasis">
          This flow has a legacy <strong>active</strong> status. Save stores a{" "}
          <strong>draft</strong>; <strong>Publish</strong> promotes it to the
          stored published configuration. Enrollment, scheduling, and delivery
          remain release-held.
        </div>
      ) : null}
      {graph.nodes.length > 0 && !graphHasTrigger ? (
        <div className="border-b border-warning/40 bg-warning-subtle px-4 py-2 text-xs text-warning-emphasis">
          No trigger is configured. Add one to complete the stored journey
          definition; this does not enable enrollment while execution is held.
        </div>
      ) : null}

      {/* Flow-level analytics (FLOW-007) */}
      {hasFlowMetrics(metrics) ? (
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-border bg-muted/30 px-4 py-2 text-xs">
          {metrics.entered !== undefined ? (
            <Metric
              label="Entered"
              value={formatMetricNumber(metrics.entered)}
            />
          ) : null}
          {metrics.active !== undefined ? (
            <Metric
              label="In progress"
              value={formatMetricNumber(metrics.active)}
            />
          ) : null}
          {metrics.completed !== undefined ? (
            <Metric
              label="Completed"
              value={formatMetricNumber(metrics.completed)}
            />
          ) : null}
          {metrics.conversionRate !== undefined ? (
            <Metric
              label="Conversion"
              value={formatPercent(metrics.conversionRate)}
            />
          ) : null}
          {metrics.revenueCents !== undefined ? (
            <Metric
              label="Revenue"
              value={formatRevenueCents(metrics.revenueCents)}
            />
          ) : null}
        </div>
      ) : null}

      {/* Validation errors — each is clickable to focus its node (FLOW-023). */}
      {validation &&
      (validation.errors?.length || validation.warnings?.length) ? (
        <div
          aria-live="polite"
          className="border-b border-border bg-muted/40 px-4 py-2 text-xs"
        >
          {validation.errors?.map((e) => {
            const target = [...errorNodeIds([e], graph.nodes)][0];
            return target ? (
              <button
                key={e}
                type="button"
                onClick={() => {
                  setShowVersions(false);
                  setSelectedId(target);
                }}
                className="block min-h-6 rounded-sm text-left text-destructive underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              >
                • {e}
              </button>
            ) : (
              <p key={e} className="text-destructive">
                • {e}
              </p>
            );
          })}
          {validation.warnings?.map((w) => (
            <p key={w} className="text-warning-emphasis">
              • {w}
            </p>
          ))}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Palette */}
        <aside className="w-full shrink-0 space-y-4 overflow-y-auto border-b border-border p-3 md:w-56 md:border-b-0 md:border-r">
          <TriggerSection
            triggers={graph.triggers ?? []}
            catalog={catalog.triggers}
            onAdd={addTrigger}
            onUpdate={updateTrigger}
            onRemove={removeTrigger}
            readOnly={!canWrite}
          />
          <PaletteSection
            title="Steps"
            items={catalog.nodes.filter(
              (c) => c.key !== "exit" && c.category !== "trigger",
            )}
            onAdd={(item) => addNode(item.key)}
            readOnly={!canWrite}
          />
          <PaletteSection
            title="Actions"
            items={catalog.actions}
            onAdd={(item) => addNode("action", { action: { kind: item.key } })}
            readOnly={!canWrite}
          />
        </aside>

        {/* Canvas */}
        <div className="min-h-[50vh] min-w-0 flex-1 md:min-h-0">
          <FlowCanvas
            nodes={graph.nodes}
            edges={graph.edges ?? []}
            entryId={graph.entry_id}
            nodeCatalog={catalog.nodes}
            conditionFields={catalog.condition_fields ?? []}
            resolveTemplateName={resolveTemplateName}
            selectedId={selectedId}
            flaggedNodeIds={flaggedNodeIds}
            nodeDropOff={nodeDropOff}
            onSelect={setSelectedId}
            onMove={canWrite ? moveNode : undefined}
            onConnect={canWrite ? connectNodes : undefined}
            onDeleteNode={canWrite ? deleteNodeWithUndo : undefined}
            onAddFirstStep={canWrite ? () => addNode("send_email") : undefined}
          />
        </div>

        {/* Right rail */}
        {showVersions ? (
          <Suspense
            fallback={<FlowRailLoading label="Loading version history" />}
          >
            <VersionHistory
              flowId={flowId}
              currentGraph={graph}
              hasUnsavedEdits={isDirty}
              identity={meQuery.data}
              canWrite={canWrite}
              onClose={() => setShowVersions(false)}
              onFlowReplaced={replaceFromFlow}
            />
          </Suspense>
        ) : showRuns ? (
          <aside className="w-full shrink-0 overflow-y-auto border-t border-border md:w-80 md:border-l md:border-t-0">
            <Suspense fallback={<FlowPanelLoading label="Loading flow runs" />}>
              <FlowRunsPanel flowId={flowId} />
            </Suspense>
          </aside>
        ) : selectedNode ? (
          <aside className="w-full shrink-0 border-t border-border md:w-80 md:border-l md:border-t-0">
            <Suspense
              fallback={<FlowPanelLoading label="Loading node settings" />}
            >
              <NodeConfigPanel
                node={selectedNode}
                nodes={graph.nodes}
                nodeCatalog={catalog.nodes}
                triggerCatalog={catalog.triggers}
                conditionFields={catalog.condition_fields ?? []}
                currentNext={currentNext}
                isEntry={graph.entry_id === selectedNode.id}
                inboundCount={inboundCount}
                requiresReview={reviewNodes.some(
                  (n) => n.id === selectedNode.id,
                )}
                readOnly={!canWrite}
                onChange={(patch) => updateNode(selectedNode.id, patch)}
                onSetNext={(toId) => setNext(selectedNode.id, toId)}
                onMakeEntry={() =>
                  setGraph((g) => ({ ...g, entry_id: selectedNode.id }))
                }
                onDelete={() => deleteNodeWithUndo(selectedNode.id)}
                onClose={() => setSelectedId(null)}
              />
            </Suspense>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="font-semibold text-foreground">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function SavedIndicator({
  saving,
  dirty,
  lastSavedAt,
}: {
  saving: boolean;
  dirty: boolean;
  lastSavedAt: number | null;
}) {
  if (saving) {
    return <span className="text-xs text-muted-foreground">Saving…</span>;
  }
  if (dirty) {
    return (
      <span className="text-xs text-warning-emphasis">Unsaved changes</span>
    );
  }
  if (lastSavedAt) {
    return (
      <span className="text-xs text-muted-foreground">
        Saved {timeAgo(new Date(lastSavedAt).toISOString())}
      </span>
    );
  }
  return (
    <span className="text-xs text-muted-foreground">All changes saved</span>
  );
}

function PaletteSection({
  title,
  items,
  onAdd,
  readOnly = false,
}: {
  title: string;
  items: CatalogItem[];
  onAdd: (item: CatalogItem) => void;
  readOnly?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onAdd(item)}
          disabled={readOnly}
          title={readOnly ? FLOW_READ_ONLY_MESSAGE : undefined}
          className="flex min-h-10 w-full items-center justify-between rounded-md border border-border bg-card px-2.5 py-1.5 text-left text-sm outline-none hover:border-primary hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
        >
          <span className="truncate">{item.label}</span>
          <span
            className={cn("ml-2 h-1.5 w-1.5 shrink-0 rounded-full", {
              "bg-emerald-500": item.runtime_status === "supported",
              "bg-amber-500": item.runtime_status === "partial",
              "bg-zinc-400": item.runtime_status === "planned",
            })}
            title={item.runtime_status}
          />
        </button>
      ))}
    </div>
  );
}

// FLOW-043: plain-language explanation of each trigger, keyed by the
// flowbuilder catalog key. Renders as a caption under a configured trigger and
// a title hint on the add-trigger options so predictive/behavioural triggers
// aren't opaque raw selects. Keys mirror flowbuilder.go's trigger catalog.
const TRIGGER_HELP: Record<string, string> = {
  list_joined: "Enrols when a subscriber joins the chosen list.",
  tag_added: "Enrols when a tag is applied to a subscriber.",
  tag_removed: "Enrols when a tag is removed from a subscriber.",
  segment_joined: "Enrols when a subscriber first matches the chosen segment.",
  product_event:
    "Enrols on a named product/commerce event (e.g. purchased, viewed).",
  subscriber_opened_email:
    "Enrols when a subscriber opens the chosen campaign.",
  subscriber_clicked_link:
    "Enrols when a subscriber clicks a link in the chosen campaign.",
  subscriber_delivered_email:
    "Enrols when a campaign is delivered to the subscriber.",
  subscriber_did_not_open:
    "Enrols when a subscriber has NOT opened the chosen campaign after N days.",
  inbound_webhook: "Enrols when a matching inbound webhook event arrives.",
  email_reply: "Enrols when a subscriber replies to an email.",
  date_field:
    "Enrols relative to a date on the profile (e.g. birthday, renewal).",
};

function TriggerSection({
  triggers,
  catalog,
  onAdd,
  onUpdate,
  onRemove,
  readOnly = false,
}: {
  triggers: FlowTrigger[];
  catalog: CatalogItem[];
  onAdd: (type: string) => void;
  onUpdate: (index: number, patch: Partial<FlowTrigger>) => void;
  onRemove: (index: number) => void;
  readOnly?: boolean;
}) {
  // Group the "add trigger" options by category so predictive/behavioural
  // triggers are easier to find (FLOW-043).
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Triggers
      </p>
      {triggers.map((t, i) => {
        const meta = catalog.find((c) => c.key === t.type);
        return (
          <div
            key={`${t.type}-${i}`}
            className="space-y-1 rounded-md border border-border bg-card p-2"
          >
            <div className="flex items-center justify-between">
              <span className="truncate text-xs font-medium">
                {meta?.label ?? t.type}
              </span>
              <IconButton
                size="sm"
                aria-label="Remove trigger"
                disabled={readOnly}
                title={readOnly ? FLOW_READ_ONLY_MESSAGE : undefined}
                className="h-6 w-6 text-muted-foreground hover:text-destructive"
                onClick={() => onRemove(i)}
              >
                <span aria-hidden className="text-xs">
                  ✕
                </span>
              </IconButton>
            </div>
            {/* FLOW-043: one-line explanation of when this trigger enrols. */}
            {TRIGGER_HELP[t.type] ? (
              <p className="text-[11px] leading-snug text-muted-foreground">
                {TRIGGER_HELP[t.type]}
              </p>
            ) : null}
            {(meta?.fields ?? []).map((field) => {
              const value = t[field.key] == null ? "" : String(t[field.key]);
              const pickerEntity = PICKABLE_FIELDS[field.key];
              if (pickerEntity) {
                return (
                  <Suspense
                    key={field.key}
                    fallback={
                      <EntityPickerLoading
                        entity={pickerEntity}
                        value={value}
                        className="h-7 text-xs"
                        ariaLabel={field.key}
                      />
                    }
                  >
                    <EntityPicker
                      entity={pickerEntity}
                      value={value}
                      onChange={(v) => onUpdate(i, { [field.key]: v })}
                      className="h-7 text-xs"
                      aria-label={field.key}
                      disabled={readOnly}
                    />
                  </Suspense>
                );
              }
              if (field.type === "select" && field.options?.length) {
                return (
                  <Select
                    key={field.key}
                    aria-label={field.key}
                    className="h-7 text-xs"
                    value={value}
                    disabled={readOnly}
                    onChange={(event) =>
                      onUpdate(i, { [field.key]: event.target.value })
                    }
                  >
                    <option value="">
                      {field.required ? `${field.key} (required)` : field.key}
                    </option>
                    {field.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </Select>
                );
              }
              return (
                <Input
                  key={field.key}
                  aria-label={field.key}
                  className="h-7 text-xs"
                  type={field.type === "number" ? "number" : "text"}
                  placeholder={
                    field.required ? `${field.key} (required)` : field.key
                  }
                  value={value}
                  disabled={readOnly}
                  onChange={(event) =>
                    onUpdate(i, {
                      [field.key]:
                        field.type === "number" && event.target.value !== ""
                          ? Number(event.target.value)
                          : event.target.value,
                    })
                  }
                />
              );
            })}
          </div>
        );
      })}
      <Select
        className="w-full text-xs"
        value=""
        aria-label="Add trigger"
        disabled={readOnly}
        title={readOnly ? FLOW_READ_ONLY_MESSAGE : undefined}
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value);
        }}
      >
        <option value="">+ Add trigger…</option>
        {catalog.map((c) => (
          <option key={c.key} value={c.key} title={TRIGGER_HELP[c.key]}>
            {c.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
