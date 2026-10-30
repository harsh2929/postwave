// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Plus, Trash2, Workflow } from "lucide-react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createInboundTrigger,
  deleteInboundTrigger,
  getInboundWebhook,
  listInboundTriggers,
  updateInboundTrigger,
  type InboundTrigger,
  type InboundTriggerInput,
  type TriggerAction,
  type TriggerOperator,
} from "@/lib/inbound-webhooks-api";
import { flowsApi, type Flow } from "@/lib/flows-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  canAdminInboundWebhooks,
  INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE,
  isSameInboundWebhookAdminContext,
  settleInboundWebhookBatch,
  verifyFreshInboundWebhookAdmin,
} from "@/lib/inbound-webhook-authority";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { RelativeTime } from "@/components/relative-time";
import {
  DataSurfaceShell,
  QueryError,
  SectionSkeleton,
} from "@/components/integrations/data-surface";
import { simulateTrigger } from "@/lib/inbound-trigger-eval";
import { asRoute } from "@/lib/typed-routes";
import { base, qk, STALE } from "@/lib/query-keys";

const OPERATORS: TriggerOperator[] = ["equals", "contains", "exists", "regex"];
const ACTIONS: TriggerAction[] = [
  "add_to_sequence",
  "add_tag",
  "remove_tag",
  "start_automation",
];

const EMPTY: InboundTriggerInput = {
  name: "",
  active: true,
  match_jsonpath: "$.event_type",
  match_operator: "equals",
  match_value: "",
  email_jsonpath: "$.user.email",
  action_type: "add_to_sequence",
  action_target_id: "",
};

function isIdTarget(action: TriggerAction): boolean {
  return action === "add_to_sequence" || action === "start_automation";
}

