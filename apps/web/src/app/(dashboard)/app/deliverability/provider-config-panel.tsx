// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { copyToClipboard } from "@/lib/clipboard";
import {
  buildProviderConfigInput,
  credentialReferenceError,
  DELIVERABILITY_PROVIDERS,
  deleteDeliverabilityProvider,
  generateWebhookToken,
  listDeliverabilityProviders,
  providerSecretState,
  providerSupportsSuppressionMirror,
  sameProviderRevision,
  saveDeliverabilityProvider,
  webhookTokenError,
  type DeliverabilityProvider,
  type DeliverabilityProviderConfig,
} from "@/lib/deliverability-admin-api";
import { STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

const REMOVE_TOKEN = "REMOVE PROVIDER";

export function ProviderConfigPanel({ identity }: { identity: MeResponse }) {
  const role = effectiveAuthRole(identity);
  const canWrite = roleCanWrite(role) && !identity.viewer_mode;
  const queryClient = useQueryClient();
  const queryKey = [
    "deliverability-admin",
    identity.tenant_id,
    role,
    "providers",
  ] as const;
  const providers = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const next = await listDeliverabilityProviders({ signal });
      assertTenantRows(next, identity.tenant_id);
      return next;
    },
    enabled: canWrite,
    staleTime: STALE.detail,
    retry: false,
  });
  const rows = useMemo(
    () => (Array.isArray(providers.data) ? providers.data : []),
    [providers.data],
  );

  const [provider, setProvider] = useState<DeliverabilityProvider>("sendgrid");
  const available = useMemo(
    () => rows.find((row) => row.provider === provider) ?? null,
    [provider, rows],
  );
  const [existing, setExisting] = useState<DeliverabilityProviderConfig | null>(
    null,
  );
  const [displayName, setDisplayName] = useState("");
  const [active, setActive] = useState(true);
  const [webhookToken, setWebhookToken] = useState("");
  const [credentialReference, setCredentialReference] = useState("");
  const [generated, setGenerated] = useState(false);
  const [storedAcknowledged, setStoredAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [switchTarget, setSwitchTarget] =
    useState<DeliverabilityProvider | null>(null);
  const [removeTarget, setRemoveTarget] =
    useState<DeliverabilityProviderConfig | null>(null);
  const operationRef = useRef(false);
  const activeRef = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);

  const supportsMirror = providerSupportsSuppressionMirror(provider);
  const secrets = providerSecretState(existing?.config ?? {});
  const dirty =
    displayName !== (existing?.display_name ?? "") ||
    active !== (existing?.active ?? true) ||
    webhookToken.length > 0 ||
    credentialReference.length > 0;
  const tokenError = webhookTokenError(webhookToken);
  const referenceError = supportsMirror
    ? credentialReferenceError(credentialReference)
    : null;
  useUnsavedChangesGuard(dirty && !saving);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (dirty || saving) return;
    if (
      existing?.id === available?.id &&
      existing?.updated_at === available?.updated_at
    ) {
      return;
    }
    setExisting(available);
    setDisplayName(available?.display_name ?? "");
    setActive(available?.active ?? true);
  }, [available, dirty, existing?.id, existing?.updated_at, saving]);

  function clearWriteOnlyDraft(): void {
    setWebhookToken("");
    setCredentialReference("");
    setGenerated(false);
    setStoredAcknowledged(false);
  }

  function adoptProvider(next: DeliverabilityProvider): void {
    const row = rows.find((candidate) => candidate.provider === next);
    clearWriteOnlyDraft();
    setProvider(next);
    setExisting(row ?? null);
    setDisplayName(row?.display_name ?? "");
    setActive(row?.active ?? true);
    setError(null);
    setSuccess(null);
  }

  async function save(): Promise<void> {
    if (!canWrite || operationRef.current || tokenError || referenceError)
      return;
    const hasStoredCredential =
      secrets.webhookTokenSet ||
      secrets.credentialRefSet ||
      secrets.legacyRawCredentialSet;
    if (
      !webhookToken.trim() &&
      !credentialReference.trim() &&
      !hasStoredCredential
    ) {
      setError(
        supportsMirror
          ? "Enter a webhook token or tenant-relative runtime-secret reference."
          : "Enter a webhook receiver token.",
      );
      return;
    }
    if (generated && !storedAcknowledged) {
      setError("Confirm that you stored the generated token before saving.");
      return;
    }
    if (displayName.trim().length > 160) {
      setError("Display name must be 160 characters or fewer.");
      return;
    }

    const reviewed = existing;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    operationRef.current = true;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      const before = await listDeliverabilityProviders({
        signal: controller.signal,
        fresh: true,
      });
      assertTenantRows(before, identity.tenant_id);
      const current = before.find((row) => row.provider === provider) ?? null;
      if (
        (reviewed && (!current || !sameProviderRevision(reviewed, current))) ||
        (!reviewed && current)
      ) {
        queryClient.setQueryData(queryKey, before);
        throw new Error(
          "This provider changed after the form opened. Review the latest server state before saving.",
        );
      }

      const saved = await saveDeliverabilityProvider(
        {
          provider,
          display_name: displayName.trim(),
          active,
          config: buildProviderConfigInput({
            webhookToken,
            credentialReference: supportsMirror ? credentialReference : "",
          }),
        },
        { id: reviewed?.id, signal: controller.signal },
      );
      if (
        saved.tenant_id !== identity.tenant_id ||
        saved.provider !== provider
      ) {
        throw new Error(
          "The provider receipt did not match this workspace and provider.",
        );
      }
      const after = await listDeliverabilityProviders({
        signal: controller.signal,
        fresh: true,
      });
      assertTenantRows(after, identity.tenant_id);
      const confirmed = after.find((row) => row.id === saved.id);
      const confirmedSecrets = providerSecretState(confirmed?.config ?? {});
      if (
        !confirmed ||
        confirmed.provider !== provider ||
        confirmed.display_name !== displayName.trim() ||
        confirmed.active !== active ||
        (webhookToken.trim() && !confirmedSecrets.webhookTokenSet) ||
        (credentialReference.trim() && !confirmedSecrets.credentialRefSet)
      ) {
        throw new Error(
          "The provider write returned, but a fresh read did not confirm the requested state.",
        );
      }
      queryClient.setQueryData(queryKey, after);
      setExisting(confirmed);
      clearWriteOnlyDraft();
      setDisplayName(confirmed.display_name);
      setActive(confirmed.active);
      setSuccess(
        "Provider configuration was saved and confirmed by a fresh server read.",
      );
      toast.success("Provider configuration saved.");
    } catch (caught) {
      if (!controller.signal.aborted && activeRef.current) {
        setError(
          apiErrorMessage(caught, "Could not save the provider configuration."),
        );
        void providers.refetch();
      }
    } finally {
      if (activeRef.current && controllerRef.current === controller) {
        operationRef.current = false;
        setSaving(false);
      }
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  async function remove(row: DeliverabilityProviderConfig): Promise<void> {
    if (!canWrite || operationRef.current) return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    operationRef.current = true;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      const before = await listDeliverabilityProviders({
        signal: controller.signal,
        fresh: true,
      });
      assertTenantRows(before, identity.tenant_id);
      const current = before.find((candidate) => candidate.id === row.id);
      if (!current || !sameProviderRevision(row, current)) {
        queryClient.setQueryData(queryKey, before);
        throw new Error(
          "This provider changed after removal was opened. Review the latest state.",
        );
      }
      await deleteDeliverabilityProvider(row.id, controller.signal);
      const after = await listDeliverabilityProviders({
        signal: controller.signal,
        fresh: true,
      });
      assertTenantRows(after, identity.tenant_id);
      if (after.some((candidate) => candidate.id === row.id)) {
        throw new Error("A fresh read did not confirm provider removal.");
      }
      queryClient.setQueryData(queryKey, after);
      if (provider === row.provider) {
        setExisting(null);
        clearWriteOnlyDraft();
        setDisplayName("");
        setActive(true);
      }
      setRemoveTarget(null);
      setSuccess(
        "Provider configuration removed. Provider-side webhooks and credentials were not changed.",
      );
      toast.success("Provider configuration removed.");
    } catch (caught) {
      if (!controller.signal.aborted && activeRef.current) {
        setError(
          apiErrorMessage(
            caught,
            "Could not remove the provider configuration.",
          ),
        );
        void providers.refetch();
        throw caught;
      }
    } finally {
      if (activeRef.current && controllerRef.current === controller) {
        operationRef.current = false;
        setSaving(false);
      }
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  if (!canWrite) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h2">Deliverability providers</CardTitle>
          <CardDescription>
            Provider connection state and write-only credentials are
            admin-scoped.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertTitle>Owner or admin access required</AlertTitle>
            <AlertDescription>
              This page does not request provider configuration for the current
              effective role.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card aria-labelledby="deliverability-provider-title">
      <CardHeader>
        <CardTitle as="h2" id="deliverability-provider-title">
          Deliverability providers
        </CardTitle>
        <CardDescription>
          Configure authenticated inbound event receivers and, where supported,
          a tenant-bound secret reference for suppression mirroring. Raw sending
          credentials are rejected and never stored here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {providers.isPending && !providers.data ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading provider configuration…
          </p>
        ) : providers.isError && !providers.data ? (
          <Alert variant="destructive">
            <AlertTitle>Provider state unavailable</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                {apiErrorMessage(
                  providers.error,
                  "Provider state could not be verified.",
                )}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={providers.isFetching}
                onClick={() => void providers.refetch()}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="deliverability-provider-kind">Provider</Label>
                <Select
                  id="deliverability-provider-kind"
                  value={provider}
                  disabled={saving}
                  onChange={(event) => {
                    const next = event.target.value as DeliverabilityProvider;
                    if (dirty) setSwitchTarget(next);
                    else adoptProvider(next);
                  }}
                >
                  {DELIVERABILITY_PROVIDERS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="deliverability-provider-label">
                  Display name
                </Label>
                <Input
                  id="deliverability-provider-label"
                  value={displayName}
                  maxLength={160}
                  disabled={saving}
                  placeholder="Production"
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="deliverability-provider-webhook-token">
                Webhook receiver token
              </Label>
              <Input
                id="deliverability-provider-webhook-token"
                type="password"
                autoComplete="new-password"
                value={webhookToken}
                maxLength={512}
                disabled={saving}
                aria-invalid={tokenError ? true : undefined}
                placeholder={
                  secrets.webhookTokenSet
                    ? "Leave blank to keep the current token"
                    : "Generate or enter at least 32 characters"
                }
                onChange={(event) => {
                  setWebhookToken(event.target.value);
                  setGenerated(false);
                  setStoredAcknowledged(false);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {secrets.webhookTokenSet
                  ? "A one-way token digest is configured. Its plaintext can never be read back."
                  : "Use the same high-entropy value at the provider or edge receiver."}
              </p>
              {tokenError ? (
                <p role="alert" className="text-sm text-destructive">
                  {tokenError}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  onClick={() => {
                    try {
                      setWebhookToken(generateWebhookToken());
                      setGenerated(true);
                      setStoredAcknowledged(false);
                      setError(null);
                    } catch (caught) {
                      setError(
                        apiErrorMessage(
                          caught,
                          "Secure token generation failed.",
                        ),
                      );
                    }
                  }}
                >
                  Generate 256-bit token
                </Button>
                {webhookToken ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={saving}
                    onClick={async () => {
                      const result = await copyToClipboard(webhookToken);
                      if (result === "copied") {
                        setStoredAcknowledged(true);
                        toast.success("Token copied. Store it before saving.");
                      } else {
                        setError(
                          result === "unavailable"
                            ? "Clipboard access is unavailable. Select and store the token manually."
                            : "The browser refused clipboard access.",
                        );
                      }
                    }}
                  >
                    Copy token
                  </Button>
                ) : null}
              </div>
              {generated ? (
                <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
                  <Checkbox
                    checked={storedAcknowledged}
                    disabled={saving}
                    onChange={(event) =>
                      setStoredAcknowledged(event.target.checked)
                    }
                  />
                  <span>
                    I stored this generated token securely. It will be cleared
                    from this form after the server confirms the write.
                  </span>
                </label>
              ) : null}
            </div>

            {supportsMirror ? (
              <div className="space-y-2">
                <Label htmlFor="deliverability-provider-credential-ref">
                  Runtime-secret reference
                </Label>
                <Input
                  id="deliverability-provider-credential-ref"
                  value={credentialReference}
                  maxLength={512}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={saving}
                  aria-invalid={referenceError ? true : undefined}
                  placeholder={
                    secrets.credentialRefSet
                      ? "Leave blank to keep the current reference"
                      : `deliverability/${provider}`
                  }
                  onChange={(event) =>
                    setCredentialReference(event.target.value)
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Tenant-relative vault name only. Never paste an API key into
                  this field.
                </p>
                {referenceError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {referenceError}
                  </p>
                ) : null}
              </div>
            ) : null}

            <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
              <Checkbox
                checked={active}
                disabled={saving}
                onChange={(event) => setActive(event.target.checked)}
              />
              <span>
                <strong className="block">Active provider connection</strong>
                Inactive rows retain their redacted configuration but are not
                treated as enabled.
              </span>
            </label>

            {secrets.legacyRawCredentialSet && !secrets.credentialRefSet ? (
              <Alert variant="warning">
                <AlertTitle>Legacy raw credential detected</AlertTitle>
                <AlertDescription>
                  Save a tenant-relative reference to migrate this row. The
                  server removes the legacy value once the reference is
                  accepted.
                </AlertDescription>
              </Alert>
            ) : null}
            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Provider change not confirmed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            {success ? (
              <p role="status" className="text-sm text-success-emphasis">
                {success}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={
                  !dirty || saving || Boolean(tokenError || referenceError)
                }
                loading={saving}
                onClick={() => void save()}
              >
                {existing ? "Save provider" : "Add provider"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={!dirty || saving}
                onClick={() => adoptProvider(provider)}
              >
                Discard changes
              </Button>
            </div>

            <div className="space-y-2 border-t pt-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium">Configured providers</h3>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={providers.isFetching || saving}
                  onClick={() => void providers.refetch()}
                >
                  {providers.isFetching ? "Refreshing…" : "Refresh"}
                </Button>
              </div>
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No provider configuration is stored.
                </p>
              ) : (
                <ul className="space-y-2">
                  {rows.map((row) => {
                    const state = providerSecretState(row.config);
                    return (
                      <li
                        key={row.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                      >
                        <div className="min-w-0 space-y-1">
                          <p className="font-medium">
                            {row.display_name || row.provider}{" "}
                            <span className="font-normal text-muted-foreground">
                              · {row.provider}
                            </span>
                          </p>
                          <div className="flex flex-wrap gap-1">
                            <Badge variant={row.active ? "success" : "outline"}>
                              {row.active ? "Active" : "Inactive"}
                            </Badge>
                            <Badge variant="outline">
                              Webhook{" "}
                              {state.webhookTokenSet ? "configured" : "not set"}
                            </Badge>
                            {providerSupportsSuppressionMirror(row.provider) ? (
                              <Badge variant="outline">
                                Mirror{" "}
                                {state.credentialRefSet
                                  ? "configured"
                                  : "not set"}
                              </Badge>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={saving}
                            onClick={() => {
                              if (dirty) {
                                setSwitchTarget(row.provider);
                              } else {
                                adoptProvider(row.provider);
                              }
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={saving}
                            onClick={() => setRemoveTarget(row)}
                          >
                            Remove
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={switchTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSwitchTarget(null);
        }}
        title="Discard this unsaved provider draft?"
        description="The label and write-only credential fields in this form have not been saved."
        confirmLabel="Discard and switch"
        onConfirm={() => {
          const next = switchTarget;
          if (next) adoptProvider(next);
          setSwitchTarget(null);
        }}
      />
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title="Remove this provider configuration?"
        description={
          <span>
            Moosewave will remove this workspace row. Provider-side webhooks,
            credentials, DNS, and other resources are not removed automatically.
          </span>
        }
        confirmLabel="Remove provider"
        confirmationToken={REMOVE_TOKEN}
        onConfirm={async () => {
          if (removeTarget) await remove(removeTarget);
        }}
      />
    </Card>
  );
}

function assertTenantRows(
  rows: DeliverabilityProviderConfig[],
  tenantId: string,
): void {
  if (rows.some((row) => row.tenant_id !== tenantId)) {
    throw new Error(
      "Provider response crossed the current workspace boundary.",
    );
  }
}
