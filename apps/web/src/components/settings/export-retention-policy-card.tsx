// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";
import { apiErrorMessage } from "@/lib/api";
import {
  effectiveAuthRole,
  whoami,
  whoamiFresh,
} from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { qk, STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";
import {
  EXPORT_RETENTION_COUNT_MAX,
  EXPORT_RETENTION_COUNT_MIN,
  EXPORT_RETENTION_DAYS_MAX,
  EXPORT_RETENTION_DAYS_MIN,
  getExportRetentionPolicy,
  sameExportRetentionRevision,
  updateExportRetentionPolicy,
  type ExportRetentionPolicy,
} from "@/lib/workspace-settings-controls-api";

export function ExportRetentionPolicyCard() {
  const queryClient = useQueryClient();
  const identityQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });
  const identity = identityQuery.data;
  const tenantId = identity?.tenant_id ?? "unverified";
  const role = identity ? effectiveAuthRole(identity) : null;
  const canWrite =
    identityQuery.isSuccess && Boolean(identity) && !identity?.viewer_mode && roleCanWrite(role);
  const authorityKey = identityQuery.isSuccess && identity
    ? [tenantId, identity.user_id, role ?? "none", identity.viewer_mode ? "viewer" : "member"].join(":")
    : "unverified";
  const policyKey = useMemo(
    () => [...qk.settings(tenantId, role, "export-retention-policy"), authorityKey],
    [authorityKey, role, tenantId],
  );
  const policyQuery = useQuery({
    queryKey: policyKey,
    queryFn: ({ signal }) => getExportRetentionPolicy({ signal }),
    enabled: identityQuery.isSuccess && canWrite,
    staleTime: STALE.detail,
    retry: false,
  });

  const [baseline, setBaseline] = useState<ExportRetentionPolicy | null>(null);
  const [retentionDays, setRetentionDays] = useState("");
  const [maxPerTenant, setMaxPerTenant] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ExportRetentionPolicy | null>(null);
  const activeRef = useRef(true);
  const savingRef = useRef(false);
  const mutationRef = useRef<AbortController | null>(null);
  const draftRef = useRef("");
  const authorityKeyRef = useRef(authorityKey);
  const previousPolicyKeyRef = useRef(policyKey);

  useEffect(() => {
    const previousKey = previousPolicyKeyRef.current;
    previousPolicyKeyRef.current = policyKey;
    authorityKeyRef.current = authorityKey;
    mutationRef.current?.abort();
    savingRef.current = false;
    setSaving(false);
    setBaseline(null);
    setRetentionDays("");
    setMaxPerTenant("");
    setConflict(null);
    setError(null);
    setSuccess(null);
    if (previousKey !== policyKey) {
      void queryClient.cancelQueries({ queryKey: previousKey, exact: true });
      queryClient.removeQueries({ queryKey: previousKey, exact: true });
    }
  }, [authorityKey, policyKey, queryClient]);

  const dirty =
    baseline !== null &&
    (retentionDays !== String(baseline.retentionDays) ||
      maxPerTenant !== String(baseline.maxPerTenant));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  draftRef.current = `${retentionDays}|${maxPerTenant}`;
  useUnsavedChangesGuard(dirty);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      mutationRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const policy = policyQuery.data;
    if (!policy || savingRef.current || dirtyRef.current) return;
    setBaseline(policy);
    setRetentionDays(String(policy.retentionDays));
    setMaxPerTenant(String(policy.maxPerTenant));
    setConflict(null);
  }, [policyQuery.data]);

  const daysError = integerFieldError(
    retentionDays,
    EXPORT_RETENTION_DAYS_MIN,
    EXPORT_RETENTION_DAYS_MAX,
  );
  const countError = integerFieldError(
    maxPerTenant,
    EXPORT_RETENTION_COUNT_MIN,
    EXPORT_RETENTION_COUNT_MAX,
  );
  const valid = !daysError && !countError;

  async function save(): Promise<void> {
    if (
      savingRef.current ||
      !baseline ||
      !identity ||
      !canWrite ||
      !dirty ||
      !valid
    ) {
      return;
    }
    const sentDraft = `${retentionDays}|${maxPerTenant}`;
    const openedAuthority = authorityKey;
    const reviewedBaseline = baseline;
    const controller = new AbortController();
    mutationRef.current?.abort();
    mutationRef.current = controller;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setSuccess(null);
    setConflict(null);
    try {
      const [freshIdentity, freshPolicy] = await Promise.all([
        whoamiFresh(controller.signal),
        getExportRetentionPolicy({ signal: controller.signal, fresh: true }),
      ]);
      const freshRole = effectiveAuthRole(freshIdentity);
      if (
        freshIdentity.tenant_id !== identity.tenant_id ||
        freshIdentity.user_id !== identity.user_id ||
        freshRole !== role ||
        freshIdentity.viewer_mode !== identity.viewer_mode ||
        !roleCanWrite(freshRole)
      ) {
        throw new Error(
          "Workspace identity or admin authority changed. Reload before saving.",
        );
      }
      if (!sameExportRetentionRevision(reviewedBaseline, freshPolicy)) {
        queryClient.setQueryData(policyKey, freshPolicy);
        if (activeRef.current) {
          setConflict(freshPolicy);
          setError(
            "The stored export policy changed after you opened this form. Review the latest values before saving again.",
          );
        }
        return;
      }

      const saved = await updateExportRetentionPolicy(
        {
          retentionDays: Number(retentionDays),
          maxPerTenant: Number(maxPerTenant),
        },
        { signal: controller.signal },
      );
      if (!activeRef.current || authorityKeyRef.current !== openedAuthority) return;
      setBaseline(saved);
      queryClient.setQueryData(policyKey, saved);
      if (draftRef.current === sentDraft) {
        setRetentionDays(String(saved.retentionDays));
        setMaxPerTenant(String(saved.maxPerTenant));
      }
      setSuccess("Export retention policy updated and read back from the server.");
      toast.success("Export retention policy updated.");
    } catch (caught) {
      if (!activeRef.current || controller.signal.aborted || authorityKeyRef.current !== openedAuthority) return;
      setError(apiErrorMessage(caught, "Could not update the export policy."));
    } finally {
      if (activeRef.current && mutationRef.current === controller) {
        savingRef.current = false;
        setSaving(false);
      }
      if (mutationRef.current === controller) mutationRef.current = null;
    }
  }

  function adoptLatest(): void {
    if (!conflict) return;
    setBaseline(conflict);
    setRetentionDays(String(conflict.retentionDays));
    setMaxPerTenant(String(conflict.maxPerTenant));
    setConflict(null);
    setError(null);
    setSuccess(null);
  }

  return (
    <Card aria-labelledby="export-retention-policy-title">
      <CardHeader>
        <CardTitle id="export-retention-policy-title">
          Export retention &amp; capacity
        </CardTitle>
        <CardDescription>
          Control the expiry assigned to newly completed workspace exports and
          reserve a bounded number of queued, running, or ready bundles.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert role="note">
          <AlertTitle>How enforcement works</AlertTitle>
          <AlertDescription>
            The worker reads this tenant policy immediately before upload and
            assigns the configured expiry. Queued and running jobs reserve
            capacity; new requests are refused at the cap, and a cap cannot be
            lowered below the active count. Expired links are hidden and the
            retention sweep removes their stored bundles.
          </AlertDescription>
        </Alert>

        {identityQuery.isPending ? (
          <LoadingFields label="Verifying workspace authority" />
        ) : identityQuery.isError ? (
          <Failure
            message="Workspace authority could not be verified. No policy request was made."
            retrying={identityQuery.isFetching}
            onRetry={() => void identityQuery.refetch()}
          />
        ) : !canWrite ? (
          <Alert>
            <AlertTitle>Owner or admin access required</AlertTitle>
            <AlertDescription>
              This policy route is admin-scoped. No policy values were fetched
              for the current effective role.
            </AlertDescription>
          </Alert>
        ) : policyQuery.isPending && !baseline ? (
          <LoadingFields label="Loading export policy" />
        ) : policyQuery.isError && !baseline ? (
          <Failure
            message={apiErrorMessage(
              policyQuery.error,
              "The export policy could not be loaded. No defaults were substituted.",
            )}
            retrying={policyQuery.isFetching}
            onRetry={() => void policyQuery.refetch()}
          />
        ) : baseline ? (
          <form
            className="space-y-4"
            aria-busy={saving}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="export-policy-days">Expiry window (days)</Label>
                <Input
                  id="export-policy-days"
                  type="number"
                  min={EXPORT_RETENTION_DAYS_MIN}
                  max={EXPORT_RETENTION_DAYS_MAX}
                  step={1}
                  inputMode="numeric"
                  value={retentionDays}
                  disabled={saving}
                  aria-invalid={Boolean(daysError)}
                  aria-describedby="export-policy-days-help"
                  onChange={(event) => {
                    setRetentionDays(event.target.value);
                    setError(null);
                    setSuccess(null);
                  }}
                />
                <p
                  id="export-policy-days-help"
                  className={daysError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
                >
                  {daysError ?? `${EXPORT_RETENTION_DAYS_MIN}–${EXPORT_RETENTION_DAYS_MAX} days.`}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="export-policy-count">Active export cap</Label>
                <Input
                  id="export-policy-count"
                  type="number"
                  min={EXPORT_RETENTION_COUNT_MIN}
                  max={EXPORT_RETENTION_COUNT_MAX}
                  step={1}
                  inputMode="numeric"
                  value={maxPerTenant}
                  disabled={saving}
                  aria-invalid={Boolean(countError)}
                  aria-describedby="export-policy-count-help"
                  onChange={(event) => {
                    setMaxPerTenant(event.target.value);
                    setError(null);
                    setSuccess(null);
                  }}
                />
                <p
                  id="export-policy-count-help"
                  className={countError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
                >
                  {countError ?? `${EXPORT_RETENTION_COUNT_MIN}–${EXPORT_RETENTION_COUNT_MAX} queued, running, or ready exports.`}
                </p>
              </div>
            </div>

            <div className="grid gap-3 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-2">
              <p>
                <span className="block text-xs text-muted-foreground">
                  Current ready-export storage
                </span>
                <span className="font-medium">
                  {formatBytes(baseline.currentStorageBytes)}
                </span>
              </p>
              <p>
                <span className="block text-xs text-muted-foreground">
                  Policy last changed
                </span>
                <span className="font-medium">
                  {formatWireTimestamp(baseline.updatedAt, "Unknown")}
                </span>
              </p>
            </div>

            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Policy was not saved</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>{error}</p>
                  {conflict ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={adoptLatest}
                    >
                      Load latest server values
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
            {success ? (
              <p role="status" className="text-sm text-success-emphasis">
                {success}
              </p>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={saving || !dirty}
                onClick={() => {
                  setRetentionDays(String(baseline.retentionDays));
                  setMaxPerTenant(String(baseline.maxPerTenant));
                  setError(null);
                  setSuccess(null);
                  setConflict(null);
                }}
              >
                Discard changes
              </Button>
              <Button
                type="submit"
                loading={saving}
                disabled={saving || !dirty || !valid}
              >
                {saving ? "Saving…" : "Save export policy"}
              </Button>
            </div>
          </form>
        ) : (
          <Failure
            message="The export policy returned no verified representation."
            retrying={policyQuery.isFetching}
            onRetry={() => void policyQuery.refetch()}
          />
        )}
      </CardContent>
    </Card>
  );
}

function LoadingFields({ label }: { label: string }) {
  return (
    <div className="space-y-3" role="status" aria-label={label}>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

function Failure({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Export policy unavailable</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{message}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={retrying}
          onClick={onRetry}
        >
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function integerFieldError(value: string, min: number, max: number): string | null {
  if (value.trim() === "") return "Enter a whole number.";
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return `Enter a whole number from ${min} to ${max}.`;
  }
  return null;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value.toLocaleString()} B`;
  if (value < 1_024 ** 2) return `${(value / 1_024).toFixed(1)} KiB`;
  if (value < 1_024 ** 3) return `${(value / 1_024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1_024 ** 3).toFixed(1)} GiB`;
}
