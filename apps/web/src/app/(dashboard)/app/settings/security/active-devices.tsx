// SPDX-License-Identifier: AGPL-3.0-only
//
// Account-session inventory. These controls remain available in viewer mode:
// they secure the signed-in user's own account and do not mutate workspace
// content. Every request is nevertheless bound to the exact current principal.
"use client";

import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import { toast } from "sonner";

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
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api";
import { verifyFreshExactPrincipal } from "@/lib/exact-principal";
import {
  abortAccountSecurityOperationForPrincipal,
  accountSecurityOperationIsCurrent,
  beginAccountSecurityOperation,
  finishAccountSecurityOperation,
  type AccountSecurityOperation,
} from "@/lib/account-security-operation";
import {
  type SessionInfo,
  type SessionsEnvelope,
  sessionsApi,
} from "@/lib/sessions-api";
import { useExactPrincipal } from "@/lib/use-exact-principal";
import { useOnline } from "@/lib/use-online";

interface SessionMutationResult {
  count: number;
  readback: SessionsEnvelope | null;
  readbackConfirmed: boolean;
}

export function ActiveDevices() {
  const queryClient = useQueryClient();
  const principal = useExactPrincipal();
  const online = useOnline();
  const identity = principal.identity;
  const principalKey = principal.principalKey;
  const principalKeyRef = useRef(principalKey);
  principalKeyRef.current = principalKey;
  const operationRef = useRef<AccountSecurityOperation | null>(null);
  const sessionsKey = useMemo(
    () => ["account-security", principalKey, "auth-sessions"] as const,
    [principalKey],
  );

  const sessionsQuery = useQuery({
    queryKey: sessionsKey,
    queryFn: ({ signal }) => sessionsApi.listAll({ signal }),
    enabled: Boolean(identity),
    retry: false,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    const scopedKey = sessionsKey;
    const scopedPrincipal = principalKey;
    return () => {
      if (operationRef.current?.principalKey === scopedPrincipal) {
        abortAccountSecurityOperationForPrincipal(scopedPrincipal);
        operationRef.current = null;
      }
      void queryClient.cancelQueries({ queryKey: scopedKey, exact: true });
      queryClient.removeQueries({ queryKey: scopedKey, exact: true });
    };
  }, [principalKey, queryClient, sessionsKey]);

  function beginOperation(): AccountSecurityOperation {
    if (!identity) {
      throw new Error("Verify your account before signing out a device.");
    }
    if (online === "offline") {
      throw new Error("Reconnect before signing out a device.");
    }
    const operation = beginAccountSecurityOperation(
      principalKey,
      "session-revocation",
    );
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
      return await sessionsApi.listAll({
        signal: operation.controller.signal,
      });
    } catch {
      return null;
    }
  }

  const revoke = useMutation({
    mutationFn: async ({
      id,
      operation,
    }: {
      id: string;
      operation: AccountSecurityOperation;
    }): Promise<SessionMutationResult> => {
      if (!identity) throw new Error("Account identity is unavailable.");
      await queryClient.cancelQueries({ queryKey: sessionsKey, exact: true });
      await verifyFreshExactPrincipal(identity, operation.controller.signal);
      if (!operationIsCurrent(operation)) {
        throw new Error(
          "Account identity changed before the session was signed out.",
        );
      }
      await sessionsApi.revoke(id, {
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      });
      const readback = await readBack(operation);
      return {
        count: 1,
        readback,
        readbackConfirmed: Boolean(
          readback && !readback.sessions.some((row) => row.id === id),
        ),
      };
    },
    onSuccess: (result, { operation }) => {
      if (!operationIsCurrent(operation)) return;
      if (result.readback && result.readbackConfirmed) {
        queryClient.setQueryData(sessionsKey, result.readback);
      } else {
        void queryClient.invalidateQueries({
          queryKey: sessionsKey,
          exact: true,
        });
      }
      toast.success("Device signed out");
      if (!result.readbackConfirmed) {
        toast.warning(
          "The server confirmed sign-out, but the refreshed session list could not be reconciled. Refresh before relying on the list.",
        );
      }
    },
    onError: (error, { operation }) => {
      if (!operationIsCurrent(operation)) return;
      toast.error(apiErrorMessage(error, "Could not sign out device"));
    },
  });

  const logoutAll = useMutation({
    mutationFn: async ({
      operation,
    }: {
      operation: AccountSecurityOperation;
    }): Promise<SessionMutationResult> => {
      if (!identity) throw new Error("Account identity is unavailable.");
      await queryClient.cancelQueries({ queryKey: sessionsKey, exact: true });
      await verifyFreshExactPrincipal(identity, operation.controller.signal);
      if (!operationIsCurrent(operation)) {
        throw new Error(
          "Account identity changed before sessions were signed out.",
        );
      }
      const receipt = await sessionsApi.logoutAllOthers({
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      });
      const readback = await readBack(operation);
      return {
        count: receipt.revoked_count,
        readback,
        readbackConfirmed: Boolean(
          readback &&
          readback.sessions.length === 1 &&
          readback.sessions[0]?.current,
        ),
      };
    },
    onSuccess: (result, { operation }) => {
      if (!operationIsCurrent(operation)) return;
      if (result.readback && result.readbackConfirmed) {
        queryClient.setQueryData(sessionsKey, result.readback);
      } else {
        void queryClient.invalidateQueries({
          queryKey: sessionsKey,
          exact: true,
        });
      }
      const count = result.count;
      toast.success(
        `Signed out ${count} other device${count === 1 ? "" : "s"}`,
      );
      if (!result.readbackConfirmed) {
        toast.warning(
          "The server confirmed the bulk sign-out, but the refreshed session list could not be reconciled. Refresh before relying on the list.",
        );
      }
    },
    onError: (error, { operation }) => {
      if (!operationIsCurrent(operation)) return;
      toast.error(apiErrorMessage(error, "Could not sign out devices"));
    },
  });

  async function revokeOne(id: string): Promise<void> {
    const operation = beginOperation();
    try {
      await revoke.mutateAsync({ id, operation });
    } finally {
      finishOperation(operation);
    }
  }

  async function logoutOtherSessions(): Promise<void> {
    const operation = beginOperation();
    try {
      await logoutAll.mutateAsync({ operation });
    } finally {
      finishOperation(operation);
    }
  }

  const sessions = Array.isArray(sessionsQuery.data?.sessions)
    ? sessionsQuery.data.sessions
    : [];
  const otherCount = sessions.filter((session) => !session.current).length;
  const busy = revoke.isPending || logoutAll.isPending;
  const unavailable = online === "offline" || !identity;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active devices</CardTitle>
        <CardDescription>
          Sessions currently signed in to your account. Sign out any you
          don&apos;t recognize.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {principal.loading ? (
          <>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </>
        ) : principal.error ? (
          <SecurityListError
            message="Account identity could not be verified. No session list was requested."
            retrying={principal.retrying}
            onRetry={principal.retry}
          />
        ) : sessionsQuery.isLoading ? (
          <>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </>
        ) : sessionsQuery.isError ? (
          <SecurityListError
            message="Could not load active devices. This is a failed security read, not an empty session list."
            retrying={sessionsQuery.isFetching}
            onRetry={() => void sessionsQuery.refetch()}
          />
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active sessions.</p>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <Laptop className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {deviceLabel(session)}
                    </span>
                    {session.current ? (
                      <Badge variant="secondary">This device</Badge>
                    ) : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {[
                      session.ip,
                      `via ${session.auth_method}`,
                      `active ${formatDate(session.last_seen_at)}`,
                      `expires ${formatDate(session.expires_at)}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              </div>
              {!session.current ? (
                <ConfirmDialog
                  title={`Sign out ${deviceLabel(session)}?`}
                  description="That device's session ends immediately and it has to sign in again. The device you're using right now is not affected."
                  confirmLabel="Sign out device"
                  confirmVariant="destructive"
                  onConfirm={() => revokeOne(session.id)}
                  trigger={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || unavailable}
                      loading={
                        revoke.isPending && revoke.variables?.id === session.id
                      }
                    >
                      Sign out
                    </Button>
                  }
                />
              ) : null}
            </div>
          ))
        )}
        {online === "offline" ? (
          <p role="note" className="text-sm text-muted-foreground">
            Reconnect to review or revoke live sessions. This security list is
            never read from an offline cache.
          </p>
        ) : null}
        {otherCount > 0 ? (
          <ConfirmDialog
            title={`Sign out ${otherCount} other ${otherCount === 1 ? "device" : "devices"}?`}
            description="Every other signed-in session ends immediately and each of those devices has to sign in again. The device you're using right now is not affected."
            confirmLabel="Sign out all"
            confirmVariant="destructive"
            onConfirm={logoutOtherSessions}
            trigger={
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy || unavailable}
                loading={logoutAll.isPending}
              >
                Sign out all other devices
              </Button>
            }
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function SecurityListError({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
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

function deviceLabel(session: SessionInfo): string {
  if (session.device_label?.trim()) return session.device_label;
  const parts = [session.device_client, session.device_os].filter(Boolean);
  if (parts.length > 0) return parts.join(" on ");
  return "Unknown device";
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
