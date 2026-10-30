// SPDX-License-Identifier: AGPL-3.0-only
//
// Trusted devices are standing MFA bypasses. The inventory is never served
// from an offline/principal-shared cache, and every revoke is rebound to the
// exact account/workspace snapshot immediately before it leaves the browser.
"use client";

import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
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
  type TrustedDeviceInfo,
  type TrustedDevicesEnvelope,
  trustedDevicesApi,
} from "@/lib/trusted-devices-api";
import { useExactPrincipal } from "@/lib/use-exact-principal";
import { useOnline } from "@/lib/use-online";

interface TrustMutationResult {
  count: number;
  readback: TrustedDevicesEnvelope | null;
  readbackConfirmed: boolean;
}

function deviceName(row: TrustedDeviceInfo): string {
  if (row.device_label?.trim()) return row.device_label;
  const parts = [row.device_client, row.device_os].filter(Boolean);
  return parts.length > 0 ? parts.join(" on ") : "Unknown device";
}

function formatWhen(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? fallback : at.toLocaleString();
}

export function TrustedDevices() {
  const queryClient = useQueryClient();
  const principal = useExactPrincipal();
  const online = useOnline();
  const identity = principal.identity;
  const principalKey = principal.principalKey;
  const principalKeyRef = useRef(principalKey);
  principalKeyRef.current = principalKey;
  const operationRef = useRef<AccountSecurityOperation | null>(null);
  const devicesKey = useMemo(
    () => ["account-security", principalKey, "auth-trusted-devices"] as const,
    [principalKey],
  );

  const devicesQuery = useQuery({
    queryKey: devicesKey,
    queryFn: ({ signal }) => trustedDevicesApi.list({ signal }),
    enabled: Boolean(identity),
    retry: false,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    const scopedKey = devicesKey;
    const scopedPrincipal = principalKey;
    return () => {
      if (operationRef.current?.principalKey === scopedPrincipal) {
        abortAccountSecurityOperationForPrincipal(scopedPrincipal);
        operationRef.current = null;
      }
      void queryClient.cancelQueries({ queryKey: scopedKey, exact: true });
      queryClient.removeQueries({ queryKey: scopedKey, exact: true });
    };
  }, [devicesKey, principalKey, queryClient]);

  function beginOperation(): AccountSecurityOperation {
    if (!identity) {
      throw new Error("Verify your account before revoking a trusted device.");
    }
    if (online === "offline") {
      throw new Error("Reconnect before revoking a trusted device.");
    }
    const operation = beginAccountSecurityOperation(
      principalKey,
      "trusted-device-revocation",
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
      return await trustedDevicesApi.list({
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
    }): Promise<TrustMutationResult> => {
      if (!identity) throw new Error("Account identity is unavailable.");
      await queryClient.cancelQueries({ queryKey: devicesKey, exact: true });
      await verifyFreshExactPrincipal(identity, operation.controller.signal);
      if (!operationIsCurrent(operation)) {
        throw new Error(
          "Account identity changed before the device was revoked.",
        );
      }
      await trustedDevicesApi.revoke(id, {
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      });
      const readback = await readBack(operation);
      return {
        count: 1,
        readback,
        readbackConfirmed: Boolean(
          readback &&
          !readback.trusted_devices.some((device) => device.id === id),
        ),
      };
    },
    onSuccess: (result, { operation }) => {
      if (!operationIsCurrent(operation)) return;
      if (result.readback && result.readbackConfirmed) {
        queryClient.setQueryData(devicesKey, result.readback);
      } else {
        void queryClient.invalidateQueries({
          queryKey: devicesKey,
          exact: true,
        });
      }
      toast.success("Device will require MFA at its next sign-in.");
      if (!result.readbackConfirmed) {
        toast.warning(
          "The server confirmed revocation, but the refreshed trusted-device list could not be reconciled. Refresh before relying on the list.",
        );
      }
    },
    onError: (error, { operation }) => {
      if (!operationIsCurrent(operation)) return;
      toast.error(apiErrorMessage(error, "Could not revoke that device."));
    },
  });

  const revokeAll = useMutation({
    mutationFn: async ({
      operation,
    }: {
      operation: AccountSecurityOperation;
    }): Promise<TrustMutationResult> => {
      if (!identity) throw new Error("Account identity is unavailable.");
      await queryClient.cancelQueries({ queryKey: devicesKey, exact: true });
      await verifyFreshExactPrincipal(identity, operation.controller.signal);
      if (!operationIsCurrent(operation)) {
        throw new Error(
          "Account identity changed before devices were revoked.",
        );
      }
      const receipt = await trustedDevicesApi.revokeAll({
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      });
      const readback = await readBack(operation);
      return {
        count: receipt.revoked_count,
        readback,
        readbackConfirmed: Boolean(
          readback && readback.trusted_devices?.length === 0,
        ),
      };
    },
    onSuccess: (result, { operation }) => {
      if (!operationIsCurrent(operation)) return;
      if (result.readback && result.readbackConfirmed) {
        queryClient.setQueryData(devicesKey, result.readback);
      } else {
        void queryClient.invalidateQueries({
          queryKey: devicesKey,
          exact: true,
        });
      }
      toast.success(`Revoked ${result.count} trusted device(s).`);
      if (!result.readbackConfirmed) {
        toast.warning(
          "The server confirmed the bulk revocation, but the refreshed trusted-device list could not be reconciled. Refresh before relying on the list.",
        );
      }
    },
    onError: (error, { operation }) => {
      if (!operationIsCurrent(operation)) return;
      toast.error(
        apiErrorMessage(error, "Could not revoke your trusted devices."),
      );
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

  async function revokeEveryDevice(): Promise<void> {
    const operation = beginOperation();
    try {
      await revokeAll.mutateAsync({ operation });
    } finally {
      finishOperation(operation);
    }
  }

  const devices = Array.isArray(devicesQuery.data?.trusted_devices)
    ? devicesQuery.data.trusted_devices
    : [];
  const policyAllows = devicesQuery.data?.allowed === true;
  const busy = revoke.isPending || revokeAll.isPending;
  const unavailable = online === "offline" || !identity;
  // Preserve the panic button when the inventory read itself failed. An
  // unreadable list must not strand a standing MFA bypass.
  const canRevokeAll = devices.length > 0 || devicesQuery.isError;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4" aria-hidden />
          Trusted devices
        </CardTitle>
        <CardDescription>
          These devices skip multi-factor authentication when you sign in.
          Revoking one forces MFA at its next sign-in.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {devicesQuery.data && !policyAllows ? (
          <p className="text-sm text-muted-foreground">
            Your workspace no longer allows new trusted devices. Existing ones
            are listed below and can still be revoked.
          </p>
        ) : null}
        {principal.loading ? (
          <Skeleton className="h-16 w-full" />
        ) : principal.error ? (
          <SecurityListError
            message="Account identity could not be verified. No trusted-device list was requested."
            retrying={principal.retrying}
            onRetry={principal.retry}
          />
        ) : devicesQuery.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : devicesQuery.isError ? (
          <SecurityListError
            message="Could not verify which devices can skip MFA. This is a failed security read, not an empty list."
            retrying={devicesQuery.isFetching}
            onRetry={() => void devicesQuery.refetch()}
          />
        ) : devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No trusted devices.</p>
        ) : (
          <ul className="divide-y">
            {devices.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">
                      {deviceName(row)}
                    </p>
                    {row.current ? (
                      <Badge variant="secondary">This device</Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Last used {formatWhen(row.last_used_at, "not yet")} ·
                    trusted for {row.trust_days} days · expires{" "}
                    {formatWhen(row.expires_at, "at an unknown time")}
                  </p>
                </div>
                <ConfirmDialog
                  title={`Revoke ${deviceName(row)}?`}
                  description="This removes the device's standing bypass, so it has to complete multi-factor authentication at its next sign-in. You can trust it again from that device."
                  confirmLabel="Revoke device"
                  confirmVariant="destructive"
                  onConfirm={() => revokeOne(row.id)}
                  trigger={
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy || unavailable}
                      loading={
                        revoke.isPending && revoke.variables?.id === row.id
                      }
                    >
                      Revoke
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
        )}
        {online === "offline" ? (
          <p role="note" className="text-sm text-muted-foreground">
            Reconnect to review or revoke MFA bypasses. This security list is
            never read from an offline cache.
          </p>
        ) : null}
        <ConfirmDialog
          title="Revoke every trusted device?"
          description={
            devicesQuery.isError ? (
              <>
                The inventory could not be verified. Every trusted device the
                server can currently find will lose its standing bypass and must
                complete multi-factor authentication at its next sign-in.
              </>
            ) : (
              <>
                All{" "}
                <strong>
                  {devices.length} trusted device
                  {devices.length === 1 ? "" : "s"}
                </strong>{" "}
                lose their standing bypass and must complete multi-factor
                authentication at their next sign-in. Nobody is signed out, but
                this cannot be undone.
              </>
            )
          }
          confirmLabel="Revoke all devices"
          confirmVariant="destructive"
          confirmationToken="REVOKE"
          onConfirm={revokeEveryDevice}
          trigger={
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={!canRevokeAll || busy || unavailable}
              loading={revokeAll.isPending}
            >
              Revoke all trusted devices
            </Button>
          }
        />
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
        size="sm"
        variant="outline"
        loading={retrying}
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}
