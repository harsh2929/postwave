// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  KeyRound,
  Pencil,
  Plus,
  Search,
  Trash2,
  Webhook,
} from "lucide-react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createInboundWebhook,
  deleteInboundWebhook,
  listInboundWebhooks,
  rotateInboundWebhookSecret,
  updateInboundWebhook,
  type InboundWebhook,
  type InboundWebhookSecretResult,
} from "@/lib/inbound-webhooks-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  canAdminInboundWebhooks,
  INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE,
  isSameInboundWebhookAdminContext,
  settleInboundWebhookBatch,
  verifyFreshInboundWebhookAdmin,
} from "@/lib/inbound-webhook-authority";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { IntegrationsPageHeader } from "@/components/integrations/integrations-page-header";
import {
  DataSurfaceShell,
  QueryError,
  SectionSkeleton,
} from "@/components/integrations/data-surface";
import { InboundSigningHelp } from "@/components/integrations/inbound-signing-help";
import { TransformTester } from "@/components/integrations/transform-tester";
import { base, qk, STALE } from "@/lib/query-keys";

function DialogLoading({ label }: { label: string }) {
  return (
    <span className="sr-only" role="status" aria-live="polite">
      Loading {label}…
    </span>
  );
}

// The endpoint editor and the received-events viewer mount only when a row
// opens them, so they load then (as one chunk) instead of riding in the
// route's initial JavaScript, which sits at the bundle budget.
const InboundEndpointEditDialog = dynamic(
  () =>
    import("./endpoint-dialogs").then(
      (module) => module.InboundEndpointEditDialog,
    ),
  { ssr: false, loading: () => <DialogLoading label="endpoint editor" /> },
);
const InboundEventsDialog = dynamic(
  () =>
    import("./endpoint-dialogs").then((module) => module.InboundEventsDialog),
  { ssr: false, loading: () => <DialogLoading label="received events" /> },
);

/** Explicit API origin wins; otherwise the browser's public origin is used. */
const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? "";

function ingestUrl(origin: string, slug: string): string {
  return `${origin.replace(/\/$/, "")}/api/public/inbound/${slug}`;
}

async function copy(text: string): Promise<void> {
  // Confirm the copy with a sonner toast (matching the dashboard's copy idiom).
  // Surface a failure instead of silently swallowing it so the user always
  // knows the outcome.
  try {
    if (!navigator.clipboard) {
      throw new Error("Clipboard unavailable");
    }
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Couldn’t copy — select the value and copy manually");
  }
}

type PendingConfirm =
  | { kind: "rotate"; endpoint: InboundWebhook }
  | { kind: "delete"; endpoint: InboundWebhook }
  | null;

