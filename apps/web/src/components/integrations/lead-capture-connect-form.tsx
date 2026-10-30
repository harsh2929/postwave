// SPDX-License-Identifier: AGPL-3.0-only
//
// LeadCaptureConnectForm — save a managed lead-capture configuration
// (GET /api/v1/lead-integrations/providers, then POST /api/v1/lead-integrations).
// Desktop parity: NativeProviderConnectModals LeadConnectModal "Save
// configuration". Credentials are vault references only; the server rejects
// raw keys in settings and its sentence is rendered verbatim.
"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api";
import {
  leadIntegrationName,
  leadIntegrationsApi,
  leadProviderFields,
  type LeadIntegration,
} from "@/lib/integrations-lifecycle-api";
import { STALE } from "@/lib/query-keys";

import {
  ADMIN_REQUIRED_REASON,
  useIntegrationLifecycleAuthority,
} from "./use-integration-lifecycle-authority";

export function LeadCaptureConnectForm({
  provider,
  providerName,
  onConnected,
}: {
  /** Catalog slug; must match a provider in the lead registry. */
  provider: string;
  providerName: string;
  onConnected?: (integration: LeadIntegration) => void | Promise<void>;
}) {
  const authority = useIntegrationLifecycleAuthority();
  const formId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [missing, setMissing] = useState<string[]>([]);

  const providers = useQuery({
    queryKey: [...authority.baseKey, "lead-providers"] as const,
    queryFn: ({ signal }) => leadIntegrationsApi.providers({ signal }),
    // The registry route is admin-scoped: never ask for it on behalf of a
    // role that cannot use it.
    enabled: authority.canAdmin,
    staleTime: STALE.reference,
    retry: false,
  });
  const spec = useMemo(
    () =>
      Array.isArray(providers.data)
        ? (providers.data.find((candidate) => candidate.provider === provider) ??
          null)
        : null,
    [provider, providers.data],
  );
  const fields = useMemo(
    () => leadProviderFields(spec).filter((field) => !field.secret),
    [spec],
  );
  const secretFields = useMemo(
    () => leadProviderFields(spec).filter((field) => field.secret),
    [spec],
  );

  const save = useMutation({
    mutationFn: async () => {
      if (!spec) throw new Error(`${providerName} is not in the lead registry.`);
      const cleaned: Record<string, string> = {};
      for (const field of fields) {
        const value = (values[field.key] ?? "").trim();
        if (value) cleaned[field.key] = value;
      }
      const credentialsRef = cleaned.credentials_ref ?? "";
      const settings = { ...cleaned };
      delete settings.credentials_ref;
      const controller = new AbortController();
      await authority.beforeWrite(controller.signal);
      return leadIntegrationsApi.create(
        {
          provider: spec.provider,
          name: name.trim() || leadIntegrationName(spec, cleaned),
          credentials_ref: credentialsRef,
          settings,
        },
        { signal: controller.signal },
      );
    },
    onSuccess: async (integration) => {
      await onConnected?.(integration);
    },
  });

  if (authority.pending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Checking your workspace role…
      </p>
    );
  }
  if (!authority.canAdmin) {
    return (
      <p role="note" className="text-sm text-muted-foreground">
        {ADMIN_REQUIRED_REASON} No lead provider request was made.
      </p>
    );
  }
  if (providers.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading lead provider setup…
      </p>
    );
  }
  if (providers.isError) {
    return (
      <div role="alert" className="space-y-2 text-sm">
        <p className="text-destructive">
          {apiErrorMessage(
            providers.error,
            "Lead provider setup couldn't be loaded. This is a failed request, not an empty registry.",
          )}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void providers.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (!spec) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        {providerName} is not registered as a managed lead connector yet.
      </p>
    );
  }
  if (!spec.managed) {
    return (
      <p role="note" className="text-sm text-muted-foreground">
        {spec.name} is bridge-only: connect it through inbound webhooks or a
        bridge recipe instead of a native lead integration.
      </p>
    );
  }

  if (save.data) {
    return (
      <div role="status" className="space-y-1 rounded-md border p-3 text-sm">
        <p className="font-medium">{save.data.name || spec.name} saved</p>
        <p className="text-muted-foreground">
          Status {save.data.status || "unknown"} · Connection {save.data.id}.
          Confirm account identity, scopes, and provider health before relying
          on it.
        </p>
      </div>
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending || !spec) return;
    const absent = fields
      .filter((field) => field.required && !(values[field.key] ?? "").trim())
      .map((field) => field.key);
    setMissing(absent);
    if (absent.length > 0) return;
    save.mutate();
  }

  return (
    <form noValidate onSubmit={submit} className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Imports {spec.sync_objects.join(", ") || "lead submissions"} through{" "}
        {spec.sync_model?.replaceAll("_", " ") ?? "managed ingest"}.
      </p>
      <div className="space-y-1">
        <Label htmlFor={`${formId}-name`}>Name (optional)</Label>
        <Input
          id={`${formId}-name`}
          value={name}
          disabled={save.isPending}
          placeholder={leadIntegrationName(spec, values)}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      {fields.map((field) => {
        const inputId = `${formId}-${field.key}`;
        const helpId = `${inputId}-help`;
        const invalid = missing.includes(field.key);
        return (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={inputId}>
              {field.label}
              {field.required ? " *" : ""}
            </Label>
            <Input
              id={inputId}
              value={values[field.key] ?? ""}
              disabled={save.isPending}
              autoComplete="off"
              aria-invalid={invalid || undefined}
              aria-describedby={field.help || invalid ? helpId : undefined}
              onChange={(event) => {
                const next = event.target.value;
                setValues((current) => ({ ...current, [field.key]: next }));
                if (invalid) {
                  setMissing((current) =>
                    current.filter((key) => key !== field.key),
                  );
                }
              }}
            />
            {field.help || invalid ? (
              <p
                id={helpId}
                className={
                  invalid
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                {invalid ? `${field.label} is required. ` : ""}
                {field.help ?? ""}
              </p>
            ) : null}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        Raw credentials are never accepted here — store the secret in the vault
        and enter its reference.
        {secretFields.length > 0
          ? ` The reference must cover: ${secretFields.map((field) => field.label).join(", ")}.`
          : ""}
      </p>
      {save.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {apiErrorMessage(
            save.error,
            `${spec.name} configuration couldn't be saved.`,
          )}
        </p>
      ) : null}
      <Button type="submit" loading={save.isPending}>
        {save.isPending ? "Saving…" : "Save configuration"}
      </Button>
    </form>
  );
}
