// SPDX-License-Identifier: AGPL-3.0-only
//
// AUTH-023 — passkey (WebAuthn) enrollment + management. A passkey is a
// phishing-resistant second factor (or a passwordless primary) bound to this
// device's authenticator. Enrollment runs the browser create() ceremony; the
// list supports rename + delete. The whole card hides on browsers without
// WebAuthn so we never dangle a button that can't work.
"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { KeyRound, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "@/lib/api";
import {
  abortAccountSecurityOperationForPrincipal,
  accountSecurityOperationIsCurrent,
  beginAccountSecurityOperation,
  finishAccountSecurityOperation,
  type AccountSecurityOperation,
} from "@/lib/account-security-operation";
import {
  deletePasskey,
  listPasskeys,
  passkeySupported,
  registerPasskey,
  renamePasskey,
  type Passkey,
} from "@/lib/auth-passkey";
import { verifyFreshExactPrincipal } from "@/lib/exact-principal";
import { useExactPrincipal } from "@/lib/use-exact-principal";
import { useOnline } from "@/lib/use-online";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// A cancelled platform prompt (user dismissed the OS dialog) is not an error to
// surface — they simply changed their mind.
function isUserCancel(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === "NotAllowedError" || err.name === "AbortError")
  );
}

export function PasskeysCard() {
  // A server render can't know if the browser supports WebAuthn; decide after
  // hydration so the markup matches and we don't flash an unusable card.
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    setSupported(passkeySupported());
  }, []);

  const queryClient = useQueryClient();
  const principal = useExactPrincipal();
  const online = useOnline();
  const identity = principal.identity;
  const principalKey = principal.principalKey;
  const principalKeyRef = useRef(principalKey);
  principalKeyRef.current = principalKey;
  const operationRef = useRef<AccountSecurityOperation | null>(null);
  const passkeysKey = useMemo(
    () => ["account-security", principalKey, "passkeys"] as const,
    [principalKey],
  );
  const listQuery = useQuery({
    queryKey: passkeysKey,
    queryFn: ({ signal }) => listPasskeys({ signal }),
    enabled: supported === true && Boolean(identity),
    retry: false,
    refetchOnWindowFocus: true,
  });

  const [enrolling, setEnrolling] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Passkey | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Passkey | null>(null);
  const renameTriggerRef = useRef<HTMLButtonElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const scopedPrincipal = principalKey;
    const scopedKey = passkeysKey;
    setRenameTarget(null);
    setDeleteTarget(null);
    setEnrolling(false);
    return () => {
      if (operationRef.current?.principalKey === scopedPrincipal) {
        abortAccountSecurityOperationForPrincipal(scopedPrincipal);
        operationRef.current = null;
      }
      void queryClient.cancelQueries({ queryKey: scopedKey, exact: true });
      queryClient.removeQueries({ queryKey: scopedKey, exact: true });
    };
  }, [passkeysKey, principalKey, queryClient]);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: passkeysKey, exact: true });

  function beginOperation(kind: string): AccountSecurityOperation {
    if (!identity) {
      throw new Error("Verify your account before changing passkeys.");
    }
    if (online === "offline") {
      throw new Error("Reconnect before changing passkeys.");
    }
    const operation = beginAccountSecurityOperation(principalKey, kind);
    operationRef.current = operation;
    return operation;
  }

  function operationIsCurrent(operation: AccountSecurityOperation): boolean {
    return (
      operationRef.current === operation &&
      accountSecurityOperationIsCurrent(operation, principalKeyRef.current)
    );
  }

  function finishOperation(operation: AccountSecurityOperation): void {
    if (operationRef.current === operation) operationRef.current = null;
    finishAccountSecurityOperation(operation);
  }

  async function readBack(operation: AccountSecurityOperation) {
    try {
      return await listPasskeys({ signal: operation.controller.signal });
    } catch {
      return null;
    }
  }

  async function addPasskey() {
    let operation: AccountSecurityOperation;
    try {
      operation = beginOperation("passkey-enroll");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not add passkey.",
      );
      return;
    }
    setEnrolling(true);
    try {
      if (!identity) throw new Error("Account identity is unavailable.");
      await queryClient.cancelQueries({ queryKey: passkeysKey, exact: true });
      await verifyFreshExactPrincipal(identity, operation.controller.signal);
      // Default the label to the platform; the user can rename it after. A
      // browser can only tell us so much, so keep it simple and honest.
      const receipt = await registerPasskey(defaultPasskeyName(), {
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
        beforeFinish: async () => {
          await verifyFreshExactPrincipal(
            identity,
            operation.controller.signal,
          );
          if (!operationIsCurrent(operation)) {
            throw new Error(
              "Account identity changed before passkey enrollment completed.",
            );
          }
        },
      });
      const readback = await readBack(operation);
      if (!operationIsCurrent(operation)) {
        throw new DOMException("Account identity changed.", "AbortError");
      }
      const confirmed = Boolean(
        readback?.some((candidate) => candidate.id === receipt.id),
      );
      if (readback) queryClient.setQueryData(passkeysKey, readback);
      else void invalidate();
      toast.success("Passkey added.");
      if (!confirmed) {
        toast.warning(
          "Enrollment was accepted, but the refreshed passkey list could not confirm it. Refresh before relying on this status.",
        );
      }
    } catch (err) {
      if (!operationIsCurrent(operation)) return;
      if (isUserCancel(err)) return;
      // The authenticator itself rejects re-enrolling a device that already has
      // a passkey for this account (excludeCredentials match) with
      // InvalidStateError — same user-facing meaning as the server's 409.
      if (
        (err instanceof DOMException && err.name === "InvalidStateError") ||
        (err instanceof ApiError && err.status === 409)
      ) {
        toast.error("That passkey is already enrolled.");
        return;
      }
      toast.error(
        err instanceof Error ? err.message : "Could not add passkey.",
      );
    } finally {
      if (operationIsCurrent(operation)) setEnrolling(false);
      finishOperation(operation);
    }
  }

  async function rename(id: string, name: string): Promise<void> {
    const operation = beginOperation("passkey-rename");
    try {
      if (!identity) throw new Error("Account identity is unavailable.");
      await queryClient.cancelQueries({ queryKey: passkeysKey, exact: true });
      await verifyFreshExactPrincipal(identity, operation.controller.signal);
      if (!operationIsCurrent(operation)) {
        throw new DOMException("Account identity changed.", "AbortError");
      }
      const receipt = await renamePasskey(id, name, {
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      });
      const readback = await readBack(operation);
      if (!operationIsCurrent(operation)) {
        throw new DOMException("Account identity changed.", "AbortError");
      }
      const confirmed = Boolean(
        readback?.some(
          (candidate) => candidate.id === id && candidate.name === receipt.name,
        ),
      );
      if (readback) queryClient.setQueryData(passkeysKey, readback);
      else void invalidate();
      if (!confirmed) {
        toast.warning(
          "Rename was accepted, but the refreshed passkey list could not confirm it. Refresh before relying on the displayed name.",
        );
      }
    } finally {
      finishOperation(operation);
    }
  }

  async function remove(id: string): Promise<void> {
    const operation = beginOperation("passkey-delete");
    try {
      if (!identity) throw new Error("Account identity is unavailable.");
      await queryClient.cancelQueries({ queryKey: passkeysKey, exact: true });
      await verifyFreshExactPrincipal(identity, operation.controller.signal);
      if (!operationIsCurrent(operation)) {
        throw new DOMException("Account identity changed.", "AbortError");
      }
      await deletePasskey(id, {
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      });
      const readback = await readBack(operation);
      if (!operationIsCurrent(operation)) {
        throw new DOMException("Account identity changed.", "AbortError");
      }
      const confirmed = Boolean(
        readback && !readback.some((candidate) => candidate.id === id),
      );
      if (readback) queryClient.setQueryData(passkeysKey, readback);
      else void invalidate();
      if (!confirmed) {
        toast.warning(
          "Removal was accepted, but the refreshed passkey list could not confirm it. Refresh before relying on this status.",
        );
      }
    } finally {
      finishOperation(operation);
    }
  }

  if (supported === false) {
    return null;
  }

  const passkeys = Array.isArray(listQuery.data) ? listQuery.data : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Passkeys</CardTitle>
        <CardDescription>
          Sign in with your fingerprint, face, or device PIN instead of a
          password. Passkeys are phishing-resistant and never leave your device.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {principal.error ? (
          <PasskeyReadError
            message="Account identity could not be verified. No passkey list was requested."
            retrying={principal.retrying}
            onRetry={principal.retry}
          />
        ) : supported === null || listQuery.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : listQuery.isError ? (
          <PasskeyReadError
            message="Could not verify your passkeys. This is a failed security read, not an empty credential list."
            retrying={listQuery.isFetching}
            onRetry={() => void listQuery.refetch()}
          />
        ) : passkeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No passkeys yet. Add one to sign in without a password.
          </p>
        ) : (
          <ul className="space-y-2">
            {passkeys.map((pk) => (
              <li
                key={pk.id}
                className="flex items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <KeyRound
                    className="size-5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {pk.name}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Added {formatDate(pk.created_at)}
                      {pk.last_used_at
                        ? ` · Last used ${formatDate(pk.last_used_at)}`
                        : " · Never used"}
                      {pk.backed_up ? " · Synced" : ""}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Rename ${pk.name}`}
                    disabled={enrolling || online === "offline"}
                    onClick={(event) => {
                      renameTriggerRef.current = event.currentTarget;
                      setRenameTarget(pk);
                    }}
                  >
                    <Pencil className="size-4" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${pk.name}`}
                    disabled={enrolling || online === "offline"}
                    onClick={(event) => {
                      deleteTriggerRef.current = event.currentTarget;
                      setDeleteTarget(pk);
                    }}
                  >
                    <Trash2 className="size-4 text-destructive" aria-hidden />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end">
          <Button
            type="button"
            onClick={() => void addPasskey()}
            disabled={
              enrolling ||
              supported !== true ||
              online === "offline" ||
              !identity ||
              listQuery.isError
            }
          >
            {enrolling ? "Waiting for device…" : "Add a passkey"}
          </Button>
        </div>
        {online === "offline" ? (
          <p role="note" className="text-sm text-muted-foreground">
            Reconnect to review or change passkeys. Passkey mutations are never
            queued for later replay.
          </p>
        ) : null}
      </CardContent>

      <RenamePasskeyDialog
        target={renameTarget}
        returnFocusRef={renameTriggerRef}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
        onDone={async () => {
          setRenameTarget(null);
        }}
        onRename={rename}
      />
      <DeletePasskeyDialog
        target={deleteTarget}
        returnFocusRef={deleteTriggerRef}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onDone={async () => {
          setDeleteTarget(null);
        }}
        onDelete={remove}
      />
    </Card>
  );
}

function RenamePasskeyDialog({
  target,
  returnFocusRef,
  onOpenChange,
  onDone,
  onRename,
}: {
  target: Passkey | null;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (target) {
      setName(target.name);
      setError(null);
    }
  }, [target]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const submit = async () => {
    if (savingRef.current || !target) return;
    const next = name.trim();
    if (!next || next === target.name) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onRename(target.id, next);
      toast.success("Passkey renamed.");
      await onDone();
    } catch (err) {
      if (isUserCancel(err)) return;
      const message =
        err instanceof Error ? err.message : "Could not rename passkey.";
      setError(message);
      toast.error(message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const trimmed = name.trim();
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && savingRef.current) return;
        onOpenChange(open);
        if (!open) restoreTriggerFocus(returnFocusRef);
      }}
    >
      <DialogContent
        aria-busy={saving}
        className="[&_button]:min-h-11 [&_input]:min-h-11 [&_input]:text-base sm:[&_button]:min-h-9 sm:[&_input]:min-h-9 sm:[&_input]:text-sm"
        onEscapeKeyDown={(event) => {
          if (savingRef.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (savingRef.current) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          const trigger = returnFocusRef.current;
          if (!trigger?.isConnected) return;
          event.preventDefault();
          trigger.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Rename passkey</DialogTitle>
          <DialogDescription>
            Give this passkey a name you&apos;ll recognize, like “MacBook Touch
            ID” or “iPhone”.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="passkey-name">Name</Label>
          <Input
            id="passkey-name"
            value={name}
            maxLength={100}
            autoFocus
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "passkey-name-error" : undefined}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            disabled={saving}
          />
        </div>
        {error ? (
          <div
            ref={errorRef}
            id="passkey-name-error"
            role="alert"
            tabIndex={-1}
            className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
          >
            {error}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={
              saving || trimmed.length === 0 || trimmed === target?.name
            }
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeletePasskeyDialog({
  target,
  returnFocusRef,
  onOpenChange,
  onDone,
  onDelete,
}: {
  target: Passkey | null;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const removingRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (target) setError(null);
  }, [target]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const submit = async () => {
    if (removingRef.current || !target) return;
    removingRef.current = true;
    setRemoving(true);
    setError(null);
    try {
      await onDelete(target.id);
      toast.success("Passkey removed.");
      await onDone();
    } catch (err) {
      if (isUserCancel(err)) return;
      const message =
        err instanceof Error ? err.message : "Could not remove passkey.";
      setError(message);
      toast.error(message);
    } finally {
      removingRef.current = false;
      setRemoving(false);
    }
  };

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && removingRef.current) return;
        onOpenChange(open);
        if (!open) restoreTriggerFocus(returnFocusRef);
      }}
    >
      <DialogContent
        aria-busy={removing}
        className="[&_button]:min-h-11 sm:[&_button]:min-h-9"
        onEscapeKeyDown={(event) => {
          if (removingRef.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (removingRef.current) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          const trigger = returnFocusRef.current;
          if (!trigger?.isConnected) return;
          event.preventDefault();
          trigger.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Remove this passkey?</DialogTitle>
          <DialogDescription>
            {target
              ? `“${target.name}” will no longer be able to sign in to your account. This can't be undone.`
              : null}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div
            ref={errorRef}
            role="alert"
            tabIndex={-1}
            className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
          >
            {error}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={removing}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void submit()}
            disabled={removing}
          >
            {removing ? "Removing…" : "Remove passkey"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PasskeyReadError({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <p className="text-sm text-destructive" role="alert">
        {message}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        loading={retrying}
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}

function defaultPasskeyName(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS device";
  if (/Android/.test(ua)) return "Android device";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows device";
  return "Passkey";
}

function restoreTriggerFocus(
  returnFocusRef: RefObject<HTMLButtonElement | null>,
): void {
  // Programmatically controlled dialogs have no Radix DialogTrigger to infer
  // a return target from. Run after the close state commits so FocusScope's
  // own teardown cannot move focus back to the document body afterward.
  window.requestAnimationFrame(() => {
    const trigger = returnFocusRef.current;
    if (trigger?.isConnected) trigger.focus();
  });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "recently";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
