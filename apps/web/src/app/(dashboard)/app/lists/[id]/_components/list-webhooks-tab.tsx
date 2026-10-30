// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Webhooks (audience-95): the list-scoped façade over the outbound-webhook
 * engine. Admin-only on the server for reads and writes, so below admin the
 * tab renders the reason and requests nothing. Create and rotate answer with
 * the HMAC signing secret exactly once; the secret dialog cannot be dismissed
 * until the operator confirms it is stored or explicitly discards it.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Webhook } from "lucide-react";
import { toast } from "sonner";

import { CopyTextButton } from "@/components/copy-text-button";
import { RelativeTime } from "@/components/relative-time";
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
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { newWriteKey } from "@/lib/audience-admin-api";
import { whoamiFresh, type MeResponse } from "@/lib/auth-api";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import {
  createListWebhook,
  DELIVERIES_PAGE_LIMIT,
  deleteListWebhook,
  LIST_WEBHOOK_EVENTS,
  listListWebhookDeliveries,
  listListWebhooks,
  rotateListWebhookSecret,
  testListWebhook,
  updateListWebhook,
  WEBHOOK_ROTATION_GRACE_HOURS,
  WEBHOOKS_PAGE_LIMIT,
  type AudienceList,
  type ListWebhook,
  type ListWebhookEvent,
  type ListWebhookWithSecret,
} from "@/lib/lists-api";
import { listKeys, STALE, type RoleKey } from "@/lib/query-keys";

import { LoadFailure, Pending } from "./tab-chrome";
import {
  assertWriteIdentity,
  WEBHOOK_REASON,
  WEBHOOK_ROLES,
} from "./write-identity";

export function testUnavailableReason(w: ListWebhook): string | null {
  if (!w.active) return "Resume this endpoint before sending a test.";
  if (w.url_status !== "ready")
    return "Replace or finish securing the destination before sending a test.";
  if (w.auth_config_status !== "ready")
    return "Repair receiver authentication before sending a test.";
  if (w.delivery_policy_status !== "ready")
    return "Repair the endpoint filter or transform before sending a test.";
  return null;
}

function readiness(w: ListWebhook): string {
  const word = (s: string) => (s || "unknown").replace(/_/gu, " ");
  return [
    w.active ? "Active" : "Paused",
    `destination ${word(w.url_status)}`,
    `authentication ${word(w.auth_config_status)}`,
    `policy ${word(w.delivery_policy_status)}`,
  ].join(" · ");
}

export function ListWebhooksTab({
  list,
  me,
  tenantId,
  roleKey,
  canAdmin,
}: {
  list: AudienceList;
  me: MeResponse | undefined;
  tenantId: string;
  roleKey: RoleKey;
  canAdmin: boolean;
}) {
  if (!canAdmin)
    return (
      <div role="status" className="rounded-lg border bg-muted/30 p-4">
        <p className="font-medium">Admin access required</p>
        <p className="mt-1 text-sm text-muted-foreground">{WEBHOOK_REASON}</p>
      </div>
    );
  return (
    <AdminWebhooksPanel
      list={list}
      me={me}
      tenantId={tenantId}
      roleKey={roleKey}
    />
  );
}

