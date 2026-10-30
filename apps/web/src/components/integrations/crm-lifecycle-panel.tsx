// SPDX-License-Identifier: AGPL-3.0-only
//
// In-app CRM connect / disconnect / sync lifecycle. Web previously surfaced
// integrations as status-only; this matches the desktop full-lifecycle UI for
// the remaining governance gap.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handshake } from "lucide-react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { whoami, type MeResponse } from "@/lib/auth-api";
import {
  ADMIN_READ_ONLY_MESSAGE,
  adminReadIdentityParts,
  canReadAdminData,
} from "@/lib/admin-read-authority";
import {
  FreshAdminAuthorityError,
  verifyFreshAdminAuthority,
} from "@/lib/admin-mutation-authority";
import {
  crmApi,
  type CrmIntegration,
  type CrmProviderSpec,
} from "@/lib/crm-api";
import { managedOAuthAvailable } from "@/lib/integrations-surface-api";
import { base, qk, STALE } from "@/lib/query-keys";

function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === "active" || s === "connected")
    return "bg-success text-success-foreground";
  if (s === "error" || s === "failed")
    return "bg-destructive/15 text-destructive-emphasis";
  if (s === "paused") return "bg-warning/15 text-warning-emphasis";
  return "bg-muted text-muted-foreground";
}

function fmtDate(value?: string | null): string {
  if (!value) return "never";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface CrmPanelData {
  providers: CrmProviderSpec[];
  items: CrmIntegration[];
  providersUnavailable: boolean;
}

function crmErrorMessage(e: unknown): string {
  if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
    return "You need admin access to manage CRM integrations.";
  }
  return e instanceof Error ? e.message : "Failed to load CRM";
}

async function loadCrmPanelData(signal?: AbortSignal): Promise<CrmPanelData> {
  const [providersResult, items] = await Promise.all([
    Promise.resolve(crmApi.providers({ signal })).then(
      (providers) => ({ providers, unavailable: false }),
      (error: unknown) => {
        if (
          signal?.aborted ||
          (error instanceof ApiError &&
            (error.status === 401 || error.status === 403))
        ) {
          throw error;
        }
        return { providers: [] as CrmProviderSpec[], unavailable: true };
      },
    ),
    crmApi.list({ signal }),
  ]);
  return {
    providers: providersResult.providers,
    providersUnavailable: providersResult.unavailable,
    items,
  };
}

export function CrmLifecyclePanel() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });
  const identity = meQuery.isSuccess ? meQuery.data : null;
  const canAdmin = canReadAdminData(identity);
  const [tenantId, userId, role, viewerMode] = adminReadIdentityParts(identity);
  const authorityKey = identity
    ? [tenantId, userId, role, viewerMode].join("\u001f")
    : "unverified";
  const integrationsBaseKey = useMemo(
    () =>
      [...base("integrations", tenantId, role), userId, viewerMode] as const,
    [role, tenantId, userId, viewerMode],
  );
  const previousScopeRef = useRef<{
    fingerprint: string;
    queryKey: readonly unknown[];
  } | null>(null);

  useEffect(() => {
    if (meQuery.isPending) return;
    const previous = previousScopeRef.current;
    const current = canAdmin
      ? { fingerprint: authorityKey, queryKey: integrationsBaseKey }
      : null;
    if (
      previous &&
      (!current || previous.fingerprint !== current.fingerprint)
    ) {
      void queryClient.cancelQueries({
        queryKey: previous.queryKey,
        exact: false,
      });
      queryClient.removeQueries({ queryKey: previous.queryKey, exact: false });
    }
    if (!current) {
      void queryClient.cancelQueries({
        predicate: (query) =>
          query.queryKey[0] === "integrations" &&
          query.queryKey.includes("crm"),
      });
      queryClient.removeQueries({
        predicate: (query) =>
          query.queryKey[0] === "integrations" &&
          query.queryKey.includes("crm"),
      });
    }
    previousScopeRef.current = current;
  }, [
    authorityKey,
    canAdmin,
    integrationsBaseKey,
    meQuery.isPending,
    queryClient,
  ]);

  if (meQuery.isPending) return <CrmAccessState kind="loading" />;
  if (meQuery.isError || !identity) {
    return (
      <CrmAccessState
        kind="error"
        message={crmErrorMessage(meQuery.error)}
        retrying={meQuery.isFetching}
        onRetry={() => void meQuery.refetch()}
      />
    );
  }
  if (!canAdmin) return <CrmAccessState kind="read-only" />;

  return (
    <AuthorizedCrmLifecyclePanel
      key={authorityKey}
      identity={identity}
      authorityKey={authorityKey}
      integrationsBaseKey={integrationsBaseKey}
    />
  );
}

