// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Webhook as WebhookIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RelativeTime } from "@/components/relative-time";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  OUTBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE,
  canAdminOutboundWebhooks,
  confirmFreshOutboundWebhookAdmin,
} from "@/lib/outbound-webhook-authority";
import { qk, STALE } from "@/lib/query-keys";
import {
  ALL_WEBHOOK_EVENTS,
  type Webhook,
  type WebhookEvent,
  type WebhookStatus,
  createWebhook,
  deleteWebhook,
  listWebhooks,
  reenableWebhook,
  testWebhook,
  rotateWebhookSecret,
  updateWebhook,
} from "@/lib/webhooks-api";
import {
  WEBHOOK_EVENT_DESCRIPTIONS,
  filterWebhookEvents,
  groupWebhookEvents,
} from "@/lib/webhook-events";

type WriteScope = {
  controller: AbortController;
  identityStamp: string;
  lockKey: string;
};

// The owner-email auto-pause preference is an admin-only card above the
// endpoint table with its own settings read/write; it loads after first paint
// so the route's eager chunk stays inside the bundle budget. The fallback keeps
// the card's silhouette so the table below does not jump when it mounts.
const WebhookOwnerEmailPreferenceCard = dynamic(
  () =>
    import("@/components/settings/webhook-owner-email-preference-card").then(
      (mod) => mod.WebhookOwnerEmailPreferenceCard,
    ),
  {
    loading: () => (
      <Card role="status" aria-label="Loading owner email preference" aria-busy>
        <CardHeader>
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    ),
  },
);

function StatusBadge({ status }: { status: WebhookStatus }) {
  if (status === "active") {
    return (
      <Badge className="border-success/30 bg-success/15 text-success-emphasis hover:bg-success/15">
        Active
      </Badge>
    );
  }
  if (status === "paused") return <Badge variant="secondary">Paused</Badge>;
  return <Badge variant="destructive">Failing</Badge>;
}

