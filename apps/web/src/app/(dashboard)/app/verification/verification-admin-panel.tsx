// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";
import {
  deleteVerificationProvider,
  getVerificationPolicy,
  getVerificationProviders,
  sameVerificationPolicyRevision,
  sameVerificationProviderRevision,
  saveVerificationPolicy,
  saveVerificationProvider,
  type VerificationMode,
  type VerificationPolicyValue,
  type VerificationProvider,
  type VerificationProviderConfig,
  type VerificationProviderSettings,
  type VerificationStatus,
} from "@/lib/verification-api";

const REMOVE_PROVIDER_TOKEN = "REMOVE PROVIDER";
const SAVE_POLICY_TOKEN = "SAVE POLICY";
const CREDENTIAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

function providerLabel(provider: VerificationProvider): string {
  return provider === "zerobounce" ? "ZeroBounce" : "Kickbox";
}

function modeLabel(mode: VerificationMode): string {
  if (mode === "off") return "Off";
  if (mode === "local") return "Local checks";
  return "Full provider verification";
}

function statusLabel(status: VerificationStatus): string {
  return status.replaceAll("_", " ");
}

function sameProviderSet(
  left: readonly VerificationProviderConfig[],
  right: readonly VerificationProviderConfig[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry) =>
      sameVerificationProviderRevision(
        entry,
        right.find((candidate) => candidate.provider === entry.provider),
      ),
    )
  );
}

function normalizedSettings(input: {
  ipAddress: string;
  cacheTtl: string;
  degradeOnFailure: boolean;
}): VerificationProviderSettings {
  const ttl = input.cacheTtl.trim() ? Number(input.cacheTtl) : 0;
  return {
    ...(input.ipAddress.trim() ? { ip_address: input.ipAddress.trim() } : {}),
    ...(input.degradeOnFailure ? { degrade_on_failure: true } : {}),
    ...(ttl > 0 ? { cache_ttl_days: ttl } : {}),
  };
}

