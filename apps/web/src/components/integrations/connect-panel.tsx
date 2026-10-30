// SPDX-License-Identifier: AGPL-3.0-only
//
// connect-panel.tsx — the single spec-driven connect surface used by the
// integration-catalog detail route. It picks one of three flows from the
// provider spec, with no per-surface branching:
//   - spec.managed                       → managed OAuth (full-page redirect)
//   - spec.sync_model ends "_ingest"     → webhook-ingest token provisioning
//   - otherwise                          → vault credential-reference form
"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyTextButton } from "@/components/copy-text-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import {
  isIngestSpec,
  managedOAuthAvailable,
  type IngestEndpoint,
  type ProviderField,
  type ProviderSpec,
  type SurfaceClient,
} from "@/lib/integrations-surface-api";

export function ConnectPanel({
  spec,
  surface,
  authorityKey,
  beforeWrite,
  onConnected,
}: {
  spec: ProviderSpec;
  surface: SurfaceClient;
  authorityKey: string;
  beforeWrite: (signal: AbortSignal) => Promise<void>;
  onConnected: () => void | Promise<void>;
}) {
  if (spec.managed && surface.oauthStartUrl) {
    return (
      <OAuthConnect
        spec={spec}
        surface={surface}
        authorityKey={authorityKey}
        beforeWrite={beforeWrite}
      />
    );
  }
  if (isIngestSpec(spec) && surface.provisionIngest) {
    return (
      <IngestConnect
        spec={spec}
        surface={surface}
        authorityKey={authorityKey}
        beforeWrite={beforeWrite}
        onConnected={onConnected}
      />
    );
  }
  return (
    <CredentialsConnect
      spec={spec}
      surface={surface}
      authorityKey={authorityKey}
      beforeWrite={beforeWrite}
      onConnected={onConnected}
    />
  );
}

function errMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
    return "Admin access is required to connect this integration.";
  }
  return e instanceof Error ? e.message : fallback;
}

