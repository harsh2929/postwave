// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
import { Textarea } from "@/components/ui/textarea";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { apiErrorMessage } from "@/lib/api";
import type { AuditFilters } from "@/lib/audit-api";
import {
  auditAccessRequesterKey,
  auditAccessRequesterLabel,
  auditFiltersFromSavedSnapshot,
  auditFiltersToSavedSnapshot,
  auditSavedViewDraftError,
  canManageAuditSavedViews,
  createAuditAccessRequest,
  createAuditSavedView,
  deleteAuditSavedView,
  listAuditAccessRequests,
  listAuditSavedViews,
  normalizeAccessRequestNote,
  resolveAuditAccessRequest,
  sameAuditSavedViewRevision,
  updateAuditSavedView,
  type AuditAccessDecision,
  type AuditAccessRequest,
  type AuditAccessStatus,
  type AuditCapabilities,
  type AuditSavedView,
} from "@/lib/audit-saved-views-access-api";
import {
  effectiveAuthRole,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";
import { STALE } from "@/lib/query-keys";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

async function verifyFreshSessionIdentity(opened: MeResponse): Promise<void> {
  const fresh = await whoamiFresh();
  if (
    fresh.user_id !== opened.user_id ||
    fresh.tenant_id !== opened.tenant_id ||
    effectiveAuthRole(fresh) !== effectiveAuthRole(opened) ||
    Boolean(fresh.viewer_mode) !== Boolean(opened.viewer_mode)
  ) {
    throw new Error(
      "Workspace identity or authority changed. Nothing was submitted; reload and retry.",
    );
  }
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function AuditRestrictedAccessPanel({
  identity,
}: {
  identity: MeResponse;
}) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<AuditAccessRequest | null>(null);
  const operationRef = useRef(false);
  const dirty = note.trim().length > 0 && !receipt;
  useUnsavedChangesGuard(dirty && !pending);

  let validation: string | null = null;
  try {
    normalizeAccessRequestNote(note);
  } catch (cause) {
    validation = cause instanceof Error ? cause.message : "The request note is invalid.";
  }

  async function submit(): Promise<void> {
    if (pending || operationRef.current || validation) return;
    operationRef.current = true;
    setPending(true);
    setError(null);
    try {
      await verifyFreshSessionIdentity(identity);
      const saved = await createAuditAccessRequest({
        note,
        expectedUserId: identity.user_id,
        expectedEmail: identity.email,
      });
      setReceipt(saved);
      setNote("");
      toast.success("Audit-access request recorded.");
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not record the audit-access request."));
    } finally {
      operationRef.current = false;
      setPending(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h2 className="font-display text-xl font-semibold tracking-tight">
          Audit log
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Raw audit evidence is restricted in this workspace.
        </p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Request elevated audit access</CardTitle>
          <CardDescription>
            Viewing raw evidence requires both <code>audit:read</code> and{" "}
            <code>audit:read_pii</code>. This request records a review item; it
            does not grant access or notify people outside Moosewave.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {receipt ? (
            <Alert>
              <AlertTitle>Request pending</AlertTitle>
              <AlertDescription>
                Request <span className="font-mono">{receipt.id}</span> was
                recorded {new Date(receipt.createdAt).toLocaleString()}. Repeated
                submissions return this same open request; the first note is
                preserved.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="audit-access-note">Reason (optional)</Label>
                <Textarea
                  id="audit-access-note"
                  value={note}
                  disabled={pending}
                  aria-invalid={Boolean(validation)}
                  aria-describedby="audit-access-note-help"
                  onChange={(event) => {
                    setNote(event.target.value);
                    setError(null);
                  }}
                  placeholder="What evidence do you need to review?"
                />
                <p
                  id="audit-access-note-help"
                  className="text-xs text-muted-foreground"
                >
                  {bytes(note)} / 1,000 UTF-8 bytes. Do not include credentials or
                  customer content.
                </p>
                {validation ? (
                  <p role="alert" className="text-sm text-destructive-emphasis">
                    {validation}
                  </p>
                ) : null}
              </div>
              {error ? (
                <Alert variant="destructive">
                  <AlertTitle>Request not recorded</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              <Button
                type="button"
                onClick={() => void submit()}
                disabled={Boolean(validation) || pending}
                loading={pending}
              >
                {pending ? "Recording…" : "Request access"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const ACCESS_FILTERS: Array<AuditAccessStatus | "all"> = [
  "pending",
  "all",
  "approved",
  "denied",
  "dismissed",
];

function statusVariant(
  status: AuditAccessStatus,
): "warning" | "success" | "destructive" | "outline" {
  if (status === "pending") return "warning";
  if (status === "approved") return "success";
  if (status === "denied") return "destructive";
  return "outline";
}

function decisionCopy(decision: AuditAccessDecision): {
  title: string;
  description: string;
  label: string;
  token: string;
} {
  if (decision === "approved") {
    return {
      title: "Record approval?",
      description:
        "This records evidence only. The server will refuse unless Team already grants this active member audit:read and audit:read_pii. It never changes a role.",
      label: "Record approved",
      token: "APPROVE",
    };
  }
  if (decision === "denied") {
    return {
      title: "Deny this request?",
      description:
        "Denial records that the access request was reviewed and refused. It does not change the requester's current role.",
      label: "Record denied",
      token: "DENY",
    };
  }
  return {
    title: "Dismiss this request?",
    description:
      "Dismissal is for duplicate, obsolete, or unactionable requests. It does not grant or revoke access.",
    label: "Record dismissed",
    token: "DISMISS",
  };
}

export function AuditAccessRequestsAdminPanel({
  identity,
}: {
  identity: MeResponse;
}) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<AuditAccessStatus | "all">("pending");
  const [decision, setDecision] = useState<{
    request: AuditAccessRequest;
    decision: AuditAccessDecision;
  } | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const role = effectiveAuthRole(identity);
  const queryKey = [
    "audit-access-requests",
    identity.tenant_id,
    role,
    status,
  ] as const;
  const requests = useQuery({
    queryKey,
    queryFn: ({ signal }) => listAuditAccessRequests(status, signal),
    staleTime: STALE.list,
    retry: false,
  });

  async function resolve(
    request: AuditAccessRequest,
    next: AuditAccessDecision,
  ): Promise<void> {
    await verifyFreshAdminAuthority(identity);
    const freshPending = await listAuditAccessRequests("pending");
    const current = freshPending.find((candidate) => candidate.id === request.id);
    if (
      !current ||
      current.createdAt !== request.createdAt ||
      auditAccessRequesterKey(current) !== auditAccessRequesterKey(request)
    ) {
      throw new Error(
        "This request changed after the decision opened. Nothing was written; refresh and review the current queue.",
      );
    }
    const result = await resolveAuditAccessRequest(current, next);
    const terminal = await listAuditAccessRequests(next);
    const confirmed = terminal.find((candidate) => candidate.id === request.id);
    if (
      !confirmed ||
      confirmed.status !== next ||
      confirmed.resolvedAt !== result.request.resolvedAt
    ) {
      throw new Error(
        "The decision returned, but a fresh status read did not confirm it.",
      );
    }
    setDecision(null);
    setReceipt(
      `${auditAccessRequesterLabel(confirmed)} was recorded as ${next}${
        next === "approved" ? " after the server verified the existing grant" : ""
      }.`,
    );
    await qc.invalidateQueries({ queryKey: ["audit-access-requests", identity.tenant_id] });
    toast.success(`Audit-access request ${next}.`);
  }

  const decisionDetails = decision ? decisionCopy(decision.decision) : null;
  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Audit-access review queue</CardTitle>
          <CardDescription>
            Review persisted requests. Use Team to grant scopes first; approval
            here is evidence of a verified grant, never the grant itself.
          </CardDescription>
        </div>
        <Button asChild type="button" variant="outline" size="sm">
          <Link href="/app/settings/team">Open Team roles</Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="audit-access-status-filter">Status</Label>
            <Select
              id="audit-access-status-filter"
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as AuditAccessStatus | "all")
              }
            >
              {ACCESS_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {value === "all" ? "All history" : value}
                </option>
              ))}
            </Select>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void requests.refetch()}
            disabled={requests.isFetching}
          >
            {requests.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>

        {receipt ? (
          <Alert>
            <AlertTitle>Decision confirmed</AlertTitle>
            <AlertDescription>{receipt}</AlertDescription>
          </Alert>
        ) : null}
        {requests.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Review queue unavailable</AlertTitle>
            <AlertDescription>
              {apiErrorMessage(
                requests.error,
                "Could not load audit-access requests. No empty-queue claim was made.",
              )}
            </AlertDescription>
          </Alert>
        ) : requests.isPending ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading audit-access requests…
          </p>
        ) : requests.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No {status === "all" ? "recorded" : status} audit-access requests.
          </p>
        ) : (
          <TableContainer>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Requester</TableHead>
                  <TableHead>Request</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.data.map((request) => (
                  <TableRow key={request.id} className="align-top">
                    <TableCell>
                      <div className="font-medium">
                        {auditAccessRequesterLabel(request)}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {auditAccessRequesterKey(request)}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-md">
                      <p className="whitespace-pre-wrap break-words text-sm">
                        {request.note || "No reason supplied."}
                      </p>
                      <time
                        dateTime={request.createdAt}
                        className="text-xs text-muted-foreground"
                      >
                        Requested {new Date(request.createdAt).toLocaleString()}
                      </time>
                      {request.resolvedAt ? (
                        <div className="text-xs text-muted-foreground">
                          Resolved {new Date(request.resolvedAt).toLocaleString()}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(request.status)}>
                        {request.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {request.status === "pending" ? (
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={!request.userId}
                            title={
                              request.userId
                                ? "Requires a separately verified Team grant"
                                : "API-key requests have no durable member grant to verify"
                            }
                            onClick={() =>
                              setDecision({ request, decision: "approved" })
                            }
                          >
                            Approve
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setDecision({ request, decision: "denied" })
                            }
                          >
                            Deny
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setDecision({ request, decision: "dismissed" })
                            }
                          >
                            Dismiss
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Terminal
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </CardContent>
      <ConfirmDialog
        open={Boolean(decision)}
        onOpenChange={(open) => !open && setDecision(null)}
        title={decisionDetails?.title ?? "Record decision?"}
        description={decisionDetails?.description ?? "Review this request."}
        confirmLabel={decisionDetails?.label}
        confirmVariant={decision?.decision === "dismissed" ? "outline" : "destructive"}
        confirmationToken={decisionDetails?.token}
        onConfirm={async () => {
          if (!decision) return;
          await resolve(decision.request, decision.decision);
        }}
      />
    </Card>
  );
}

type SavedFilterState = ReturnType<typeof auditFiltersFromSavedSnapshot>;

export function AuditSavedViewsPanel({
  identity,
  capabilities,
  currentFilters,
  onApply,
}: {
  identity: MeResponse;
  capabilities: AuditCapabilities;
  currentFilters: AuditFilters;
  onApply: (filters: SavedFilterState) => void;
}) {
  const qc = useQueryClient();
  const role = effectiveAuthRole(identity);
  const canManage = canManageAuditSavedViews(capabilities) && !identity.viewer_mode;
  const queryKey = ["audit-saved-views", identity.tenant_id, role] as const;
  const views = useQuery({
    queryKey,
    queryFn: ({ signal }) => listAuditSavedViews(signal),
    staleTime: STALE.list,
    retry: false,
  });
  const [selectedId, setSelectedId] = useState("");
  const [editing, setEditing] = useState<"create" | AuditSavedView | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [replaceFilters, setReplaceFilters] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AuditSavedView | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const operationRef = useRef(false);
  const currentSnapshot = auditFiltersToSavedSnapshot(currentFilters);
  const draftFilters =
    editing === "create" || replaceFilters
      ? currentSnapshot
      : editing?.filters ?? currentSnapshot;
  const baselineName = editing && editing !== "create" ? editing.name : "";
  const baselineDescription =
    editing && editing !== "create" ? editing.description : "";
  const dirty = Boolean(
    editing &&
      (name !== baselineName ||
        description !== baselineDescription ||
        (editing !== "create" && replaceFilters)),
  );
  useUnsavedChangesGuard(dirty && !saving);
  const validation = editing
    ? auditSavedViewDraftError({ name, description, filters: draftFilters })
    : null;
  const selected = views.data?.find((view) => view.id === selectedId) ?? null;

  function closeEditor(): void {
    setEditing(null);
    setName("");
    setDescription("");
    setReplaceFilters(false);
    setFormError(null);
  }

  function openCreate(): void {
    setEditing("create");
    setName("");
    setDescription("");
    setReplaceFilters(true);
    setFormError(null);
    setReceipt(null);
  }

  function openEdit(view: AuditSavedView): void {
    setEditing(view);
    setName(view.name);
    setDescription(view.description);
    setReplaceFilters(false);
    setFormError(null);
    setReceipt(null);
  }

  async function save(): Promise<void> {
    if (!canManage || !editing || validation || operationRef.current) return;
    operationRef.current = true;
    setSaving(true);
    setFormError(null);
    try {
      await verifyFreshAdminAuthority(identity);
      const before = await listAuditSavedViews(undefined, true);
      let saved: AuditSavedView;
      if (editing === "create") {
        if (before.some((view) => view.name === name.trim())) {
          throw new Error("A saved view with this name already exists.");
        }
        saved = await createAuditSavedView({ name, description, filters: draftFilters });
      } else {
        const current = before.find((view) => view.id === editing.id);
        if (!current || !sameAuditSavedViewRevision(current, editing)) {
          qc.setQueryData(queryKey, before);
          throw new Error(
            "This saved view changed after editing began. Review the latest server state.",
          );
        }
        saved = await updateAuditSavedView(current, {
          name,
          description,
          filters: draftFilters,
        });
      }
      const after = await listAuditSavedViews(undefined, true);
      const confirmed = after.find((view) => view.id === saved.id);
      if (!confirmed || !sameAuditSavedViewRevision(saved, confirmed)) {
        throw new Error(
          "The saved-view write returned, but a fresh read did not confirm it.",
        );
      }
      qc.setQueryData(queryKey, after);
      setSelectedId(confirmed.id);
      closeEditor();
      setReceipt(`Saved view “${confirmed.name}” was written and read back.`);
      toast.success("Audit saved view confirmed.");
    } catch (cause) {
      setFormError(apiErrorMessage(cause, "Could not save the audit view."));
      void views.refetch();
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  async function remove(view: AuditSavedView): Promise<void> {
    if (!canManage || operationRef.current) return;
    operationRef.current = true;
    setSaving(true);
    try {
      await verifyFreshAdminAuthority(identity);
      const before = await listAuditSavedViews(undefined, true);
      const current = before.find((candidate) => candidate.id === view.id);
      if (!current || !sameAuditSavedViewRevision(current, view)) {
        qc.setQueryData(queryKey, before);
        throw new Error(
          "This saved view changed after deletion was opened. Review the latest state.",
        );
      }
      await deleteAuditSavedView(current);
      const after = await listAuditSavedViews(undefined, true);
      if (after.some((candidate) => candidate.id === view.id)) {
        throw new Error("A fresh read did not confirm saved-view deletion.");
      }
      qc.setQueryData(queryKey, after);
      if (selectedId === view.id) setSelectedId("");
      if (editing !== "create" && editing?.id === view.id) closeEditor();
      setDeleteTarget(null);
      setReceipt(`Saved view “${view.name}” was deleted; audit rows were untouched.`);
      toast.success("Audit saved view deleted.");
    } catch (cause) {
      void views.refetch();
      throw cause;
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">Saved audit views</h3>
          <p className="text-sm text-muted-foreground">
            Load tenant-shared filter sets. Exact calendar ranges created on web
            remain readable on desktop, where relative ranges are the native control.
          </p>
        </div>
        {canManage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={Boolean(editing) || saving}
            onClick={openCreate}
          >
            Save current view
          </Button>
        ) : (
          <Badge variant="outline">Read-only</Badge>
        )}
      </div>

      {views.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Saved views unavailable</AlertTitle>
          <AlertDescription>
            {apiErrorMessage(views.error, "Could not load saved audit views.")}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1 space-y-1.5">
            <Label htmlFor="audit-saved-view-select">Saved view</Label>
            <Select
              id="audit-saved-view-select"
              value={selectedId}
              disabled={views.isPending || saving}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              <option value="">
                {views.isPending
                  ? "Loading saved views…"
                  : views.data?.length
                    ? "Choose a saved view"
                    : "No saved views"}
              </option>
              {views.data?.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.name}
                </option>
              ))}
            </Select>
          </div>
          <Button
            type="button"
            disabled={!selected || saving}
            onClick={() => {
              if (!selected) return;
              onApply(auditFiltersFromSavedSnapshot(selected.filters));
              setReceipt(`Applied saved view “${selected.name}” to the URL-backed filters.`);
            }}
          >
            Apply
          </Button>
          {canManage ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={!selected || Boolean(editing) || saving}
                onClick={() => selected && openEdit(selected)}
              >
                Edit
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={!selected || saving}
                onClick={() => selected && setDeleteTarget(selected)}
              >
                Delete
              </Button>
            </>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            disabled={views.isFetching}
            onClick={() => void views.refetch()}
          >
            {views.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      )}

      {selected?.description ? (
        <p className="text-sm text-muted-foreground">{selected.description}</p>
      ) : null}
      {receipt ? (
        <p role="status" aria-live="polite" className="text-sm text-success-emphasis">
          {receipt}
        </p>
      ) : null}

      {editing ? (
        <section
          aria-label={editing === "create" ? "Create saved audit view" : "Edit saved audit view"}
          className="space-y-4 rounded-md border bg-muted/20 p-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="audit-saved-view-name">Name</Label>
              <Input
                id="audit-saved-view-name"
                value={name}
                disabled={saving}
                aria-invalid={Boolean(validation)}
                onChange={(event) => setName(event.target.value)}
                placeholder="SOC 2 monthly review"
              />
              <p className="text-xs text-muted-foreground">
                {bytes(name.trim())} / 256 UTF-8 bytes
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="audit-saved-view-description">
                Description (optional)
              </Label>
              <Input
                id="audit-saved-view-description"
                value={description}
                disabled={saving}
                onChange={(event) => setDescription(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {bytes(description.trim())} / 2,048 UTF-8 bytes
              </p>
            </div>
          </div>
          {editing !== "create" ? (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={replaceFilters}
                disabled={saving}
                onChange={(event) => setReplaceFilters(event.target.checked)}
              />
              <span>
                Replace this view&apos;s stored filters with the filters currently
                applied to the audit page.
              </span>
            </label>
          ) : null}
          {validation ? (
            <p role="alert" className="text-sm text-destructive-emphasis">
              {validation}
            </p>
          ) : null}
          {formError ? (
            <Alert variant="destructive">
              <AlertTitle>Saved view not written</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => void save()}
              disabled={Boolean(validation) || saving}
              loading={saving}
            >
              {saving ? "Saving…" : editing === "create" ? "Create view" : "Save changes"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => (dirty ? setDiscardOpen(true) : closeEditor())}
            >
              Cancel
            </Button>
          </div>
        </section>
      ) : null}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete saved audit view?"
        description={`Delete “${deleteTarget?.name ?? "this view"}”? This removes only the named filter set; no audit rows are deleted.`}
        confirmLabel="Delete view"
        confirmationToken={deleteTarget?.name}
        onConfirm={async () => {
          if (deleteTarget) await remove(deleteTarget);
        }}
      />
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard saved-view draft?"
        description="The unsaved name, description, and filter selection will be lost."
        confirmLabel="Discard draft"
        confirmationToken="DISCARD"
        onConfirm={() => {
          closeEditor();
          setDiscardOpen(false);
        }}
      />
    </div>
  );
}