function settingsEqual(
  left: VerificationProviderSettings,
  right: VerificationProviderSettings,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface VerificationAdminPanelProps {
  identity: MeResponse;
  queryKeyBase: readonly unknown[];
}

export function VerificationAdminPanel({
  identity,
  queryKeyBase,
}: VerificationAdminPanelProps) {
  const role = effectiveAuthRole(identity);
  const canAdmin = roleCanWrite(role) && !identity.viewer_mode;

  if (!canAdmin) {
    return (
      <>
        <section
          aria-labelledby="v-providers-access"
          className="rounded-lg border p-4 sm:p-6"
        >
          <h2 id="v-providers-access" className="text-base font-medium">
            Providers
          </h2>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            Admin-only. Provider configuration is hidden for your current role
            or viewer mode.
          </p>
        </section>
        <section
          aria-labelledby="v-policy-access"
          className="rounded-lg border p-4 sm:p-6"
        >
          <h2 id="v-policy-access" className="text-base font-medium">
            Policy
          </h2>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            Admin-only. Verification enforcement policy is hidden for your
            current role or viewer mode.
          </p>
        </section>
      </>
    );
  }

  return (
    <>
      <ProviderControl
        identity={identity}
        queryKey={[...queryKeyBase, "providers"]}
      />
      <PolicyControl
        identity={identity}
        queryKey={[...queryKeyBase, "policy"]}
        providerQueryKey={[...queryKeyBase, "providers"]}
      />
    </>
  );
}

function ProviderControl({
  identity,
  queryKey,
}: {
  identity: MeResponse;
  queryKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getVerificationProviders({ signal }),
    staleTime: STALE.detail,
    retry: false,
  });
  const credentialId = useId();
  const ipId = useId();
  const ttlId = useId();
  const providerId = useId();
  const enabledId = useId();
  const degradeId = useId();
  const validationId = useId();
  const [selected, setSelected] = useState<VerificationProvider>("zerobounce");
  const [reviewedRows, setReviewedRows] = useState<
    VerificationProviderConfig[] | null
  >(null);
  const [reviewed, setReviewed] = useState<VerificationProviderConfig | null>(
    null,
  );
  const [credentialRef, setCredentialRef] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [ipAddress, setIpAddress] = useState("");
  const [cacheTtl, setCacheTtl] = useState("");
  const [degradeOnFailure, setDegradeOnFailure] = useState(false);
  // Validation waits for the reader: it appears once they leave one of the
  // text fields or change a checkbox. An unconfigured provider opens with an
  // empty credential reference, and flagging that on arrival reads as a
  // mistake they made. Reset whenever a provider row is adopted.
  const [touched, setTouched] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<VerificationProvider | null>(
    null,
  );
  const [saveConfirming, setSaveConfirming] = useState(false);
  const [removeConfirming, setRemoveConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const active = useRef(true);

  const draftSettings = useMemo(
    () => normalizedSettings({ ipAddress, cacheTtl, degradeOnFailure }),
    [cacheTtl, degradeOnFailure, ipAddress],
  );
  const dirty =
    reviewedRows !== null &&
    (credentialRef !== (reviewed?.credential_ref ?? "") ||
      enabled !== (reviewed?.enabled ?? true) ||
      !settingsEqual(draftSettings, reviewed?.settings ?? {}));
  const ttlNumber = cacheTtl.trim() ? Number(cacheTtl) : 0;
  const validationError = !CREDENTIAL_REF_PATTERN.test(credentialRef.trim())
    ? "Enter an opaque tenant-local credential reference (1–128 letters, digits, dots, dashes, or underscores)."
    : cacheTtl.trim() &&
        (!Number.isSafeInteger(ttlNumber) || ttlNumber < 0 || ttlNumber > 180)
      ? "Cache TTL must be a whole number from 0 to 180 days. Leave it blank for the server default."
      : ipAddress.length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(ipAddress)
        ? "Provider IP must be at most 64 characters with no control characters."
        : null;
  const shownValidationError = touched ? validationError : null;

  function adopt(
    provider: VerificationProvider,
    rows: readonly VerificationProviderConfig[],
  ): void {
    const row = rows.find((entry) => entry.provider === provider) ?? null;
    setSelected(provider);
    setReviewedRows(rows.map((entry) => ({ ...entry })));
    setReviewed(row);
    setCredentialRef(row?.credential_ref ?? "");
    setEnabled(row?.enabled ?? true);
    setIpAddress(row?.settings?.ip_address ?? "");
    setCacheTtl(
      typeof row?.settings.cache_ttl_days === "number"
        ? String(row.settings.cache_ttl_days)
        : "",
    );
    setDegradeOnFailure(row?.settings?.degrade_on_failure ?? false);
    setTouched(false);
    setError(null);
  }

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      operation.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!query.data || pending) return;
    if (reviewedRows === null || !dirty) {
      adopt(selected, query.data.providers);
    }
    // `dirty` intentionally freezes the reviewed server revision. A later
    // query refresh is checked during preflight instead of overwriting a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, pending]);

  useEffect(() => {
    if (!dirty || pending) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "Unsaved verification provider changes will be lost.";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, pending]);

  function requestSelection(next: VerificationProvider): void {
    if (next === selected || !query.data) return;
    if (dirty) setSwitchTarget(next);
    else adopt(next, query.data.providers);
  }

  async function save(): Promise<void> {
    if (pending || validationError || !dirty || reviewedRows === null) {
      return;
    }
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      const before = await getVerificationProviders({
        signal: controller.signal,
        fresh: true,
      });
      if (!sameProviderSet(reviewedRows, before.providers)) {
        queryClient.setQueryData(queryKey, before);
        throw new Error(
          "Provider configuration changed after this form opened. Review the latest server state before saving.",
        );
      }
      const receipt = await saveVerificationProvider(
        selected,
        {
          credential_ref: credentialRef,
          enabled,
          settings: draftSettings,
        },
        controller.signal,
      );
      if (
        receipt.provider !== selected ||
        receipt.credential_ref !== credentialRef.trim() ||
        receipt.enabled !== enabled ||
        !settingsEqual(receipt.settings, draftSettings)
      ) {
        throw new Error(
          "The provider receipt did not match the requested configuration.",
        );
      }
      const after = await getVerificationProviders({
        signal: controller.signal,
        fresh: true,
      });
      const confirmed = after.providers.find(
        (entry) => entry.provider === selected,
      );
      if (
        !confirmed ||
        confirmed.credential_ref !== credentialRef.trim() ||
        confirmed.enabled !== enabled ||
        !settingsEqual(confirmed.settings, draftSettings) ||
        (enabled &&
          after.providers.some(
            (entry) => entry.provider !== selected && entry.enabled,
          ))
      ) {
        throw new Error(
          "The provider write returned, but a fresh read did not confirm the requested state.",
        );
      }
      queryClient.setQueryData(queryKey, after);
      adopt(selected, after.providers);
      setSaveConfirming(false);
      setSuccess(
        "Provider configuration was saved and confirmed by a fresh server read.",
      );
    } catch (caught) {
      if (!controller.signal.aborted && active.current) {
        setError(
          apiErrorMessage(caught, "Could not save the verification provider."),
        );
        void query.refetch();
        throw caught;
      }
    } finally {
      if (active.current && operation.current === controller) setPending(false);
      if (operation.current === controller) operation.current = null;
    }
  }

  async function remove(): Promise<void> {
    if (pending || !reviewed || reviewedRows === null) return;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      const before = await getVerificationProviders({
        signal: controller.signal,
        fresh: true,
      });
      if (!sameProviderSet(reviewedRows, before.providers)) {
        queryClient.setQueryData(queryKey, before);
        throw new Error(
          "Provider configuration changed after removal was opened. Review the latest server state.",
        );
      }
      await deleteVerificationProvider(selected, controller.signal);
      const after = await getVerificationProviders({
        signal: controller.signal,
        fresh: true,
      });
      if (after.providers.some((entry) => entry.provider === selected)) {
        throw new Error(
          "A fresh server read did not confirm provider removal.",
        );
      }
      queryClient.setQueryData(queryKey, after);
      adopt(selected, after.providers);
      setRemoveConfirming(false);
      setSuccess(
        "Provider configuration was removed. Existing verification results remain cached; provider-side credentials were not deleted.",
      );
    } catch (caught) {
      if (!controller.signal.aborted && active.current) {
        setError(
          apiErrorMessage(
            caught,
            "Could not remove the verification provider.",
          ),
        );
        void query.refetch();
        throw caught;
      }
    } finally {
      if (active.current && operation.current === controller) setPending(false);
      if (operation.current === controller) operation.current = null;
    }
  }

  return (
    <section
      aria-labelledby="v-providers"
      className="rounded-lg border p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="v-providers" className="text-base font-medium">
            Providers
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Configure a tenant-local credential reference; never paste an API
            key. Saving performs a live vendor balance probe before the server
            changes the active configuration and can take up to 45 seconds.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={query.isFetching || pending}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? "Refreshing…" : "Refresh providers"}
        </Button>
      </div>

      {query.isPending && !query.data ? (
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          Loading provider configuration…
        </p>
      ) : query.isError && !query.data ? (
        <Alert variant="destructive" className="mt-4">
          <AlertTitle>Provider configuration unavailable</AlertTitle>
          <AlertDescription>
            {apiErrorMessage(
              query.error,
              "The server provider state could not be verified.",
            )}
          </AlertDescription>
        </Alert>
      ) : query.data ? (
        <div className="mt-5 space-y-5">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Provider change not confirmed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {success ? (
            <Alert>
              <AlertTitle>Provider state confirmed</AlertTitle>
              <AlertDescription>{success}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={providerId}>Provider</Label>
              <Select
                id={providerId}
                value={selected}
                disabled={pending}
                onChange={(event) =>
                  requestSelection(event.target.value as VerificationProvider)
                }
              >
                {query.data.available.map((entry) => (
                  <option key={entry} value={entry}>
                    {providerLabel(entry)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={credentialId}>Credential reference</Label>
              <Input
                id={credentialId}
                value={credentialRef}
                maxLength={128}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={
                  shownValidationError?.startsWith("Enter") ? true : undefined
                }
                aria-describedby={
                  shownValidationError?.startsWith("Enter")
                    ? validationId
                    : undefined
                }
                disabled={pending}
                placeholder="verification-prod"
                onBlur={() => setTouched(true)}
                onChange={(event) => setCredentialRef(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Opaque ID only. The server derives the tenant/provider secret
                path; the browser never reads or writes the credential itself.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={ipId}>ZeroBounce request IP (optional)</Label>
              <Input
                id={ipId}
                value={ipAddress}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                disabled={pending || selected !== "zerobounce"}
                placeholder="203.0.113.10"
                aria-invalid={
                  shownValidationError?.startsWith("Provider IP")
                    ? true
                    : undefined
                }
                aria-describedby={
                  shownValidationError?.startsWith("Provider IP")
                    ? validationId
                    : undefined
                }
                onBlur={() => setTouched(true)}
                onChange={(event) => setIpAddress(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={ttlId}>Cache TTL days</Label>
              <Input
                id={ttlId}
                type="number"
                inputMode="numeric"
                min={0}
                max={180}
                step={1}
                value={cacheTtl}
                disabled={pending}
                placeholder="Server default"
                aria-invalid={
                  shownValidationError?.startsWith("Cache TTL")
                    ? true
                    : undefined
                }
                aria-describedby={
                  shownValidationError?.startsWith("Cache TTL")
                    ? validationId
                    : undefined
                }
                onBlur={() => setTouched(true)}
                onChange={(event) => setCacheTtl(event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
              <Checkbox
                id={enabledId}
                checked={enabled}
                disabled={pending}
                onChange={(event) => {
                  setTouched(true);
                  setEnabled(event.target.checked);
                }}
              />
              <span>
                <span className="font-medium">Enable provider</span>
                <span className="mt-1 block text-muted-foreground">
                  Enabling this provider atomically disables any other enabled
                  verification provider.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
              <Checkbox
                id={degradeId}
                checked={degradeOnFailure}
                disabled={pending}
                onChange={(event) => {
                  setTouched(true);
                  setDegradeOnFailure(event.target.checked);
                }}
              />
              <span>
                <span className="font-medium">Degrade bulk runs locally</span>
                <span className="mt-1 block text-muted-foreground">
                  On vendor failure, bulk checks can fall back to local
                  evidence. This does not make a mailbox verdict “valid.”
                </span>
              </span>
            </label>
          </div>

          {shownValidationError ? (
            <p
              id={validationId}
              role="alert"
              className="text-sm text-destructive"
            >
              {shownValidationError}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={pending || !dirty || Boolean(validationError)}
              onClick={() => setSaveConfirming(true)}
            >
              {pending
                ? "Working…"
                : reviewed
                  ? "Save provider"
                  : "Configure provider"}
            </Button>
            {reviewed ? (
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={() => setRemoveConfirming(true)}
              >
                Remove provider
              </Button>
            ) : null}
            {dirty ? (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => adopt(selected, reviewedRows ?? [])}
              >
                Discard changes
              </Button>
            ) : null}
          </div>

          <div className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
            <p>
              Current state: {reviewed ? "configured" : "not configured"}
              {reviewed
                ? reviewed.enabled
                  ? " and enabled"
                  : " but disabled"
                : ""}
              .
              {reviewed?.last_balance !== undefined
                ? ` Last observed balance: ${reviewed.last_balance === -1 ? "unmetered" : reviewed.last_balance.toLocaleString()}.`
                : ""}
            </p>
            {reviewed?.has_error ? (
              <p className="mt-1 text-destructive">
                The server recorded a sanitized provider connection error.
              </p>
            ) : null}
            {reviewed?.updated_at ? (
              <p className="mt-1">
                Last server update:{" "}
                {formatWireTimestamp(reviewed.updated_at, "unknown")}.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={saveConfirming}
        onOpenChange={setSaveConfirming}
        title="Save verification provider?"
        description={
          <span>
            The server will resolve the opaque credential reference and make a
            live balance request to {providerLabel(selected)} before committing.
            A rejected or unavailable proposed credential leaves the previous
            provider unchanged. This read/then-write API has no ETag, so a small
            time-of-check/time-of-use window remains after the fresh preflight.
          </span>
        }
        confirmLabel="Save and probe"
        confirmVariant="default"
        onConfirm={save}
      />
      <ConfirmDialog
        open={removeConfirming}
        onOpenChange={setRemoveConfirming}
        title={`Remove ${providerLabel(selected)}?`}
        description={
          <span>
            Future full verification will have no vendor unless another provider
            is enabled. Full forms then fail open as degraded after local
            checks; full confirmed imports fail closed. Existing cached verdicts
            and the provider-side credential are not deleted.
          </span>
        }
        confirmLabel="Remove provider"
        confirmationToken={REMOVE_PROVIDER_TOKEN}
        onConfirm={remove}
      />
      <ConfirmDialog
        open={switchTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSwitchTarget(null);
        }}
        title="Discard provider changes?"
        description="Switching providers discards this unsaved provider draft."
        confirmLabel="Discard and switch"
        onConfirm={() => {
          if (switchTarget && query.data) {
            adopt(switchTarget, query.data.providers);
          }
          setSwitchTarget(null);
        }}
      />
    </section>
  );
}

function PolicyControl({
  identity,
  queryKey,
  providerQueryKey,
}: {
  identity: MeResponse;
  queryKey: readonly unknown[];
  providerQueryKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getVerificationPolicy({ signal }),
    staleTime: STALE.detail,
    retry: false,
  });
  const providerQuery = useQuery({
    queryKey: providerQueryKey,
    queryFn: ({ signal }) => getVerificationProviders({ signal }),
    staleTime: STALE.detail,
    retry: false,
  });
  const formsModeId = useId();
  const importModeId = useId();
  const typoId = useId();
  const [reviewed, setReviewed] = useState<VerificationPolicyValue | null>(
    null,
  );
  const [formsMode, setFormsMode] = useState<VerificationMode>("off");
  const [importMode, setImportMode] = useState<VerificationMode>("off");
  const [rejectStatuses, setRejectStatuses] = useState<VerificationStatus[]>(
    [],
  );
  const [suggestTypos, setSuggestTypos] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [serverWarning, setServerWarning] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const active = useRef(true);

  const draft: Omit<VerificationPolicyValue, "updated_at"> = useMemo(
    () => ({
      forms_mode: formsMode,
      forms_reject_statuses: rejectStatuses,
      forms_suggest_typos: suggestTypos,
      import_mode: importMode,
    }),
    [formsMode, importMode, rejectStatuses, suggestTypos],
  );
  const dirty =
    reviewed !== null &&
    (reviewed.forms_mode !== formsMode ||
      reviewed.import_mode !== importMode ||
      reviewed.forms_suggest_typos !== suggestTypos ||
      reviewed.forms_reject_statuses.length !== rejectStatuses.length ||
      reviewed.forms_reject_statuses.some(
        (entry, index) => entry !== rejectStatuses[index],
      ));
  const riskyReject = rejectStatuses.some(
    (entry) => entry === "catch_all" || entry === "unknown",
  );
  const fullMode = formsMode === "full" || importMode === "full";
  const enabledProvider = providerQuery.data?.providers?.some(
    (entry) => entry.enabled,
  );

  function adopt(policy: VerificationPolicyValue): void {
    setReviewed(policy);
    setFormsMode(policy.forms_mode);
    setImportMode(policy.import_mode);
    setRejectStatuses([...policy.forms_reject_statuses]);
    setSuggestTypos(policy.forms_suggest_typos);
    setError(null);
  }

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      operation.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!query.data || pending) return;
    if (reviewed === null || !dirty) adopt(query.data.policy);
    // Preserve a dirty draft; the save preflight compares its reviewed revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, pending]);

  useEffect(() => {
    if (!dirty || pending) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "Unsaved verification policy changes will be lost.";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, pending]);

  function toggleStatus(status: VerificationStatus, checked: boolean): void {
    if (!query.data) return;
    const next = checked
      ? [...new Set([...rejectStatuses, status])]
      : rejectStatuses.filter((entry) => entry !== status);
    const ordered = next.sort(
      (left, right) =>
        query.data.rejectable_statuses.indexOf(left) -
        query.data.rejectable_statuses.indexOf(right),
    );
    setRejectStatuses(ordered);
  }

  async function save(): Promise<void> {
    if (pending || !dirty || !reviewed || rejectStatuses.length === 0) return;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setPending(true);
    setError(null);
    setSuccess(null);
    setServerWarning(null);
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      const before = await getVerificationPolicy({
        signal: controller.signal,
        fresh: true,
      });
      if (!sameVerificationPolicyRevision(reviewed, before.policy)) {
        queryClient.setQueryData(queryKey, before);
        throw new Error(
          "Verification policy changed after this form opened. Review the latest server state before saving.",
        );
      }
      const receipt = await saveVerificationPolicy(draft, controller.signal);
      if (!samePolicyState(receipt.policy, draft)) {
        throw new Error(
          "The policy receipt did not match the requested state.",
        );
      }
      const after = await getVerificationPolicy({
        signal: controller.signal,
        fresh: true,
      });
      if (!samePolicyState(after.policy, draft)) {
        throw new Error(
          "The policy write returned, but a fresh read did not confirm the requested state.",
        );
      }
      queryClient.setQueryData(queryKey, after);
      adopt(after.policy);
      setServerWarning(receipt.warning ?? null);
      setConfirming(false);
      setSuccess(
        "Verification policy was saved and confirmed by a fresh read.",
      );
    } catch (caught) {
      if (!controller.signal.aborted && active.current) {
        setError(
          apiErrorMessage(caught, "Could not save the verification policy."),
        );
        void query.refetch();
        throw caught;
      }
    } finally {
      if (active.current && operation.current === controller) setPending(false);
      if (operation.current === controller) operation.current = null;
    }
  }

  return (
    <section
      aria-labelledby="v-policy"
      className="rounded-lg border p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="v-policy" className="text-base font-medium">
            Policy
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Choose where verification is enforced. Local checks can disprove an
            address but cannot prove a mailbox valid; full mode can spend one
            provider credit for each locally undecided address.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={query.isFetching || pending}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? "Refreshing…" : "Refresh policy"}
        </Button>
      </div>

      {query.isPending && !query.data ? (
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          Loading policy…
        </p>
      ) : query.isError && !query.data ? (
        <Alert variant="destructive" className="mt-4">
          <AlertTitle>Policy unavailable</AlertTitle>
          <AlertDescription>
            {apiErrorMessage(
              query.error,
              "The enforcement policy could not be verified.",
            )}
          </AlertDescription>
        </Alert>
      ) : query.data ? (
        <div className="mt-5 space-y-5">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Policy change not confirmed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {success ? (
            <Alert>
              <AlertTitle>Policy state confirmed</AlertTitle>
              <AlertDescription>{success}</AlertDescription>
            </Alert>
          ) : null}
          {serverWarning ? (
            <Alert variant="warning">
              <AlertTitle>Server warning</AlertTitle>
              <AlertDescription>{serverWarning}</AlertDescription>
            </Alert>
          ) : null}
          {fullMode && providerQuery.isSuccess && !enabledProvider ? (
            <Alert variant="warning">
              <AlertTitle>Full mode has no enabled provider</AlertTitle>
              <AlertDescription>
                Forms preserve availability by failing open as degraded after
                local checks. Confirmed imports fail closed before subscriber
                writes until a provider is enabled.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={formsModeId}>Public forms</Label>
              <Select
                id={formsModeId}
                value={formsMode}
                disabled={pending}
                onChange={(event) =>
                  setFormsMode(event.target.value as VerificationMode)
                }
              >
                {query.data.modes.map((entry) => (
                  <option key={entry} value={entry}>
                    {modeLabel(entry)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={importModeId}>Confirmed imports</Label>
              <Select
                id={importModeId}
                value={importMode}
                disabled={pending}
                onChange={(event) =>
                  setImportMode(event.target.value as VerificationMode)
                }
              >
                {query.data.modes.map((entry) => (
                  <option key={entry} value={entry}>
                    {modeLabel(entry)}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">
              Reject these form verdicts
            </legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {query.data.rejectable_statuses.map((entry) => (
                <label
                  key={entry}
                  className="flex items-center gap-2 rounded-md border p-3 text-sm capitalize"
                >
                  <Checkbox
                    checked={rejectStatuses.includes(entry)}
                    disabled={pending}
                    onChange={(event) =>
                      toggleStatus(entry, event.target.checked)
                    }
                  />
                  {statusLabel(entry)}
                </label>
              ))}
            </div>
            {rejectStatuses.length === 0 ? (
              <p role="alert" className="text-sm text-destructive">
                Keep at least one rejection status. The server defaults an empty
                set, so sending none would not mean “reject nothing.”
              </p>
            ) : null}
          </fieldset>

          <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
            <Checkbox
              id={typoId}
              checked={suggestTypos}
              disabled={pending}
              onChange={(event) => setSuggestTypos(event.target.checked)}
            />
            <span>
              <span className="font-medium">Suggest likely domain typos</span>
              <span className="mt-1 block text-muted-foreground">
                Advisory only. This does not rewrite the submitted address.
              </span>
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={pending || !dirty || rejectStatuses.length === 0}
              onClick={() => setConfirming(true)}
            >
              {pending ? "Saving…" : "Save policy"}
            </Button>
            {dirty ? (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => reviewed && adopt(reviewed)}
              >
                Discard changes
              </Button>
            ) : null}
            {reviewed?.updated_at ? (
              <span className="text-xs text-muted-foreground">
                Server update:{" "}
                {formatWireTimestamp(reviewed.updated_at, "unknown")}
              </span>
            ) : null}
          </div>

          <div
            className="flex flex-wrap gap-2"
            aria-label="Policy consequences"
          >
            <Badge variant={formsMode === "full" ? "warning" : "outline"}>
              Forms: {modeLabel(formsMode)}
            </Badge>
            <Badge variant={importMode === "full" ? "warning" : "outline"}>
              Imports: {modeLabel(importMode)}
            </Badge>
            {riskyReject ? (
              <Badge variant="warning">
                Catch-all/unknown rejection enabled
              </Badge>
            ) : null}
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Apply verification policy?"
        description={
          <span>
            This changes which public-form signups are refused and how confirmed
            imports are admitted. Full checks can spend provider credits.
            Rejecting catch-all or unknown verdicts can exclude legitimate B2B
            addresses. Type the confirmation phrase after reviewing these
            consequences. The API has no conditional-write token, so a small
            race remains after the fresh preflight.
          </span>
        }
        confirmLabel="Apply policy"
        confirmVariant="default"
        confirmationToken={SAVE_POLICY_TOKEN}
        onConfirm={save}
      />
    </section>
  );
}

function samePolicyState(
  actual: VerificationPolicyValue,
  expected: Omit<VerificationPolicyValue, "updated_at">,
): boolean {
  return (
    actual.forms_mode === expected.forms_mode &&
    actual.import_mode === expected.import_mode &&
    actual.forms_suggest_typos === expected.forms_suggest_typos &&
    actual.forms_reject_statuses.length ===
      expected.forms_reject_statuses.length &&
    actual.forms_reject_statuses.every(
      (entry, index) => entry === expected.forms_reject_statuses[index],
    )
  );
}
