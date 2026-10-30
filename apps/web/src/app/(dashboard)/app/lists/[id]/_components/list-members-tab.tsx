// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Users } from "lucide-react";
import { toast } from "sonner";

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
import { MiddleTruncate } from "@/components/ui/middle-truncate";
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
import { newWriteKey } from "@/lib/audience-admin-api";
import { invalidateMembership } from "@/lib/audience-invalidation";
import { whoamiFresh, type MeResponse } from "@/lib/auth-api";
import {
  addMembers,
  findSubscriberCandidates,
  listMemberSourceLabel,
  listMembers,
  MEMBER_STATUSES,
  MEMBERS_PAGE_SIZE,
  removeMember,
  type AudienceList,
  type ListMember,
  type MemberStatus,
} from "@/lib/lists-api";
import { base, listKeys, STALE, type RoleKey } from "@/lib/query-keys";

import {
  assertWriteIdentity,
  MEMBERSHIP_REASON,
  MEMBERSHIP_ROLES,
} from "./write-identity";

type StatusFilter = "all" | MemberStatus;

const STATUS_LABELS: Record<MemberStatus, string> = {
  enabled: "Enabled",
  disabled: "Disabled",
  blocklisted: "Blocklisted",
  unconfirmed: "Unconfirmed",
};

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  if (s === "blocklisted")
    return <Badge variant="destructive">Blocklisted</Badge>;
  if (s === "disabled") return <Badge variant="warning">Disabled</Badge>;
  if (s === "unconfirmed") return <Badge variant="warning">Unconfirmed</Badge>;
  if (s === "enabled") return <Badge variant="success">Enabled</Badge>;
  return <Badge variant="outline">{status || "—"}</Badge>;
}

