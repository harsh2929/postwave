// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
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
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import {
  getBlocklistAutoSuppress,
  setBlocklistAutoSuppress,
} from "@/lib/deliverability-admin-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";

export function BlocklistContainmentPanel({
  identity,
}: {
  identity: MeResponse;
}) {
  const queryClient = useQueryClient();
  const role = effectiveAuthRole(identity);
  const canWrite = roleCanWrite(role) && !identity.viewer_mode;
  const queryKey = [
    "deliverability-admin",
    identity.tenant_id,
    role,
    "blocklist-containment",
  ] as const;
  const state = useQuery({
    queryKey,
    queryFn: ({ signal }) => getBlocklistAutoSuppress({ signal }),
    staleTime: STALE.detail,
    retry: false,
  });
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(): Promise<void> {
    if (!canWrite || pendingValue === null || saving || !state.data) return;
    const requested = pendingValue;
    setSaving(true);
    setError(null);
    try {
      await verifyFreshAdminAuthority(identity);
      const before = await getBlocklistAutoSuppress({ fresh: true });
      if (before.auto_suppress !== state.data.auto_suppress) {
        queryClient.setQueryData(queryKey, before);
        throw new Error(
          "The containment policy changed after this confirmation opened. Review the latest state.",
        );
      }
      const receipt = await setBlocklistAutoSuppress(requested);
      const confirmed = await getBlocklistAutoSuppress({ fresh: true });
      if (
        receipt.auto_suppress !== requested ||
        confirmed.auto_suppress !== requested
      ) {
        throw new Error(
          "The policy request returned, but a fresh read did not confirm it.",
        );
      }
      queryClient.setQueryData(queryKey, confirmed);
      setPendingValue(null);
      toast.success(
        requested
          ? "Blocklist auto-containment enabled."
          : "Blocklist auto-containment disabled.",
      );
    } catch (caught) {
      setError(apiErrorMessage(caught, "Could not change containment policy."));
      void state.refetch();
      throw caught;
    } finally {
      setSaving(false);
    }
  }

  const enabled = state.data?.auto_suppress === true;
  return (
    <Card aria-labelledby="blocklist-containment-title">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="space-y-1.5">
          <CardTitle as="h2" id="blocklist-containment-title">
            Blocklist auto-containment
          </CardTitle>
          <CardDescription>
            Desired workspace policy for newly qualifying domain and
            dedicated-IP evidence. The worker evaluates it once per minute.
          </CardDescription>
        </div>
        {state.data ? (
          <Badge variant={enabled ? "success" : "outline"}>
            {enabled ? "Configured on" : "Configured off"}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {state.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading containment policy…
          </p>
        ) : state.isError && !state.data ? (
          <Alert variant="destructive">
            <AlertTitle>Policy state unavailable</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                {apiErrorMessage(
                  state.error,
                  "The stored policy could not be verified.",
                )}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={state.isFetching}
                onClick={() => void state.refetch()}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : state.data ? (
          <>
            <dl className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md bg-muted/40 p-3">
                <dt className="text-xs uppercase text-muted-foreground">
                  Qualifying, not contained
                </dt>
                <dd className="text-xl tabular-nums">
                  {state.data.eligible_now.toLocaleString()}
                </dd>
              </div>
              <div className="rounded-md bg-muted/40 p-3">
                <dt className="text-xs uppercase text-muted-foreground">
                  Active suppressions
                </dt>
                <dd className="text-xl tabular-nums">
                  {state.data.active_suppressions.toLocaleString()}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-muted-foreground">
              Evidence observed{" "}
              {formatWireTimestamp(
                state.data.observed_at,
                "at an unknown time",
              )}
              . This is policy state, not worker-health proof. Turning it off
              never clears existing suppressions.
            </p>
            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Policy change not confirmed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={enabled ? "destructive" : "default"}
                disabled={!canWrite || saving || state.isFetching}
                onClick={() => setPendingValue(!enabled)}
              >
                {enabled ? "Disable containment" : "Enable containment"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={state.isFetching || saving}
                onClick={() => void state.refetch()}
              >
                {state.isFetching ? "Refreshing…" : "Refresh impact"}
              </Button>
            </div>
            {!canWrite ? (
              <p className="text-sm text-muted-foreground">
                Owner or admin access is required to change this policy.
              </p>
            ) : null}
          </>
        ) : null}
      </CardContent>
      <ConfirmDialog
        open={pendingValue !== null}
        onOpenChange={(open) => {
          if (!open) setPendingValue(null);
        }}
        title={
          pendingValue
            ? "Enable automatic blocklist containment?"
            : "Disable automatic blocklist containment?"
        }
        description={
          pendingValue ? (
            <span>
              The next worker sweep can create sending-pool suppressions for
              currently qualifying subjects. The send loop enforces those
              decisions.
            </span>
          ) : (
            <span>
              New qualifying evidence will stop creating automatic suppressions.
              Existing suppressions remain active.
            </span>
          )
        }
        confirmLabel={
          pendingValue ? "Enable containment" : "Disable containment"
        }
        confirmationToken={
          pendingValue ? "ENABLE CONTAINMENT" : "DISABLE CONTAINMENT"
        }
        onConfirm={save}
      />
    </Card>
  );
}
