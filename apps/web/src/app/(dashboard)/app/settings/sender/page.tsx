// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { emailComplianceApi } from "@/lib/email-compliance-api";
import { getAuthChecks } from "@/lib/inbox-reality-api";
import { qk, STALE } from "@/lib/query-keys";
import { sendingControlsApi } from "@/lib/sending-controls-api";
import type { SendingSettings } from "@/lib/sending-settings-api";
import { roleCanWrite } from "@/lib/use-admin-gate";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { exactPrincipalKey } from "@/lib/exact-principal";
import {
  isServiceNotDeployed,
  isSendingDomainNotConfigured,
} from "@/lib/service-availability";

import {
  ComplianceProfileCard,
  EmailSendingSafetyCard,
  FromIdentityCard,
} from "./sender-settings-cards";
import {
  DEFAULT_PAUSE_REASON,
  EMPTY_PROFILE,
  isComplianceReady,
  loadSenderSettings,
  profilePayloadForSave,
  profileInputFromCompliance,
  type EmailComplianceProfileDraft,
  type SenderSettingsData,
} from "./sender-settings-helpers";

// The pause dialog only opens from the kill switch, so its module loads when
// the page first renders it; nothing is shown while it loads because the
// dialog stays closed until the operator asks to pause.
const PauseEmailSendingDialog = dynamic(
  () =>
    import("./pause-email-sending-dialog").then(
      (m) => m.PauseEmailSendingDialog,
    ),
  { loading: () => null },
);

// The sending-limits card (rate caps, quiet hours, and its step-up flow) sits
// below the sending-safety card; it loads after first paint so the route's
// eager chunk stays inside the bundle budget. The fallback mirrors the card's
// own loading state so the layout does not jump when it mounts.
const SendingLimitsCard = dynamic(
  () => import("./sending-limits-card").then((m) => m.SendingLimitsCard),
  {
    loading: () => (
      <Card
        id="sending-limits"
        tabIndex={-1}
        className="scroll-mt-24 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-busy
      >
        <CardHeader>
          <CardTitle>Sending limits</CardTitle>
          <CardDescription>
            Cap how fast this workspace sends and hold delivery during quiet
            hours. These feed the production-readiness checklist above.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            role="status"
            className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
          >
            Loading the saved sending limits…
          </div>
        </CardContent>
      </Card>
    ),
  },
);

// The authentication-health card is the last card on the page and only shows
// the live SPF/DKIM/DMARC read; it loads after first paint for the same
// bundle-budget reason. The fallback keeps the card's id and heading so the
// readiness checklist's anchor link still has a target while it mounts.
const AuthenticationHealthCard = dynamic(
  () =>
    import("./authentication-health-card").then(
      (m) => m.AuthenticationHealthCard,
    ),
  {
    loading: () => (
      <Card
        id="auth-health"
        tabIndex={-1}
        className="scroll-mt-24 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-busy
      >
        <CardHeader>
          <CardTitle>Authentication health</CardTitle>
          <CardDescription>
            Live SPF, DKIM, and DMARC results from the deliverability service.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div role="status" className="text-sm text-muted-foreground">
            Loading auth checks...
          </div>
        </CardContent>
      </Card>
    ),
  },
);

function useSenderIdentityQuery() {
  return useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
}

export default function SenderIdentityPage() {
  const meQuery = useSenderIdentityQuery();
  const principalScope = exactPrincipalKey(meQuery.data);

  return (
    <SenderIdentitySurface
      key={`sender-settings:${principalScope}`}
      meQuery={meQuery}
      principalScope={principalScope}
    />
  );
}

