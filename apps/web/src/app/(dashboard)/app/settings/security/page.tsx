// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";
import {
  getSecuritySettings,
  updateSecuritySettings,
  type SecuritySettings,
} from "@/lib/security-api";
import { STALE } from "@/lib/query-keys";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { newUUIDv7 } from "@/lib/http-fetch";
import { useOnline } from "@/lib/use-online";
import { SecurityPolicySettingsCard } from "./security-policy-settings-card";
import { useSettingsQueryKey } from "./settings-query-key";

const TotpEnrollmentCard = dynamic(
  () => import("./totp-enrollment-card").then((mod) => mod.TotpEnrollmentCard),
  { ssr: false, loading: () => <ActiveDevicesFallback /> },
);
const PasskeysCard = dynamic(
  () => import("./passkeys-card").then((mod) => mod.PasskeysCard),
  { ssr: false, loading: () => <ActiveDevicesFallback /> },
);
const IdentityProviderCard = dynamic(
  () =>
    import("./identity-provider-card").then((mod) => mod.IdentityProviderCard),
  { ssr: false, loading: () => <ActiveDevicesFallback /> },
);
const SecurityActivityCard = dynamic(
  () =>
    import("./security-activity-card").then((mod) => mod.SecurityActivityCard),
  { ssr: false, loading: () => <ActiveDevicesFallback /> },
);
const ScimAdminSection = dynamic(
  () => import("./scim-admin-section").then((mod) => mod.ScimAdminSection),
  { ssr: false, loading: () => <ActiveDevicesFallback /> },
);

const TrustedDevices = dynamic(
  () => import("./trusted-devices").then((mod) => mod.TrustedDevices),
  { loading: () => <ActiveDevicesFallback /> },
);
const ActiveDevices = dynamic(
  () => import("./active-devices").then((mod) => mod.ActiveDevices),
  { loading: () => <ActiveDevicesFallback /> },
);