function OAuthConnect({
  spec,
  surface,
  authorityKey,
  beforeWrite,
}: {
  spec: ProviderSpec;
  surface: SurfaceClient;
  authorityKey: string;
  beforeWrite: (signal: AbortSignal) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const lockRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const authorityRef = useRef(authorityKey);

  useEffect(() => {
    authorityRef.current = authorityKey;
    controllerRef.current?.abort();
    controllerRef.current = null;
    lockRef.current = false;
    setStarting(false);
    setError(null);
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      lockRef.current = false;
    };
  }, [authorityKey]);

  async function onConnect() {
    if (!surface.oauthStartUrl || lockRef.current) return;
    const intent = {
      authorityKey,
      provider: spec.provider,
      startUrl: surface.oauthStartUrl,
      availability: surface.oauthAvailability,
    } as const;
    const controller = new AbortController();
    lockRef.current = true;
    controllerRef.current = controller;
    setStarting(true);
    setError(null);
    try {
      const avail = intent.availability
        ? await intent.availability(intent.provider, {
            signal: controller.signal,
          })
        : { available: true };
      if (
        controller.signal.aborted ||
        authorityRef.current !== intent.authorityKey
      ) {
        return;
      }
      if (!managedOAuthAvailable(avail)) {
        setError(
          "Managed OAuth isn't configured for this provider on the server.",
        );
        return;
      }
      // Availability can take arbitrarily long. Re-check immediately before
      // navigating to the admin-only start endpoint rather than trusting the
      // authority that rendered this button.
      await beforeWrite(controller.signal);
      if (
        controller.signal.aborted ||
        authorityRef.current !== intent.authorityKey
      ) {
        return;
      }
      // Full-page navigation: the server 302s to the provider consent screen
      // and returns the operator to the owning surface's callback.
      window.location.href = intent.startUrl(intent.provider);
    } catch (e) {
      if (
        !controller.signal.aborted &&
        authorityRef.current === intent.authorityKey
      ) {
        setError(errMessage(e, "Could not start OAuth"));
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        lockRef.current = false;
        setStarting(false);
      }
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {spec.name} uses managed OAuth. You&apos;ll be redirected to grant
        access, then sent back here.
      </p>
      <Button
        onClick={() => void onConnect()}
        loading={starting}
        className="w-full sm:w-auto"
      >
        {starting ? "Starting…" : `Connect with ${spec.name}`}
      </Button>
      {error && (
        <p
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}

function CredentialsConnect({
  spec,
  surface,
  authorityKey,
  beforeWrite,
  onConnected,
}: {
  spec: ProviderSpec;
  surface: SurfaceClient;
  authorityKey: string;
  beforeWrite: (signal: AbortSignal) => Promise<void>;
  onConnected: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [credentialsRef, setCredentialsRef] = useState("");
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lockRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const authorityRef = useRef(authorityKey);

  useEffect(() => {
    authorityRef.current = authorityKey;
    controllerRef.current?.abort();
    controllerRef.current = null;
    lockRef.current = false;
    // Credential references and provider configuration belong to the exact
    // principal that entered them. Never retain them across a role/workspace
    // transition, even when a parent forgets to key the panel.
    setName("");
    setCredentialsRef("");
    setSettings({});
    setSubmitting(false);
    setError(null);
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      lockRef.current = false;
    };
  }, [authorityKey]);

  // Non-secret settings the runtime reads (subdomain, store, site, project_id…).
  // Secret material never goes in `settings` — it lives in the vault bundle the
  // credentials_ref points at (the backend rejects raw secrets in settings).
  const configFields: ProviderField[] = [
    ...(spec.required_settings ?? []),
    ...(spec.optional_settings ?? []),
  ].filter((f) => !f.secret && f.key !== "credentials_ref");
  const secretFields: ProviderField[] = [
    ...(spec.required_settings ?? []),
    ...(spec.optional_settings ?? []),
  ].filter((f) => f.secret);

  const missingRequiredConfig = (spec.required_settings ?? [])
    .filter((f) => !f.secret && f.required && f.key !== "credentials_ref")
    .some((f) => !(settings[f.key] ?? "").trim());

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!credentialsRef.trim() || missingRequiredConfig || lockRef.current) {
      return;
    }
    const cleanedSettings: Record<string, string> = {};
    for (const [key, value] of Object.entries(settings)) {
      if (value.trim()) cleanedSettings[key] = value.trim();
    }
    const intent = {
      authorityKey,
      input: {
        provider: spec.provider,
        name: name.trim() || undefined,
        credentials_ref: credentialsRef.trim(),
        settings: Object.keys(cleanedSettings).length
          ? cleanedSettings
          : undefined,
      },
      create: surface.create,
    } as const;
    const controller = new AbortController();
    lockRef.current = true;
    controllerRef.current = controller;
    setSubmitting(true);
    setError(null);
    try {
      await beforeWrite(controller.signal);
      if (
        controller.signal.aborted ||
        authorityRef.current !== intent.authorityKey
      ) {
        return;
      }
      await intent.create(intent.input, { signal: controller.signal });
      if (
        controller.signal.aborted ||
        authorityRef.current !== intent.authorityKey
      ) {
        return;
      }
      setName("");
      setCredentialsRef("");
      setSettings({});
      toast.success(`${spec.name} connected`);
      await onConnected();
    } catch (err) {
      if (
        !controller.signal.aborted &&
        authorityRef.current === intent.authorityKey
      ) {
        setError(errMessage(err, "Connect failed"));
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        lockRef.current = false;
        setSubmitting(false);
      }
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="connect-name">Name (optional)</Label>
        <Input
          id="connect-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
          placeholder={spec.name}
        />
      </div>

      {configFields.map((field) => (
        <div key={field.key} className="space-y-1.5">
          <Label htmlFor={`cfg-${field.key}`}>
            {field.label}
            {field.required ? " *" : ""}
          </Label>
          <Input
            id={`cfg-${field.key}`}
            value={settings[field.key] ?? ""}
            onChange={(e) =>
              setSettings((s) => ({ ...s, [field.key]: e.target.value }))
            }
            disabled={submitting}
            placeholder={field.help || field.key}
            required={field.required}
            aria-describedby={field.help ? `cfg-${field.key}-help` : undefined}
          />
          {field.help && (
            <p
              id={`cfg-${field.key}-help`}
              className="text-xs leading-5 text-muted-foreground"
            >
              {field.help}
            </p>
          )}
        </div>
      ))}

      <div className="space-y-1.5">
        <Label htmlFor="connect-credref">Credential reference *</Label>
        <Input
          id="connect-credref"
          value={credentialsRef}
          onChange={(e) => setCredentialsRef(e.target.value)}
          disabled={submitting}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="vault://…"
          className="font-mono"
          required
        />
        <p className="text-xs text-muted-foreground">
          Raw credentials are never accepted here—store the secret in the vault
          and paste its reference.
          {secretFields.length > 0 && (
            <>
              {" "}
              The vault bundle should contain:{" "}
              {secretFields.map((f) => f.label).join(", ")}.
            </>
          )}
        </p>
      </div>

      <Button
        type="submit"
        disabled={!credentialsRef.trim() || missingRequiredConfig}
        loading={submitting}
        className="w-full sm:w-auto"
      >
        {submitting ? "Connecting…" : "Connect"}
      </Button>
      {error && (
        <p
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
          role="alert"
        >
          {error}
        </p>
      )}
    </form>
  );
}

function IngestConnect({
  spec,
  surface,
  authorityKey,
  beforeWrite,
  onConnected,
}: {
  spec: ProviderSpec;
  surface: SurfaceClient;
  authorityKey: string;
  beforeWrite: (signal: AbortSignal) => Promise<void>;
  onConnected: () => void | Promise<void>;
}) {
  const [endpoint, setEndpoint] = useState<IngestEndpoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const lockRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const authorityRef = useRef(authorityKey);

  useEffect(() => {
    authorityRef.current = authorityKey;
    controllerRef.current?.abort();
    controllerRef.current = null;
    lockRef.current = false;
    // The endpoint contains a reveal-once ingest token. Purge it and any open
    // rotation confirmation as soon as the principal changes.
    setEndpoint(null);
    setBusy(false);
    setError(null);
    setConfirmRotate(false);
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      lockRef.current = false;
    };
  }, [authorityKey]);

  async function onProvision() {
    if (!surface.provisionIngest || lockRef.current) return;
    const intent = {
      authorityKey,
      provider: spec.provider,
      provision: surface.provisionIngest,
    } as const;
    const controller = new AbortController();
    lockRef.current = true;
    controllerRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      await beforeWrite(controller.signal);
      if (
        controller.signal.aborted ||
        authorityRef.current !== intent.authorityKey
      ) {
        return;
      }
      const ep = await intent.provision(
        { provider: intent.provider },
        { signal: controller.signal },
      );
      if (
        controller.signal.aborted ||
        authorityRef.current !== intent.authorityKey
      ) {
        return;
      }
      setEndpoint(ep);
      toast.success("Ingest endpoint ready");
      await onConnected();
    } catch (e) {
      if (
        !controller.signal.aborted &&
        authorityRef.current === intent.authorityKey
      ) {
        setError(errMessage(e, "Could not provision the ingest endpoint"));
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        lockRef.current = false;
        setBusy(false);
      }
    }
  }

  async function onRotate() {
    if (!surface.rotateIngest || !endpoint || lockRef.current) return;
    const intent = {
      authorityKey,
      integrationId: endpoint.integration_id,
      rotate: surface.rotateIngest,
    } as const;
    const controller = new AbortController();
    lockRef.current = true;
    controllerRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      await beforeWrite(controller.signal);
      if (
        controller.signal.aborted ||
        authorityRef.current !== intent.authorityKey
      ) {
        return;
      }
      const ep = await intent.rotate(intent.integrationId, {
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        authorityRef.current !== intent.authorityKey
      ) {
        return;
      }
      setEndpoint(ep);
      toast.success("Ingest token rotated");
    } catch (e) {
      if (
        !controller.signal.aborted &&
        authorityRef.current === intent.authorityKey
      ) {
        setError(errMessage(e, "Rotate failed"));
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        lockRef.current = false;
        setBusy(false);
      }
    }
  }

  const url = endpoint?.ingest_url || endpoint?.ingest_path || "";

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {spec.name} is push-only: it sends events to a webhook. Provision an
        ingest endpoint, then paste the URL into {spec.name}&apos;s webhook
        settings.
      </p>
      {!endpoint ? (
        <Button
          onClick={() => void onProvision()}
          loading={busy}
          className="w-full sm:w-auto"
        >
          {busy ? "Provisioning…" : "Provision ingest endpoint"}
        </Button>
      ) : (
        <div className="space-y-2 rounded-lg border p-4">
          <Label htmlFor="ingest-url">Webhook ingest URL</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="ingest-url"
              readOnly
              value={url}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="min-w-0 font-mono text-xs"
            />
            <CopyTextButton
              value={url}
              variant="outline"
              size="default"
              className="w-full sm:w-auto"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Treat this URL as a secret — anyone with it can post events to your
            workspace. Rotate if it leaks.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setConfirmRotate(true)}
            disabled={busy}
          >
            Rotate token
          </Button>
        </div>
      )}
      {error && (
        <p
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
          role="alert"
        >
          {error}
        </p>
      )}

      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title="Rotate the ingest token?"
        description="The current webhook URL stops working immediately. You'll need to update the URL in the provider's settings with the new one."
        confirmLabel="Rotate token"
        onConfirm={async () => {
          await onRotate();
          setConfirmRotate(false);
        }}
      />
    </div>
  );
}