function SenderIdentitySurface({
  meQuery,
  principalScope,
}: {
  meQuery: ReturnType<typeof useSenderIdentityQuery>;
  principalScope: string;
}) {
  const queryClient = useQueryClient();
  const [profile, setProfile] =
    useState<EmailComplianceProfileDraft>(EMPTY_PROFILE);
  const [profileDirty, setProfileDirty] = useState(false);
  // Latest profile, readable after an await — see saveProfile.
  const profileRef = useRef(profile);
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingControl, setSavingControl] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const savingProfileRef = useRef(false);
  const savingControlRef = useRef(false);
  const retryingRef = useRef(false);
  const activePrincipalRef = useRef(true);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const mutationBusyRef = useRef(false);
  const safetyActionRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  // Pause flow uses an in-app Dialog so Cancel/Escape truly aborts the
  // destructive kill switch in webview/desktop shells.
  const [pauseDialogOpen, setPauseDialogOpen] = useState(false);
  const [pauseReason, setPauseReason] = useState(DEFAULT_PAUSE_REASON);

  const tenantId = meQuery.data?.tenant_id ?? "anon";
  // Effective role, not the durable one: the View-as-Viewer preview
  // (maintenance page) sets `effective_role`, and the server gates writes on
  // `EffectiveRoleOrDurable()`. Reading `role` here left the Save controls
  // enabled during a preview the whole point of which is to show what a
  // viewer can do.
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const senderSettingsKey = useMemo(
    () => [...qk.settings(tenantId, role, "sender"), principalScope],
    [principalScope, role, tenantId],
  );
  const senderSettingsQuery = useQuery({
    queryKey: senderSettingsKey,
    queryFn: () => loadSenderSettings(roleCanWrite(role), tenantId),
    enabled: meQuery.isSuccess && Boolean(meQuery.data?.tenant_id),
    staleTime: STALE.list,
  });
  useEffect(() => {
    return () => {
      void queryClient.cancelQueries({
        queryKey: senderSettingsKey,
        exact: true,
      });
      queryClient.removeQueries({ queryKey: senderSettingsKey, exact: true });
    };
  }, [queryClient, senderSettingsKey]);
  // Authentication health is the deliverability service's live DNS read: the
  // slowest call here, and absent where that service is not deployed. Its own
  // query keeps it from holding back every other card, and a failure or an
  // absence stays inside its card. No query-level retries: the transport
  // already retries a transient failure, and a Retry button asks again.
  const authChecksKey = useMemo(
    () => [
      ...qk.settings(tenantId, role, "sender-auth-checks"),
      principalScope,
    ],
    [principalScope, role, tenantId],
  );
  const authChecksQuery = useQuery({
    queryKey: authChecksKey,
    queryFn: getAuthChecks,
    enabled: meQuery.isSuccess && Boolean(meQuery.data?.tenant_id),
    staleTime: STALE.list,
    retry: false,
  });
  useEffect(() => {
    return () => {
      void queryClient.cancelQueries({ queryKey: authChecksKey, exact: true });
      queryClient.removeQueries({ queryKey: authChecksKey, exact: true });
    };
  }, [queryClient, authChecksKey]);
  const [lastVerifiedSenderSettings, setLastVerifiedSenderSettings] = useState<{
    data: SenderSettingsData;
    scope: string;
  } | null>(null);
  useEffect(() => {
    if (!senderSettingsQuery.data) return;
    setLastVerifiedSenderSettings({
      data: senderSettingsQuery.data,
      scope: principalScope,
    });
  }, [principalScope, senderSettingsQuery.data]);
  const retainedSenderSettings =
    lastVerifiedSenderSettings?.scope === principalScope
      ? lastVerifiedSenderSettings.data
      : null;
  const senderSettingsData = senderSettingsQuery.data ?? retainedSenderSettings;
  const showingRetainedSenderSettings = Boolean(
    !senderSettingsQuery.data && retainedSenderSettings,
  );
  const loading =
    meQuery.isLoading || (senderSettingsQuery.isPending && !senderSettingsData);
  const senderSettingsReadError =
    senderSettingsQuery.error instanceof Error
      ? senderSettingsQuery.error.message
      : senderSettingsQuery.isError
        ? "Could not load sender settings — this is a failed request, not an unconfigured sender."
        : null;
  const identityReadError =
    meQuery.error instanceof Error
      ? meQuery.error.message
      : meQuery.isError
        ? "Could not verify your sender-settings access."
        : null;
  const loadError = !meQuery.data
    ? identityReadError
    : !senderSettingsData
      ? senderSettingsReadError
      : null;
  const staleError = meQuery.data
    ? (identityReadError ??
      (senderSettingsData ? senderSettingsReadError : null))
    : null;

  const error = actionError ?? loadError;
  const me = meQuery.data ?? null;
  const authChecksNeedDomain = isSendingDomainNotConfigured(
    authChecksQuery.error,
  );
  const checks =
    !authChecksNeedDomain && Array.isArray(authChecksQuery.data)
      ? authChecksQuery.data
      : [];
  const control = senderSettingsData?.control ?? null;
  const readiness = senderSettingsData?.readiness ?? null;
  // The identity failure already explains that the page cannot load; repeating
  // it here would add a second, indistinguishable live region.
  const authChecksNotDeployed = isServiceNotDeployed(authChecksQuery.error);
  const authChecksError =
    !meQuery.data ||
    authChecksNotDeployed ||
    authChecksNeedDomain ||
    !authChecksQuery.isError
      ? null
      : authChecksQuery.error instanceof Error
        ? authChecksQuery.error.message
        : "Could not load authentication health.";
  const complianceReady = isComplianceReady(profile);
  const canWrite =
    meQuery.isSuccess && !meQuery.data.viewer_mode && roleCanWrite(role);
  // A failed/unfinished read is not an empty sender configuration. Keep every
  // full-replace editor inert until its real baseline has been verified.
  const staleReadOnly = Boolean(
    staleError ||
    showingRetainedSenderSettings ||
    (senderSettingsQuery.isFetching && senderSettingsData),
  );
  const editorUnavailable = loading || Boolean(loadError) || staleReadOnly;
  const canMutate = canWrite && !editorUnavailable;
  useUnsavedChangesGuard(profileDirty);

  useEffect(() => {
    activePrincipalRef.current = true;
    return () => {
      activePrincipalRef.current = false;
      mutationControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    const complianceProfile = senderSettingsData?.complianceProfile;
    if (!complianceProfile || profileDirty) return;
    setProfile(profileInputFromCompliance(complianceProfile, me));
  }, [me, profileDirty, senderSettingsData?.complianceProfile]);

  // Authentication health reads the domains the sender settings name, so a
  // change to them re-reads it too. Invalidation (unlike refetch) leaves the
  // query alone while it is disabled.
  const invalidateSenderSettings = (): Promise<void> =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: senderSettingsKey,
        exact: false,
      }),
      queryClient.invalidateQueries({ queryKey: authChecksKey, exact: true }),
    ]).then(() => undefined);

  const acceptSendingLimitsSave = (saved?: SendingSettings): void => {
    if (saved) {
      const withSavedLimits = (
        data: SenderSettingsData,
      ): SenderSettingsData => ({ ...data, sendingSettings: saved });
      queryClient.setQueryData<SenderSettingsData>(senderSettingsKey, (cur) =>
        cur ? withSavedLimits(cur) : cur,
      );
      // A failed invalidation may remove query.data. Retain the canonical PUT
      // row immediately so the stale read-only view can never regress to R1.
      setLastVerifiedSenderSettings((previous) => {
        const baseline =
          previous?.scope === principalScope
            ? previous.data
            : senderSettingsData;
        return baseline
          ? { data: withSavedLimits(baseline), scope: principalScope }
          : previous;
      });
    }
    void invalidateSenderSettings();
  };

  const updateProfile = (
    patch: Partial<Omit<EmailComplianceProfileDraft, "verified_sender_domain">>,
  ) => {
    if (!canMutate) return;
    setActionError(null);
    setProfileDirty(true);
    setProfile((prev) => ({ ...prev, ...patch }));
  };

  const saveProfile = async () => {
    if (savingProfileRef.current || mutationBusyRef.current || !canMutate)
      return;
    mutationBusyRef.current = true;
    savingProfileRef.current = true;
    setSavingProfile(true);
    setActionError(null);
    // The fields stay enabled during a save, so the operator can keep typing.
    // Reference identity tells us whether they did — updateProfile spreads
    // into a fresh object on every edit.
    const sent = profile;
    const intent = profilePayloadForSave(profile);
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    try {
      await verifyFreshAdminAuthority(meQuery.data!, controller.signal);
      const saved = await emailComplianceApi.put(intent, controller.signal);
      if (!activePrincipalRef.current) return;
      queryClient.setQueryData<SenderSettingsData>(senderSettingsKey, (cur) =>
        cur ? { ...cur, complianceProfile: saved } : cur,
      );
      // Writing the echo back unconditionally reverted edits made while the
      // request was open, and clearing the dirty flag hid that it happened.
      if (profileRef.current === sent) {
        setProfile(profileInputFromCompliance(saved, me));
        setProfileDirty(false);
      }
      toast.success("Sender compliance profile saved.");
      void invalidateSenderSettings();
    } catch (err) {
      if (!activePrincipalRef.current) return;
      setActionError(
        err instanceof Error ? err.message : "Could not save profile.",
      );
      toast.error(
        err instanceof Error ? err.message : "Could not save profile.",
      );
    } finally {
      savingProfileRef.current = false;
      mutationBusyRef.current = false;
      if (activePrincipalRef.current) setSavingProfile(false);
    }
  };

  const pauseEmailSending = async () => {
    if (savingControlRef.current || mutationBusyRef.current || !canMutate)
      return;
    mutationBusyRef.current = true;
    savingControlRef.current = true;
    setSavingControl(true);
    setActionError(null);
    try {
      const reason = pauseReason.trim() || "operator pause";
      const controller = new AbortController();
      mutationControllerRef.current = controller;
      await verifyFreshAdminAuthority(meQuery.data!, controller.signal);
      const next = await sendingControlsApi.pause(reason, controller.signal);
      if (!activePrincipalRef.current) return;
      queryClient.setQueryData<SenderSettingsData>(senderSettingsKey, (cur) =>
        cur ? { ...cur, control: next } : cur,
      );
      await invalidateSenderSettings();
      setPauseDialogOpen(false);
      toast.success("Email sending paused.");
    } catch (err) {
      if (!activePrincipalRef.current) return;
      setActionError(
        err instanceof Error ? err.message : "Could not pause sends.",
      );
      toast.error(
        err instanceof Error ? err.message : "Could not pause sends.",
      );
    } finally {
      savingControlRef.current = false;
      mutationBusyRef.current = false;
      if (activePrincipalRef.current) setSavingControl(false);
    }
  };

  const resumeEmailSending = async () => {
    if (savingControlRef.current || mutationBusyRef.current || !canMutate)
      return;
    mutationBusyRef.current = true;
    savingControlRef.current = true;
    setSavingControl(true);
    setActionError(null);
    try {
      const controller = new AbortController();
      mutationControllerRef.current = controller;
      await verifyFreshAdminAuthority(meQuery.data!, controller.signal);
      const next = await sendingControlsApi.resume(controller.signal);
      if (!activePrincipalRef.current) return;
      queryClient.setQueryData<SenderSettingsData>(senderSettingsKey, (cur) =>
        cur ? { ...cur, control: next } : cur,
      );
      await invalidateSenderSettings();
      toast.success("Email sending resumed.");
    } catch (err) {
      if (!activePrincipalRef.current) return;
      setActionError(
        err instanceof Error ? err.message : "Could not resume sends.",
      );
      toast.error(
        err instanceof Error ? err.message : "Could not resume sends.",
      );
    } finally {
      savingControlRef.current = false;
      mutationBusyRef.current = false;
      if (activePrincipalRef.current) setSavingControl(false);
    }
  };

  const retryLoad = async () => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    setActionError(null);
    try {
      await Promise.all([
        meQuery.refetch(),
        senderSettingsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: authChecksKey, exact: true }),
      ]);
    } finally {
      retryingRef.current = false;
      if (activePrincipalRef.current) setRetrying(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      {error && (
        <div
          ref={errorRef}
          role="alert"
          tabIndex={-1}
          className="space-y-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p className="break-words [overflow-wrap:anywhere]">{error}</p>
          {loadError ? (
            <>
              <p className="text-xs">
                Existing sender values remain protected until this request
                succeeds.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                loading={retrying}
                onClick={() => void retryLoad()}
              >
                Retry sender settings
              </Button>
            </>
          ) : null}
        </div>
      )}

      {staleError && !loadError ? (
        <div className="space-y-3 rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-emphasis">
          <div
            role="status"
            aria-live="polite"
            className="space-y-1 break-words [overflow-wrap:anywhere]"
          >
            <p className="font-medium">
              Showing the last verified sender settings.
            </p>
            <p>Latest error: {staleError}</p>
            <p>
              Every sender and sending-policy control is read-only until current
              workspace data is verified again.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            loading={retrying}
            onClick={() => void retryLoad()}
          >
            Verify current settings
          </Button>
        </div>
      ) : null}

      <EmailSendingSafetyCard
        actionRef={safetyActionRef}
        canWrite={canWrite}
        control={control}
        loading={loading}
        loadError={loadError}
        onOpenPause={() => {
          setActionError(null);
          setPauseReason(DEFAULT_PAUSE_REASON);
          setPauseDialogOpen(true);
        }}
        onResume={() => void resumeEmailSending()}
        readOnly={staleReadOnly}
        readiness={readiness}
        savingControl={savingControl}
      />

      <SendingLimitsCard
        key={`sending-limits:${principalScope}`}
        readiness={readiness}
        settings={senderSettingsData?.sendingSettings ?? null}
        canWrite={canWrite}
        disabled={Boolean(loadError)}
        loading={loading}
        onSaved={acceptSendingLimitsSave}
        readOnly={staleReadOnly}
        identity={meQuery.data!}
        authorityKey={principalScope}
        beginSharedMutation={() => {
          if (mutationBusyRef.current) return false;
          mutationBusyRef.current = true;
          return true;
        }}
        endSharedMutation={() => {
          mutationBusyRef.current = false;
        }}
      />

      <FromIdentityCard />

      <ComplianceProfileCard
        canWrite={canWrite}
        complianceReady={complianceReady}
        loading={loading}
        onProfileChange={updateProfile}
        onSave={() => void saveProfile()}
        profile={profile}
        profileDirty={profileDirty}
        readOnly={staleReadOnly}
        savingProfile={savingProfile}
        unavailable={Boolean(loadError)}
      />

      <AuthenticationHealthCard
        checks={checks}
        loading={
          meQuery.isLoading ||
          (authChecksQuery.isPending && authChecksQuery.isFetching)
        }
        loadError={authChecksError}
        notDeployed={authChecksNotDeployed}
        onRetry={() => void authChecksQuery.refetch()}
        retrying={authChecksQuery.isFetching}
      />

      <PauseEmailSendingDialog
        canWrite={canMutate}
        open={pauseDialogOpen}
        onOpenChange={(open) => {
          if (!savingControl) setPauseDialogOpen(open);
        }}
        onConfirm={() => void pauseEmailSending()}
        onReasonChange={setPauseReason}
        reason={pauseReason}
        returnFocusRef={safetyActionRef}
        savingControl={savingControl}
      />
    </div>
  );
}
