// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

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
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import {
  createReplyMailbox,
  deleteReplyMailbox,
  listReplyMailboxes,
  setReplyMailboxEnabled,
  tenantMailboxSecretPrefix,
  type ReplyMailbox,
} from "@/lib/reply-mailboxes-api";
import { useOnline } from "@/lib/use-online";

type PendingAction = "create" | `enable:${string}` | `disable:${string}` | `delete:${string}`;

export function ReplyMailboxManager({ identity }: { identity: MeResponse }) {
  const role = effectiveAuthRole(identity);
  const canManage =
    !identity.viewer_mode && (role === "admin" || role === "owner");
  const online = useOnline();
  const onlineNow = online === "online";
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ["reply-mailboxes", identity.tenant_id, role, identity.viewer_mode === true] as const,
    [identity.tenant_id, identity.viewer_mode, role],
  );
  const identityKey = `${identity.user_id}\u001f${identity.tenant_id}\u001f${role}\u001f${identity.viewer_mode === true}`;
  const identityRef = useRef(identityKey);
  identityRef.current = identityKey;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => listReplyMailboxes({ signal }),
    enabled: onlineNow,
    retry: false,
    staleTime: 30_000,
  });
  const rows = Array.isArray(query.data) ? query.data : [];
  const prefix = tenantMailboxSecretPrefix(identity.tenant_id);
  const labelId = useId();
  const hostId = useId();
  const folderId = useId();
  const usernameRefId = useId();
  const passwordRefId = useId();
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [folder, setFolder] = useState("INBOX");
  const [usernameRef, setUsernameRef] = useState("");
  const [passwordRef, setPasswordRef] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const operationRef = useRef<AbortController | null>(null);

  useEffect(() => {
    operationRef.current?.abort();
    setPending(null);
    setFormError(null);
    setReceipt(null);
    setLabel("");
    setHost("");
    setFolder("INBOX");
    setUsernameRef("");
    setPasswordRef("");
    return () => {
      operationRef.current?.abort();
    };
  }, [identityKey]);

  async function freshRows(
    signal: AbortSignal,
    expectedIdentity: string,
    assertion: (next: ReplyMailbox[]) => boolean,
  ): Promise<ReplyMailbox[]> {
    const next = await listReplyMailboxes({ signal, fresh: true });
    assertIdentity(expectedIdentity);
    if (!assertion(next)) {
      throw new Error(
        "The operation returned, but a fresh mailbox read did not confirm it.",
      );
    }
    queryClient.setQueryData(queryKey, next);
    return next;
  }

  function assertIdentity(expected: string): void {
    if (identityRef.current !== expected) {
      throw new Error(
        "Workspace identity or authority changed. Nothing was confirmed in this view.",
      );
    }
  }

  function begin(action: PendingAction): {
    controller: AbortController;
    identity: string;
  } {
    if (!canManage) throw new Error("Owner or admin access is required.");
    if (!onlineNow) throw new Error("Reconnect before changing reply mailboxes.");
    operationRef.current?.abort();
    const controller = new AbortController();
    operationRef.current = controller;
    setPending(action);
    setReceipt(null);
    return { controller, identity: identityKey };
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const expectedIdentity = identityKey;
    try {
      const operation = begin("create");
      await verifyFreshAdminAuthority(identity, operation.controller.signal);
      assertIdentity(operation.identity);
      const created = await createReplyMailbox(
        {
          label,
          host,
          folder,
          usernameSecretRef: usernameRef,
          passwordSecretRef: passwordRef,
        },
        identity.tenant_id,
        operation.controller.signal,
      );
      assertIdentity(operation.identity);
      if (created.enabled) {
        throw new Error("The server did not confirm disabled-first registration.");
      }
      await freshRows(
        operation.controller.signal,
        operation.identity,
        (next) => next.some((row) => row.id === created.id && !row.enabled),
      );
      setLabel("");
      setHost("");
      setFolder("INBOX");
      setUsernameRef("");
      setPasswordRef("");
      setReceipt(`${created.label} registered disabled. Confirm its settings, then enable polling.`);
    } catch (error) {
      if (identityRef.current === expectedIdentity) {
        setFormError(apiErrorMessage(error, "Could not register that mailbox."));
      }
    } finally {
      if (identityRef.current === expectedIdentity) setPending(null);
    }
  }

  async function changeEnabled(mailbox: ReplyMailbox, enabled: boolean) {
    const action = `${enabled ? "enable" : "disable"}:${mailbox.id}` as PendingAction;
    const operation = begin(action);
    try {
      await verifyFreshAdminAuthority(identity, operation.controller.signal);
      assertIdentity(operation.identity);
      const changed = await setReplyMailboxEnabled(
        mailbox.id,
        enabled,
        operation.controller.signal,
      );
      assertIdentity(operation.identity);
      if (changed.id !== mailbox.id || changed.enabled !== enabled) {
        throw new Error("The mailbox action receipt did not match the reviewed action.");
      }
      await freshRows(
        operation.controller.signal,
        operation.identity,
        (next) => next.some((row) => row.id === mailbox.id && row.enabled === enabled),
      );
      setReceipt(
        enabled
          ? `${mailbox.label} is enabled. This confirms registry state, not a successful live poll.`
          : `${mailbox.label} is disabled; its poll cursor is retained.`,
      );
    } catch (error) {
      throw new Error(apiErrorMessage(error, `Could not ${enabled ? "enable" : "disable"} that mailbox.`));
    } finally {
      if (identityRef.current === operation.identity) setPending(null);
    }
  }

  async function remove(mailbox: ReplyMailbox) {
    const operation = begin(`delete:${mailbox.id}`);
    try {
      await verifyFreshAdminAuthority(identity, operation.controller.signal);
      assertIdentity(operation.identity);
      await deleteReplyMailbox(mailbox.id, operation.controller.signal);
      assertIdentity(operation.identity);
      await freshRows(
        operation.controller.signal,
        operation.identity,
        (next) => !next.some((row) => row.id === mailbox.id),
      );
      setReceipt(`${mailbox.label} and its poll cursor were deleted.`);
    } catch (error) {
      throw new Error(apiErrorMessage(error, "Could not delete that mailbox."));
    } finally {
      if (identityRef.current === operation.identity) setPending(null);
    }
  }

  const busy = pending !== null;

  return (
    <Card aria-labelledby="reply-mailbox-manager-title">
      <CardHeader>
        <CardTitle as="h2" id="reply-mailbox-manager-title">
          Reply mailbox capture
        </CardTitle>
        <CardDescription>
          Manage the IMAP sources that pull campaign replies into Moosewave.
          Status comes from the registry and poller; it is not live mailbox
          certification.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!onlineNow ? (
          <Alert variant="warning" role="status">
            <AlertTitle>Reconnect to verify mailbox state</AlertTitle>
            <AlertDescription>
              Changes are online-only and are never queued. Last-loaded rows remain visible but may be stale.
            </AlertDescription>
          </Alert>
        ) : null}

        {query.isPending && rows.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {onlineNow ? "Loading reply mailboxes…" : "Mailbox state has not been loaded on this connection."}
          </p>
        ) : query.isError && rows.length === 0 ? (
          <Alert variant="destructive">
            <AlertTitle>Reply mailboxes could not be verified</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>A failed request is not being presented as an empty registry.</p>
              <Button type="button" variant="outline" onClick={() => void query.refetch()} disabled={!onlineNow || query.isFetching}>
                {query.isFetching ? "Retrying…" : "Retry mailbox read"}
              </Button>
            </AlertDescription>
          </Alert>
        ) : query.isSuccess && rows.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No reply mailboxes are registered in this workspace.
          </p>
        ) : null}

        {rows.length > 0 ? (
          <ul className="divide-y rounded-md border" aria-label="Registered reply mailboxes">
            {rows.map((mailbox) => {
              const quarantined = Boolean(mailbox.securityQuarantinedAt);
              const failing = Boolean(mailbox.lastError?.trim());
              const status = quarantined
                ? "Security quarantined"
                : failing
                  ? "Poll failing"
                  : mailbox.enabled
                    ? mailbox.lastPolledAt
                      ? "Polling"
                      : "Awaiting first poll"
                    : "Disabled";
              const variant = quarantined || failing ? "destructive" : mailbox.enabled ? "success" : "secondary";
              return (
                <li key={mailbox.id} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-medium">{mailbox.label}</h3>
                      <p className="break-all text-sm text-muted-foreground">
                        {mailbox.host}:{mailbox.port} · {mailbox.folder} · {mailbox.useTLS ? "implicit TLS" : "unsafe legacy transport"}
                      </p>
                    </div>
                    <Badge variant={variant}>{status}</Badge>
                  </div>
                  <dl className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                    <div>
                      <dt className="font-medium text-foreground">Username reference</dt>
                      <dd className="break-all font-mono">{mailbox.usernameSecretRef}</dd>
                    </div>
                    <div>
                      <dt className="font-medium text-foreground">Last poll</dt>
                      <dd>
                        {mailbox.lastPolledAt ? (
                          <time dateTime={mailbox.lastPolledAt}>{new Date(mailbox.lastPolledAt).toLocaleString()}</time>
                        ) : (
                          "No completed poll recorded"
                        )}
                      </dd>
                    </div>
                  </dl>
                  {mailbox.lastError ? (
                    <p role="alert" className="whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis">
                      Last poll error: {mailbox.lastError}
                    </p>
                  ) : null}
                  {quarantined ? (
                    <p role="status" className="rounded-md border border-warning/30 bg-warning/5 p-3 text-sm text-muted-foreground">
                      This legacy registration cannot be enabled. Delete it and register a TLS/tenant-reference replacement.
                    </p>
                  ) : null}
                  {canManage ? (
                    <div className="flex flex-wrap gap-2">
                      <ConfirmDialog
                        title={`${mailbox.enabled ? "Disable" : "Enable"} ${mailbox.label}?`}
                        description={mailbox.enabled ? "Polling stops, but the current cursor is retained for a later resume." : "Polling will begin from the stored cursor. This does not certify a successful connection."}
                        confirmLabel={mailbox.enabled ? "Disable polling" : "Enable polling"}
                        confirmVariant={mailbox.enabled ? "destructive" : "default"}
                        trigger={
                          <Button type="button" variant="outline" disabled={!onlineNow || busy || quarantined} aria-label={`${mailbox.enabled ? "Disable" : "Enable"} polling for ${mailbox.label}`}>
                            {mailbox.enabled ? "Disable" : "Enable"}
                          </Button>
                        }
                        onConfirm={() => changeEnabled(mailbox, !mailbox.enabled)}
                      />
                      <ConfirmDialog
                        title={`Delete ${mailbox.label}?`}
                        description="This removes the registration and poll cursor. A later replacement starts at the mailbox's then-current high-water mark, so replies received while it was absent may be skipped. Disable instead if you may resume later. Deployment secret values are not deleted."
                        confirmLabel="Delete mailbox"
                        confirmationToken={mailbox.label}
                        trigger={
                          <Button type="button" variant="destructive" disabled={!onlineNow || busy} aria-label={`Delete ${mailbox.label}`}>
                            Delete
                          </Button>
                        }
                        onConfirm={() => remove(mailbox)}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {query.isError && rows.length > 0 ? (
          <Alert variant="warning" role="status">
            <AlertTitle>Latest mailbox refresh failed</AlertTitle>
            <AlertDescription>
              Last verified rows remain visible and may be stale.
            </AlertDescription>
          </Alert>
        ) : null}

        {receipt ? <p role="status" className="text-sm text-success-emphasis">{receipt}</p> : null}

        {canManage ? (
          <form className="space-y-4 rounded-md border p-4" onSubmit={(event) => void create(event)}>
            <div>
              <h3 className="font-medium">Register a disabled mailbox</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Supply references only—never usernames or passwords. The server validates public DNS and fixes transport to implicit TLS on port 993.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={labelId}>Label</Label>
                <Input id={labelId} value={label} onChange={(event) => setLabel(event.target.value)} maxLength={200} required disabled={busy} />
              </div>
              <div className="space-y-2">
                <Label htmlFor={hostId}>IMAP host</Label>
                <Input id={hostId} value={host} onChange={(event) => setHost(event.target.value)} placeholder="imap.example.com" maxLength={253} required autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={busy} />
              </div>
              <div className="space-y-2">
                <Label htmlFor={folderId}>Folder</Label>
                <Input id={folderId} value={folder} onChange={(event) => setFolder(event.target.value)} maxLength={255} required disabled={busy} />
              </div>
              <div className="rounded-md bg-muted/40 p-3 text-sm">
                <span className="font-medium">Transport</span>
                <p className="text-muted-foreground">Implicit TLS · port 993 · created disabled</p>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor={usernameRefId}>Username secret reference</Label>
                <Input id={usernameRefId} value={usernameRef} onChange={(event) => setUsernameRef(event.target.value)} placeholder={`${prefix}SUPPORT_USERNAME`} maxLength={192} required autoComplete="off" autoCapitalize="off" spellCheck={false} className="font-mono" disabled={busy} />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor={passwordRefId}>Password secret reference</Label>
                <Input id={passwordRefId} value={passwordRef} onChange={(event) => setPasswordRef(event.target.value)} placeholder={`${prefix}SUPPORT_PASSWORD`} maxLength={192} required autoComplete="off" autoCapitalize="off" spellCheck={false} className="font-mono" disabled={busy} />
                <p className="break-all text-xs text-muted-foreground">Required prefix: <code>{prefix}</code></p>
              </div>
            </div>
            {formError ? <p role="alert" className="text-sm text-destructive">{formError}</p> : null}
            <Button type="submit" disabled={!onlineNow || busy} loading={pending === "create"}>
              {pending === "create" ? "Registering…" : "Register disabled mailbox"}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">
            Reply mailbox configuration is read-only for your effective role. An owner or admin outside viewer mode can manage it.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
