// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Outbound destinations — the customer-facing `/api/v1/outbound-webhooks`
 * entity (signed event delivery to Zapier, n8n, a customer's own server).
 *
 * This is NOT the settings/webhooks page: that one manages `/api/v1/webhooks`,
 * Moosewave's own product-webhook family, with different tables and a different
 * contract. The two surfaces are deliberately separate.
 *
 * Every verb here is live. Pause is a soft delete, resume is re-enable, and
 * delete is a tombstone that shreds the destination's secrets — each one names
 * its consequence in the confirm before it runs.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, Webhook } from "lucide-react";
import { toast } from "sonner";

import { PageShell } from "@/components/dashboard/page-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
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
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami, type MeResponse } from "@/lib/auth-api";
import { exactPrincipalKey } from "@/lib/exact-principal";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { newUUIDv7 } from "@/lib/http-fetch";
import {
  OUTBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE,
  canAdminOutboundWebhooks,
  confirmFreshOutboundWebhookAdmin,
} from "@/lib/outbound-webhook-authority";
import {
  deleteOutboundWebhook,
  listOutboundWebhooksPage,
  outboundWebhookKeys,
  outboundWebhookSetupBlock,
  pauseOutboundWebhook,
  reEnableOutboundWebhook,
  rotateOutboundWebhookSecret,
  testOutboundWebhook,
  type OutboundWebhookRecord,
  type OutboundWebhookTestResult,
} from "@/lib/outbound-webhooks-api";
import { base, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";
import {
  OutboundWebhookEditDialog,
  ReceiverPresetDialog,
  SigningMaterialDialog,
  type RevealedMaterial,
} from "./outbound-webhook-dialogs";

export const OUTBOUND_WEBHOOK_ADMIN_ONLY = OUTBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE;

type RowVerb = "pause" | "resume" | "delete";

interface PageOperation {
  controller: AbortController;
  openedIdentity: MeResponse;
  principalKey: string;
}

interface SingleWebhookOperation extends PageOperation {
  idempotencyKey: string;
  webhook: OutboundWebhookRecord;
}

interface RowOperation extends SingleWebhookOperation {
  verb: RowVerb;
}

interface BulkOperation extends PageOperation {
  items: Array<{ id: string; idempotencyKey: string }>;
  verb: RowVerb;
}

/** The consequence sentence each destructive verb has to name. */
function pauseSentence(webhook: OutboundWebhookRecord): string {
  return `New events will stop being enqueued for ${webhook.url}, and pending deliveries will not be attempted while paused. History, delivery rows, and signing configuration are retained for a later resume.`;
}

function deleteSentence(webhook: OutboundWebhookRecord): string {
  return `This permanently tombstones ${webhook.url}. Pending deliveries are cancelled as “skipped,” retained history stays available in tenant-wide diagnostics, and destination, receiver-auth, and signing secrets are shredded. Pause instead if you need a reversible stop.`;
}

function rotateSentence(webhook: OutboundWebhookRecord): string {
  return `Moosewave will generate new ${webhook.signing_algorithm ?? "signing"} material for ${webhook.url} and dual-sign deliveries for 24 hours. Store the returned one-time value and update every verifier before the old key expires.`;
}

function testSentence(webhook: OutboundWebhookRecord): string {
  return `Moosewave will apply this destination's filter and transform to a webhook.test event. If the event passes, it is signed and sent to ${webhook.url} now; the receiver may execute real side effects.`;
}

function statusOf(webhook: OutboundWebhookRecord): {
  label: string;
  variant: "success" | "secondary" | "warning";
  detail: string;
} {
  if (webhook.active === false) {
    return {
      label: "Paused",
      variant: "secondary",
      detail: webhook.disabled_reason
        ? `Paused: ${webhook.disabled_reason}`
        : "No events are enqueued while paused.",
    };
  }
  if ((webhook.consecutive_failures ?? 0) > 0) {
    return {
      label: "Failing",
      variant: "warning",
      detail: `${webhook.consecutive_failures} consecutive failures since the last success.`,
    };
  }
  return {
    label: "Active",
    variant: "success",
    detail: "Subscribed events are being enqueued for delivery.",
  };
}

function testOutcomeSentence(
  webhook: OutboundWebhookRecord,
  result: OutboundWebhookTestResult,
): string {
  if (result.filtered) {
    return `The configured filter suppressed the test event for ${webhook.url}. Nothing was signed or sent.`;
  }
  const status = result.status_code
    ? `HTTP ${result.status_code}`
    : "no response";
  const error = result.error ? ` ${result.error}` : "";
  return `Live test to ${webhook.url} returned ${status}.${error}`;
}

export interface OutboundWebhooksClientProps {
  /**
   * Row-action seam. A Deliveries panel implementer renders its trigger here
   * (one control per row, beside Test/Edit) without reopening this file.
   */
  rowActionSlot?: (webhook: OutboundWebhookRecord) => ReactNode;
}

export function OutboundWebhooksClient({
  rowActionSlot,
}: OutboundWebhooksClientProps = {}) {
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const me = meQuery.data;
  const canAdmin = canAdminOutboundWebhooks(me);
  const tenantId = me?.tenant_id ?? "pending";
  const role = me ? effectiveAuthRole(me) : null;
  const principalKey = exactPrincipalKey(me);
  const principalKeyRef = useRef(principalKey);
  principalKeyRef.current = principalKey;
  const operationRef = useRef<PageOperation | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [cursor, setCursor] = useState("");
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<OutboundWebhookRecord | null>(
    null,
  );
  const [testTarget, setTestTarget] = useState<OutboundWebhookRecord | null>(
    null,
  );
  const [pauseTarget, setPauseTarget] = useState<OutboundWebhookRecord | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] =
    useState<OutboundWebhookRecord | null>(null);
  const [rotateTarget, setRotateTarget] =
    useState<OutboundWebhookRecord | null>(null);
  const [bulkPauseOpen, setBulkPauseOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [revealed, setRevealed] = useState<RevealedMaterial | null>(null);
  const [testOutcome, setTestOutcome] = useState<string | null>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setAppliedQuery(searchInput.trim());
      setCursor("");
      setCursorStack([]);
    }, 300);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  useEffect(() => {
    const scopedPrincipal = principalKey;
    return () => {
      const operation = operationRef.current;
      if (operation?.principalKey === scopedPrincipal) {
        operation.controller.abort();
        operationRef.current = null;
      }
    };
  }, [principalKey]);

  function beginOperation<T extends object>(
    details: T,
  ): (PageOperation & T) | null {
    if (operationRef.current || !me || !canAdmin) return null;
    const operation: PageOperation & T = {
      controller: new AbortController(),
      openedIdentity: me,
      principalKey,
      ...details,
    };
    operationRef.current = operation;
    return operation;
  }

  function finishOperation(operation: PageOperation) {
    if (operationRef.current === operation) operationRef.current = null;
  }

  async function authorizeOperation(operation: PageOperation): Promise<void> {
    await confirmFreshOutboundWebhookAdmin(
      operation.openedIdentity,
      operation.controller.signal,
    );
    if (principalKeyRef.current !== operation.principalKey) {
      throw new Error(
        "Workspace identity changed while this outbound-destination action was in flight. Refresh before trying again.",
      );
    }
  }

  function beginSingleWebhookOperation(
    webhook: OutboundWebhookRecord,
  ): SingleWebhookOperation | null {
    return beginOperation({ webhook, idempotencyKey: newUUIDv7() });
  }

  function beginRowOperation(
    webhook: OutboundWebhookRecord,
    verb: RowVerb,
  ): RowOperation | null {
    return beginOperation({ webhook, verb, idempotencyKey: newUUIDv7() });
  }

  function beginBulkOperation(
    ids: readonly string[],
    verb: RowVerb,
  ): BulkOperation | null {
    return beginOperation({
      items: [...ids].map((id) => ({ id, idempotencyKey: newUUIDv7() })),
      verb,
    });
  }

  const listQuery = useQuery({
    queryKey: outboundWebhookKeys.list(
      tenantId,
      role,
      appliedQuery,
      cursor,
      principalKey,
    ),
    queryFn: ({ signal }) =>
      listOutboundWebhooksPage({
        query: appliedQuery || undefined,
        cursor: cursor || undefined,
        signal,
      }),
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.list,
  });

  const rows = useMemo(
    () => listQuery.data?.webhooks ?? [],
    [listQuery.data?.webhooks],
  );
  const nextCursor = listQuery.data?.next_cursor ?? "";
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const selectedOnPage = rowIds.filter((id) => selected.has(id));
  const allChecked =
    rowIds.length > 0 && selectedOnPage.length === rowIds.length;
  const hiddenSelected = selected.size - selectedOnPage.length;

  function resetToFirstPage() {
    setCursor("");
    setCursorStack([]);
  }

  async function refreshAfterMutation() {
    resetToFirstPage();
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: outboundWebhookKeys.all(tenantId, role, principalKey),
      }),
      // The routing overview lists the same destinations under its own key.
      queryClient.invalidateQueries({
        queryKey: base("routing", tenantId, role),
      }),
    ]);
  }

  const rowMutation = useMutation({
    mutationKey: ["outbound-webhooks", principalKey, "row-write"],
    mutationFn: async (operation: RowOperation) => {
      await authorizeOperation(operation);
      const options = {
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      };
      if (operation.verb === "resume") {
        return reEnableOutboundWebhook(operation.webhook.id, options);
      }
      if (operation.verb === "pause") {
        return pauseOutboundWebhook(operation.webhook.id, options);
      }
      return deleteOutboundWebhook(operation.webhook.id, options);
    },
    onSuccess: async (_data, operation) => {
      if (principalKeyRef.current !== operation.principalKey) return;
      const { webhook, verb } = operation;
      const past =
        verb === "pause" ? "paused" : verb === "resume" ? "resumed" : "deleted";
      // A tombstoned row cannot be a bulk target; leaving its id selected
      // would count a destination that no longer exists.
      if (verb === "delete") {
        setSelected((current) => {
          if (!current.has(webhook.id)) return current;
          const next = new Set(current);
          next.delete(webhook.id);
          return next;
        });
      }
      await refreshAfterMutation();
      if (principalKeyRef.current === operation.principalKey) {
        toast.success(`${webhook.url} was ${past}.`);
      }
    },
    onSettled: (_data, _error, operation) => finishOperation(operation),
  });

  const testMutation = useMutation({
    mutationKey: ["outbound-webhooks", principalKey, "live-test"],
    mutationFn: async (operation: SingleWebhookOperation) => {
      await authorizeOperation(operation);
      return testOutboundWebhook(operation.webhook.id, {
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      });
    },
    onSuccess: (result, operation) => {
      if (principalKeyRef.current !== operation.principalKey) return;
      const { webhook } = operation;
      const sentence = testOutcomeSentence(webhook, result);
      setTestOutcome(sentence);
      const succeeded =
        result.filtered ||
        (result.status_code >= 200 &&
          result.status_code < 300 &&
          !result.error);
      if (succeeded) toast.success(sentence);
      else toast.error(sentence);
    },
    onSettled: (_data, _error, operation) => finishOperation(operation),
  });

  const rotateMutation = useMutation({
    mutationKey: ["outbound-webhooks", principalKey, "rotate"],
    mutationFn: async (operation: SingleWebhookOperation) => {
      await authorizeOperation(operation);
      return rotateOutboundWebhookSecret(operation.webhook.id, {
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      });
    },
    onSuccess: async (response, operation) => {
      if (principalKeyRef.current !== operation.principalKey) return;
      setRevealed({ reason: "rotated", response });
      await refreshAfterMutation();
      if (principalKeyRef.current === operation.principalKey) {
        toast.success(
          "Signing material rotated; the 24-hour grace window is active.",
        );
      }
    },
    onSettled: (_data, _error, operation) => finishOperation(operation),
  });

  const bulkMutation = useMutation({
    mutationKey: ["outbound-webhooks", principalKey, "bulk-write"],
    mutationFn: async (operation: BulkOperation) => {
      await authorizeOperation(operation);
      const failed: string[] = [];
      for (const item of operation.items) {
        try {
          const options = {
            signal: operation.controller.signal,
            idempotencyKey: item.idempotencyKey,
          };
          if (operation.verb === "resume") {
            await reEnableOutboundWebhook(item.id, options);
          } else if (operation.verb === "pause") {
            await pauseOutboundWebhook(item.id, options);
          } else {
            await deleteOutboundWebhook(item.id, options);
          }
        } catch {
          failed.push(item.id);
        }
      }
      return { attempted: operation.items.length, failed };
    },
    onSuccess: async ({ attempted, failed }, operation) => {
      if (principalKeyRef.current !== operation.principalKey) return;
      const { verb } = operation;
      const past =
        verb === "pause" ? "Paused" : verb === "resume" ? "Resumed" : "Deleted";
      const succeeded = attempted - failed.length;
      const sentence =
        failed.length > 0
          ? `${past} ${succeeded}; ${failed.length} failed and remain selected for retry.`
          : `${past} ${succeeded} destination${succeeded === 1 ? "" : "s"}.`;
      setSelected(new Set(failed));
      if (failed.length > 0) toast.error(sentence);
      await refreshAfterMutation();
      if (
        failed.length === 0 &&
        principalKeyRef.current === operation.principalKey
      ) {
        toast.success(sentence);
      }
    },
    onSettled: (_data, _error, operation) => finishOperation(operation),
  });

  const busy =
    rowMutation.isPending ||
    testMutation.isPending ||
    rotateMutation.isPending ||
    bulkMutation.isPending;

  if (meQuery.isPending) {
    return (
      <PageShell>
        <div
          className="space-y-3"
          aria-busy="true"
          aria-label="Loading identity"
        >
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-40 w-full" />
        </div>
      </PageShell>
    );
  }

  if (meQuery.isError || !me) {
    return (
      <PageShell>
        <Alert variant="destructive">
          <AlertTitle>Workspace identity could not be read</AlertTitle>
          <AlertDescription>
            {apiErrorMessage(
              meQuery.error,
              "Your role could not be confirmed, so no destination request was made.",
            )}{" "}
            <Button
              type="button"
              variant="link"
              className="h-auto p-0"
              onClick={() => void meQuery.refetch()}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </PageShell>
    );
  }

  if (!canAdmin) {
    return (
      <PageShell>
        <header className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Channel infrastructure
          </p>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Outbound destinations
          </h1>
        </header>
        <Alert variant="destructive">
          <AlertTitle>Administrator access required</AlertTitle>
          <AlertDescription>{OUTBOUND_WEBHOOK_ADMIN_ONLY}</AlertDescription>
        </Alert>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Button
            asChild
            variant="link"
            className="h-auto p-0 text-xs text-muted-foreground"
          >
            <Link href={asRoute("/app/routing")}>
              <ArrowLeft aria-hidden className="mr-1 h-3 w-3" />
              Back to routing
            </Link>
          </Button>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Outbound destinations
          </h1>
          <p className="text-sm text-muted-foreground">
            Signed workspace-event delivery to external systems. Tests, key
            rotation, and configuration changes run against the server
            immediately — nothing here is queued on this device.
          </p>
        </div>
        <Button
          type="button"
          disabled={busy}
          onClick={() => setCreateOpen(true)}
        >
          <Plus aria-hidden /> New destination
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-xs">
          <Label htmlFor="outbound-webhook-search">
            Search destinations on the server
          </Label>
          <Input
            id="outbound-webhook-search"
            value={searchInput}
            maxLength={200}
            placeholder="Destination or event…"
            autoComplete="off"
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        {searchInput ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setSearchInput("")}
          >
            Clear search
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          loading={listQuery.isFetching}
          onClick={() => void listQuery.refetch()}
        >
          Refresh
        </Button>
      </div>

      {testOutcome ? (
        <Alert role="status">
          <AlertTitle>Test delivery result</AlertTitle>
          <AlertDescription>{testOutcome}</AlertDescription>
        </Alert>
      ) : null}

      {testMutation.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {apiErrorMessage(
              testMutation.error,
              "The live test request failed; nothing was delivered.",
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {rowMutation.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {apiErrorMessage(
              rowMutation.error,
              "The destination was not changed.",
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {rotateMutation.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {apiErrorMessage(
              rotateMutation.error,
              "Signing material was not rotated.",
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {listQuery.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Destinations could not be loaded</AlertTitle>
          <AlertDescription>
            {apiErrorMessage(
              listQuery.error,
              "The listing failed; this is not a workspace with no destinations.",
            )}{" "}
            <Button
              type="button"
              variant="link"
              className="h-auto p-0"
              loading={listQuery.isFetching}
              onClick={() => void listQuery.refetch()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {selected.size > 0 ? (
        <div
          role="group"
          aria-label="Bulk destination actions"
          aria-busy={bulkMutation.isPending || undefined}
          className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 p-3"
        >
          <span className="text-sm">
            <strong>{selected.size}</strong> selected
            {hiddenSelected > 0
              ? ` · ${hiddenSelected} on another page or hidden by search`
              : ""}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              const operation = beginBulkOperation([...selected], "resume");
              if (operation) bulkMutation.mutate(operation);
            }}
          >
            Resume all
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setBulkPauseOpen(true)}
          >
            Pause all
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => setBulkDeleteOpen(true)}
          >
            Delete all
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={bulkMutation.isPending}
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </Button>
        </div>
      ) : null}

      {listQuery.isPending ? (
        <div
          className="space-y-3"
          aria-busy="true"
          aria-label="Loading destinations"
        >
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Webhook}
          title={
            appliedQuery
              ? "No destinations match this search"
              : "No outbound destinations yet"
          }
          description={
            appliedQuery
              ? "The server query completed and matched nothing. Clear the search to see every destination."
              : "Connect Zapier, n8n, or your own HTTPS endpoint to receive signed workspace events."
          }
          action={
            appliedQuery ? null : (
              <Button type="button" onClick={() => setCreateOpen(true)}>
                <Plus aria-hidden /> New destination
              </Button>
            )
          }
        />
      ) : (
        <TableContainer aria-label="Outbound destinations">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="Select every destination on this page"
                    checked={allChecked}
                    indeterminate={selectedOnPage.length > 0 && !allChecked}
                    onChange={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        for (const id of rowIds) {
                          if (allChecked) next.delete(id);
                          else next.add(id);
                        }
                        return next;
                      })
                    }
                  />
                </TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((webhook) => {
                const status = statusOf(webhook);
                const setupBlock = outboundWebhookSetupBlock(webhook);
                const events = Array.isArray(webhook.events)
                  ? webhook.events
                  : [];
                const resumeBlocked = !webhook.active && Boolean(setupBlock);
                return (
                  <TableRow key={webhook.id}>
                    <TableCell className="align-top">
                      <Checkbox
                        aria-label={`Select ${webhook.url}`}
                        checked={selected.has(webhook.id)}
                        disabled={busy}
                        onChange={() =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (next.has(webhook.id)) next.delete(webhook.id);
                            else next.add(webhook.id);
                            return next;
                          })
                        }
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="break-all font-mono text-xs">
                        {webhook.url}
                      </div>
                      {webhook.description ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {webhook.description}
                        </div>
                      ) : null}
                      <div className="mt-1 text-xs text-muted-foreground">
                        {webhook.signing_algorithm ??
                          "signing algorithm not reported"}
                        {webhook.secondary_expires_at
                          ? " · rotation grace active"
                          : ""}
                      </div>
                      {setupBlock ? (
                        <p
                          className="mt-1 text-xs text-destructive-emphasis"
                          id={`setup-${webhook.id}`}
                        >
                          {setupBlock}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge variant={status.variant}>{status.label}</Badge>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {status.detail}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Last success{" "}
                        {formatWireTimestamp(
                          webhook.last_succeeded_at ?? undefined,
                          "never",
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="align-top text-xs text-muted-foreground">
                      {events.length === 0
                        ? "No event subscriptions returned"
                        : events.join(", ")}
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="flex flex-wrap justify-end gap-2">
                        {rowActionSlot?.(webhook)}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy || Boolean(setupBlock)}
                          aria-describedby={
                            setupBlock ? `setup-${webhook.id}` : undefined
                          }
                          aria-label={`Send a test delivery to ${webhook.url}`}
                          onClick={() => {
                            setTestOutcome(null);
                            testMutation.reset();
                            setTestTarget(webhook);
                          }}
                        >
                          Test
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          aria-label={`Edit ${webhook.url}`}
                          onClick={() => setEditTarget(webhook)}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          aria-label={`Rotate the signing key for ${webhook.url}`}
                          onClick={() => setRotateTarget(webhook)}
                        >
                          Rotate key
                        </Button>
                        {webhook.active === false ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busy || resumeBlocked}
                            aria-describedby={
                              resumeBlocked ? `setup-${webhook.id}` : undefined
                            }
                            aria-label={`Resume ${webhook.url}`}
                            onClick={() => {
                              const operation = beginRowOperation(
                                webhook,
                                "resume",
                              );
                              if (operation) rowMutation.mutate(operation);
                            }}
                          >
                            Resume
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            aria-label={`Pause ${webhook.url}`}
                            onClick={() => setPauseTarget(webhook)}
                          >
                            Pause
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={busy}
                          aria-label={`Delete ${webhook.url}`}
                          onClick={() => setDeleteTarget(webhook)}
                        >
                          Delete
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

      {listQuery.data ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {rows.length.toLocaleString()}{" "}
            {rows.length === 1 ? "destination" : "destinations"} on this page
            {nextCursor
              ? "; more are available from the server."
              : "; end of the current server query."}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label="Previous page of destinations"
              disabled={cursorStack.length === 0 || listQuery.isFetching}
              onClick={() => {
                setCursorStack((stack) => {
                  const next = [...stack];
                  const previous = next.pop() ?? "";
                  setCursor(previous);
                  return next;
                });
              }}
            >
              Previous
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label="Next page of destinations"
              disabled={!nextCursor || listQuery.isFetching}
              onClick={() => {
                setCursorStack((stack) => [...stack, cursor]);
                setCursor(nextCursor);
              }}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      {createOpen ? (
        <ReceiverPresetDialog
          identity={me}
          onClose={() => setCreateOpen(false)}
          onCreated={(response) => {
            setCreateOpen(false);
            setRevealed({ reason: "created", response });
            void refreshAfterMutation();
          }}
        />
      ) : null}

      {editTarget ? (
        <OutboundWebhookEditDialog
          identity={me}
          webhook={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            void refreshAfterMutation();
          }}
        />
      ) : null}

      {revealed ? (
        <SigningMaterialDialog
          revealed={revealed}
          onDismiss={() => setRevealed(null)}
        />
      ) : null}

      <ConfirmDialog
        open={testTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTestTarget(null);
        }}
        title="Send a live test delivery?"
        description={testTarget ? testSentence(testTarget) : ""}
        confirmLabel="Send test"
        confirmVariant="destructive"
        onConfirm={async () => {
          if (!testTarget) return;
          const operation = beginSingleWebhookOperation(testTarget);
          if (!operation) return;
          await testMutation.mutateAsync(operation);
          setTestTarget(null);
        }}
      />

      <ConfirmDialog
        open={pauseTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPauseTarget(null);
        }}
        title="Pause this destination?"
        description={pauseTarget ? pauseSentence(pauseTarget) : ""}
        confirmLabel="Pause destination"
        confirmVariant="default"
        onConfirm={async () => {
          if (!pauseTarget) return;
          const operation = beginRowOperation(pauseTarget, "pause");
          if (!operation) return;
          await rowMutation.mutateAsync(operation);
          setPauseTarget(null);
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Permanently delete this destination?"
        description={deleteTarget ? deleteSentence(deleteTarget) : ""}
        confirmLabel="Delete permanently"
        confirmationToken="DELETE"
        onConfirm={async () => {
          if (!deleteTarget) return;
          const operation = beginRowOperation(deleteTarget, "delete");
          if (!operation) return;
          await rowMutation.mutateAsync(operation);
          setDeleteTarget(null);
        }}
      />

      <ConfirmDialog
        open={rotateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRotateTarget(null);
        }}
        title="Rotate signing material?"
        description={rotateTarget ? rotateSentence(rotateTarget) : ""}
        confirmLabel="Rotate key"
        onConfirm={async () => {
          if (!rotateTarget) return;
          const operation = beginSingleWebhookOperation(rotateTarget);
          if (!operation) return;
          await rotateMutation.mutateAsync(operation);
          setRotateTarget(null);
        }}
      />

      <ConfirmDialog
        open={bulkPauseOpen}
        onOpenChange={setBulkPauseOpen}
        title={`Pause ${selected.size} ${selected.size === 1 ? "destination" : "destinations"}?`}
        description={`This affects only the ${selected.size} selected ${selected.size === 1 ? "destination" : "destinations"}. New events and pending attempts are paused; history, delivery rows, and signing configuration are retained, and each destination can be resumed.`}
        confirmLabel="Pause selected"
        confirmVariant="default"
        onConfirm={async () => {
          const operation = beginBulkOperation([...selected], "pause");
          if (!operation) return;
          await bulkMutation.mutateAsync(operation);
          setBulkPauseOpen(false);
        }}
      />

      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={`Delete ${selected.size} ${selected.size === 1 ? "destination" : "destinations"}?`}
        description={`This permanently tombstones only the ${selected.size} selected ${selected.size === 1 ? "destination" : "destinations"}. Pending deliveries are cancelled as “skipped,” tenant-wide diagnostics retain delivery evidence, and destination, receiver-auth, and signing secrets are shredded. Pause instead for a reversible stop.`}
        confirmLabel="Delete selected"
        confirmationToken="DELETE"
        onConfirm={async () => {
          const operation = beginBulkOperation([...selected], "delete");
          if (!operation) return;
          await bulkMutation.mutateAsync(operation);
          setBulkDeleteOpen(false);
        }}
      />
    </PageShell>
  );
}