function AuthorizedCrmLifecyclePanel({
  identity,
  authorityKey,
  integrationsBaseKey,
}: {
  identity: MeResponse;
  authorityKey: string;
  integrationsBaseKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const operationLockRef = useRef(false);
  const operationControllerRef = useRef<AbortController | null>(null);
  const authorityRef = useRef(authorityKey);
  authorityRef.current = authorityKey;

  useEffect(
    () => () => {
      operationControllerRef.current?.abort();
      operationControllerRef.current = null;
      operationLockRef.current = false;
    },
    [],
  );

  const crmKey = useMemo(
    () => [...integrationsBaseKey, "crm"] as const,
    [integrationsBaseKey],
  );
  const crmQuery = useQuery({
    queryKey: crmKey,
    queryFn: ({ signal }) => loadCrmPanelData(signal),
    staleTime: STALE.list,
    retry: false,
  });
  const providers = Array.isArray(crmQuery.data?.providers)
    ? crmQuery.data?.providers
    : [];
  const items = Array.isArray(crmQuery.data?.items) ? crmQuery.data?.items : [];
  const providersUnavailable = crmQuery.data?.providersUnavailable ?? false;
  const loading = crmQuery.isPending && !crmQuery.data;
  const error = crmQuery.error ? crmErrorMessage(crmQuery.error) : null;

  useEffect(() => {
    if (error || providersUnavailable) setShowConnect(false);
    if (!error) return;
    // Do not leave a tenant-scoped confirmation or lifecycle request alive
    // after the protected connection read has failed (including a late 403).
    setDisconnectTarget(null);
    operationControllerRef.current?.abort();
    operationControllerRef.current = null;
    operationLockRef.current = false;
    setBusyId(null);
  }, [error, providersUnavailable]);

  const invalidateCrm = (): Promise<void> =>
    queryClient
      .invalidateQueries({
        queryKey: crmKey,
        exact: false,
      })
      .then(() => undefined);

  const containAuthorityFailure = useCallback(
    (failure: unknown) => {
      void queryClient.cancelQueries({
        queryKey: integrationsBaseKey,
        exact: false,
      });
      queryClient.removeQueries({
        queryKey: integrationsBaseKey,
        exact: false,
      });
      if (failure instanceof FreshAdminAuthorityError) {
        queryClient.setQueryData(qk.authMe(), failure.freshIdentity);
      }
    },
    [integrationsBaseKey, queryClient],
  );

  const beforeWrite = useCallback(
    async (signal: AbortSignal) => {
      try {
        await verifyFreshAdminAuthority(identity, signal);
      } catch (failure) {
        if (!signal.aborted) containAuthorityFailure(failure);
        throw failure;
      }
    },
    [containAuthorityFailure, identity],
  );

  async function runLifecycle(
    id: string,
    success: string,
    fallback: string,
    request: (signal: AbortSignal) => Promise<unknown>,
  ) {
    if (operationLockRef.current) return;
    const intent = { authorityKey, id, request, success, fallback } as const;
    const controller = new AbortController();
    operationLockRef.current = true;
    operationControllerRef.current = controller;
    setBusyId(id);
    try {
      await beforeWrite(controller.signal);
      if (
        controller.signal.aborted ||
        authorityRef.current !== intent.authorityKey
      ) {
        return;
      }
      await intent.request(controller.signal);
      if (
        controller.signal.aborted ||
        authorityRef.current !== intent.authorityKey
      ) {
        return;
      }
      toast.success(intent.success);
      await invalidateCrm();
    } catch (error) {
      if (
        !controller.signal.aborted &&
        authorityRef.current === intent.authorityKey
      ) {
        toast.error(error instanceof Error ? error.message : intent.fallback);
      }
    } finally {
      if (operationControllerRef.current === controller) {
        operationControllerRef.current = null;
        operationLockRef.current = false;
        setBusyId(null);
      }
    }
  }

  const onSync = (id: string) =>
    runLifecycle(id, "Sync started", "Sync failed", (signal) =>
      crmApi.sync(id, { signal }),
    );
  const onPause = (id: string) =>
    runLifecycle(id, "Integration paused", "Pause failed", (signal) =>
      crmApi.pause(id, { signal }),
    );
  const onResume = (id: string) =>
    runLifecycle(id, "Integration resumed", "Resume failed", (signal) =>
      crmApi.resume(id, { signal }),
    );
  const onDisconnect = (id: string) =>
    runLifecycle(
      id,
      "Integration disconnected",
      "Disconnect failed",
      (signal) => crmApi.disconnect(id, { signal }),
    );

  return (
    <section
      className="mt-8 border-t border-border pt-6"
      data-testid="crm-lifecycle"
    >
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">CRM</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Connect a CRM to sync contacts and events. Disconnect anytime.
          </p>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
          {!error && !providersUnavailable && (
            <Button
              type="button"
              onClick={() => setShowConnect((v) => !v)}
              variant="outline"
              size="sm"
              aria-expanded={showConnect}
            >
              {showConnect ? "Cancel" : "Connect CRM"}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void crmQuery.refetch()}
          >
            Refresh
          </Button>
        </div>
      </div>

      {!error && providersUnavailable ? (
        <div
          className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
          role="alert"
        >
          Connected CRMs are shown below, but provider requirements could not be
          loaded. New connection controls are paused until a refresh succeeds.
        </div>
      ) : null}

      {!error && !providersUnavailable && showConnect && (
        <ConnectCrmForm
          key={authorityKey}
          providers={providers}
          authorityKey={authorityKey}
          beforeWrite={beforeWrite}
          onConnected={async () => {
            setShowConnect(false);
            await invalidateCrm();
          }}
        />
      )}

      {error && (
        <div className="mb-3 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}
      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}
      {!loading && !error && items.length === 0 && !showConnect && (
        <EmptyState
          icon={Handshake}
          title="No CRM integrations connected"
          description="Connect a CRM to sync contacts and events into Moosewave. You can pause or disconnect anytime."
        />
      )}

      <div className="space-y-3">
        {(error ? [] : items).map((item) => {
          const busy = busyId === item.id;
          const lifecycleBusy = busyId !== null;
          const paused = item.status.toLowerCase() === "paused";
          return (
            <div
              key={item.id}
              className="border border-border rounded-md bg-card p-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-sm truncate">
                    {item.name || item.provider}
                  </span>
                  <span
                    className={`text-[11px] px-2 py-0.5 rounded-full ${statusClass(item.status)}`}
                  >
                    {item.status || "unknown"}
                  </span>
                </div>
                {item.error_message && (
                  <div
                    className="mt-2 break-words text-xs text-destructive"
                    title={item.error_message}
                  >
                    {item.error_message}
                  </div>
                )}
                <div className="text-xs text-muted-foreground mt-2">
                  {item.provider} · last sync {fmtDate(item.last_sync_at)}
                </div>
              </div>
              <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:flex-wrap sm:justify-end">
                <Button
                  type="button"
                  loading={busy}
                  disabled={lifecycleBusy}
                  variant="outline"
                  size="sm"
                  onClick={() => void onSync(item.id)}
                >
                  {busy ? "…" : "Sync now"}
                </Button>
                {!paused && (
                  <Button
                    type="button"
                    disabled={lifecycleBusy}
                    variant="outline"
                    size="sm"
                    onClick={() => void onPause(item.id)}
                  >
                    Pause
                  </Button>
                )}
                {paused && (
                  <Button
                    type="button"
                    disabled={lifecycleBusy}
                    variant="outline"
                    size="sm"
                    onClick={() => void onResume(item.id)}
                  >
                    Resume
                  </Button>
                )}
                <Button
                  type="button"
                  disabled={lifecycleBusy}
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setDisconnectTarget({
                      id: item.id,
                      name: item.name || item.provider,
                    })
                  }
                  className="text-destructive hover:text-destructive"
                >
                  Disconnect
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={disconnectTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDisconnectTarget(null);
        }}
        title="Disconnect this CRM?"
        description={
          disconnectTarget
            ? `Moosewave will stop syncing contacts and events from ${disconnectTarget.name}. This cannot be undone.`
            : ""
        }
        confirmLabel="Disconnect"
        onConfirm={async () => {
          if (disconnectTarget) await onDisconnect(disconnectTarget.id);
          setDisconnectTarget(null);
        }}
      />
    </section>
  );
}

function CrmAccessState({
  kind,
  message,
  retrying = false,
  onRetry,
}: {
  kind: "loading" | "error" | "read-only";
  message?: string;
  retrying?: boolean;
  onRetry?: () => void;
}) {
  return (
    <section
      className="mt-8 border-t border-border pt-6"
      data-testid="crm-lifecycle"
    >
      <h2 className="text-lg font-semibold">CRM</h2>
      <div
        className="mt-3 rounded-lg border border-border p-4 text-sm text-muted-foreground"
        role={kind === "loading" ? "status" : "alert"}
      >
        <p className="font-medium text-foreground">
          {kind === "loading"
            ? "Checking CRM access…"
            : kind === "error"
              ? "Couldn’t verify CRM access"
              : "Owner or admin access required"}
        </p>
        <p className="mt-1">
          {kind === "loading"
            ? "Moosewave is confirming the current workspace and effective role before requesting CRM data."
            : kind === "error"
              ? `${message ?? "The identity check failed."} No CRM request was made.`
              : `${ADMIN_READ_ONLY_MESSAGE} No CRM provider or connection request was made.`}
        </p>
        {kind === "error" && onRetry ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={onRetry}
            loading={retrying}
          >
            {retrying ? "Retrying…" : "Retry access check"}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function ConnectCrmForm({
  providers,
  authorityKey,
  beforeWrite,
  onConnected,
}: {
  providers: CrmProviderSpec[];
  authorityKey: string;
  beforeWrite: (signal: AbortSignal) => Promise<void>;
  onConnected: () => void | Promise<void>;
}) {
  const [provider, setProvider] = useState<string>(
    providers[0]?.provider ?? "",
  );
  const [credentialsRef, setCredentialsRef] = useState("");
  const [name, setName] = useState("");
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
    setProvider("");
    setCredentialsRef("");
    setName("");
    setSubmitting(false);
    setError(null);
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      lockRef.current = false;
    };
  }, [authorityKey]);

  useEffect(() => {
    if (!provider && providers.length > 0) setProvider(providers[0].provider);
  }, [providers, provider]);

  const spec = providers.find((p) => p.provider === provider);
  const managed = spec?.managed ?? false;

  async function onManagedConnect() {
    // Managed OAuth: full-page navigate to the server's /oauth/start which
    // 302s to the provider consent screen. Fail closed if availability cannot
    // be checked; guessing "available" can send an operator into a dead flow.
    if (!provider || lockRef.current) return;
    const intent = {
      authorityKey,
      provider,
      startUrl: crmApi.oauthStartUrl(provider),
    } as const;
    const controller = new AbortController();
    lockRef.current = true;
    controllerRef.current = controller;
    setSubmitting(true);
    setError(null);
    try {
      const avail = await crmApi.oauthAvailability(intent.provider, {
        signal: controller.signal,
      });
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
      await beforeWrite(controller.signal);
      if (
        controller.signal.aborted ||
        authorityRef.current !== intent.authorityKey
      ) {
        return;
      }
      window.location.href = intent.startUrl;
    } catch (e) {
      if (
        !controller.signal.aborted &&
        authorityRef.current === intent.authorityKey
      ) {
        setError(e instanceof Error ? e.message : "Could not start OAuth");
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        lockRef.current = false;
        setSubmitting(false);
      }
    }
  }

  async function onRefConnect(e: React.FormEvent) {
    e.preventDefault();
    if (!provider || !credentialsRef.trim() || lockRef.current) return;
    const intent = {
      authorityKey,
      input: {
        provider,
        name: name.trim() || undefined,
        credentials_ref: credentialsRef.trim(),
      },
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
      await crmApi.create(intent.input, { signal: controller.signal });
      if (
        controller.signal.aborted ||
        authorityRef.current !== intent.authorityKey
      ) {
        return;
      }
      setCredentialsRef("");
      setName("");
      toast.success("CRM connected");
      await onConnected();
    } catch (err) {
      if (
        !controller.signal.aborted &&
        authorityRef.current === intent.authorityKey
      ) {
        if (
          err instanceof ApiError &&
          (err.status === 401 || err.status === 403)
        ) {
          setError("Admin access is required to connect a CRM.");
        } else {
          setError(err instanceof Error ? err.message : "Connect failed");
        }
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
    <div className="mb-6 space-y-3 rounded-xl border border-border bg-card p-4">
      <div>
        <label
          htmlFor="crm-connect-provider"
          className="block text-sm text-muted-foreground mb-1"
        >
          Provider
        </label>
        <select
          id="crm-connect-provider"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            // Credential references are provider-specific. Do not carry one
            // across a provider switch inside the same admin session.
            setCredentialsRef("");
            setName("");
            setError(null);
          }}
          disabled={submitting}
          className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm"
        >
          {providers.length === 0 && (
            <option value="">No providers available</option>
          )}
          {providers.map((p) => (
            <option key={p.provider} value={p.provider}>
              {p.name}
              {p.managed ? " (OAuth)" : ""}
            </option>
          ))}
        </select>
      </div>

      {managed ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {spec?.name} uses managed OAuth. You&apos;ll be redirected to grant
            access, then sent back here.
          </p>
          <Button
            type="button"
            disabled={!provider}
            loading={submitting}
            onClick={() => void onManagedConnect()}
            className="w-full sm:w-auto"
          >
            Connect with {spec?.name ?? "provider"}
          </Button>
        </div>
      ) : (
        <form onSubmit={onRefConnect} className="space-y-3">
          <div>
            <label
              htmlFor="crm-connect-name"
              className="block text-sm text-muted-foreground mb-1"
            >
              Name (optional)
            </label>
            <input
              id="crm-connect-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              placeholder={spec?.name ?? "My CRM"}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label
              htmlFor="crm-connect-credref"
              className="block text-sm text-muted-foreground mb-1"
            >
              Credential reference
            </label>
            <input
              id="crm-connect-credref"
              value={credentialsRef}
              onChange={(e) => setCredentialsRef(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="vault://crm/…"
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm font-mono"
              required
            />
            <p className="text-xs text-muted-foreground mt-1">
              Raw credentials are never accepted here — store them in the vault
              and pass the reference.
            </p>
          </div>
          <Button
            type="submit"
            disabled={!credentialsRef.trim()}
            loading={submitting}
            className="w-full sm:w-auto"
          >
            {submitting ? "Connecting…" : "Connect"}
          </Button>
        </form>
      )}

      {error && (
        <div className="text-sm text-destructive" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