export function ListMembersTab({
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
  const qc = useQueryClient();
  const reasonId = useId();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const [removeTarget, setRemoveTarget] = useState<ListMember | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // 220ms debounce mirrors the desktop members search.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(query.trim());
      setPage(1);
    }, 220);
    return () => clearTimeout(t);
  }, [query]);

  const params = {
    query: debounced || undefined,
    status: status === "all" ? undefined : status,
    page,
    perPage: MEMBERS_PAGE_SIZE,
  };
  const members = useQuery({
    queryKey: listKeys.members(tenantId, roleKey, list.id, params),
    queryFn: ({ signal }) => listMembers(list.id, params, signal),
    placeholderData: (previous) => previous,
    staleTime: STALE.list,
  });

  const total = members.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / MEMBERS_PAGE_SIZE));
  const rows = Array.isArray(members.data?.items) ? members.data.items : [];
  const filtered = Boolean(debounced) || status !== "all";

  /** Everything the membership change moved — this table included. */
  async function refreshMembership(subscriberIds: string[]): Promise<void> {
    await invalidateMembership(qc, tenantId, roleKey, { subscriberIds });
  }

  /** Thrown errors render inside the confirm dialog with the server's sentence. */
  async function confirmRemove(): Promise<void> {
    if (!removeTarget || !me) return;
    assertWriteIdentity(
      me,
      await whoamiFresh(),
      MEMBERSHIP_ROLES,
      MEMBERSHIP_REASON,
    );
    await removeMember(
      list.id,
      removeTarget.id,
      newWriteKey("list-member-remove"),
    );
    toast.success(
      `${removeTarget.email} is no longer on ${list.name}. The subscriber record is kept.`,
    );
    // Last row on a later page: step back so the operator is not left on an
    // empty page; otherwise refetch in place.
    if (rows.length === 1 && page > 1) setPage((p) => Math.max(1, p - 1));
    await refreshMembership([removeTarget.id]);
    setRemoveTarget(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <Label htmlFor={`${reasonId}-search`}>Search members</Label>
          <Input
            id={`${reasonId}-search`}
            value={query}
            placeholder="Email"
            onChange={(e) => setQuery(e.target.value)}
            className="max-w-md"
          />
        </div>
        <div>
          <Label htmlFor={`${reasonId}-status`}>Status</Label>
          <Select
            id={`${reasonId}-status`}
            aria-label="Filter by status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as StatusFilter);
              setPage(1);
            }}
          >
            <option value="all">All statuses</option>
            {MEMBER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>
        <Button
          type="button"
          disabled={!canAdmin}
          aria-describedby={canAdmin ? undefined : reasonId}
          onClick={() => setAddOpen(true)}
        >
          <UserPlus aria-hidden className="size-4" /> Add subscribers
        </Button>
      </div>
      {!canAdmin ? (
        <p id={reasonId} className="text-xs text-muted-foreground">
          {MEMBERSHIP_REASON}
        </p>
      ) : null}

      {members.isError ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 p-4"
        >
          <p className="font-medium text-destructive">
            Members could not be loaded
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {apiErrorMessage(members.error, "The list members request failed")}
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-3"
            loading={members.isFetching}
            onClick={() => void members.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : members.isPending ? (
        <p role="status" aria-label="Loading members">
          Loading members…
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title={filtered ? "No members match" : "No subscribers yet"}
          description={
            filtered
              ? "Clear the search or status filter to see every member."
              : "Add existing subscribers to start building this list."
          }
        />
      ) : (
        <TableContainer aria-label={`${list.name} members`}>
          <Table className="min-w-[640px]">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Email</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Source</TableHead>
                <TableHead scope="col">Added</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="max-w-[280px]">
                    <MiddleTruncate value={m.email} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={m.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {(() => {
                      const source = listMemberSourceLabel(m.source);
                      if (!source) return "—";
                      return <span title={source.hint}>{source.label}</span>;
                    })()}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <RelativeTime iso={m.added_at} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={!canAdmin}
                      aria-describedby={canAdmin ? undefined : reasonId}
                      aria-label={`Remove ${m.email} from ${list.name}`}
                      onClick={() => setRemoveTarget(m)}
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {members.data ? (
        <nav
          aria-label="Member pages"
          className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
        >
          <span>
            Page {page} of {totalPages} · {total.toLocaleString()} member
            {total === 1 ? "" : "s"}
          </span>
          {total > MEMBERS_PAGE_SIZE ? (
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                aria-label="Previous page"
                disabled={page <= 1 || members.isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                aria-label="Next page"
                disabled={page >= totalPages || members.isFetching}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          ) : null}
        </nav>
      ) : null}

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(v) => !v && setRemoveTarget(null)}
        title="Remove from list?"
        description={
          removeTarget
            ? `${removeTarget.email} will be removed from ${list.name}. The subscriber record itself is kept.`
            : ""
        }
        confirmLabel="Remove"
        onConfirm={confirmRemove}
      />

      <AddSubscribersDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        list={list}
        me={me}
        tenantId={tenantId}
        roleKey={roleKey}
        onAdded={refreshMembership}
      />
    </div>
  );
}

function AddSubscribersDialog({
  open,
  onClose,
  list,
  me,
  tenantId,
  roleKey,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  list: AudienceList;
  me: MeResponse | undefined;
  tenantId: string;
  roleKey: RoleKey;
  onAdded: (subscriberIds: string[]) => Promise<void>;
}) {
  const searchId = useId();
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 220);
    return () => clearTimeout(t);
  }, [term]);

  const candidates = useQuery({
    queryKey: [
      ...base("subscriber-candidates", tenantId, roleKey),
      String(list.id),
      debounced,
    ],
    queryFn: ({ signal }) => findSubscriberCandidates(debounced, signal),
    enabled: open,
    staleTime: STALE.list,
  });

  function reset(): void {
    setTerm("");
    setDebounced("");
    setSelected(new Set());
    setError(null);
  }

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(): Promise<void> {
    if (busy || !me || selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      assertWriteIdentity(
        me,
        await whoamiFresh(),
        MEMBERSHIP_ROLES,
        MEMBERSHIP_REASON,
      );
      const picked = [...selected];
      const receipt = await addMembers(
        list.id,
        picked,
        newWriteKey("list-members-add"),
      );
      // The server's counts, verbatim: skipped covers existing members,
      // suppressed addresses and unknown ids.
      const copy = `${receipt.added} added, ${receipt.skipped} skipped on ${list.name}.`;
      if (receipt.added > 0) toast.success(copy);
      else toast.info(copy);
      // The receipt does not say which ids were skipped, so every picked
      // profile is refreshed.
      if (receipt.added > 0) await onAdded(picked);
      if (!mounted.current) return;
      reset();
      onClose();
    } catch (e) {
      if (mounted.current)
        setError(apiErrorMessage(e, "Subscribers could not be added"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (busy || v) return;
        reset();
        onClose();
      }}
    >
      <DialogContent closeDisabled={busy}>
        <DialogHeader>
          <DialogTitle>Add subscribers to {list.name}</DialogTitle>
          <DialogDescription>
            Search existing subscribers by email and pick the ones to add.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Label htmlFor={searchId}>Search subscribers</Label>
          <Input
            id={searchId}
            value={term}
            placeholder="Email"
            disabled={busy}
            onChange={(e) => setTerm(e.target.value)}
          />
          <div
            className="max-h-72 overflow-y-auto rounded-md border"
            aria-live="polite"
          >
            {candidates.isPending ? (
              <p className="p-3 text-sm text-muted-foreground">Searching…</p>
            ) : candidates.isError ? (
              <p role="alert" className="p-3 text-sm text-destructive">
                {apiErrorMessage(candidates.error, "Search failed")}
              </p>
            ) : candidates.data.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                {debounced
                  ? `No subscribers match "${debounced}".`
                  : "No subscribers found."}
              </p>
            ) : (
              <ul className="divide-y">
                {candidates.data.map((c) => (
                  <li key={c.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                      <Checkbox
                        checked={selected.has(c.id)}
                        disabled={busy}
                        aria-label={`Select ${c.email}`}
                        onChange={() => toggle(c.id)}
                      />
                      <span className="min-w-0 flex-1 truncate" title={c.email}>
                        {c.email}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {c.status || "—"}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || selected.size === 0}
            loading={busy}
            onClick={() => void submit()}
          >
            {busy
              ? "Adding…"
              : selected.size > 0
                ? `Add (${selected.size})`
                : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