function errText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** URL + grouped event picker shared by the Create and Edit dialogs (SETA-037). */
function WebhookForm({
  url,
  setUrl,
  selected,
  setSelected,
  disabled = false,
  errorId,
}: {
  url: string;
  setUrl: (v: string) => void;
  selected: WebhookEvent[];
  setSelected: (updater: (cur: WebhookEvent[]) => WebhookEvent[]) => void;
  disabled?: boolean;
  errorId?: string;
}) {
  const [filter, setFilter] = useState("");
  const visible = useMemo(() => filterWebhookEvents(filter), [filter]);
  const visibleGroups = useMemo(() => groupWebhookEvents(visible), [visible]);
  const allVisibleSelected =
    visible.length > 0 && visible.every((e) => selected.includes(e));

  const toggle = (e: WebhookEvent) =>
    setSelected((cur) =>
      cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e],
    );

  const setGroup = (events: WebhookEvent[], on: boolean) =>
    setSelected((cur) => {
      const set = new Set(cur);
      for (const e of events) {
        if (on) set.add(e);
        else set.delete(e);
      }
      return ALL_WEBHOOK_EVENTS.filter((e) => set.has(e));
    });

  return (
    <div className="space-y-4 py-2">
      <div className="space-y-2">
        <Label htmlFor="wh-url">URL</Label>
        <Input
          id="wh-url"
          placeholder="https://api.example.com/hook"
          value={url}
          disabled={disabled}
          aria-describedby={errorId}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label>Events</Label>
          <span className="text-xs text-muted-foreground">
            {selected.length} selected
          </span>
        </div>
        <Input
          type="search"
          placeholder="Filter events…"
          value={filter}
          disabled={disabled}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter events"
        />
        <div className="flex items-center justify-between border-b pb-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={allVisibleSelected}
              disabled={disabled}
              onChange={(e) => setGroup(visible, e.target.checked)}
            />
            Select all {filter ? "shown" : ""}
          </label>
        </div>
        <div className="max-h-64 space-y-3 overflow-auto rounded-md border p-3">
          {visibleGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No events match “{filter}”.
            </p>
          ) : (
            visibleGroups.map((group) => {
              const groupAll = group.events.every((e) => selected.includes(e));
              const groupSome = group.events.some((e) => selected.includes(e));
              return (
                <div key={group.prefix} className="space-y-1.5">
                  <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <Checkbox
                      checked={groupAll}
                      indeterminate={!groupAll && groupSome}
                      disabled={disabled}
                      onChange={(e) => setGroup(group.events, e.target.checked)}
                    />
                    {group.prefix}
                  </label>
                  <div className="space-y-1 pl-6">
                    {group.events.map((e) => (
                      <label
                        key={e}
                        className="flex cursor-pointer items-start gap-2 text-sm"
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={selected.includes(e)}
                          disabled={disabled}
                          onChange={() => toggle(e)}
                        />
                        <span className="min-w-0">
                          <span className="block font-mono text-xs">{e}</span>
                          <span className="block text-xs text-muted-foreground">
                            {WEBHOOK_EVENT_DESCRIPTIONS[e]}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export default function WebhooksPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Webhook | null>(null);
  const [secretOpen, setSecretOpen] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState("");
  const [secretStored, setSecretStored] = useState(false);
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<WebhookEvent[]>([]);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const createErrorRef = useRef<HTMLParagraphElement>(null);
  const editErrorRef = useRef<HTMLParagraphElement>(null);
  const createReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const editReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const secretReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [editUrl, setEditUrl] = useState("");
  const [editSelected, setEditSelected] = useState<WebhookEvent[]>([]);
  const [changingId, setChangingId] = useState<string | null>(null);
  const [copyingSecret, setCopyingSecret] = useState(false);
  const copyingSecretRef = useRef(false);
  const [secretError, setSecretError] = useState<string | null>(null);
  const secretErrorRef = useRef<HTMLParagraphElement>(null);
  const secretOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writeLocksRef = useRef(new Set<string>());
  const writeControllersRef = useRef(new Set<AbortController>());
  const secretIdentityStampRef = useRef<string | null>(null);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data ?? null;
  const tenantId = identity?.tenant_id ?? "anon";
  const role = identity ? effectiveAuthRole(identity) : null;
  const viewerMode = Boolean(identity?.viewer_mode);
  const canAdmin = canAdminOutboundWebhooks(identity);
  const webhooksScopeKey = useMemo(
    () => qk.settings(tenantId, role, "webhooks"),
    [role, tenantId],
  );
  const webhooksKey = useMemo(
    () =>
      [
        ...webhooksScopeKey,
        identity?.user_id ?? "anon",
        viewerMode ? "viewer-mode" : "durable-mode",
      ] as const,
    [identity?.user_id, viewerMode, webhooksScopeKey],
  );
  const identityStamp = `${identity?.user_id ?? "anon"}\u0000${tenantId}\u0000${role ?? "none"}\u0000${viewerMode ? "viewer" : "durable"}`;
  const identityStampRef = useRef(identityStamp);
  identityStampRef.current = identityStamp;
  const previousIdentityRef = useRef<{
    stamp: string;
    key: readonly unknown[];
  } | null>(null);
  const webhooksQuery = useQuery({
    queryKey: webhooksKey,
    queryFn: ({ signal }) => listWebhooks({ signal }),
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.list,
  });
  const hooks = Array.isArray(webhooksQuery.data) ? webhooksQuery.data : [];
  const loading =
    meQuery.isPending ||
    (canAdmin && webhooksQuery.isPending && !webhooksQuery.data);
  const identityError = meQuery.error instanceof Error;
  const loadError = canAdmin && webhooksQuery.isError;

  const clearProtectedState = () => {
    writeControllersRef.current.forEach((controller) => controller.abort());
    writeControllersRef.current.clear();
    writeLocksRef.current.clear();
    savingRef.current = false;
    copyingSecretRef.current = false;
    if (secretOpenTimerRef.current) {
      clearTimeout(secretOpenTimerRef.current);
      secretOpenTimerRef.current = null;
    }
    secretIdentityStampRef.current = null;
    setCreateOpen(false);
    setEditing(null);
    setSecretOpen(false);
    setRevealedSecret("");
    setSecretStored(false);
    setUrl("");
    setSelected([]);
    setEditUrl("");
    setEditSelected([]);
    setCreateError(null);
    setEditError(null);
    setSecretError(null);
    setSaving(false);
    setChangingId(null);
    setCopyingSecret(false);
  };

  useEffect(() => {
    const previous = previousIdentityRef.current;
    if (previous && previous.stamp !== identityStamp) {
      clearProtectedState();
      void queryClient.cancelQueries({ queryKey: previous.key });
      queryClient.removeQueries({ queryKey: previous.key });
    }
    previousIdentityRef.current = { stamp: identityStamp, key: webhooksKey };
  }, [identityStamp, queryClient, webhooksKey]);

  useEffect(() => {
    if (meQuery.isPending || (meQuery.isSuccess && canAdmin)) return;
    clearProtectedState();
    void queryClient.cancelQueries({ queryKey: webhooksScopeKey });
    queryClient.removeQueries({ queryKey: webhooksScopeKey });
  }, [
    canAdmin,
    meQuery.isPending,
    meQuery.isSuccess,
    queryClient,
    webhooksScopeKey,
  ]);

  useEffect(() => {
    if (!webhooksQuery.isError) return;
    toast.error(
      "Could not load webhooks — this is a failed request, not an empty list.",
    );
  }, [webhooksQuery.isError]);

  useEffect(() => {
    if (createError) createErrorRef.current?.focus();
  }, [createError]);
  useEffect(() => {
    if (editError) editErrorRef.current?.focus();
  }, [editError]);
  useEffect(() => {
    if (secretError) secretErrorRef.current?.focus();
  }, [secretError]);
  useEffect(
    () => () => {
      if (secretOpenTimerRef.current) clearTimeout(secretOpenTimerRef.current);
      writeControllersRef.current.forEach((controller) => controller.abort());
    },
    [],
  );

  // ⌘K "Add webhook" deep-link opens the create dialog (SETA-054).
  useEffect(() => {
    if (typeof window === "undefined" || !meQuery.isSuccess || !canAdmin)
      return;
    if (new URLSearchParams(window.location.search).get("create") === "1") {
      setCreateOpen(true);
    }
  }, [canAdmin, meQuery.isSuccess]);

  const invalidateWebhooks = (): Promise<void> =>
    queryClient
      .invalidateQueries({ queryKey: webhooksKey, exact: true })
      .then(() => undefined);

  const beginWrite = (
    lockKey: string,
    markSaving = false,
  ): WriteScope | null => {
    if (!meQuery.isSuccess || !identity || !canAdmin) {
      toast.error(OUTBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE);
      return null;
    }
    if (writeLocksRef.current.has(lockKey)) return null;
    const controller = new AbortController();
    writeLocksRef.current.add(lockKey);
    writeControllersRef.current.add(controller);
    if (markSaving) {
      savingRef.current = true;
      setSaving(true);
    }
    return { controller, identityStamp, lockKey };
  };

  const finishWrite = (scope: WriteScope, markSaving = false) => {
    writeLocksRef.current.delete(scope.lockKey);
    writeControllersRef.current.delete(scope.controller);
    if (markSaving) finishSaving();
  };

  const verifyWrite = async (scope: WriteScope) => {
    await confirmFreshOutboundWebhookAdmin(identity, scope.controller.signal);
    if (identityStampRef.current !== scope.identityStamp) {
      throw new Error(
        "Your outbound-webhook authority changed. Nothing was changed.",
      );
    }
  };

  const responseIsCurrent = (scope: WriteScope): boolean =>
    !scope.controller.signal.aborted &&
    identityStampRef.current === scope.identityStamp;

  const finishSaving = () => {
    savingRef.current = false;
    setSaving(false);
  };

  const validationError = (
    candidateUrl: string,
    events: WebhookEvent[],
  ): string | null => {
    if (!candidateUrl.trim().startsWith("https://"))
      return "URL must use HTTPS.";
    if (events.length === 0) return "Pick at least one event.";
    return null;
  };

  const revealSecretAfterCurrentDialog = (
    secret: string,
    scopeStamp: string,
  ) => {
    if (identityStampRef.current !== scopeStamp) return;
    secretIdentityStampRef.current = scopeStamp;
    setRevealedSecret(secret);
    setSecretStored(false);
    setSecretError(null);
    if (secretOpenTimerRef.current) clearTimeout(secretOpenTimerRef.current);
    secretOpenTimerRef.current = setTimeout(() => {
      secretOpenTimerRef.current = null;
      if (identityStampRef.current !== scopeStamp) {
        setRevealedSecret("");
        secretIdentityStampRef.current = null;
        return;
      }
      setSecretOpen(true);
    }, 0);
  };

  const editUnchanged = editing
    ? editUrl.trim() === editing.url.trim() &&
      editSelected.length === editing.events.length &&
      editSelected.every((event) => editing.events.includes(event))
    : true;

  const handleCreate = async () => {
    const intent = { url: url.trim(), events: [...selected] };
    const invalid = validationError(intent.url, intent.events);
    if (invalid) {
      setCreateError(invalid);
      toast.error(invalid);
      return;
    }
    const scope = beginWrite("form", true);
    if (!scope) return;
    setCreateError(null);
    try {
      await verifyWrite(scope);
      const res = await createWebhook(intent, {
        signal: scope.controller.signal,
      });
      if (!responseIsCurrent(scope)) return;
      queryClient.setQueryData<Webhook[]>(webhooksKey, (cur) => [
        res.webhook,
        ...(cur ?? []),
      ]);
      secretReturnFocusRef.current = createReturnFocusRef.current;
      revealSecretAfterCurrentDialog(res.secret, scope.identityStamp);
      setUrl("");
      setSelected([]);
      setCreateOpen(false);
      setTimeout(() => createReturnFocusRef.current?.focus(), 0);
      void invalidateWebhooks();
    } catch (err) {
      if (!responseIsCurrent(scope)) return;
      const message = errText(err, "Could not create webhook.");
      setCreateError(message);
      toast.error(message);
    } finally {
      finishWrite(scope, true);
    }
  };

  const openEdit = (hook: Webhook, trigger: HTMLButtonElement) => {
    if (!canAdmin) return;
    editReturnFocusRef.current = trigger;
    setEditing(structuredClone(hook));
    setEditUrl(hook.url);
    setEditSelected([...hook.events]);
    setEditError(null);
  };

  // Send the complete intended state (url + events) so PATCH-replace semantics
  // preserve the signing secret + delivery history (SETA-002).
  const handleEditSave = async () => {
    if (!editing) return;
    const intent = {
      id: editing.id,
      url: editUrl.trim(),
      events: [...editSelected],
    };
    const invalid = validationError(intent.url, intent.events);
    if (invalid) {
      setEditError(invalid);
      toast.error(invalid);
      return;
    }
    if (editUnchanged) {
      setEditError("No changes to save.");
      return;
    }
    const scope = beginWrite("form", true);
    if (!scope) return;
    setEditError(null);
    try {
      await verifyWrite(scope);
      const updated = await updateWebhook(
        intent.id,
        { url: intent.url, events: intent.events },
        { signal: scope.controller.signal },
      );
      if (!responseIsCurrent(scope)) return;
      queryClient.setQueryData<Webhook[]>(webhooksKey, (cur) =>
        (cur ?? []).map((h) => (h.id === updated.id ? updated : h)),
      );
      toast.success("Webhook updated.");
      setEditing(null);
      setTimeout(() => editReturnFocusRef.current?.focus(), 0);
      void invalidateWebhooks();
    } catch (err) {
      if (!responseIsCurrent(scope)) return;
      const message = errText(err, "Could not update webhook.");
      setEditError(message);
      toast.error(message);
    } finally {
      finishWrite(scope, true);
    }
  };

  const handleDelete = async (id: string) => {
    const intent = { id };
    const scope = beginWrite(`webhook:${intent.id}`);
    if (!scope) return;
    try {
      await verifyWrite(scope);
      await deleteWebhook(intent.id, { signal: scope.controller.signal });
      if (!responseIsCurrent(scope)) return;
      queryClient.setQueryData<Webhook[]>(webhooksKey, (cur) =>
        (cur ?? []).filter((h) => h.id !== intent.id),
      );
      toast.success("Webhook removed.");
      void invalidateWebhooks();
    } catch (err) {
      if (!responseIsCurrent(scope)) return;
      toast.error(errText(err, "Delete failed."));
      throw err;
    } finally {
      finishWrite(scope);
    }
  };

  const handleTest = async (id: string) => {
    const intent = { id };
    const scope = beginWrite(`webhook:${intent.id}`);
    if (!scope) return;
    try {
      await verifyWrite(scope);
      const res = await testWebhook(intent.id, {
        signal: scope.controller.signal,
      });
      if (!responseIsCurrent(scope)) return;
      if (res.ok) {
        toast.success(`Delivered (${res.statusCode}, ${res.responseMs}ms).`);
      } else {
        toast.error(`Endpoint returned ${res.statusCode}.`);
      }
      void invalidateWebhooks();
    } catch (err) {
      if (!responseIsCurrent(scope)) return;
      toast.error(errText(err, "Test delivery failed."));
    } finally {
      finishWrite(scope);
    }
  };

  const handleRotateSecret = async (id: string) => {
    const intent = { id };
    const scope = beginWrite(`webhook:${intent.id}`);
    if (!scope) return;
    try {
      await verifyWrite(scope);
      const res = await rotateWebhookSecret(intent.id, {
        signal: scope.controller.signal,
      });
      if (!responseIsCurrent(scope)) return;
      revealSecretAfterCurrentDialog(res.secret, scope.identityStamp);
      toast.success("Signing secret rotated.");
    } catch (err) {
      if (!responseIsCurrent(scope)) return;
      toast.error(errText(err, "Could not rotate the signing secret."));
      throw err;
    } finally {
      finishWrite(scope);
    }
  };

  const handleStatusChange = async (webhook: Webhook) => {
    const intent = { id: webhook.id, status: webhook.status };
    const scope = beginWrite(`webhook:${intent.id}`);
    if (!scope) return;
    setChangingId(intent.id);
    try {
      await verifyWrite(scope);
      if (intent.status === "active") {
        await updateWebhook(
          intent.id,
          { status: "paused" },
          { signal: scope.controller.signal },
        );
        if (!responseIsCurrent(scope)) return;
        queryClient.setQueryData<Webhook[]>(webhooksKey, (cur) =>
          (cur ?? []).map((item) =>
            item.id === intent.id ? { ...item, status: "paused" } : item,
          ),
        );
        toast.success("Webhook paused.");
      } else {
        await reenableWebhook(intent.id, { signal: scope.controller.signal });
        if (!responseIsCurrent(scope)) return;
        queryClient.setQueryData<Webhook[]>(webhooksKey, (cur) =>
          (cur ?? []).map((item) =>
            item.id === intent.id ? { ...item, status: "active" } : item,
          ),
        );
        toast.success("Webhook re-enabled.");
      }
      void invalidateWebhooks();
    } catch (err) {
      if (!responseIsCurrent(scope)) return;
      toast.error(errText(err, "Could not change webhook status."));
    } finally {
      finishWrite(scope);
      if (identityStampRef.current === scope.identityStamp) setChangingId(null);
    }
  };

  const handleCopySecret = async () => {
    if (copyingSecretRef.current) return;
    copyingSecretRef.current = true;
    setCopyingSecret(true);
    setSecretError(null);
    try {
      if (
        !canAdmin ||
        !revealedSecret ||
        secretIdentityStampRef.current !== identityStamp
      ) {
        throw new Error("The signing secret is no longer available.");
      }
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(revealedSecret);
        toast.success("Secret copied.");
        return;
      }
      throw new Error(
        "Clipboard unavailable. Select and copy the secret manually.",
      );
    } catch (cause: unknown) {
      const message = errText(cause, "Could not copy secret.");
      setSecretError(message);
      toast.error(message);
    } finally {
      copyingSecretRef.current = false;
      setCopyingSecret(false);
    }
  };

  const clearSecretReveal = () => {
    setSecretOpen(false);
    setRevealedSecret("");
    setSecretStored(false);
    setSecretError(null);
    secretIdentityStampRef.current = null;
    setTimeout(() => secretReturnFocusRef.current?.focus(), 0);
  };

  const handleSecretOpenChange = (next: boolean) => {
    if (!next && copyingSecretRef.current) return;
    if (!next && !secretStored) {
      toast.warning("Confirm you've saved the secret before closing.");
      return;
    }
    if (!next) {
      clearSecretReveal();
      return;
    }
    setSecretOpen(true);
  };

  const handleDoneSecret = () => {
    if (!secretStored) return;
    clearSecretReveal();
  };

  // SETA-049: shared action buttons so the desktop table cell and the mobile
  // card render the exact same controls.
  const hookActions = (h: (typeof hooks)[number]) => (
    <>
      {canAdmin ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={changingId === h.id}
            onClick={() => void handleStatusChange(h)}
          >
            {h.status === "active" ? "Pause" : "Re-enable"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={(event) => openEdit(h, event.currentTarget)}
          >
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => handleTest(h.id)}
          >
            Test
          </Button>
        </>
      ) : null}
      <Button asChild variant="ghost" size="sm" type="button">
        <Link href={`/app/settings/webhooks/${h.id}/deliveries`}>
          Deliveries
        </Link>
      </Button>
      {canAdmin ? (
        <ConfirmDialog
          title="Rotate signing secret?"
          description="A new secret is minted and shown once. Deliveries signed with the current secret will fail verification until your receiver is updated."
          confirmLabel="Rotate secret"
          onConfirm={() => handleRotateSecret(h.id)}
          trigger={
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={(event) => {
                secretReturnFocusRef.current = event.currentTarget;
              }}
            >
              Rotate secret
            </Button>
          }
        />
      ) : null}
      {canAdmin ? (
        <ConfirmDialog
          title="Delete webhook?"
          description="This endpoint and its delivery history will be removed. Event delivery stops immediately."
          confirmLabel="Delete"
          onConfirm={() => handleDelete(h.id)}
          fallbackFocusRef={createReturnFocusRef}
          trigger={
            <Button variant="ghost" size="sm" type="button">
              Delete
            </Button>
          }
        />
      ) : null}
    </>
  );

  return (
    <div className="max-w-5xl space-y-6">
      <header>
        <h2 className="font-display text-xl font-semibold tracking-tight">
          Webhooks
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Deliver real-time events to your endpoints, signed with HMAC-SHA256.
        </p>
      </header>

      {meQuery.isSuccess && canAdmin ? (
        <WebhookOwnerEmailPreferenceCard />
      ) : null}

      <Card>
        <CardHeader className="flex-row items-start justify-between">
          <div>
            <CardTitle>Endpoints</CardTitle>
            <CardDescription>
              Each delivery is signed so you can verify it came from Moosewave.
            </CardDescription>
          </div>
          {meQuery.isSuccess && canAdmin ? (
            <Dialog
              open={createOpen}
              onOpenChange={(open) => {
                if (!open && savingRef.current) return;
                setCreateOpen(open);
                if (open) setCreateError(null);
                else {
                  setUrl("");
                  setSelected([]);
                  setCreateError(null);
                  setTimeout(() => createReturnFocusRef.current?.focus(), 0);
                }
              }}
            >
              <DialogTrigger asChild>
                <Button
                  ref={createReturnFocusRef}
                  type="button"
                  onClick={(event) => {
                    createReturnFocusRef.current = event.currentTarget;
                  }}
                >
                  Add webhook
                </Button>
              </DialogTrigger>
              <DialogContent
                aria-busy={saving}
                className="max-w-lg [&_button]:min-h-11 [&_input]:min-h-11 [&_input]:text-base sm:[&_button]:min-h-0 sm:[&_input]:min-h-0 sm:[&_input]:text-sm"
                onEscapeKeyDown={(event) => {
                  if (savingRef.current) event.preventDefault();
                }}
                onPointerDownOutside={(event) => {
                  if (savingRef.current) event.preventDefault();
                }}
                onCloseAutoFocus={(event) => {
                  if (!createReturnFocusRef.current) return;
                  event.preventDefault();
                  createReturnFocusRef.current.focus();
                }}
              >
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleCreate();
                  }}
                >
                  <DialogHeader>
                    <DialogTitle>Add a webhook</DialogTitle>
                    <DialogDescription>
                      We&apos;ll generate a signing secret you can use to verify
                      request authenticity. We show it once and never again.
                    </DialogDescription>
                  </DialogHeader>
                  <WebhookForm
                    url={url}
                    setUrl={(next) => {
                      setCreateError(null);
                      setUrl(next);
                    }}
                    selected={selected}
                    setSelected={(updater) => {
                      setCreateError(null);
                      setSelected(updater);
                    }}
                    disabled={saving}
                    errorId={createError ? "webhook-create-error" : undefined}
                  />
                  {createError ? (
                    <p
                      ref={createErrorRef}
                      id="webhook-create-error"
                      role="alert"
                      tabIndex={-1}
                      className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {createError}
                    </p>
                  ) : null}
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="ghost" type="button" disabled={saving}>
                        Cancel
                      </Button>
                    </DialogClose>
                    <Button type="submit" disabled={saving} loading={saving}>
                      {saving ? "Creating…" : "Create"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          ) : null}
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : identityError ? (
            <div className="flex flex-col items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4">
              <p className="text-sm text-destructive" role="alert">
                Workspace identity could not be verified. No webhook request was
                made.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void meQuery.refetch()}
              >
                Retry identity check
              </Button>
            </div>
          ) : !canAdmin ? (
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="text-sm font-medium">
                Owner or admin access required
              </p>
              <p className="mt-1 text-sm text-muted-foreground" role="status">
                {OUTBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE} No endpoint or delivery
                data was fetched.
              </p>
            </div>
          ) : loadError ? (
            <div className="flex flex-col items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4">
              <p className="text-sm text-destructive">
                Couldn&apos;t load your webhooks. They may still be configured —
                retry before adding new ones.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  void webhooksQuery.refetch();
                }}
              >
                Retry
              </Button>
            </div>
          ) : hooks.length === 0 ? (
            <EmptyState
              icon={WebhookIcon}
              title="No webhooks yet"
              description="Add an endpoint to receive real-time events as they happen."
              action={
                canAdmin ? (
                  <Button
                    type="button"
                    onClick={(event) => {
                      createReturnFocusRef.current = event.currentTarget;
                      setCreateOpen(true);
                    }}
                  >
                    Add webhook
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              {/* SETA-049: mobile reflows the webhooks table to stacked cards. */}
              <div className="space-y-2 sm:hidden">
                {hooks.map((h) => (
                  <div key={h.id} className="rounded-md border p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 break-all font-mono text-xs">
                        {h.url}
                      </span>
                      <StatusBadge status={h.status} />
                    </div>
                    {h.events.length ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {h.events.map((e) => (
                          <Badge
                            key={e}
                            variant="secondary"
                            className="font-mono text-[10px]"
                          >
                            {e}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                    <p className="mt-2 text-xs text-muted-foreground">
                      {h.lastDelivery ? (
                        <>
                          <RelativeTime iso={h.lastDelivery.at} /> —{" "}
                          {h.lastDelivery.statusCode || "ERR"}
                        </>
                      ) : (
                        "No deliveries yet"
                      )}
                    </p>
                    <div className="mt-2 flex flex-wrap justify-end gap-1">
                      {hookActions(h)}
                    </div>
                  </div>
                ))}
              </div>
              <TableContainer className="hidden sm:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>URL</TableHead>
                      <TableHead>Events</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Last delivery</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {hooks.map((h) => (
                      <TableRow key={h.id} className="align-top">
                        <TableCell className="max-w-xs break-all font-mono text-xs">
                          {h.url}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {h.events.map((e) => (
                              <Badge
                                key={e}
                                variant="secondary"
                                className="font-mono text-[10px]"
                              >
                                {e}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={h.status} />
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {h.lastDelivery ? (
                            <span>
                              <RelativeTime iso={h.lastDelivery.at} /> —{" "}
                              {h.lastDelivery.statusCode || "ERR"}
                            </span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="space-x-1 text-right">
                          {hookActions(h)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </>
          )}
        </CardContent>
      </Card>

      {/* Edit dialog — reuses the create form; preserves secret + history. */}
      <Dialog
        open={editing !== null && meQuery.isSuccess && canAdmin}
        onOpenChange={(open) => {
          if (!open && savingRef.current) return;
          if (!open) {
            setEditing(null);
            setEditError(null);
            setTimeout(() => editReturnFocusRef.current?.focus(), 0);
          }
        }}
      >
        <DialogContent
          aria-busy={saving}
          className="max-w-lg [&_button]:min-h-11 [&_input]:min-h-11 [&_input]:text-base sm:[&_button]:min-h-0 sm:[&_input]:min-h-0 sm:[&_input]:text-sm"
          onEscapeKeyDown={(event) => {
            if (savingRef.current) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (savingRef.current) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (!editReturnFocusRef.current) return;
            event.preventDefault();
            editReturnFocusRef.current.focus();
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleEditSave();
            }}
          >
            <DialogHeader>
              <DialogTitle>Edit webhook</DialogTitle>
              <DialogDescription>
                Change the URL or the events this endpoint receives. The signing
                secret and delivery history are preserved.
              </DialogDescription>
            </DialogHeader>
            <WebhookForm
              url={editUrl}
              setUrl={(next) => {
                setEditError(null);
                setEditUrl(next);
              }}
              selected={editSelected}
              setSelected={(updater) => {
                setEditError(null);
                setEditSelected(updater);
              }}
              disabled={saving}
              errorId={editError ? "webhook-edit-error" : undefined}
            />
            {editError ? (
              <p
                ref={editErrorRef}
                id="webhook-edit-error"
                role="alert"
                tabIndex={-1}
                className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {editError}
              </p>
            ) : editUnchanged ? (
              <p className="text-sm text-muted-foreground" role="status">
                Change the URL or event selection to enable saving.
              </p>
            ) : null}
            <DialogFooter>
              <Button
                variant="ghost"
                type="button"
                disabled={saving}
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saving || editUnchanged}
                loading={saving}
              >
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={secretOpen && meQuery.isSuccess && canAdmin}
        onOpenChange={handleSecretOpenChange}
      >
        <DialogContent
          aria-busy={copyingSecret}
          closeDisabled={copyingSecret}
          className="[&_button]:min-h-11 sm:[&_button]:min-h-0"
          onEscapeKeyDown={(event) => {
            if (copyingSecretRef.current || !secretStored) {
              event.preventDefault();
            }
          }}
          onPointerDownOutside={(event) => {
            if (copyingSecretRef.current || !secretStored) {
              event.preventDefault();
            }
          }}
          onCloseAutoFocus={(event) => {
            if (!secretReturnFocusRef.current) return;
            event.preventDefault();
            secretReturnFocusRef.current.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Save your signing secret</DialogTitle>
            <DialogDescription>
              We&apos;ll never show this again. Verify HMAC-SHA256 of the
              request body against this secret on every delivery.
            </DialogDescription>
          </DialogHeader>
          <code
            className="block break-all rounded-md bg-muted p-3 font-mono text-xs"
            aria-label="Signing secret"
          >
            {revealedSecret}
          </code>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 py-2 text-sm">
            <Checkbox
              checked={secretStored}
              disabled={copyingSecret}
              onChange={(e) => setSecretStored(e.target.checked)}
            />
            I&apos;ve saved it safely.
          </label>
          {secretError ? (
            <p
              ref={secretErrorRef}
              role="alert"
              tabIndex={-1}
              className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {secretError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              loading={copyingSecret}
              onClick={() => void handleCopySecret()}
            >
              Copy
            </Button>
            <Button
              type="button"
              disabled={!secretStored || copyingSecret}
              onClick={handleDoneSecret}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
