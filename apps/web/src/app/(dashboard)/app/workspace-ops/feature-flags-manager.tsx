// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag } from "lucide-react";
import { toast } from "sonner";

import {
  OperationsFailure,
  OperationsLoading,
  OperationsSection,
} from "@/components/operations/operations-surface";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import {
  featureFlagDraftError,
  listFeatureFlagRegistry,
  removeFeatureFlagOverride,
  resolveFeatureFlag,
  sameFeatureFlagRevision,
  upsertFeatureFlagOverride,
  type FeatureFlagRecord,
  type FeatureFlagResolution,
} from "@/lib/feature-flags-admin-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

const RENDER_CAP = 200;

export function FeatureFlagsManager({ identity }: { identity: MeResponse }) {
  const role = effectiveAuthRole(identity);
  const canWrite = roleCanWrite(role) && !identity.viewer_mode;
  const queryClient = useQueryClient();
  const queryKey = [
    "workspace-ops",
    identity.tenant_id,
    identity.user_id,
    role,
    identity.viewer_mode ? "viewer" : "member",
    "feature-flags-admin",
  ] as const;
  const flags = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      listFeatureFlagRegistry(identity.tenant_id, { signal }),
    staleTime: STALE.detail,
    retry: false,
  });
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<FeatureFlagRecord | "new" | null>(
    null,
  );
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<FeatureFlagRecord | null>(
    null,
  );
  const [resolveKey, setResolveKey] = useState("");
  const [resolution, setResolution] = useState<FeatureFlagResolution | null>(
    null,
  );
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const operationRef = useRef(false);

  const rows = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return (Array.isArray(flags.data) ? flags.data : [])
      .filter(
        (flag) =>
          !query ||
          flag.key.toLowerCase().includes(query) ||
          flag.value.toLowerCase().includes(query) ||
          flag.note.toLowerCase().includes(query),
      )
      .sort((left, right) =>
        left.key === right.key
          ? Number(left.isDefault) - Number(right.isDefault)
          : left.key.localeCompare(right.key),
      );
  }, [filter, flags.data]);
  const baseline = editing === "new" ? null : editing;
  const dirty = Boolean(
    editing &&
    (key !== (baseline?.key ?? "") ||
      value !== (baseline?.value ?? "") ||
      note !== (baseline?.note ?? "")),
  );
  useUnsavedChangesGuard(dirty && !saving);
  const validation = featureFlagDraftError({ key, value, note });

  function openDraft(flag?: FeatureFlagRecord, createOverride = false): void {
    setEditing(createOverride || !flag ? "new" : flag);
    setKey(flag?.key ?? "");
    setValue(flag?.value ?? "");
    setNote(flag?.note ?? "");
    setAcknowledged(false);
    setError(null);
    setSuccess(null);
  }

  function closeDraft(): void {
    setEditing(null);
    setKey("");
    setValue("");
    setNote("");
    setAcknowledged(false);
    setError(null);
  }

  async function save(): Promise<void> {
    if (
      !canWrite ||
      !editing ||
      validation ||
      !acknowledged ||
      operationRef.current
    ) {
      return;
    }
    operationRef.current = true;
    setSaving(true);
    setError(null);
    setSuccess(null);
    const normalizedKey = key.trim();
    try {
      await verifyFreshAdminAuthority(identity);
      const before = await listFeatureFlagRegistry(identity.tenant_id, {
        fresh: true,
      });
      const current = before.find(
        (flag) => !flag.isDefault && flag.key === normalizedKey,
      );
      if (
        (baseline &&
          (!current || !sameFeatureFlagRevision(baseline, current))) ||
        (!baseline && current)
      ) {
        queryClient.setQueryData(queryKey, before);
        throw new Error(
          "This override changed after the form opened. Review the latest server state.",
        );
      }
      const receipt = await upsertFeatureFlagOverride({
        key: normalizedKey,
        value: value.trim(),
        note: note.trim(),
      });
      const after = await listFeatureFlagRegistry(identity.tenant_id, {
        fresh: true,
      });
      const confirmed = after.find(
        (flag) => !flag.isDefault && flag.key === normalizedKey,
      );
      if (
        !confirmed ||
        confirmed.id !== receipt.id ||
        confirmed.value !== value.trim() ||
        confirmed.note !== note.trim()
      ) {
        throw new Error(
          "The override write returned, but a fresh read did not confirm it.",
        );
      }
      queryClient.setQueryData(queryKey, after);
      closeDraft();
      setSuccess(
        confirmed.enabled
          ? "Tenant override saved and confirmed."
          : "Tenant override updated and confirmed, but it remains disabled in the registry.",
      );
      toast.success("Feature-flag override saved.");
    } catch (caught) {
      setError(
        apiErrorMessage(caught, "Could not save the feature-flag override."),
      );
      void flags.refetch();
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  async function remove(flag: FeatureFlagRecord): Promise<void> {
    if (!canWrite || flag.isDefault || operationRef.current) return;
    operationRef.current = true;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await verifyFreshAdminAuthority(identity);
      const before = await listFeatureFlagRegistry(identity.tenant_id, {
        fresh: true,
      });
      const current = before.find(
        (candidate) => !candidate.isDefault && candidate.key === flag.key,
      );
      if (!current || !sameFeatureFlagRevision(flag, current)) {
        queryClient.setQueryData(queryKey, before);
        throw new Error(
          "This override changed after removal was opened. Review the latest state.",
        );
      }
      await removeFeatureFlagOverride(flag.key);
      const after = await listFeatureFlagRegistry(identity.tenant_id, {
        fresh: true,
      });
      if (
        after.some(
          (candidate) => !candidate.isDefault && candidate.key === flag.key,
        )
      ) {
        throw new Error("A fresh read did not confirm override removal.");
      }
      queryClient.setQueryData(queryKey, after);
      if (baseline?.id === flag.id) closeDraft();
      setRemoveTarget(null);
      setSuccess(
        "Tenant override removed. Resolution now falls back to an enabled platform default or missing.",
      );
      toast.success("Feature-flag override removed.");
    } catch (caught) {
      setError(
        apiErrorMessage(caught, "Could not remove the feature-flag override."),
      );
      void flags.refetch();
      throw caught;
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  async function resolve(): Promise<void> {
    const requested = resolveKey.trim();
    if (!requested || requested.length > 200 || resolving) return;
    setResolving(true);
    setResolveError(null);
    setResolution(null);
    try {
      setResolution(await resolveFeatureFlag(requested));
    } catch (caught) {
      setResolveError(apiErrorMessage(caught, "Could not resolve this flag."));
    } finally {
      setResolving(false);
    }
  }

  return (
    <OperationsSection
      id="wo-flags"
      title="Feature-flag registry"
      description="Inspect defaults, manage tenant overrides, and resolve the effective value used by this workspace."
      aside={
        <span className="inline-flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Flag className="size-4" aria-hidden />
        </span>
      }
      className="lg:col-span-2"
    >
      <div className="space-y-5">
        <Alert role="note">
          <AlertTitle>Registry boundary</AlertTitle>
          <AlertDescription>
            Removing an override does not disable a feature; it falls back to an
            enabled platform default, or to missing. This route has no ETag, so
            mutations use a fresh exact preflight and post-write readback.
          </AlertDescription>
        </Alert>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-56 flex-1 space-y-2">
            <Label htmlFor="feature-flags-filter">Filter registry</Label>
            <Input
              id="feature-flags-filter"
              value={filter}
              maxLength={200}
              placeholder="Key, value, or note"
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={flags.isFetching || saving}
              onClick={() => void flags.refetch()}
            >
              {flags.isFetching ? "Refreshing…" : "Refresh registry"}
            </Button>
            <Button
              type="button"
              disabled={!canWrite || saving || editing !== null}
              onClick={() => openDraft()}
            >
              Set override
            </Button>
          </div>
        </div>

        {flags.isPending && !flags.data ? (
          <OperationsLoading label="Loading feature flags" rows={3} />
        ) : flags.isError && !flags.data ? (
          <OperationsFailure
            description={apiErrorMessage(
              flags.error,
              "Feature flags could not be verified.",
            )}
            onRetry={() => void flags.refetch()}
            retrying={flags.isFetching}
          />
        ) : rows.length === 0 ? (
          <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
            {filter.trim()
              ? "No registry row matches this filter."
              : "No platform default or tenant override was returned."}
          </p>
        ) : (
          <>
            <ul className="space-y-2">
              {rows.slice(0, RENDER_CAP).map((flag) => (
                <li
                  key={`${flag.isDefault ? "default" : "tenant"}:${flag.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="break-all font-mono text-sm">
                      {flag.key} = {flag.value}
                    </p>
                    <p className="break-words text-xs text-muted-foreground">
                      {flag.note || "No operator note"} · updated{" "}
                      {formatWireTimestamp(
                        flag.updatedAt,
                        "at an unknown time",
                      )}
                    </p>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant={flag.isDefault ? "secondary" : "success"}>
                        {flag.isDefault
                          ? "Platform default"
                          : "Tenant override"}
                      </Badge>
                      <Badge variant={flag.enabled ? "outline" : "warning"}>
                        {flag.enabled ? "Enabled row" : "Disabled row"}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!canWrite || saving || editing !== null}
                      onClick={() => openDraft(flag, flag.isDefault)}
                    >
                      {flag.isDefault ? "Override" : "Edit"}
                    </Button>
                    {!flag.isDefault ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={!canWrite || saving}
                        onClick={() => setRemoveTarget(flag)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            {rows.length > RENDER_CAP ? (
              <p className="text-xs text-muted-foreground">
                Showing the first {RENDER_CAP.toLocaleString()} of{" "}
                {rows.length.toLocaleString()} matching rows. Narrow the filter
                to manage another key.
              </p>
            ) : null}
          </>
        )}

        {editing ? (
          <form
            className="space-y-4 rounded-lg border bg-muted/20 p-4"
            aria-busy={saving}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <h3 className="font-medium">
              {baseline?.id ? "Edit tenant override" : "Set tenant override"}
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="feature-flag-key">Key</Label>
                <Input
                  id="feature-flag-key"
                  value={key}
                  maxLength={200}
                  disabled={saving || Boolean(baseline?.id)}
                  spellCheck={false}
                  onChange={(event) => setKey(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="feature-flag-value">Value</Label>
                <Input
                  id="feature-flag-value"
                  value={value}
                  maxLength={200}
                  disabled={saving}
                  spellCheck={false}
                  onChange={(event) => setValue(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="feature-flag-note">Operator note</Label>
              <Input
                id="feature-flag-note"
                value={note}
                maxLength={3_000}
                disabled={saving}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            {baseline && !baseline.enabled ? (
              <Alert variant="warning">
                <AlertTitle>This override row is disabled</AlertTitle>
                <AlertDescription>
                  The current API can change its value and note but cannot
                  re-enable it. Effective resolution continues to fall back.
                </AlertDescription>
              </Alert>
            ) : null}
            <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
              <Checkbox
                checked={acknowledged}
                disabled={saving}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                I reviewed the key and value. This workspace override can change
                live runtime behavior wherever this registry key is consumed.
              </span>
            </label>
            {validation ? (
              <p role="alert" className="text-sm text-destructive">
                {validation}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={Boolean(validation) || !acknowledged || saving}
                loading={saving}
              >
                Save override
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={closeDraft}
              >
                {dirty ? "Discard draft" : "Cancel"}
              </Button>
            </div>
          </form>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Override operation not confirmed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {success ? (
          <p role="status" className="text-sm text-success-emphasis">
            {success}
          </p>
        ) : null}
        {!canWrite ? (
          <p className="text-sm text-muted-foreground">
            Owner or admin access is required to change tenant overrides.
          </p>
        ) : null}

        <div className="space-y-3 border-t pt-4">
          <div>
            <h3 className="font-medium">Resolve effective value</h3>
            <p className="text-sm text-muted-foreground">
              This uncached read reports tenant override, platform default, or
              missing for the current workspace.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              className="min-w-56 flex-1 font-mono"
              value={resolveKey}
              maxLength={200}
              aria-label="Flag key to resolve"
              onChange={(event) => setResolveKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void resolve();
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!resolveKey.trim() || resolving}
              loading={resolving}
              onClick={() => void resolve()}
            >
              Resolve
            </Button>
          </div>
          {resolveError ? (
            <p role="alert" className="text-sm text-destructive">
              {resolveError}
            </p>
          ) : null}
          {resolution ? (
            <div role="status" className="rounded-md bg-muted/40 p-3 text-sm">
              <Badge
                variant={
                  resolution.source === "tenant" ? "success" : "secondary"
                }
              >
                {resolution.source}
              </Badge>{" "}
              <span className="font-mono">
                {resolution.key} ={" "}
                {resolution.source === "missing"
                  ? "(missing)"
                  : resolution.value}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title="Remove this tenant override?"
        description="The effective value will immediately fall back to an enabled platform default, or become missing."
        confirmLabel="Remove override"
        confirmationToken="REMOVE OVERRIDE"
        onConfirm={async () => {
          if (removeTarget) await remove(removeTarget);
        }}
      />
    </OperationsSection>
  );
}