export default function SecuritySettingsPage() {
  const queryClient = useQueryClient();
  const online = useOnline();
  const {
    queryKey: securitySettingsKey,
    enabled: securitySettingsEnabled,
    identityLoading,
    identityError,
    identity,
    canAdmin,
    authorityKey,
    retryIdentity,
    retryingIdentity,
  } = useSettingsQueryKey("security", { adminOnly: true });
  const [settings, setSettings] = useState<SecuritySettings>({
    require_2fa_for_admins: false,
    require_2fa_for_all: false,
    allow_trusted_devices: true,
    sso_provider: "",
    sso_metadata_url: "",
    session_max_minutes: null,
  });
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveRef = useRef(false);
  const saveControllerRef = useRef<AbortController | null>(null);
  const authorityKeyRef = useRef(authorityKey);
  const previousAuthorityRef = useRef<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: securitySettingsKey,
    queryFn: ({ signal }) => getSecuritySettings({ signal }),
    enabled: securitySettingsEnabled,
    staleTime: STALE.detail,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    authorityKeyRef.current = authorityKey;
    const previous = previousAuthorityRef.current;
    if (previous && previous !== authorityKey) {
      saveControllerRef.current?.abort();
      saveControllerRef.current = null;
      saveRef.current = false;
      setSaving(false);
      setSettingsDirty(false);
      setSaveError(null);
      setSettings({
        require_2fa_for_admins: false,
        require_2fa_for_all: false,
        allow_trusted_devices: true,
        sso_provider: "",
        sso_metadata_url: "",
        session_max_minutes: null,
      });
      void queryClient.cancelQueries({
        predicate: (query) => query.queryKey.includes(previous),
      });
      queryClient.removeQueries({
        predicate: (query) => query.queryKey.includes(previous),
      });
    }
    previousAuthorityRef.current =
      authorityKey === "unverified" ? null : authorityKey;
  }, [authorityKey, queryClient]);

  useEffect(() => {
    if (settingsDirty || !settingsQuery.data) return;
    setSettings(settingsQuery.data);
  }, [settingsDirty, settingsQuery.data]);

  useEffect(() => {
    if (!settingsQuery.isError) return;
    toast.error(
      settingsQuery.error instanceof Error
        ? settingsQuery.error.message
        : "Could not load security settings — this is a failed request, so the values shown are not your saved policy.",
    );
  }, [settingsQuery.isError, settingsQuery.error]);

  const loading =
    identityLoading || (settingsQuery.isPending && !settingsQuery.data);

  useUnsavedChangesGuard(settingsDirty);

  // Latest settings, readable after an await — see save().
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(
    () => () => {
      saveControllerRef.current?.abort();
      saveControllerRef.current = null;
      saveRef.current = false;
    },
    [],
  );

  const patchSettings = (patch: Partial<SecuritySettings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    setSettingsDirty(
      !settingsQuery.data || !securitySettingsEqual(next, settingsQuery.data),
    );
    setSaveError(null);
  };

  const save = async () => {
    if (
      !identity ||
      !canAdmin ||
      !settingsQuery.data ||
      settingsQuery.isError ||
      saveRef.current
    )
      return;
    if (online === "offline") {
      setSaveError("Reconnect before saving workspace security policy.");
      return;
    }
    if (
      settings.session_max_minutes != null &&
      (!Number.isInteger(settings.session_max_minutes) ||
        settings.session_max_minutes < 1 ||
        settings.session_max_minutes > 43_200)
    ) {
      setSaveError(
        "Session timeout must be a whole number from 1 to 43,200 minutes, or blank.",
      );
      return;
    }
    const openedAuthorityKey = authorityKey;
    const intent: SecuritySettings = Object.freeze({
      require_2fa_for_admins: settings.require_2fa_for_admins,
      require_2fa_for_all: settings.require_2fa_for_all,
      allow_trusted_devices: settings.allow_trusted_devices !== false,
      sso_provider: (settings.sso_provider ?? "").trim(),
      sso_metadata_url: (settings.sso_metadata_url ?? "").trim(),
      session_max_minutes: settings.session_max_minutes ?? null,
    });
    const controller = new AbortController();
    saveRef.current = true;
    saveControllerRef.current = controller;
    setSaving(true);
    setSaveError(null);
    // Keep the exact object that opened the operation so a future UI change
    // that permits editing during save still cannot erase a newer edit.
    const sent = settings;
    try {
      // Send the COMPLETE settings state. The backend PUT is a full replace
      // (INSERT…ON CONFLICT sets every column), so omitting sso_provider /
      // sso_metadata_url / session_max_minutes silently wiped them on every
      // save (SETC-038 / SETC-039 + the PATCH-replace footgun).
      await queryClient.cancelQueries({
        queryKey: securitySettingsKey,
        exact: true,
      });
      await verifyFreshAdminAuthority(identity, controller.signal);
      if (authorityKeyRef.current !== openedAuthorityKey) return;
      const updated = await updateSecuritySettings(intent, {
        signal: controller.signal,
        idempotencyKey: newUUIDv7(),
      });
      let readback: SecuritySettings | null = null;
      try {
        readback = await getSecuritySettings({ signal: controller.signal });
      } catch {
        // The write receipt still proves the mutation. Keep its authoritative
        // echo, invalidate the scoped query, and state that verification did
        // not complete instead of reporting the whole save as failed.
      }
      if (authorityKeyRef.current !== openedAuthorityKey) return;
      const resolved = readback ?? updated;
      // Writing the echo back unconditionally reverted a toggle flipped while
      // the request was open, and clearing the dirty flag hid the loss.
      if (settingsRef.current === sent) {
        setSettings(resolved);
        setSettingsDirty(false);
      }
      queryClient.setQueryData(securitySettingsKey, resolved);
      toast.success("Security settings saved.");
      if (!readback || !securitySettingsEqual(intent, readback)) {
        void queryClient.invalidateQueries({
          queryKey: securitySettingsKey,
          exact: true,
        });
        toast.warning(
          "The policy write was accepted, but its live readback could not be reconciled. Refresh before relying on the displayed values.",
        );
      }
    } catch (err) {
      if (
        controller.signal.aborted ||
        authorityKeyRef.current !== openedAuthorityKey
      ) {
        return;
      }
      const msg =
        err instanceof Error ? err.message : "Could not save settings.";
      setSaveError(msg);
      toast.error(msg);
    } finally {
      if (saveControllerRef.current === controller) {
        saveControllerRef.current = null;
        saveRef.current = false;
        setSaving(false);
      }
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <TotpEnrollmentCard />

      <PasskeysCard />

      <IdentityProviderCard />

      {identityError ? (
        <Card>
          <CardContent className="space-y-3 p-5">
            <p role="alert" className="text-sm text-destructive">
              Security administration access could not be verified. No admin
              policy or SCIM data was requested.
            </p>
            <Button
              type="button"
              variant="outline"
              loading={retryingIdentity}
              onClick={retryIdentity}
            >
              {retryingIdentity ? "Retrying…" : "Retry identity"}
            </Button>
          </CardContent>
        </Card>
      ) : canAdmin && settingsQuery.isError ? (
        <Card>
          <CardContent className="space-y-3 p-5">
            <p role="alert" className="text-sm text-destructive">
              Security policy could not be loaded. The fallback values are not
              editable and no save can be attempted without an authoritative
              baseline.
            </p>
            <Button
              type="button"
              variant="outline"
              loading={settingsQuery.isFetching}
              disabled={online === "offline"}
              onClick={() => void settingsQuery.refetch()}
            >
              {settingsQuery.isFetching ? "Retrying…" : "Retry policy"}
            </Button>
          </CardContent>
        </Card>
      ) : canAdmin ? (
        <SecurityPolicySettingsCard
          loading={loading}
          saving={saving}
          dirty={settingsDirty}
          settings={settings}
          onPatch={patchSettings}
          onSave={save}
          unavailable={online === "offline"}
        />
      ) : identityLoading ? (
        <ActiveDevicesFallback />
      ) : (
        <Card>
          <CardContent className="p-5 text-sm text-muted-foreground">
            Security policy and SCIM administration require an owner or
            administrator role and are unavailable in viewer mode.
          </CardContent>
        </Card>
      )}

      {saveError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
        >
          {saveError}
        </div>
      ) : null}

      <ActiveDevices />
      <TrustedDevices />

      <SecurityActivityCard />

      {canAdmin ? <ScimAdminSection key={authorityKey} /> : null}
    </div>
  );
}

function securitySettingsEqual(
  expected: SecuritySettings,
  actual: SecuritySettings,
): boolean {
  const text = (value: string | null | undefined) => (value ?? "").trim();
  return (
    expected.require_2fa_for_admins === actual.require_2fa_for_admins &&
    expected.require_2fa_for_all === actual.require_2fa_for_all &&
    (expected.allow_trusted_devices !== false) ===
      (actual.allow_trusted_devices !== false) &&
    text(expected.sso_provider) === text(actual.sso_provider) &&
    text(expected.sso_metadata_url) === text(actual.sso_metadata_url) &&
    (expected.session_max_minutes ?? null) ===
      (actual.session_max_minutes ?? null)
  );
}

function ActiveDevicesFallback() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </CardContent>
    </Card>
  );
}