export default function InboundWebhooksPage() {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [transformJQ, setTransformJQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [apiOrigin, setApiOrigin] = useState(API_ORIGIN);
  const [search, setSearch] = useState("");
  const [confirm, setConfirm] = useState<PendingConfirm>(null);
  const [editing, setEditing] = useState<InboundWebhook | null>(null);
  const editTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [eventsFor, setEventsFor] = useState<InboundWebhook | null>(null);
  const eventsTriggerRef = useRef<HTMLButtonElement | null>(null);
  // INTG-034: multi-select + bulk enable/disable/delete over the endpoint list.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  // The plaintext secret is returned exactly once (on create/rotate).
  const [revealed, setRevealed] = useState<InboundWebhookSecretResult | null>(
    null,
  );

  useEffect(() => {
    if (!apiOrigin && typeof window !== "undefined") {
      setApiOrigin(window.location.origin);
    }
  }, [apiOrigin]);

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
  // Server-side search: the query param is part of the key so switching the
  // search term is a distinct, cached fetch (the API supports ?query=).
  const deferredSearch = useDeferredValue(search);
  const searchTerm = deferredSearch.trim();
  const inboundWebhooksKey = useMemo(
    () => [...inboundBaseKey, "endpoints", searchTerm] as const,
    [inboundBaseKey, searchTerm],
  );
  const inboundWebhooksQuery = useQuery({
    queryKey: inboundWebhooksKey,
    queryFn: ({ signal }) =>
      listInboundWebhooks(searchTerm || undefined, { signal }),
    enabled: canAdmin,
    staleTime: STALE.list,
  });
  const items = useMemo(
    () =>
      Array.isArray(inboundWebhooksQuery.data?.items)
        ? inboundWebhooksQuery.data.items
        : [],
    [inboundWebhooksQuery.data?.items],
  );
  const loading =
    meQuery.isLoading ||
    (inboundWebhooksQuery.isPending && !inboundWebhooksQuery.data);
  const loadError =
    inboundWebhooksQuery.error instanceof Error
      ? inboundWebhooksQuery.error.message
      : meQuery.error instanceof Error
        ? meQuery.error.message
        : inboundWebhooksQuery.isError
          ? "Could not load inbound webhooks — this is a failed request, not an empty list."
          : null;

  const error = actionError;

  // The endpoint inventory includes secret-management metadata and event
  // controls. Remove every cached variant on a downgrade instead of leaving a
  // previous admin response resident behind a disabled query.
  useEffect(() => {
    if (!meQuery.isSuccess || canAdmin) return;
    const filter = { queryKey: ["inbound-webhooks"], exact: false } as const;
    void queryClient.cancelQueries(filter).finally(() => {
      queryClient.removeQueries(filter);
    });
    setSelected(new Set());
    setRevealed(null);
    setEditing(null);
    setEventsFor(null);
    setConfirm(null);
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
      setRevealed(null);
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

  const patchEndpointInCache = (updated: InboundWebhook): void => {
    queryClient.setQueryData<{ items: InboundWebhook[] }>(
      inboundWebhooksKey,
      (cur) => ({
        items: (Array.isArray(cur?.items) ? cur?.items : []).map((endpoint) =>
          endpoint.id === updated.id ? updated : endpoint,
        ),
      }),
    );
  };

  const onCreate = async (): Promise<void> => {
    if (!canAdmin) {
      setActionError(INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE);
      return;
    }
    if (!name.trim()) {
      setActionError("Name is required");
      return;
    }
    setCreating(true);
    setActionError(null);
    try {
      await verifyAdmin();
      const res = await createInboundWebhook({
        name: name.trim(),
        transform_jq: transformJQ.trim() || undefined,
      });
      if (!canPublishAdminResult()) return;
      setRevealed(res);
      queryClient.setQueryData<{ items: InboundWebhook[] }>(
        inboundWebhooksKey,
        (cur) => ({
          items: [res.endpoint, ...(cur?.items ?? [])],
        }),
      );
      setName("");
      setTransformJQ("");
      void invalidateInboundWebhooks();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  };

  const onRotate = async (id: string): Promise<void> => {
    if (!canAdmin) {
      setActionError(INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE);
      throw new Error(INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE);
    }
    setActionError(null);
    try {
      await verifyAdmin();
      const res = await rotateInboundWebhookSecret(id);
      if (!canPublishAdminResult()) return;
      setRevealed(res);
      patchEndpointInCache(res.endpoint);
      void invalidateInboundWebhooks();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Rotate failed");
      throw e;
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
      await deleteInboundWebhook(id);
      if (!canPublishAdminResult()) return;
      queryClient.setQueryData<{ items: InboundWebhook[] }>(
        inboundWebhooksKey,
        (cur) => ({
          items: (Array.isArray(cur?.items) ? cur?.items : []).filter(
            (endpoint) => endpoint.id !== id,
          ),
        }),
      );
      if (revealed?.endpoint.id === id) setRevealed(null);
      void invalidateInboundWebhooks();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Delete failed");
      throw e;
    }
  };

  // INTG-034 bulk actions. No bulk endpoint exists, so each loops the existing
  // per-item mutation with allSettled and reports partial failure.
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
    items.filter((w) => selected.has(w.id)).map((w) => w.id);

  useEffect(() => {
    const visible = new Set(items.map((item) => item.id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => visible.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  const bulkSetEnabled = async (enabled: boolean): Promise<void> => {
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
        return updateInboundWebhook(id, { enabled });
      });
      if (!canPublishAdminResult()) return;
      const failedIds = ids.filter(
        (_, index) => results[index]?.status === "rejected",
      );
      if (failedIds.length > 0) {
        setActionError(
          `${failedIds.length} of ${ids.length} could not be updated. Failed endpoints remain selected.`,
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
        return deleteInboundWebhook(id);
      });
      if (!canPublishAdminResult()) return;
      const failedIds = ids.filter(
        (_, index) => results[index]?.status === "rejected",
      );
      if (failedIds.length > 0) {
        setActionError(
          `${failedIds.length} of ${ids.length} could not be deleted. Failed endpoints remain selected.`,
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

  if (meQuery.isLoading || meQuery.isError) {
    return (
      <DataSurfaceShell className="max-w-6xl">
        <IntegrationsPageHeader
          icon={Webhook}
          title="Inbound webhooks"
          description="Receive events from external systems at a signed ingest URL, transform the payload with jq, then route matches into sequences and tags."
        />
        {meQuery.isLoading ? (
          <SectionSkeleton rows={4} />
        ) : (
          <QueryError
            title="Workspace identity could not be loaded"
            description="Endpoint reads and mutations are paused until the workspace context is verified."
            onRetry={() => void meQuery.refetch()}
          />
        )}
      </DataSurfaceShell>
    );
  }

  if (!identity || !canAdmin) {
    return (
      <DataSurfaceShell className="max-w-6xl">
        <IntegrationsPageHeader
          icon={Webhook}
          title="Inbound webhooks"
          description="Receive signed events from external systems and route verified payloads into Moosewave."
        />
        <Card className="border-border bg-muted/30" role="status">
          <CardContent className="space-y-1 py-6">
            <h2 className="font-semibold">Administrator access required</h2>
            <p className="text-sm text-muted-foreground">
              {INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE} No endpoint inventory, event
              payload, signing-secret control, or trigger configuration was
              requested.
            </p>
          </CardContent>
        </Card>
      </DataSurfaceShell>
    );
  }

  return (
    <DataSurfaceShell className="max-w-6xl">
      <IntegrationsPageHeader
        icon={Webhook}
        title="Inbound webhooks"
        description="Receive events from external systems at a signed ingest URL, transform the payload with jq, then route matches into sequences and tags."
      />

      {error ? (
        <Card className="border-destructive/40 bg-destructive/5" role="alert">
          <CardContent className="p-3 text-sm text-destructive">
            {error}
          </CardContent>
        </Card>
      ) : null}

      {revealed ? (
        <Card className="border-success/40 bg-success/5">
          <CardContent className="py-4">
            <h2 className="text-lg font-semibold mb-1">
              Signing secret for “{revealed.endpoint.name}”
            </h2>
            <p className="text-sm text-muted-foreground mb-3">
              Copy this now — it is shown only once and cannot be retrieved
              later.
            </p>
            <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              {/* Shown only once: allow wrap/scroll rather than truncate so the
                  operator can read the full secret, not just copy it. */}
              <code className="flex-1 min-w-0 break-all rounded bg-muted px-3 py-2 text-sm">
                {revealed.secret}
              </code>
              <Button
                variant="outline"
                size="sm"
                className="w-full shrink-0 sm:w-auto"
                onClick={() => void copy(revealed.secret)}
              >
                <Copy className="w-4 h-4 mr-1" />
                Copy secret
              </Button>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="flex-1 min-w-0 break-all rounded bg-muted px-3 py-2 text-sm">
                {ingestUrl(apiOrigin, revealed.endpoint.slug)}
              </code>
              <Button
                variant="outline"
                size="sm"
                className="w-full shrink-0 sm:w-auto"
                disabled={!apiOrigin}
                onClick={() =>
                  void copy(ingestUrl(apiOrigin, revealed.endpoint.slug))
                }
              >
                <Copy className="w-4 h-4 mr-1" />
                Copy URL
              </Button>
            </div>
            <InboundSigningHelp />
            <div className="flex justify-end mt-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRevealed(null)}
              >
                Done
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="p-4 sm:p-5">
          <h2 className="text-lg font-semibold mb-3">+ New endpoint</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void onCreate();
            }}
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <Label htmlFor="wh-name">Name</Label>
                <Input
                  id="wh-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Typeform → onboarding"
                  required
                />
              </div>
              <div className="md:col-span-2">
                <Label htmlFor="wh-jq">Transform (jq, optional)</Label>
                <Textarea
                  id="wh-jq"
                  value={transformJQ}
                  onChange={(e) => setTransformJQ(e.target.value)}
                  rows={3}
                  className="font-mono text-xs"
                  spellCheck={false}
                  placeholder=". + { email: .form_response.answers[0].email }"
                />
                <TransformTester
                  transformJQ={transformJQ}
                  identity={identity}
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <Button
                type="submit"
                loading={creating}
                className="w-full sm:w-auto"
              >
                <Plus className="w-4 h-4 mr-1" />
                {creating ? "Creating…" : "Create endpoint"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">Endpoints ({items.length})</h2>
        <div className="relative w-full sm:max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search endpoints…"
            aria-label="Search endpoints"
            className="pl-8 text-base sm:text-sm"
          />
        </div>
      </div>

      {loading ? (
        <div className="grid min-w-0 gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
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
                void inboundWebhooksQuery.refetch();
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
              icon={Webhook}
              title={
                searchTerm ? "No matching endpoints" : "No inbound webhooks yet"
              }
              description={
                searchTerm
                  ? "No endpoints match your search. Try a different term."
                  : "Create an endpoint above to get a signed ingest URL. Point Typeform, Stripe, or any external system at it, then route matched events into sequences and tags."
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid min-w-0 gap-2">
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
                  onClick={() => void bulkSetEnabled(true)}
                >
                  Enable
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={bulkBusy}
                  onClick={() => void bulkSetEnabled(false)}
                >
                  Disable
                </Button>
                <ConfirmDialog
                  open={bulkDeleteOpen}
                  onOpenChange={setBulkDeleteOpen}
                  title={`Delete ${selected.size} endpoint${selected.size === 1 ? "" : "s"}?`}
                  description="The selected inbound endpoints and their ingest URLs will stop working. This cannot be undone."
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
          {items.map((wh) => (
            <Card key={wh.id} className="min-w-0 max-w-full">
              <CardContent className="flex min-w-0 flex-col gap-3 p-3.5 sm:flex-row sm:items-start sm:justify-between">
                <label className="flex min-h-11 min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/40 sm:min-h-9 sm:px-0">
                  <Checkbox
                    aria-label={`Select ${wh.name}`}
                    checked={selected.has(wh.id)}
                    onChange={() => toggleSelect(wh.id)}
                  />
                  <span className="sm:sr-only">Select endpoint</span>
                </label>
                <div className="flex-1 min-w-0">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <strong className="break-words">{wh.name}</strong>
                    <span
                      className={`text-xs px-2 py-0.5 rounded ${
                        wh.enabled
                          ? "bg-success text-success-foreground"
                          : "bg-muted"
                      }`}
                    >
                      {wh.enabled ? "enabled" : "disabled"}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={!apiOrigin}
                    onClick={() => void copy(ingestUrl(apiOrigin, wh.slug))}
                    className="inline-flex min-h-11 w-full min-w-0 max-w-full items-center gap-1 rounded-sm text-left text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8 sm:w-auto"
                    title="Copy ingest URL"
                  >
                    <code className="min-w-0 flex-1 truncate">
                      {ingestUrl(apiOrigin, wh.slug)}
                    </code>
                    <Copy className="w-3 h-3 shrink-0" />
                  </button>
                </div>
                <div className="grid min-w-0 max-w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:flex-wrap sm:justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(event) => {
                      eventsTriggerRef.current = event.currentTarget;
                      setEventsFor(wh);
                    }}
                  >
                    Events
                  </Button>
                  <Button asChild variant="outline" size="sm">
                    <Link
                      href={`/app/inbound-webhooks/${encodeURIComponent(wh.id)}/triggers`}
                    >
                      Triggers
                    </Link>
                  </Button>
                  <Tooltip label="Edit endpoint">
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="Edit endpoint"
                      onClick={(event) => {
                        editTriggerRef.current = event.currentTarget;
                        setEditing(wh);
                      }}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                  </Tooltip>
                  <Tooltip label="Rotate signing secret">
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="Rotate signing secret"
                      onClick={() =>
                        setConfirm({ kind: "rotate", endpoint: wh })
                      }
                    >
                      <KeyRound className="w-4 h-4" />
                    </Button>
                  </Tooltip>
                  <Tooltip label="Delete endpoint">
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="Delete endpoint"
                      className="text-destructive"
                      onClick={() =>
                        setConfirm({ kind: "delete", endpoint: wh })
                      }
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </Tooltip>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {editing ? (
        <InboundEndpointEditDialog
          endpoint={editing}
          identity={identity}
          open={editing !== null}
          returnFocusRef={editTriggerRef}
          onOpenChange={(next) => {
            if (!next) setEditing(null);
          }}
          onSaved={(updated) => {
            if (!canPublishAdminResult()) return;
            patchEndpointInCache(updated);
            void invalidateInboundWebhooks();
            setEditing(null);
          }}
        />
      ) : null}

      {eventsFor ? (
        <InboundEventsDialog
          endpointId={eventsFor.id}
          endpointName={eventsFor.name}
          identity={identity}
          baseKey={inboundBaseKey}
          open={eventsFor !== null}
          returnFocusRef={eventsTriggerRef}
          onOpenChange={(next) => {
            if (!next) setEventsFor(null);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(next) => {
          if (!next) setConfirm(null);
        }}
        title={
          confirm?.kind === "delete"
            ? "Delete this endpoint?"
            : "Rotate the signing secret?"
        }
        description={
          confirm?.kind === "delete"
            ? "The ingest URL stops working immediately and received-event history is lost. This cannot be undone."
            : "A new secret is issued now and shown once. The old secret keeps working for a 24-hour grace window, then stops."
        }
        confirmLabel={
          confirm?.kind === "delete" ? "Delete endpoint" : "Rotate secret"
        }
        confirmVariant={confirm?.kind === "delete" ? "destructive" : "default"}
        onConfirm={async () => {
          if (!confirm) return;
          if (confirm.kind === "delete") await onDelete(confirm.endpoint.id);
          else await onRotate(confirm.endpoint.id);
        }}
      />
    </DataSurfaceShell>
  );
}
