// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// SETC-010 — the workspace roster + copy-link invitations. The page owns
// identity (whoami); this component owns the members + invites data and every
// mutation, all gated on the write role. Server-side guards (last-owner,
// owner-grants-owner, owner-modifies-owner) are the source of truth; the UI
// gating here is a courtesy that avoids surfacing a 403 after the fact.

import { useEffect, useMemo, useRef, useState } from "react";
import { UserPlus } from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
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
import { CopyTextButton } from "@/components/copy-text-button";
import { RelativeTime } from "@/components/relative-time";
import { ApiError } from "@/lib/api";
import type { AuthRole, MeResponse } from "@/lib/auth-api";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { base, STALE } from "@/lib/query-keys";
import {
  acceptInviteUrl,
  assignableRoleOptions,
  createInvite,
  labelForMemberRole,
  labelForMemberStatus,
  listInvites,
  listMembers,
  patchMember,
  revokeInvite,
} from "@/lib/team-members-api";

function statusVariant(status: string): "success" | "warning" | "outline" {
  if (status === "active") return "success";
  if (status === "suspended") return "warning";
  return "outline";
}

const INVITE_ROLES: AuthRole[] = ["admin", "editor", "viewer", "owner"];

export function TeamRoster({
  canWrite,
  callerCanOwner,
  tenantId,
  role,
  identityReady,
  identity,
}: {
  canWrite: boolean;
  callerCanOwner: boolean;
  tenantId: string;
  role: AuthRole | null;
  identityReady: boolean;
  identity: MeResponse | null;
}) {
  const qc = useQueryClient();
  const operationRef = useRef(false);
  const controllersRef = useRef(new Set<AbortController>());
  const userId = identity?.user_id ?? "anon";
  const viewerState = identity?.viewer_mode ? "viewer-mode" : "durable-mode";
  const membersKey = useMemo(
    () =>
      [
        ...base("workspace-members", tenantId, role),
        userId,
        viewerState,
      ] as const,
    [tenantId, role, userId, viewerState],
  );
  const invitesKey = useMemo(
    () =>
      [
        ...base("workspace-invites", tenantId, role),
        userId,
        viewerState,
      ] as const,
    [tenantId, role, userId, viewerState],
  );

  const membersQuery = useQuery({
    queryKey: membersKey,
    queryFn: ({ signal }) => listMembers({ signal }),
    // GET /api/v1/workspace/members is admin-scoped: a viewer/editor session
    // 403s, so only fetch when the caller can actually read the roster.
    enabled: identityReady && canWrite,
    staleTime: STALE.list,
  });
  const invitesQuery = useQuery({
    queryKey: invitesKey,
    queryFn: ({ signal }) => listInvites({ signal }),
    // Only owners/admins can list invites; a viewer would 403.
    enabled: identityReady && canWrite,
    staleTime: STALE.list,
  });

  const data = membersQuery.data ?? null;
  const callerIsOwner = data?.callerIsOwner ?? callerCanOwner;

  const patchMut = useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: { role?: string; status?: string };
    }) => {
      if (!identity || !canWrite || operationRef.current)
        throw new Error(
          "Owner or admin access is required or another team action is running.",
        );
      operationRef.current = true;
      const controller = new AbortController();
      controllersRef.current.add(controller);
      const frozenPatch = { ...patch };
      try {
        await verifyFreshAdminAuthority(identity, controller.signal);
        return await patchMember(id, frozenPatch, {
          signal: controller.signal,
          requireOnline: true,
          maxAttempts: 1,
        });
      } finally {
        controllersRef.current.delete(controller);
        operationRef.current = false;
      }
    },
    onError: (err) => {
      toast.error(
        err instanceof ApiError ? err.message : "Could not update the member.",
      );
    },
    onSuccess: () => toast.success("Member updated."),
    onSettled: () => void qc.invalidateQueries({ queryKey: membersKey }),
  });

  const revokeMut = useMutation({
    mutationFn: async (id: string) => {
      if (!identity || !canWrite || operationRef.current)
        throw new Error(
          "Owner or admin access is required or another team action is running.",
        );
      operationRef.current = true;
      const controller = new AbortController();
      controllersRef.current.add(controller);
      try {
        await verifyFreshAdminAuthority(identity, controller.signal);
        return await revokeInvite(id, {
          signal: controller.signal,
          requireOnline: true,
          maxAttempts: 1,
        });
      } finally {
        controllersRef.current.delete(controller);
        operationRef.current = false;
      }
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Could not revoke.");
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: invitesKey }),
  });

  const invites = Array.isArray(invitesQuery.data?.invites)
    ? invitesQuery.data?.invites
    : [];

  useEffect(() => {
    if (identityReady && canWrite) return;
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current.clear();
    operationRef.current = false;
    void qc.cancelQueries({ queryKey: membersKey });
    void qc.cancelQueries({ queryKey: invitesKey });
    qc.removeQueries({ queryKey: membersKey });
    qc.removeQueries({ queryKey: invitesKey });
  }, [canWrite, identityReady, invitesKey, membersKey, qc]);

  useEffect(
    () => () => {
      for (const controller of controllersRef.current) controller.abort();
      controllersRef.current.clear();
    },
    [],
  );

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            Everyone with access to this workspace.{" "}
            {canWrite
              ? "Invite teammates, change roles, or remove access."
              : "Only an owner or admin can change membership."}
          </CardDescription>
        </div>
        {canWrite ? (
          <InviteDialog
            key={`${tenantId}:${userId}:${role ?? "none"}:${viewerState}`}
            callerIsOwner={callerIsOwner}
            identity={identity}
            operationRef={operationRef}
            controllersRef={controllersRef}
            onCreated={() =>
              void qc.invalidateQueries({ queryKey: invitesKey })
            }
          />
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {!canWrite ? (
          <p className="text-sm text-muted-foreground">
            Only an owner or admin can view and manage the member roster. Ask a
            workspace admin if you need access changed.
          </p>
        ) : membersQuery.isPending ? (
          // The roster read is gated on `enabled`, so it reports isPending
          // (never isLoading) until identity resolves. Without this arm the
          // table renders its headers over an empty body, which reads as a
          // workspace with no members.
          <div
            className="space-y-2"
            aria-busy="true"
            aria-label="Loading members"
          >
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : membersQuery.isError ? (
          <p role="alert" className="text-sm text-destructive-emphasis">
            Could not load members:{" "}
            {membersQuery.error instanceof Error
              ? membersQuery.error.message
              : "unknown error"}
          </p>
        ) : (
          <TableContainer>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(Array.isArray(data?.members) ? data?.members : []).map(
                  (m) => {
                    const roleOptions = assignableRoleOptions(
                      callerIsOwner,
                      m.role,
                    );
                    // A non-owner cannot modify a sitting owner at all.
                    const rowLocked =
                      !canWrite ||
                      m.isSelf ||
                      (!callerIsOwner && m.role === "owner");
                    return (
                      <TableRow key={m.id} className="align-top">
                        <TableCell className="font-mono text-xs">
                          {m.email}
                          {m.isSelf ? (
                            <span className="ml-2 text-muted-foreground">
                              (you)
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          {rowLocked ? (
                            <span className="capitalize">
                              {labelForMemberRole(m.role)}
                            </span>
                          ) : (
                            <Select
                              aria-label={`Role for ${m.email}`}
                              value={m.role}
                              disabled={patchMut.isPending}
                              onChange={(e) =>
                                patchMut.mutate({
                                  id: m.id,
                                  patch: { role: e.target.value },
                                })
                              }
                            >
                              {roleOptions.map((r) => (
                                <option key={r} value={r}>
                                  {labelForMemberRole(r)}
                                </option>
                              ))}
                            </Select>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(m.status)}>
                            {labelForMemberStatus(m.status)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {rowLocked ? (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          ) : m.status === "suspended" ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={patchMut.isPending}
                              onClick={() =>
                                patchMut.mutate({
                                  id: m.id,
                                  patch: { status: "active" },
                                })
                              }
                            >
                              Reactivate
                            </Button>
                          ) : (
                            <ConfirmDialog
                              title={`Remove ${m.email}?`}
                              description="This suspends the member and immediately revokes their access. You can reactivate them later; it does not permanently delete the account."
                              confirmLabel="Remove access"
                              confirmVariant="destructive"
                              onConfirm={async () => {
                                await patchMut.mutateAsync({
                                  id: m.id,
                                  patch: { status: "suspended" },
                                });
                              }}
                              trigger={
                                <Button type="button" variant="ghost" size="sm">
                                  Remove
                                </Button>
                              }
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  },
                )}
                {/* `data && data.members.length` guarded the response but not
                    the field, so a payload without `members` threw here while
                    the map above survived on its Array.isArray check. Use the
                    same guard rather than a second dialect. The table only
                    renders once the query has settled, so this row states the
                    empty case and never has to speak for a load in flight. */}
                {data &&
                !(Array.isArray(data.members) && data.members.length) ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="text-center text-muted-foreground"
                    >
                      No members yet.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {canWrite && invites.length > 0 ? (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              Pending invitations
            </div>
            <TableContainer>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invites.map((iv) => (
                    <TableRow key={iv.id}>
                      <TableCell className="font-mono text-xs">
                        {iv.email}
                      </TableCell>
                      <TableCell className="capitalize">
                        {labelForMemberRole(iv.role)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        <RelativeTime iso={iv.expiresAt} />
                      </TableCell>
                      <TableCell className="text-right">
                        <ConfirmDialog
                          title={`Revoke the invite for ${iv.email}?`}
                          description="The invite link stops working immediately and cannot be re-enabled. You can send them a fresh invite at any time."
                          confirmLabel="Revoke invite"
                          confirmVariant="destructive"
                          onConfirm={async () => {
                            await revokeMut.mutateAsync(iv.id);
                          }}
                          trigger={
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={revokeMut.isPending}
                            >
                              Revoke
                            </Button>
                          }
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function InviteDialog({
  callerIsOwner,
  onCreated,
  identity,
  operationRef,
  controllersRef,
}: {
  callerIsOwner: boolean;
  onCreated: () => void;
  identity: MeResponse | null;
  operationRef: { current: boolean };
  controllersRef: { current: Set<AbortController> };
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AuthRole>("editor");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const roleChoices = callerIsOwner
    ? INVITE_ROLES
    : INVITE_ROLES.filter((r) => r !== "owner");

  const createMut = useMutation({
    mutationFn: async ({ email, role }: { email: string; role: AuthRole }) => {
      if (!identity || operationRef.current)
        throw new Error(
          "Owner or admin access is required or another team action is running.",
        );
      operationRef.current = true;
      const controller = new AbortController();
      controllersRef.current.add(controller);
      try {
        await verifyFreshAdminAuthority(identity, controller.signal);
        return await createInvite(email, role, {
          signal: controller.signal,
          requireOnline: true,
          maxAttempts: 1,
          idempotencyKey: null,
        });
      } finally {
        controllersRef.current.delete(controller);
        operationRef.current = false;
      }
    },
    onSuccess: (res, input) => {
      setEmail(input.email);
      setRole(input.role);
      setLink(acceptInviteUrl(window.location.origin, res.token));
      onCreated();
    },
    onError: (err) => {
      const message =
        err instanceof Error ? err.message : "Could not create the invite.";
      setError(message);
      toast.error(message);
    },
  });

  function reset() {
    setEmail("");
    setRole("editor");
    setLink(null);
    setError(null);
    creatingRef.current = false;
    createMut.reset();
  }

  async function submit(): Promise<void> {
    if (creatingRef.current) return;
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) return;
    creatingRef.current = true;
    setError(null);
    try {
      await createMut.mutateAsync({ email: cleanEmail, role });
    } catch {
      // The mutation owns the visible, retryable error state.
    } finally {
      creatingRef.current = false;
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && (creatingRef.current || createMut.isPending)) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm">
          <UserPlus className="h-4 w-4" />
          Invite
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-busy={createMut.isPending}
        closeDisabled={createMut.isPending}
        className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto [&_button]:min-h-11 [&_button]:min-w-11 [&_input]:min-h-11 [&_input]:text-base sm:[&_button]:min-w-0 sm:[&_input]:text-sm"
      >
        <DialogHeader>
          <DialogTitle>Invite a teammate</DialogTitle>
          <DialogDescription>
            Generates a single-use invite link. No email is sent — copy the link
            and share it however you like. It expires in 7 days.
          </DialogDescription>
        </DialogHeader>

        {link ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Share this link with <span className="font-medium">{email}</span>.
              They&apos;ll set a password and join as {labelForMemberRole(role)}
              .
            </p>
            <code className="block break-all rounded-md bg-muted p-3 text-xs font-mono">
              {link}
            </code>
            <div className="flex justify-end gap-2">
              <CopyTextButton value={link} label="Copy link" />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
              >
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="space-y-1">
              <label htmlFor="invite-email" className="text-sm font-medium">
                Email
              </label>
              <Input
                id="invite-email"
                type="email"
                required
                placeholder="teammate@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError(null);
                }}
                disabled={createMut.isPending}
                autoFocus
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "invite-error" : undefined}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="invite-role" className="text-sm font-medium">
                Role
              </label>
              <Select
                id="invite-role"
                value={role}
                onChange={(e) => {
                  setRole(e.target.value as AuthRole);
                  if (error) setError(null);
                }}
                disabled={createMut.isPending}
              >
                {roleChoices.map((r) => (
                  <option key={r} value={r}>
                    {labelForMemberRole(r)}
                  </option>
                ))}
              </Select>
            </div>
            {error ? (
              <p
                ref={errorRef}
                id="invite-error"
                role="alert"
                tabIndex={-1}
                className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {error}
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={createMut.isPending || !email.trim()}
                aria-busy={createMut.isPending}
              >
                {createMut.isPending ? "Creating…" : "Create invite link"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