export default function InboundWebhookTriggersPage() {
  const queryClient = useQueryClient();
  const params = useParams<{ id: string }>();
  const webhookID = params.id;

  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState<InboundTriggerInput>(EMPTY);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<InboundTrigger | null>(
    null,
  );
  // INTG-034: multi-select + bulk resume/pause/delete over triggers.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data;
  const tenantId = identity?.tenant_id ?? "anon";
  const effectiveRole = identity ? effectiveAuthRole(identity) : null;
  const canAdmin = canAdminInboundWebhooks(identity);
  const latestIdentityRef = useRef(identity);
  latestIdentityRef.current = identity;
  const inboundBaseKey = useMemo(
    () => [
      ...base("inbound-webhooks", tenantId, effectiveRole),
      identity?.user_id ?? "anon",
      Boolean(identity?.viewer_mode),
    ],
    [effectiveRole, identity?.user_id, identity?.viewer_mode, tenantId],
  );
  const triggersKey = useMemo(
    () => [...inboundBaseKey, "triggers", webhookID] as const,
    [inboundBaseKey, webhookID],
  );
  const endpointKey = useMemo(
    () => [...inboundBaseKey, "endpoint", webhookID] as const,
    [inboundBaseKey, webhookID],
  );
  const triggersQuery = useQuery({
    queryKey: triggersKey,
    queryFn: ({ signal }) => listInboundTriggers(webhookID, { signal }),
    enabled: canAdmin,
    staleTime: STALE.list,
  });
  // Fetch the parent endpoint so the header confirms which endpoint is being
  // configured (INTG-012) — otherwise only the opaque id sits in the route.
  const endpointQuery = useQuery({
    queryKey: endpointKey,
    queryFn: ({ signal }) => getInboundWebhook(webhookID, { signal }),
    enabled: canAdmin,
    staleTime: STALE.detail,
  });
  // Flows back the add_to_sequence / start_automation pickers (INTG-025/026).
  const flowsKey = useMemo(
    () => [...inboundBaseKey, "flow-targets"] as const,
    [inboundBaseKey],
  );
  const flowsQuery = useQuery({
    queryKey: flowsKey,
    // Not swallowed with `.catch(() => [])`: a failed fetch would then be
    // indistinguishable from a workspace with no sequences, and the picker
    // would silently vanish. The error branch below names the failure.
    queryFn: () => flowsApi.listAll(),
    enabled: canAdmin,
    staleTime: STALE.list,
  });
  const flows = useMemo(
    () => (Array.isArray(flowsQuery.data) ? flowsQuery.data : []),
    [flowsQuery.data],
  );
  const flowById = useMemo(() => {
    const map = new Map<string, Flow>();
    for (const f of flows) map.set(f.id, f);
    return map;
  }, [flows]);

  const items = useMemo(
    () =>
      Array.isArray(triggersQuery.data?.items) ? triggersQuery.data.items : [],
    [triggersQuery.data?.items],
  );
  const endpoint = endpointQuery.data ?? null;
  const loading =
    meQuery.isLoading || (triggersQuery.isPending && !triggersQuery.data);
  const loadError =
    triggersQuery.error instanceof Error
      ? triggersQuery.error.message
      : meQuery.error instanceof Error
        ? meQuery.error.message
        : triggersQuery.isError
          ? "Could not load triggers — this is a failed request, not an endpoint without triggers."
          : null;

  const error = actionError;

  useEffect(() => {
    if (!meQuery.isSuccess || canAdmin) return;
    const filter = { queryKey: ["inbound-webhooks"], exact: false } as const;
    void queryClient.cancelQueries(filter).finally(() => {
      queryClient.removeQueries(filter);
    });
    setSelected(new Set());
    setConfirmDelete(null);
    setBulkDeleteOpen(false);
  }, [canAdmin, meQuery.isSuccess, queryClient]);

  const verifyAdmin = async (): Promise<void> => {
    if (!identity || !canAdmin) {
      throw new Error(INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE);
    }
    await verifyFreshInboundWebhookAdmin(identity);
  };

  const canPublishAdminResult = (): boolean => {
    if (
      !identity ||
      !isSameInboundWebhookAdminContext(identity, latestIdentityRef.current)
    ) {
      queryClient.removeQueries({
        queryKey: ["inbound-webhooks"],
        exact: false,
      });
      setActionError(
        "Workspace authority changed while the request was in flight. Protected results were discarded; refresh to verify the server state.",
      );
      return false;
    }
    return true;
  };

  const invalidateInboundWebhooks = (): Promise<void> =>
    queryClient
      .invalidateQueries({
        queryKey: inboundBaseKey,
        exact: false,
      })
      .then(() => undefined);

  // Client-side validation mirrors the API's hard 400s (missing_name / missing
  // target for id-based actions) so we don't burn a doomed round-trip.
  const usesIdTarget = isIdTarget(draft.action_type);
  // A match value is only ignored by the `exists` operator; for
  // equals/contains/regex an empty value produces a trigger that can never fire.
  const matchValueRequired = draft.match_operator !== "exists";
  const onCreate = async (): Promise<void> => {
    if (!canAdmin) {
      setActionError(INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE);
      return;
    }
    if (!draft.name.trim()) {
      setActionError("Name is required");
      return;
    }
    if (!draft.match_jsonpath.trim()) {
      setActionError("Match JSONPath is required");
      return;
    }
    if (!draft.email_jsonpath.trim()) {
      setActionError("Email JSONPath is required");
      return;
    }
    if (!draft.action_target_id.trim()) {
      setActionError(
        usesIdTarget
          ? "Target sequence or automation is required"
          : "Tag name is required",
      );
      return;
    }
    if (matchValueRequired && !(draft.match_value ?? "").trim()) {
      setActionError(
        `Match value is required for the “${draft.match_operator}” operator`,
      );
      return;
    }
    setCreating(true);
    setActionError(null);
    try {
      await verifyAdmin();
      const created = await createInboundTrigger(webhookID, draft);
      if (!canPublishAdminResult()) return;
      queryClient.setQueryData<{ items: InboundTrigger[] }>(
        triggersKey,
        (cur) => ({
          items: [created, ...(cur?.items ?? [])],
        }),
      );
      setDraft(EMPTY);
      void invalidateInboundWebhooks();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  };

  const onToggleActive = async (t: InboundTrigger): Promise<void> => {
    if (togglingId) return;
    if (!canAdmin) {
      setActionError(INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE);
      return;
    }
    setTogglingId(t.id);
    setActionError(null);
    try {
      await verifyAdmin();
      const updated = await updateInboundTrigger(webhookID, t.id, {
        active: !t.active,
      });
      if (!canPublishAdminResult()) return;
      queryClient.setQueryData<{ items: InboundTrigger[] }>(
        triggersKey,
        (cur) => ({
          items: (Array.isArray(cur?.items) ? cur?.items : []).map((item) =>
            item.id === t.id ? updated : item,
          ),
        }),
      );
      void invalidateInboundWebhooks();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setTogglingId(null);
    }
  };

  // INTG-034 bulk actions over triggers (loop existing per-item mutations).
  const toggleSelect = (id: string): void => {
    if (!canAdmin) return;
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());
  const selectedIds = () =>
    items.filter((t) => selected.has(t.id)).map((t) => t.id);

  useEffect(() => {
    const visible = new Set(items.map((item) => item.id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => visible.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  const bulkSetActive = async (active: boolean): Promise<void> => {
    if (!canAdmin) {
      setActionError(INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE);
      return;
    }
    const ids = selectedIds();
    if (ids.length === 0) return;
    setBulkBusy(true);
    setActionError(null);
    try {
      const results = await settleInboundWebhookBatch(ids, async (id) => {
        await verifyAdmin();
        return updateInboundTrigger(webhookID, id, { active });
      });
      if (!canPublishAdminResult()) return;
      const failedIds = ids.filter(
        (_, index) => results[index]?.status === "rejected",
      );
      if (failedIds.length > 0) {
        setActionError(
          `${failedIds.length} of ${ids.length} could not be updated. Failed triggers remain selected.`,
        );
        setSelected(new Set(failedIds));
      } else {
        clearSelection();
      }
      void invalidateInboundWebhooks();
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkDelete = async (): Promise<void> => {
    if (!canAdmin) {
      setActionError(INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE);
      throw new Error(INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE);
    }
    const ids = selectedIds();
    if (ids.length === 0) return;
    setBulkBusy(true);
    setActionError(null);
    try {
      const results = await settleInboundWebhookBatch(ids, async (id) => {
        await verifyAdmin();
        return deleteInboundTrigger(webhookID, id);
      });
      if (!canPublishAdminResult()) return;
      const failedIds = ids.filter(
        (_, index) => results[index]?.status === "rejected",
      );
      if (failedIds.length > 0) {
        setActionError(
          `${failedIds.length} of ${ids.length} could not be deleted. Failed triggers remain selected.`,
        );
        setSelected(new Set(failedIds));
      } else {
        clearSelection();
      }
      setBulkDeleteOpen(false);
      void invalidateInboundWebhooks();
    } finally {
      setBulkBusy(false);
    }
  };

  const onDelete = async (id: string): Promise<void> => {
    if (!canAdmin) {
      setActionError(INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE);
      throw new Error(INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE);
    }
    setActionError(null);
    try {
      await verifyAdmin();
      await deleteInboundTrigger(webhookID, id);
      if (!canPublishAdminResult()) return;
      queryClient.setQueryData<{ items: InboundTrigger[] }>(
        triggersKey,
        (cur) => ({
          items: (Array.isArray(cur?.items) ? cur?.items : []).filter(
            (item) => item.id !== id,
          ),
        }),
      );
      void invalidateInboundWebhooks();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Delete failed");
      throw e;
    }
  };

  if (meQuery.isLoading || meQuery.isError) {
    return (
      <DataSurfaceShell className="max-w-6xl">
        <Breadcrumb
          items={[
            {
              label: "Inbound webhooks",
              href: asRoute("/app/inbound-webhooks"),
            },
            { label: "Triggers" },
          ]}
        />
        <div className="flex items-start gap-3">
          <Workflow
            className="size-6 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Triggers
          </h1>
        </div>
        {meQuery.isLoading ? (
          <SectionSkeleton rows={4} />
        ) : (
          <QueryError
            title="Workspace identity could not be loaded"
            description="Trigger reads and mutations are paused until the workspace context is verified."
            onRetry={() => void meQuery.refetch()}
          />
        )}
      </DataSurfaceShell>
    );
  }

  if (!identity || !canAdmin) {
    return (
      <DataSurfaceShell className="max-w-6xl">
        <Breadcrumb
          items={[
            {
              label: "Inbound webhooks",
              href: asRoute("/app/inbound-webhooks"),
            },
            { label: "Triggers" },
          ]}
        />
        <div className="flex items-start gap-3">
          <Workflow
            className="size-6 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              Inbound webhook triggers
            </h1>
            <p className="mt-2 text-sm text-muted-foreground" role="status">
              {INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE} No endpoint, trigger, or
              flow-target inventory was requested.
            </p>
          </div>
        </div>
      </DataSurfaceShell>
    );
  }

  return (
    <DataSurfaceShell className="max-w-6xl">
      <Breadcrumb
        items={[
          { label: "Inbound webhooks", href: asRoute("/app/inbound-webhooks") },
          { label: endpoint?.name ?? "Endpoint" },
          { label: "Triggers" },
        ]}
      />
      <div className="flex items-start gap-3">
        <Workflow
          className="h-6 w-6 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Triggers{endpoint ? ` · ${endpoint.name}` : ""}
          </h1>
          {endpoint ? (
            <p className="break-words text-sm leading-6 text-muted-foreground">
              Route events received at{" "}
              <code className="break-all rounded bg-muted px-1">
                /api/public/inbound/{endpoint.slug}
              </code>{" "}
              into sequences and tags.
            </p>
          ) : endpointQuery.isError ? (
            <p className="text-sm text-destructive">
              Could not load this endpoint’s details — its name and ingest URL
              are unavailable.
            </p>
          ) : null}
        </div>
      </div>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/5" role="alert">
          <CardContent className="p-3 text-sm text-destructive">
            {error}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="p-4 sm:p-5">
          <h2 className="text-lg font-semibold mb-3">+ Add trigger</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void onCreate();
            }}
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <Label htmlFor="t-name">Name</Label>
                <Input
                  id="t-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="VIP signup → onboarding sequence"
                  required
                />
              </div>
              <div>
                <Label htmlFor="t-match-path">Match JSONPath</Label>
                <Input
                  id="t-match-path"
                  value={draft.match_jsonpath}
                  onChange={(e) =>
                    setDraft({ ...draft, match_jsonpath: e.target.value })
                  }
                  placeholder="$.event_type"
                  required
                />
              </div>
              <div>
                <Label htmlFor="t-op">Operator</Label>
                <Select
                  id="t-op"
                  value={draft.match_operator}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      match_operator: e.target.value as TriggerOperator,
                    })
                  }
                >
                  {OPERATORS.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="t-val">Match value</Label>
                <Input
                  id="t-val"
                  value={draft.match_value ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, match_value: e.target.value })
                  }
                  placeholder='e.g. "user.created"'
                  disabled={draft.match_operator === "exists"}
                  required={matchValueRequired}
                  aria-describedby="t-val-hint"
                />
                <p
                  id="t-val-hint"
                  className="text-xs text-muted-foreground mt-1"
                >
                  {draft.match_operator === "exists"
                    ? "Not used — “exists” only checks that the JSONPath resolves."
                    : draft.match_operator === "regex"
                      ? "Required — a regular expression to test the resolved value against."
                      : "Required — the value the resolved JSONPath must match."}
                </p>
              </div>
              <div>
                <Label htmlFor="t-email-path">Email JSONPath</Label>
                <Input
                  id="t-email-path"
                  value={draft.email_jsonpath}
                  onChange={(e) =>
                    setDraft({ ...draft, email_jsonpath: e.target.value })
                  }
                  placeholder="$.user.email"
                  required
                />
              </div>
              <div>
                <Label htmlFor="t-action">Action</Label>
                <Select
                  id="t-action"
                  value={draft.action_type}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      action_type: e.target.value as TriggerAction,
                      action_target_id: "",
                    })
                  }
                >
                  {ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a.replaceAll("_", " ")}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="md:col-span-2">
                <Label htmlFor="t-target">
                  {usesIdTarget ? "Target sequence / automation" : "Tag"}
                </Label>
                {usesIdTarget && flowsQuery.isError ? (
                  <p className="mb-2 text-sm text-destructive">
                    Could not load your sequences and automations — paste the
                    target ID directly.
                  </p>
                ) : null}
                {usesIdTarget && flows.length > 0 ? (
                  <Select
                    aria-label="Pick a sequence or automation"
                    className="mb-2"
                    value={
                      flowById.has(draft.action_target_id)
                        ? draft.action_target_id
                        : ""
                    }
                    onChange={(e) =>
                      setDraft({ ...draft, action_target_id: e.target.value })
                    }
                  >
                    <option value="">Pick a sequence or automation…</option>
                    {flows.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name} ({f.status})
                      </option>
                    ))}
                  </Select>
                ) : null}
                <Input
                  id="t-target"
                  value={draft.action_target_id}
                  onChange={(e) =>
                    setDraft({ ...draft, action_target_id: e.target.value })
                  }
                  placeholder={
                    draft.action_type === "add_to_sequence" ? "seq_xxx" : "VIP"
                  }
                  className={usesIdTarget ? "font-mono" : undefined}
                  required
                  aria-describedby="t-target-hint"
                />
                <p
                  id="t-target-hint"
                  className="text-xs text-muted-foreground mt-1"
                >
                  {usesIdTarget
                    ? "Pick from the list above, or paste a sequence/automation ID directly."
                    : "The tag name to add or remove (created if it doesn’t exist)."}
                </p>
              </div>
            </div>

            <TriggerTestPanel draft={draft} />

            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="submit"
                loading={creating}
                className="w-full sm:w-auto"
              >
                <Plus className="w-4 h-4 mr-1" />
                {creating ? "Creating…" : "Add trigger"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <h2 className="text-lg font-semibold">
        Configured triggers ({items.length})
      </h2>

      {loading ? (
        <div className="grid gap-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : loadError ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="py-6 flex flex-col items-start gap-3 text-destructive">
            <p>{loadError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void meQuery.refetch();
                void triggersQuery.refetch();
              }}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-4">
            <EmptyState
              icon={Workflow}
              title="No triggers yet"
              description="Add a trigger above to start routing inbound events into sequences and tags. Use the tester to confirm your match rule before going live."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-2">
          {selected.size > 0 ? (
            <div className="sticky top-2 z-20 flex flex-col gap-3 rounded-lg border border-primary/30 bg-background/95 px-3 py-3 text-sm shadow-sm backdrop-blur sm:flex-row sm:items-center sm:px-4">
              <span className="font-medium tabular-nums">
                {selected.size} selected
              </span>
              <div className="grid w-full grid-cols-2 gap-2 sm:ml-auto sm:flex sm:w-auto sm:items-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={bulkBusy}
                  onClick={() => void bulkSetActive(true)}
                >
                  Resume
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={bulkBusy}
                  onClick={() => void bulkSetActive(false)}
                >
                  Pause
                </Button>
                <ConfirmDialog
                  open={bulkDeleteOpen}
                  onOpenChange={setBulkDeleteOpen}
                  title={`Delete ${selected.size} trigger${selected.size === 1 ? "" : "s"}?`}
                  description="The selected triggers will stop routing matched events. This cannot be undone."
                  confirmLabel="Delete"
                  confirmVariant="destructive"
                  onConfirm={bulkDelete}
                  trigger={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      loading={bulkBusy}
                      className="text-destructive hover:text-destructive"
                    >
                      Delete
                    </Button>
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={bulkBusy}
                  onClick={clearSelection}
                >
                  Clear
                </Button>
              </div>
            </div>
          ) : null}
          {items.map((t) => {
            const targetFlow = isIdTarget(t.action_type)
              ? flowById.get(t.action_target_id)
              : undefined;
            return (
              <Card key={t.id}>
                <CardContent className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-start sm:justify-between">
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/40 sm:min-h-9 sm:px-0">
                    <Checkbox
                      aria-label={`Select ${t.name}`}
                      checked={selected.has(t.id)}
                      onChange={() => toggleSelect(t.id)}
                    />
                    <span className="sm:sr-only">Select trigger</span>
                  </label>
                  <div className="flex-1 min-w-0">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <strong className="break-words">{t.name}</strong>
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          t.active
                            ? "bg-success text-success-foreground"
                            : "bg-muted"
                        }`}
                      >
                        {t.active ? "active" : "paused"}
                      </span>
                    </div>
                    <div className="break-words text-sm leading-6 text-muted-foreground">
                      When <code className="break-all">{t.match_jsonpath}</code>{" "}
                      {t.match_operator}{" "}
                      {t.match_value != null ? (
                        <code>{JSON.stringify(t.match_value)}</code>
                      ) : null}{" "}
                      → {t.action_type.replaceAll("_", " ")}{" "}
                      {isIdTarget(t.action_type) ? (
                        <Link
                          href={asRoute(
                            // Encoded: action_target_id is a free-text field
                            // the operator types, so it is not guaranteed to be
                            // a bare id — an unescaped "?" or "#" would rewrite
                            // the destination instead of opening the target.
                            `/app/flows/${encodeURIComponent(t.action_target_id)}`,
                          )}
                          className="inline-flex min-h-11 max-w-full items-center break-all rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                          title={
                            targetFlow
                              ? `Open ${targetFlow.name}`
                              : "Open target sequence / automation"
                          }
                        >
                          {targetFlow ? targetFlow.name : t.action_target_id}
                        </Link>
                      ) : (
                        <code>{t.action_target_id}</code>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Fired {t.fired_count}× ·{" "}
                      {t.last_fired_at ? (
                        <>
                          last fired <RelativeTime iso={t.last_fired_at} />
                        </>
                      ) : (
                        "never fired"
                      )}
                    </div>
                  </div>
                  <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      loading={togglingId === t.id}
                      disabled={Boolean(togglingId && togglingId !== t.id)}
                      onClick={() => void onToggleActive(t)}
                    >
                      {t.active ? "Pause" : "Resume"}
                    </Button>
                    <Tooltip label="Delete trigger">
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label="Delete trigger"
                        className="text-destructive"
                        onClick={() => setConfirmDelete(t)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </Tooltip>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmDelete(null);
        }}
        title="Delete this trigger?"
        description={
          confirmDelete
            ? `“${confirmDelete.name}” will stop routing matched events. This cannot be undone.`
            : ""
        }
        confirmLabel="Delete trigger"
        onConfirm={async () => {
          if (confirmDelete) await onDelete(confirmDelete.id);
        }}
      />
    </DataSurfaceShell>
  );
}

/**
 * Test a draft trigger against a sample payload before shipping it (INTG-023).
 * Evaluation is client-side and executes no side effects — it mirrors the
 * backend JSONPath + operator semantics.
 */
function TriggerTestPanel({ draft }: { draft: InboundTriggerInput }) {
  const [open, setOpen] = useState(false);
  const [sample, setSample] = useState(
    `{
  "event_type": "user.created",
  "user": { "email": "person@example.com" }
}`,
  );
  const [result, setResult] = useState<ReturnType<
    typeof simulateTrigger
  > | null>(null);

  function run() {
    setResult(
      simulateTrigger(sample, {
        match_jsonpath: draft.match_jsonpath,
        match_operator: draft.match_operator,
        match_value: draft.match_value,
        email_jsonpath: draft.email_jsonpath,
      }),
    );
  }

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-sm font-medium"
      >
        {open ? "Hide tester" : "Test against a sample payload"}
      </button>
      {open ? (
        <div className="mt-2 space-y-2">
          <Label htmlFor="t-sample" className="text-xs">
            Sample payload (JSON)
          </Label>
          <Textarea
            id="t-sample"
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            rows={5}
            className="font-mono text-xs"
            spellCheck={false}
          />
          <Button type="button" variant="outline" size="sm" onClick={run}>
            Run test
          </Button>
          {result ? (
            <div
              className="rounded border p-2 text-xs"
              role="status"
              aria-live="polite"
            >
              {result.parseError ? (
                <p className="text-destructive">
                  Invalid JSON: {result.parseError}
                </p>
              ) : result.matched ? (
                <>
                  <p className="font-medium text-success">✓ Rule matches</p>
                  {result.emailValid ? (
                    <p className="text-muted-foreground">
                      Resolved email:{" "}
                      <code className="rounded bg-background px-1">
                        {result.resolvedEmail}
                      </code>
                    </p>
                  ) : (
                    <p className="text-warning-emphasis">{result.note}</p>
                  )}
                </>
              ) : (
                <p className="text-muted-foreground">
                  ✗ Rule does not match this payload.
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
