// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { ApiError, apiErrorMessage } from "@/lib/api";
import {
  listOAuthIdentities,
  oauthLinkStartUrl,
  unlinkOAuthIdentity,
  type OAuthIdentitiesResponse,
} from "@/lib/auth-api";
import { verifyFreshExactPrincipal } from "@/lib/exact-principal";
import {
  abortAccountSecurityOperationForPrincipal,
  accountSecurityOperationIsCurrent,
  beginAccountSecurityOperation,
  finishAccountSecurityOperation,
  type AccountSecurityOperation,
} from "@/lib/account-security-operation";
import { qk } from "@/lib/query-keys";
import { useExactPrincipal } from "@/lib/use-exact-principal";
import { useOnline } from "@/lib/use-online";

export function IdentityProviderCard() {
  const queryClient = useQueryClient();
  const principal = useExactPrincipal();
  const online = useOnline();
  const identity = principal.identity;
  const principalKey = principal.principalKey;
  const principalKeyRef = useRef(principalKey);
  principalKeyRef.current = principalKey;
  const operationRef = useRef<AccountSecurityOperation | null>(null);
  const [connecting, setConnecting] = useState(false);
  const identitiesKey = useMemo(
    () => ["account-security", principalKey, "oauth-identities"] as const,
    [principalKey],
  );

  const identitiesQuery = useQuery({
    queryKey: identitiesKey,
    queryFn: ({ signal }) => listOAuthIdentities({ signal }),
    enabled: Boolean(identity),
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    const scopedKey = identitiesKey;
    const scopedPrincipal = principalKey;
    setConnecting(false);
    return () => {
      if (operationRef.current?.principalKey === scopedPrincipal) {
        abortAccountSecurityOperationForPrincipal(scopedPrincipal);
        operationRef.current = null;
      }
      void queryClient.cancelQueries({ queryKey: scopedKey, exact: true });
      queryClient.removeQueries({ queryKey: scopedKey, exact: true });
    };
  }, [identitiesKey, principalKey, queryClient]);

  function beginOperation(kind: string): AccountSecurityOperation {
    if (!identity) {
      throw new Error("Verify your account before changing a sign-in method.");
    }
    if (online === "offline") {
      throw new Error("Reconnect before changing a sign-in method.");
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

  const unlink = useMutation({
    mutationFn: async ({
      operation,
    }: {
      operation: AccountSecurityOperation;
    }): Promise<{ readback: OAuthIdentitiesResponse | null }> => {
      if (!identity) throw new Error("Account identity is unavailable.");
      await queryClient.cancelQueries({
        queryKey: identitiesKey,
        exact: true,
      });
      await verifyFreshExactPrincipal(identity, operation.controller.signal);
      if (!operationIsCurrent(operation)) {
        throw new Error(
          "Account identity changed before Google was disconnected.",
        );
      }
      await unlinkOAuthIdentity("google", {
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      });
      try {
        return {
          readback: await listOAuthIdentities({
            signal: operation.controller.signal,
          }),
        };
      } catch {
        return { readback: null };
      }
    },
    onSuccess: ({ readback }, { operation }) => {
      if (!operationIsCurrent(operation)) return;
      const confirmed = Boolean(
        readback &&
        !readback.identities.some((entry) => entry.provider === "google"),
      );
      if (readback && confirmed) {
        queryClient.setQueryData(identitiesKey, readback);
      } else {
        void queryClient.invalidateQueries({
          queryKey: identitiesKey,
          exact: true,
        });
      }
      void queryClient.invalidateQueries({ queryKey: qk.authMe() });
      toast.success("Google disconnected.");
      if (!confirmed) {
        toast.warning(
          "The server confirmed disconnection, but the refreshed sign-in-method list could not be reconciled. Refresh before relying on the list.",
        );
      }
    },
    onError: (error, { operation }) => {
      if (!operationIsCurrent(operation)) return;
      if (error instanceof ApiError && error.code === "last_login_method") {
        toast.error("Set a password first — this is your only way to sign in.");
        return;
      }
      toast.error(apiErrorMessage(error, "Could not disconnect Google."));
    },
  });

  async function disconnectGoogle(): Promise<void> {
    const operation = beginOperation("oauth-unlink");
    try {
      await unlink.mutateAsync({ operation });
    } finally {
      if (operationRef.current === operation) operationRef.current = null;
      finishAccountSecurityOperation(operation);
    }
  }

  async function connectGoogle(): Promise<void> {
    let operation: AccountSecurityOperation;
    try {
      operation = beginOperation("oauth-link-start");
    } catch (error) {
      toast.error(apiErrorMessage(error, "Could not start Google connection."));
      return;
    }
    setConnecting(true);
    try {
      if (!identity) throw new Error("Account identity is unavailable.");
      await verifyFreshExactPrincipal(identity, operation.controller.signal);
      if (!operationIsCurrent(operation)) return;
      window.location.assign(oauthLinkStartUrl("google"));
    } catch (error) {
      if (!operationIsCurrent(operation)) return;
      toast.error(apiErrorMessage(error, "Could not start Google connection."));
    } finally {
      if (operationIsCurrent(operation)) setConnecting(false);
      if (operationRef.current === operation) operationRef.current = null;
      finishAccountSecurityOperation(operation);
    }
  }

  const identities = Array.isArray(identitiesQuery.data?.identities)
    ? identitiesQuery.data.identities
    : [];
  const google = identities.find((entry) => entry.provider === "google");
  const hasPassword = identitiesQuery.data?.has_password ?? false;
  const hasPasskey = identitiesQuery.data?.has_passkey ?? false;
  const isOnlySignInMethod =
    !hasPassword && !hasPasskey && identities.length <= 1;
  const unavailable = online === "offline" || !identity;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Identity provider</CardTitle>
        <CardDescription>
          Add a verified Google sign-in to this account. Linking requires this
          active session and a provider-verified email that matches your
          Moosewave account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {principal.error ? (
          <IdentityReadError
            message="Account identity could not be verified. No linked sign-in methods were requested."
            retrying={principal.retrying}
            onRetry={principal.retry}
          />
        ) : identitiesQuery.isError ? (
          <IdentityReadError
            message="Could not verify linked sign-in methods. This failure is not being shown as ‘not connected’."
            retrying={identitiesQuery.isFetching}
            onRetry={() => void identitiesQuery.refetch()}
          />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Google</span>
              {principal.loading || identitiesQuery.isPending ? (
                <Badge variant="secondary">Checking…</Badge>
              ) : google ? (
                <Badge variant="success">Connected</Badge>
              ) : (
                <Badge variant="secondary">Not connected</Badge>
              )}
              {google ? (
                <span className="truncate text-xs text-muted-foreground">
                  {google.email}
                </span>
              ) : null}
            </div>

            {principal.loading || identitiesQuery.isPending ? null : google ? (
              isOnlySignInMethod ? (
                <span
                  className="text-xs text-muted-foreground"
                  title="Set a password before disconnecting your only sign-in method"
                >
                  Set a password to disconnect
                </span>
              ) : (
                <ConfirmDialog
                  trigger={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={unlink.isPending || unavailable}
                    >
                      Disconnect
                    </Button>
                  }
                  title="Disconnect Google?"
                  description="You'll no longer be able to sign in with Google. You can reconnect it any time."
                  confirmLabel="Disconnect"
                  confirmVariant="destructive"
                  onConfirm={disconnectGoogle}
                />
              )
            ) : online === "offline" ? (
              <Button type="button" variant="outline" size="sm" disabled>
                Connect Google
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={connecting}
                disabled={connecting || unavailable}
                onClick={() => void connectGoogle()}
              >
                Connect Google
              </Button>
            )}
          </div>
        )}
        {online === "offline" ? (
          <p role="note" className="text-sm text-muted-foreground">
            Reconnect to review or change sign-in methods. These account
            security details are never read from an offline cache.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function IdentityReadError({
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
      <p role="alert" className="text-sm text-destructive">
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