function AdminWebhooksPanel({
  list,
  me,
  tenantId,
  roleKey,
}: {
  list: AudienceList;
  me: MeResponse | undefined;
  tenantId: string;
  roleKey: RoleKey;
}) {
  const qc = useQueryClient();
  const reasonId = useId();
  const webhooks = useInfiniteQuery({
    queryKey: listKeys.webhooks(tenantId, roleKey, list.id),
    queryFn: ({ pageParam, signal }) =>
      listListWebhooks(
        list.id,
        { limit: WEBHOOKS_PAGE_LIMIT, cursor: pageParam || undefined },
        signal,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor || undefined,
    staleTime: STALE.list,
  });
  const rows = Array.isArray(webhooks.data?.pages)
    ? webhooks.data.pages.flatMap((page) =>
        Array.isArray(page.webhooks) ? page.webhooks : [],
      )
    : [];

  const [addSession, setAddSession] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [revealed, setRevealed] = useState<ListWebhookWithSecret | null>(null);
  const [rotateTarget, setRotateTarget] = useState<ListWebhook | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ListWebhook | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const blockedReason = revealed
    ? "Store or discard the shown signing secret before starting another webhook action."
    : webhooks.isPending
      ? "Wait while the webhook configuration loads."
      : busyId
        ? "Wait for the current webhook operation to finish."
        : null;

  async function refresh(): Promise<void> {
    await qc.invalidateQueries({
      queryKey: listKeys.webhooks(tenantId, roleKey, list.id),
    });
  }

  async function authorize(): Promise<void> {
    if (!me) throw new Error(WEBHOOK_REASON);
    assertWriteIdentity(me, await whoamiFresh(), WEBHOOK_ROLES, WEBHOOK_REASON);
  }

  /** Thrown errors render inside the confirm with the server's sentence. */
  async function confirmRotate(): Promise<void> {
    if (!rotateTarget) return;
    await authorize();
    const rotated = await rotateListWebhookSecret(
      list.id,
      rotateTarget.id,
      newWriteKey("list-webhook-rotate"),
    );
    setRotateTarget(null);
    setRevealed(rotated);
    toast.success(
      "Signing secret rotated — store it before leaving this view.",
    );
    await refresh();
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) return;
    await authorize();
    await deleteListWebhook(
      list.id,
      deleteTarget.id,
      newWriteKey("list-webhook-delete"),
    );
    toast.success(`Webhook for ${deleteTarget.url} deleted from ${list.name}`);
    if (expanded === deleteTarget.id) setExpanded(null);
    setDeleteTarget(null);
    await refresh();
  }

  async function test(w: ListWebhook): Promise<void> {
    if (blockedReason || testUnavailableReason(w)) return;
    setBusyId(w.id);
    try {
      await authorize();
      const r = await testListWebhook(
        list.id,
        w.id,
        newWriteKey("list-webhook-test"),
      );
      const ok = r.status_code >= 200 && r.status_code < 300;
      if (r.filtered)
        toast.info(
          "Test did not match the endpoint filter; no request was signed or sent.",
        );
      else if (ok && r.signed)
        toast.success(
          `Test fired — the receiver answered HTTP ${r.status_code}.`,
        );
      else if (ok)
        toast.error("Test was not signed; review the endpoint configuration.");
      else toast.error(`Test returned HTTP ${r.status_code}.`);
      await refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Test failed"));
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }

  async function toggleActive(w: ListWebhook): Promise<void> {
    if (blockedReason) return;
    setBusyId(w.id);
    try {
      await authorize();
      await updateListWebhook(
        list.id,
        w.id,
        { active: !w.active },
        newWriteKey("list-webhook-update"),
      );
      toast.success(w.active ? `Paused ${w.url}` : `Resumed ${w.url}`);
      await refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Webhook could not be updated"));
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Webhooks scoped to{" "}
          <span className="font-medium text-foreground">{list.name}</span> POST
          a signed payload when a subscriber is added to this list.
        </p>
        <Button
          type="button"
          disabled={blockedReason !== null}
          aria-describedby={blockedReason ? reasonId : undefined}
          onClick={() => {
            setAddSession((s) => s + 1);
            setAddOpen(true);
          }}
        >
          <Plus aria-hidden className="size-4" /> Add webhook
        </Button>
      </div>
      {blockedReason ? (
        <p id={reasonId} className="text-xs text-muted-foreground">
          {blockedReason}
        </p>
      ) : null}

      {webhooks.isPending ? (
        <Pending label="Loading webhooks" rows={2} />
      ) : webhooks.isError ? (
        <LoadFailure
          what="Webhooks"
          error={webhooks.error}
          busy={webhooks.isFetching}
          onRetry={() => void webhooks.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Webhook}
          title="No webhooks for this list"
          description="Add one to receive a signed POST whenever a subscriber is added."
        />
      ) : (
        <ul className="space-y-3" aria-label={`${list.name} webhooks`}>
          {rows.map((w) => {
            const testReason = testUnavailableReason(w);
            const rowBusy = busyId === w.id;
            const blocked = blockedReason !== null;
            return (
              <li key={w.id} className="rounded-lg border p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 space-y-1">
                    <p className="truncate font-mono text-sm" title={w.url}>
                      {w.url}
                    </p>
                    {w.description ? (
                      <p className="text-sm text-muted-foreground">
                        {w.description}
                      </p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {w.events.join(", ")}
                    </p>
                    <div
                      className={`text-xs ${testReason ? "text-warning-emphasis" : "text-muted-foreground"}`}
                    >
                      <Badge
                        variant={w.active ? "success" : "warning"}
                        className="mr-2"
                      >
                        {w.active ? "Active" : "Paused"}
                      </Badge>
                      {readiness(w)}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {w.last_succeeded_at ? (
                        <>
                          Last success{" "}
                          <RelativeTime iso={w.last_succeeded_at} />
                        </>
                      ) : (
                        "No successful delivery yet"
                      )}
                      {w.last_failed_at ? (
                        <>
                          {" · "}Last failure{" "}
                          <RelativeTime iso={w.last_failed_at} />
                        </>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      loading={rowBusy}
                      disabled={blocked || testReason !== null}
                      title={testReason ?? undefined}
                      aria-describedby={blocked ? reasonId : undefined}
                      aria-label={`Test ${w.url}`}
                      onClick={() => void test(w)}
                    >
                      Test
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={blocked}
                      aria-describedby={blocked ? reasonId : undefined}
                      aria-label={`Rotate secret for ${w.url}`}
                      onClick={() => setRotateTarget(w)}
                    >
                      Rotate secret
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={blocked}
                      aria-describedby={blocked ? reasonId : undefined}
                      aria-label={`${w.active ? "Pause" : "Resume"} ${w.url}`}
                      onClick={() => void toggleActive(w)}
                    >
                      {w.active ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-expanded={expanded === w.id}
                      aria-label={`${expanded === w.id ? "Hide" : "Show"} deliveries for ${w.url}`}
                      onClick={() =>
                        setExpanded(expanded === w.id ? null : w.id)
                      }
                    >
                      {expanded === w.id ? "Hide deliveries" : "Deliveries"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={blocked}
                      aria-describedby={blocked ? reasonId : undefined}
                      aria-label={`Delete webhook ${w.url}`}
                      onClick={() => setDeleteTarget(w)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                {expanded === w.id ? (
                  <DeliveriesPanel
                    list={list}
                    webhook={w}
                    tenantId={tenantId}
                    roleKey={roleKey}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {webhooks.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          loading={webhooks.isFetchingNextPage}
          disabled={blockedReason !== null}
          onClick={() => void loadNextQueryPage(webhooks, webhooks.isEnabled)}
        >
          Load older webhooks
        </Button>
      ) : null}

      <WebhookCreateDialog
        key={addSession}
        open={addOpen}
        list={list}
        me={me}
        onClose={() => setAddOpen(false)}
        onCreated={async (created) => {
          setRevealed(created);
          toast.success("Webhook added — store the signing secret now.");
          await refresh();
        }}
      />

      {revealed ? (
        <SecretDialog
          key={`${revealed.id}:${revealed.signing_secret}`}
          revealed={revealed}
          onResolve={() => setRevealed(null)}
        />
      ) : null}

      <ConfirmDialog
        open={rotateTarget !== null}
        onOpenChange={(v) => !v && setRotateTarget(null)}
        title="Rotate signing secret?"
        description={
          rotateTarget
            ? `A new one-time signing secret is generated for ${rotateTarget.url}. Moosewave dual-signs during the ${WEBHOOK_ROTATION_GRACE_HOURS}-hour grace window so you can update the receiver without an abrupt cutover.`
            : ""
        }
        confirmLabel="Rotate secret"
        confirmVariant="default"
        onConfirm={confirmRotate}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="Delete webhook?"
        description={
          deleteTarget
            ? `Permanently tombstones ${deleteTarget.url}. Pending deliveries are cancelled as skipped, signing and destination secrets are shredded immediately, and a request already in flight may still finish. Value-free delivery evidence remains until retention purges it. Type DELETE to continue.`
            : ""
        }
        confirmationToken="DELETE"
        confirmLabel="Delete webhook"
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function WebhookCreateDialog({
  open,
  list,
  me,
  onClose,
  onCreated,
}: {
  open: boolean;
  list: AudienceList;
  me: MeResponse | undefined;
  onClose: () => void;
  onCreated: (created: ListWebhookWithSecret) => Promise<void>;
}) {
  const ids = useId();
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<Set<ListWebhookEvent>>(
    () => new Set(LIST_WEBHOOK_EVENTS),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const dirty =
    url !== "" ||
    description !== "" ||
    events.size !== LIST_WEBHOOK_EVENTS.length;

  function requestClose(): void {
    if (submitting) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  }

  async function submit(): Promise<void> {
    if (submitting || !me) return;
    setSubmitting(true);
    setError(null);
    try {
      assertWriteIdentity(
        me,
        await whoamiFresh(),
        WEBHOOK_ROLES,
        WEBHOOK_REASON,
      );
      const created = await createListWebhook(
        list.id,
        { url, description, events: [...events] },
        newWriteKey("list-webhook-create"),
      );
      await onCreated(created);
      if (!mounted.current) return;
      onClose();
    } catch (e) {
      if (mounted.current)
        setError(apiErrorMessage(e, "Webhook could not be added"));
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && requestClose()}>
        <DialogContent
          closeDisabled={submitting}
          onEscapeKeyDown={(e) => submitting && e.preventDefault()}
          onPointerDownOutside={(e) => submitting && e.preventDefault()}
        >
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>Add webhook to {list.name}</DialogTitle>
              <DialogDescription>
                POSTs a signed payload to your receiver when a subscriber is
                added to this list. The signing secret is shown once after
                creation.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-url`}>Receiver URL</Label>
              <Input
                id={`${ids}-url`}
                type="url"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                placeholder="https://example.com/postwave-hook"
                value={url}
                disabled={submitting}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-description`}>Description</Label>
              <Input
                id={`${ids}-description`}
                placeholder="(optional)"
                value={description}
                disabled={submitting}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Events</legend>
              {LIST_WEBHOOK_EVENTS.map((ev) => (
                <label key={ev} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={events.has(ev)}
                    disabled={submitting}
                    aria-label={ev}
                    onChange={(e) =>
                      setEvents((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(ev);
                        else next.delete(ev);
                        return next;
                      })
                    }
                  />
                  <code className="font-mono text-xs">{ev}</code>
                </label>
              ))}
            </fieldset>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={requestClose}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                loading={submitting}
                disabled={submitting || !url.trim() || events.size === 0}
              >
                {submitting ? "Adding…" : "Add webhook"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={(v) => !v && setDiscardOpen(false)}
        title="Discard webhook draft?"
        description="The receiver URL and event selection in this draft will be lost."
        confirmLabel="Discard draft"
        onConfirm={() => {
          setDiscardOpen(false);
          onClose();
        }}
      />
    </>
  );
}

/**
 * Shown-once secret. Every close path — Escape, the X, the footer — routes
 * through the stored/discard decision; nothing dismisses it silently.
 */
function SecretDialog({
  revealed,
  onResolve,
}: {
  revealed: ListWebhookWithSecret;
  onResolve: () => void;
}) {
  const ids = useId();
  const [stored, setStored] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  function requestClose(): void {
    if (stored) onResolve();
    else setDiscardOpen(true);
  }

  return (
    <>
      <Dialog open onOpenChange={(v) => !v && requestClose()}>
        <DialogContent onPointerDownOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Store your signing secret</DialogTitle>
            <DialogDescription>
              This HMAC-SHA256 secret is shown exactly once. Moosewave cannot
              retrieve it for you after this dialog closes.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Receiver
              </p>
              <p className="break-all font-mono text-xs">{revealed.url}</p>
            </div>
            <div className="grid gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Signing secret
              </p>
              <pre
                aria-label="Signing secret"
                tabIndex={0}
                className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <code>{revealed.signing_secret}</code>
              </pre>
              <div>
                <CopyTextButton
                  value={revealed.signing_secret}
                  label="Copy signing secret"
                  copiedLabel="Copied"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Parse <code>X-Postwave-Signature</code> as{" "}
                <code>t=&lt;unix-seconds&gt;,v1=&lt;digest&gt;</code>, reject
                stale timestamps and compare <code>v1</code> against an HMAC of
                the exact raw body in constant time. During rotation accept
                either valid signature only for the advertised grace window.
                Store this value in an approved secret manager, not source
                control.
              </p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={stored}
                aria-describedby={stored ? undefined : `${ids}-help`}
                onChange={(e) => setStored(e.target.checked)}
              />
              <span>
                I stored this secret securely and understand it cannot be shown
                again.
              </span>
            </label>
            {!stored ? (
              <p id={`${ids}-help`} className="text-xs text-muted-foreground">
                Confirm secure storage before closing this one-time view.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDiscardOpen(true)}
            >
              Discard shown secret…
            </Button>
            <Button type="button" disabled={!stored} onClick={onResolve}>
              I&apos;ve stored it securely
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={(v) => !v && setDiscardOpen(false)}
        title="Discard the shown signing secret?"
        description="This value cannot be recovered. The webhook stays active, so rotate its secret before relying on receiver verification."
        confirmLabel="Discard shown value"
        cancelLabel="Keep it open"
        onConfirm={() => {
          setDiscardOpen(false);
          onResolve();
        }}
      />
    </>
  );
}

function DeliveriesPanel({
  list,
  webhook,
  tenantId,
  roleKey,
}: {
  list: AudienceList;
  webhook: ListWebhook;
  tenantId: string;
  roleKey: RoleKey;
}) {
  const deliveries = useInfiniteQuery({
    queryKey: listKeys.webhookDeliveries(
      tenantId,
      roleKey,
      list.id,
      webhook.id,
    ),
    queryFn: ({ pageParam, signal }) =>
      listListWebhookDeliveries(
        list.id,
        webhook.id,
        { limit: DELIVERIES_PAGE_LIMIT, cursor: pageParam || undefined },
        signal,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor || undefined,
    staleTime: STALE.list,
  });
  const rows = Array.isArray(deliveries.data?.pages)
    ? deliveries.data.pages.flatMap((page) =>
        Array.isArray(page.deliveries) ? page.deliveries : [],
      )
    : [];

  return (
    <div className="mt-4 space-y-3 border-t pt-4">
      {deliveries.isPending ? (
        <Pending label="Loading deliveries" rows={2} />
      ) : deliveries.isError ? (
        <LoadFailure
          what="Deliveries"
          error={deliveries.error}
          busy={deliveries.isFetching}
          onRetry={() => void deliveries.refetch()}
        />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No deliveries recorded for this webhook yet.
        </p>
      ) : (
        <TableContainer aria-label={`Deliveries for ${webhook.url}`}>
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Event</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col" className="text-right">
                  Attempts
                </TableHead>
                <TableHead scope="col" className="text-right">
                  HTTP
                </TableHead>
                <TableHead scope="col">Created</TableHead>
                <TableHead scope="col">Evidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-mono text-xs">
                    {d.event_type || "—"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        d.status === "delivered" || d.status === "succeeded"
                          ? "success"
                          : d.status === "failed" || d.status === "dead"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {d.status || "—"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {d.attempt_count}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {d.last_status_code ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {d.created_at ? <RelativeTime iso={d.created_at} /> : "—"}
                  </TableCell>
                  <TableCell
                    className="max-w-[280px] truncate font-mono text-xs text-muted-foreground"
                    title={d.last_error ?? d.last_response_body_truncated}
                  >
                    {(
                      d.last_error ??
                      d.last_response_body_truncated ??
                      ""
                    ).slice(0, 200) || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {deliveries.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={deliveries.isFetchingNextPage}
          onClick={() =>
            void loadNextQueryPage(deliveries, deliveries.isEnabled)
          }
        >
          Load older deliveries
        </Button>
      ) : null}
    </div>
  );
}
