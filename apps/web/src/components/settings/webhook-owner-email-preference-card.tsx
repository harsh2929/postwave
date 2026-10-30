// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api";
import {
  effectiveAuthRole,
  whoami,
  whoamiFresh,
} from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { qk, STALE } from "@/lib/query-keys";
import {
  getWebhookOwnerEmailPreference,
  sameWebhookPreferenceRevision,
  updateWebhookOwnerEmailPreference,
  WorkspaceSettingContractError,
  type WebhookOwnerEmailPreference,
} from "@/lib/workspace-settings-controls-api";

export function WebhookOwnerEmailPreferenceCard() {
  const queryClient = useQueryClient();
  const identityQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });
  const identity = identityQuery.data;
  const role = identity ? effectiveAuthRole(identity) : null;
  const isOwner = role === "owner";
  const preferenceKey = useMemo(
    () => [
      ...qk.settings(
        identity?.tenant_id ?? "unverified",
        role,
        "webhook-owner-email-preference",
      ),
      identity?.user_id ?? "unverified",
    ],
    [identity?.tenant_id, identity?.user_id, role],
  );
  const preferenceQuery = useQuery({
    queryKey: preferenceKey,
    queryFn: async ({ signal }) => {
      const preference = await getWebhookOwnerEmailPreference({ signal });
      assertPreferenceIdentity(preference, identity);
      return preference;
    },
    enabled: identityQuery.isSuccess && isOwner,
    staleTime: STALE.detail,
    retry: false,
  });

  const [baseline, setBaseline] =
    useState<WebhookOwnerEmailPreference | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [conflict, setConflict] =
    useState<WebhookOwnerEmailPreference | null>(null);
  const activeRef = useRef(true);
  const savingRef = useRef(false);
  const mutationRef = useRef<AbortController | null>(null);
  const draftRef = useRef(enabled);
  const dirty = baseline !== null && enabled !== baseline.notifyAutoDisabled;
  const dirtyRef = useRef(dirty);
  draftRef.current = enabled;
  dirtyRef.current = dirty;
  useUnsavedChangesGuard(dirty);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      mutationRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const preference = preferenceQuery.data;
    if (!preference || savingRef.current || dirtyRef.current) return;
    setBaseline(preference);
    setEnabled(preference.notifyAutoDisabled);
    setConflict(null);
  }, [preferenceQuery.data]);

  async function save(): Promise<void> {
    if (
      savingRef.current ||
      !identity ||
      !isOwner ||
      !baseline ||
      !dirty
    ) {
      return;
    }
    const sent = enabled;
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
      const [freshIdentity, freshPreference] = await Promise.all([
        whoamiFresh(controller.signal),
        getWebhookOwnerEmailPreference({
          signal: controller.signal,
          fresh: true,
        }),
      ]);
      if (
        freshIdentity.tenant_id !== identity.tenant_id ||
        freshIdentity.user_id !== identity.user_id ||
        effectiveAuthRole(freshIdentity) !== "owner"
      ) {
        throw new Error(
          "Workspace identity or owner authority changed. Reload before saving.",
        );
      }
      assertPreferenceIdentity(freshPreference, freshIdentity);
      if (!sameWebhookPreferenceRevision(reviewedBaseline, freshPreference)) {
        queryClient.setQueryData(preferenceKey, freshPreference);
        if (activeRef.current) {
          setConflict(freshPreference);
          setError(
            "Webhook notification preferences changed after you opened this form. Review the latest owner value before saving again.",
          );
        }
        return;
      }

      await updateWebhookOwnerEmailPreference(
        freshPreference,
        sent,
        { signal: controller.signal },
      );
      // PUT returns only {ok:true}. Read back before claiming success so a
      // write routed to the wrong user/tenant cannot be presented as applied.
      const verified = await getWebhookOwnerEmailPreference({
        signal: controller.signal,
        fresh: true,
      });
      assertPreferenceIdentity(verified, freshIdentity);
      if (verified.notifyAutoDisabled !== sent) {
        throw new WorkspaceSettingContractError(
          "the server acknowledgement did not match the saved owner preference",
        );
      }
      if (!activeRef.current) return;
      setBaseline(verified);
      queryClient.setQueryData(preferenceKey, verified);
      if (draftRef.current === sent) setEnabled(verified.notifyAutoDisabled);
      const message = sent
        ? "Owner email after webhook auto-pause is enabled."
        : "Owner email after webhook auto-pause is disabled.";
      setSuccess(message);
      toast.success(message);
    } catch (caught) {
      if (!activeRef.current || controller.signal.aborted) return;
      setError(
        apiErrorMessage(
          caught,
          "The owner email preference could not be updated.",
        ),
      );
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
    setEnabled(conflict.notifyAutoDisabled);
    setConflict(null);
    setError(null);
    setSuccess(null);
  }

  return (
    <Card aria-labelledby="webhook-owner-email-title">
      <CardHeader>
        <CardTitle id="webhook-owner-email-title">
          Auto-pause owner email
        </CardTitle>
        <CardDescription>
          Choose whether the workspace owner receives email when repeated
          delivery failures cause an outbound webhook to auto-pause.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {identityQuery.isPending ? (
          <div role="status" aria-label="Verifying owner authority">
            <Skeleton className="h-16 w-full" />
          </div>
        ) : identityQuery.isError ? (
          <PreferenceFailure
            message="Workspace identity could not be verified. No preference request was made."
            retrying={identityQuery.isFetching}
            onRetry={() => void identityQuery.refetch()}
          />
        ) : role === "admin" ? (
          <Alert variant="warning" role="note">
            <AlertTitle>Only the owner can change this recipient</AlertTitle>
            <AlertDescription>
              The live API stores preferences for the signed-in user, while the
              auto-pause worker consults only the owner&apos;s row. An admin write
              would be accepted but would not change the owner email, so this
              control fails closed for admins.
            </AlertDescription>
          </Alert>
        ) : !isOwner ? (
          <Alert>
            <AlertTitle>Owner access required</AlertTitle>
            <AlertDescription>
              No owner preference was fetched for the current effective role.
            </AlertDescription>
          </Alert>
        ) : preferenceQuery.isPending && !baseline ? (
          <div role="status" aria-label="Loading owner email preference">
            <Skeleton className="h-16 w-full" />
          </div>
        ) : preferenceQuery.isError && !baseline ? (
          <PreferenceFailure
            message={apiErrorMessage(
              preferenceQuery.error,
              "The owner email preference could not be loaded. No local default was substituted.",
            )}
            retrying={preferenceQuery.isFetching}
            onRetry={() => void preferenceQuery.refetch()}
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
            <div className="flex items-start gap-3 rounded-md border p-4">
              <Checkbox
                id="webhook-auto-pause-owner-email"
                checked={enabled}
                disabled={saving}
                onChange={(event) => {
                  setEnabled(event.target.checked);
                  setError(null);
                  setSuccess(null);
                }}
              />
              <div className="min-w-0 space-y-1">
                <Label htmlFor="webhook-auto-pause-owner-email">
                  Email the workspace owner after an automatic pause
                </Label>
                <p className="text-xs leading-5 text-muted-foreground">
                  This changes only the canonical auto-pause email. Legacy
                  failure-rate and latency values are preserved exactly because
                  the server&apos;s PUT contract replaces the full preference row.
                </p>
              </div>
            </div>

            <Alert role="note">
              <AlertTitle>Preserved compatibility settings</AlertTitle>
              <AlertDescription>
                Failure-rate email {baseline.notifyFailureRate ? "enabled" : "disabled"}
                {baseline.notifyFailureRate
                  ? ` at ${baseline.failureRatePct}%`
                  : ""}
                ; latency email {baseline.notifyLatency ? "enabled" : "disabled"}
                {baseline.notifyLatency
                  ? ` at ${baseline.latencyMs.toLocaleString()} ms`
                  : ""}
                . Last server update: {formatWireTimestamp(baseline.updatedAt, "not persisted yet")}.
              </AlertDescription>
            </Alert>

            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Preference was not saved</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>{error}</p>
                  {conflict ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={adoptLatest}
                    >
                      Load latest owner preference
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
                  setEnabled(baseline.notifyAutoDisabled);
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
                disabled={saving || !dirty}
              >
                {saving ? "Saving…" : "Save owner email preference"}
              </Button>
            </div>
          </form>
        ) : (
          <PreferenceFailure
            message="The preference route returned no verified representation."
            retrying={preferenceQuery.isFetching}
            onRetry={() => void preferenceQuery.refetch()}
          />
        )}
      </CardContent>
    </Card>
  );
}

function assertPreferenceIdentity(
  preference: WebhookOwnerEmailPreference,
  identity:
    | { tenant_id: string; user_id: string }
    | null
    | undefined,
): void {
  if (
    !identity ||
    preference.tenantId !== identity.tenant_id ||
    preference.userId !== identity.user_id
  ) {
    throw new WorkspaceSettingContractError(
      "webhook preference identity does not match the authenticated workspace user",
    );
  }
}

function PreferenceFailure({
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
      <AlertTitle>Owner email preference unavailable</AlertTitle>
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
