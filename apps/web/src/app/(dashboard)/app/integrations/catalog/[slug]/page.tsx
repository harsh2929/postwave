// SPDX-License-Identifier: AGPL-3.0-only
//
// Integration catalog detail + connect route. Derives detail from the catalog
// list + the owning surface's provider spec (no backend detail endpoint needed),
// then renders the spec-driven ConnectPanel and a lifecycle list of existing
// connections for this provider (sync / pause / disconnect).
"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PackageOpen } from "lucide-react";

import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { DataSurfaceShell } from "@/components/integrations/data-surface";
import { DocsLink } from "@/components/integrations/docs-link";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { RelativeTime } from "@/components/relative-time";
import { ApiError, apiErrorMessage } from "@/lib/api";
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
  heldConnectSurfaceForCatalogItem,
  surfaceForCatalogItem,
  type CatalogSurface,
} from "@/lib/catalog-connect-map";
import { resolveSetupPath } from "@/lib/integration-setup-path";
import {
  badgeLabel,
  integrationsCatalogApi,
  runtimeStatusLabel,
  runtimeStatusTone,
  type CatalogItem,
  type IntegrationsCatalog,
} from "@/lib/integrations-catalog-api";
import type { NativeLifecycleFamily } from "@/lib/integrations-lifecycle-api";
import {
  isIngestSpec,
  type ProviderSpec,
  type SurfaceIntegration,
} from "@/lib/integrations-surface-api";
import { asRoute } from "@/lib/typed-routes";
import { base, qk, STALE } from "@/lib/query-keys";

// The connector detail, the connect wizard and the lead-capture form all
// render below the hero and carry the lifecycle and surface clients with
// them. Splitting them keeps the route under the dashboard bundle budget
// without changing what admins see; each fallback mirrors the component's own
// first render.
const ConnectorDetailPanels = dynamic(
  () =>
    import("@/components/integrations/connector-detail-panels").then(
      (module) => module.ConnectorDetailPanels,
    ),
  {
    loading: () => (
      <p role="status" className="text-sm text-muted-foreground">
        Loading connector detail…
      </p>
    ),
  },
);

const LeadCaptureConnectForm = dynamic(
  () =>
    import("@/components/integrations/lead-capture-connect-form").then(
      (module) => module.LeadCaptureConnectForm,
    ),
  {
    loading: () => (
      <p role="status" className="text-sm text-muted-foreground">
        Checking your workspace role…
      </p>
    ),
  },
);

const ConnectPanel = dynamic(
  () =>
    import("@/components/integrations/connect-panel").then(
      (module) => module.ConnectPanel,
    ),
  {
    loading: () => (
      <div
        role="status"
        aria-label="Loading connection setup"
        className="space-y-3"
      >
        <span className="sr-only">Loading connection setup…</span>
        <div className="h-10 w-full animate-pulse rounded bg-muted/40 motion-reduce:animate-none" />
        <div className="h-10 w-40 animate-pulse rounded bg-muted/40 motion-reduce:animate-none" />
      </div>
    ),
  },
);

// The release-held support connect dialog (desktop parity platform-91) opens
// on demand from its trigger, so its chunk — the static provider catalog read
// and the held form — is never part of the route's initial graph.
const SupportProviderConnectDialog = dynamic(
  () =>
    import("@/components/integrations/support-provider-connect-dialog").then(
      (module) => module.SupportProviderConnectDialog,
    ),
  {
    ssr: false,
    loading: () => (
      <p role="status" aria-label="Loading support provider connect">
        <span className="sr-only">Loading support provider connect…</span>
      </p>
    ),
  },
);

function normalize(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function statusVariant(
  status: string,
): "success" | "warning" | "destructive" | "secondary" {
  const s = status.toLowerCase();
  if (s === "active" || s === "connected") return "success";
  if (s === "error" || s === "failed") return "destructive";
  if (s === "paused") return "warning";
  return "secondary";
}

interface IntegrationDetailData {
  item: CatalogItem | null;
  surface: CatalogSurface | null;
  spec: ProviderSpec | null;
  connections: SurfaceIntegration[];
  /** The row's native lifecycle family, from its badge and owning sources. */
  lifecycleFamily: NativeLifecycleFamily | null;
  /** Release-held support provider: no runtime verb may be offered. */
  supportHeld: boolean;
  specUnavailable: boolean;
  connectionsUnavailable: boolean;
  authorizationRejected: boolean;
  notFound: boolean;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("The integration request was aborted.", "AbortError");
}

async function loadIntegrationDetail(
  slug: string,
  // Reuse the catalog already in the list's cache when present, so opening a
  // detail page doesn't re-download all ~630 items (INTG-046). Only the
  // per-surface spec + connections are fetched fresh.
  resolveCatalog: (signal?: AbortSignal) => Promise<IntegrationsCatalog>,
  signal?: AbortSignal,
): Promise<IntegrationDetailData> {
  throwIfAborted(signal);
  const catalog = await resolveCatalog(signal);
  throwIfAborted(signal);
  const found = catalog.items.find((i) => i.slug === slug) ?? null;
  if (!found) {
    return {
      item: null,
      surface: null,
      spec: null,
      connections: [],
      lifecycleFamily: null,
      supportHeld: false,
      specUnavailable: false,
      connectionsUnavailable: false,
      authorizationRejected: false,
      notFound: true,
    };
  }

  // The catalog row's lifecycle family and support hold, read from its
  // declared owning sources (a row without sources has neither). The
  // classifiers live in the lifecycle client, which the detail panels load on
  // demand, so they are read here alongside the data they describe rather
  // than in the render graph.
  const { isSupportRuntimeHeld, nativeLifecycleFamily } =
    await import("@/lib/integrations-lifecycle-api");
  throwIfAborted(signal);
  const foundSources = Array.isArray(found.sources) ? found.sources : [];
  const lifecycleFamily = nativeLifecycleFamily({
    badge: found.badge,
    sources: foundSources,
  });
  const supportHeld = isSupportRuntimeHeld({
    category: found.category,
    sources: foundSources,
  });

  const surface = surfaceForCatalogItem(found);
  if (!surface) {
    return {
      item: found,
      surface: null,
      spec: null,
      connections: [],
      lifecycleFamily,
      supportHeld,
      specUnavailable: false,
      connectionsUnavailable: false,
      authorizationRejected: false,
      notFound: false,
    };
  }

  const [specResult, integrationsResult] = await Promise.allSettled([
    surface.client.providers({ signal }),
    surface.client.list({ signal }),
  ]);
  throwIfAborted(signal);
  const specs =
    specResult.status === "fulfilled" && Array.isArray(specResult.value)
      ? specResult.value
      : [];
  const integrations =
    integrationsResult.status === "fulfilled" &&
    Array.isArray(integrationsResult.value)
      ? integrationsResult.value
      : [];
  const matched =
    specs.find((s) => s.provider === slug) ??
    specs.find((s) => normalize(s.provider) === normalize(slug)) ??
    null;
  const spec = matched ?? {
    provider: slug,
    name: found.name,
    category: found.category,
    auth_mode: surface.ingestSyncModel ? "ingest_token_ref" : "api_key_ref",
    managed: false,
    runtime_status: found.runtime_status,
    ...(surface.ingestSyncModel ? { sync_model: surface.ingestSyncModel } : {}),
    capabilities: found.capabilities ?? [],
    required_settings: [],
    scopes: [],
    sync_objects: [],
    docs_url: found.docs_url ?? "",
  };
  const connections = integrations.filter(
    (c) => c.provider === slug || normalize(c.provider) === normalize(slug),
  );

  return {
    item: found,
    surface,
    spec,
    connections,
    lifecycleFamily,
    supportHeld,
    specUnavailable: specResult.status === "rejected",
    connectionsUnavailable: integrationsResult.status === "rejected",
    authorizationRejected: [specResult, integrationsResult].some(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof ApiError &&
        (result.reason.status === 401 || result.reason.status === 403),
    ),
    notFound: false,
  };
}

/** Returns a catalog resolver that prefers the list's cached copy (INTG-046). */
function makeCatalogResolver(
  queryClient: QueryClient,
  catalogKey: readonly unknown[],
): (signal?: AbortSignal) => Promise<IntegrationsCatalog> {
  return (signal?: AbortSignal) => {
    throwIfAborted(signal);
    const cached = queryClient.getQueryData<IntegrationsCatalog>(
      catalogKey as never,
    );
    if (cached) return Promise.resolve(cached);
    return integrationsCatalogApi.get({ signal });
  };
}

export default function IntegrationDetailPage() {
  const queryClient = useQueryClient();
  const params = useParams<{ slug: string }>();
  const slug =
    (Array.isArray(params.slug) ? params.slug[0] : params.slug) ?? "";

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
  const previousAdminScopeRef = useRef<{
    fingerprint: string;
    queryKey: readonly unknown[];
  } | null>(null);

  useEffect(() => {
    if (meQuery.isPending) return;
    const previous = previousAdminScopeRef.current;
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
        queryKey: ["integrations"],
        exact: false,
      });
      queryClient.removeQueries({ queryKey: ["integrations"], exact: false });
    }
    previousAdminScopeRef.current = current;
  }, [
    authorityKey,
    canAdmin,
    integrationsBaseKey,
    meQuery.isPending,
    queryClient,
  ]);

  if (meQuery.isPending) {
    return <DetailAccessState kind="loading" slug={slug} />;
  }
  if (meQuery.isError || !identity) {
    return (
      <DetailAccessState
        kind="error"
        slug={slug}
        message={apiErrorMessage(
          meQuery.error,
          "Moosewave could not verify the current workspace identity.",
        )}
        retrying={meQuery.isFetching}
        onRetry={() => void meQuery.refetch()}
      />
    );
  }
  if (!canAdmin) {
    return <DetailAccessState kind="read-only" slug={slug} />;
  }

  return (
    <AuthorizedIntegrationDetail
      key={`${authorityKey}\u001f${slug}`}
      slug={slug}
      identity={identity}
      authorityKey={authorityKey}
      integrationsBaseKey={integrationsBaseKey}
    />
  );
}

function AuthorizedIntegrationDetail({
  slug,
  identity,
  authorityKey,
  integrationsBaseKey,
}: {
  slug: string;
  identity: MeResponse;
  authorityKey: string;
  integrationsBaseKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<{
    id: string;
    name: string;
  } | null>(null);
  // Desktop parity platform-91: the held support connect dialog, opened from
  // its trigger. Its submit stays disabled with the hold reason.
  const [supportConnectOpen, setSupportConnectOpen] = useState(false);
  const lifecycleLockRef = useRef(false);
  const lifecycleControllerRef = useRef<AbortController | null>(null);
  const authorityKeyRef = useRef(authorityKey);
  authorityKeyRef.current = authorityKey;

  useEffect(
    () => () => {
      lifecycleControllerRef.current?.abort();
      lifecycleControllerRef.current = null;
      lifecycleLockRef.current = false;
    },
    [],
  );

  const catalogKey = useMemo(
    () => [...integrationsBaseKey, "catalog"] as const,
    [integrationsBaseKey],
  );
  const detailKey = useMemo(
    () => [...integrationsBaseKey, "catalog-detail", slug] as const,
    [integrationsBaseKey, slug],
  );
  const resolveCatalog = useMemo(
    () => makeCatalogResolver(queryClient, catalogKey),
    [queryClient, catalogKey],
  );
  const detailQuery = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) =>
      loadIntegrationDetail(slug, resolveCatalog, signal),
    staleTime: STALE.detail,
    retry: false,
  });
  const loading = detailQuery.isPending && !detailQuery.data;
  const error = detailQuery.isError
    ? detailQuery.error instanceof ApiError &&
      (detailQuery.error.status === 401 || detailQuery.error.status === 403)
      ? "This integration is unavailable because the server did not accept owner/admin authority. No denied catalog or connection result is being shown as empty."
      : apiErrorMessage(
          detailQuery.error,
          "Could not load this integration — this is a failed request, not an integration with nothing configured",
        )
    : null;

  const detailData = detailQuery.isError ? null : detailQuery.data;
  const item = detailData?.item ?? null;
  const surface = detailData?.surface ?? null;
  const authorizationRejected = detailData?.authorizationRejected ?? false;
  // A mixed fan-out can race: one admin endpoint may reject while another
  // succeeds under authority that has just changed. Keep the catalog identity
  // visible, but do not paint provider requirements or connection rows from
  // that mixed result.
  const spec = authorizationRejected ? null : (detailData?.spec ?? null);
  const connections =
    !authorizationRejected && Array.isArray(detailData?.connections)
      ? detailData?.connections
      : [];
  const notFound = detailData?.notFound ?? false;
  const specUnavailable = detailData?.specUnavailable ?? false;
  const connectionsUnavailable = detailData?.connectionsUnavailable ?? false;

  useEffect(() => {
    if (!error && !authorizationRejected) return;
    // A late authorization rejection must also tear down privileged UI that
    // was opened from an earlier successful read. The dialog description can
    // contain a tenant-scoped connection name, and an in-flight lifecycle
    // intent must not outlive the now-unavailable detail surface.
    setConfirmDisconnect(null);
    setSupportConnectOpen(false);
    lifecycleControllerRef.current?.abort();
    lifecycleControllerRef.current = null;
    lifecycleLockRef.current = false;
    setBusyId(null);
  }, [authorizationRejected, error]);

  const invalidateIntegrationDetail = (): Promise<void> =>
    Promise.all([
      detailQuery.refetch(),
      queryClient.invalidateQueries({
        queryKey: [...integrationsBaseKey, "lifecycle-detail", slug],
        exact: true,
      }),
      queryClient.invalidateQueries({
        queryKey: [...integrationsBaseKey, "lifecycle-health", slug],
        exact: true,
      }),
    ]).then(() => undefined);

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

  async function lifecycle(
    id: string,
    action: "sync" | "pause" | "disconnect",
  ) {
    if (!surface || lifecycleLockRef.current) return;
    const intent = {
      id,
      action,
      authorityKey,
      client: surface.client,
    } as const;
    const controller = new AbortController();
    lifecycleLockRef.current = true;
    lifecycleControllerRef.current = controller;
    setBusyId(id);
    try {
      await beforeWrite(controller.signal);
      if (
        controller.signal.aborted ||
        authorityKeyRef.current !== intent.authorityKey
      ) {
        return;
      }
      await intent.client[intent.action](intent.id, {
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        authorityKeyRef.current !== intent.authorityKey
      ) {
        return;
      }
      toast.success(
        intent.action === "sync"
          ? "Sync started"
          : intent.action === "pause"
            ? "Integration paused"
            : "Integration disconnected",
      );
      await invalidateIntegrationDetail();
    } catch (e) {
      if (
        !controller.signal.aborted &&
        authorityKeyRef.current === intent.authorityKey
      ) {
        toast.error(apiErrorMessage(e, `${intent.action} failed`));
      }
    } finally {
      if (lifecycleControllerRef.current === controller) {
        lifecycleControllerRef.current = null;
        lifecycleLockRef.current = false;
        setBusyId(null);
      }
    }
  }

  // Per-integration document title so the tab identifies the deep-link and
  // history is legible (INTG-039). Restored on unmount.
  useEffect(() => {
    if (!item) return;
    const previous = document.title;
    document.title = `${item.name} · Integrations · Moosewave`;
    return () => {
      document.title = previous;
    };
  }, [item]);

  // The catalog row's lifecycle family and support hold, classified with the
  // detail read (a row without sources has neither).
  const lifecycleFamily = detailData?.lifecycleFamily ?? null;
  const supportHeld = detailData?.supportHeld ?? false;
  // A category whose connect verb is built but release-held resolves to the
  // named dialog rather than a live CatalogSurface (catalog-connect-map).
  const heldConnect = item ? heldConnectSurfaceForCatalogItem(item) : null;

  const connectKind = useMemo(() => {
    if (!spec) return "";
    if (spec.managed && surface?.client.oauthStartUrl) return "OAuth";
    if (isIngestSpec(spec)) return "Webhook ingest";
    return "Credential reference";
  }, [spec, surface]);

  return (
    <DataSurfaceShell className="max-w-3xl">
      <Breadcrumb
        items={[
          { label: "Integrations", href: asRoute("/app/integrations") },
          { label: "Catalog", href: asRoute("/app/integrations/catalog") },
          { label: item?.name ?? slug },
        ]}
      />

      {loading && <DetailSkeleton />}

      {!loading && notFound && (
        <Card role="alert" className="border-destructive/40 bg-destructive/5">
          <CardContent className="p-6">
            <EmptyState
              icon={PackageOpen}
              title="Integration not found"
              description={`“${slug}” isn’t in the catalog — it may have been renamed or removed.`}
              action={
                <Button asChild>
                  <Link href="/app/integrations/catalog">Back to catalog</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      )}

      {!loading && error && (
        <Card role="alert">
          <CardContent className="flex flex-col items-start gap-3 p-6">
            <p className="text-sm text-destructive">{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void detailQuery.refetch()}
            >
              Try again
            </Button>
          </CardContent>
        </Card>
      )}

      {!loading && !error && item && (
        <>
          {/* Hero */}
          <header className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <h1 className="min-w-0 break-words font-display text-2xl font-semibold tracking-tight sm:text-3xl">
                {item.name}
              </h1>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <Badge variant={item.native ? "default" : "secondary"}>
                  {badgeLabel(item.badge)}
                </Badge>
                <Badge variant={runtimeStatusTone(item.runtime_status)}>
                  {runtimeStatusLabel(item.runtime_status)}
                </Badge>
              </div>
            </div>
            <p className="break-words text-sm leading-6 text-muted-foreground">
              {item.summary}
            </p>
            {item.capabilities?.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {item.capabilities.map((c) => (
                  <span
                    key={c}
                    className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {c}
                  </span>
                ))}
              </div>
            )}
            {item.docs_url && (
              <DocsLink
                href={item.docs_url}
                className="inline-block text-sm text-primary hover:underline"
              />
            )}
          </header>

          {/* The server's own connector detail: lifecycle verbs, health,
              contract, setup steps and recipes. Never for a release-held
              support provider — its runtime verbs must not be offered. */}
          {!supportHeld && (
            <ConnectorDetailPanels
              slug={item.slug}
              onChanged={invalidateIntegrationDetail}
            />
          )}

          {heldConnect && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Support integration runtime held
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <p>
                  This provider is available for catalog exploration only.
                  Support credentials, connection creation, ingest provisioning,
                  sync, backfill, ingest, pause, disconnect, and run history are
                  release-held.
                </p>
                <p>
                  No support runtime request was sent. Hold code:{" "}
                  <code>{heldConnect.holdCode}</code>.
                </p>
                {/* The connect verb itself, as desktop offers it: the dialog
                    lists the static provider catalog and keeps its submit
                    disabled with the hold reason. */}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setSupportConnectOpen(true)}
                >
                  Connect
                </Button>
                {supportConnectOpen ? (
                  <SupportProviderConnectDialog
                    item={{ slug: item.slug, name: item.name }}
                    open={supportConnectOpen}
                    onOpenChange={setSupportConnectOpen}
                    onConnected={invalidateIntegrationDetail}
                  />
                ) : null}
              </CardContent>
            </Card>
          )}

          {/* Lead-capture providers save a managed configuration here. */}
          {lifecycleFamily === "lead_capture" && (
            <LeadCaptureConnectForm
              provider={item.slug}
              providerName={item.name}
              onConnected={invalidateIntegrationDetail}
            />
          )}

          {/* Not a connectable owning surface: offer the backend-specified
              setup surface instead of a dead-end (INTG-006). */}
          {!surface &&
            !heldConnect &&
            lifecycleFamily !== "lead_capture" &&
            (() => {
              const setup = resolveSetupPath(item.setup_path);
              return (
                <Card>
                  <CardContent className="space-y-3 p-6 text-sm text-muted-foreground">
                    <p>
                      This integration is set up from another surface in
                      Moosewave, not connected directly here.
                    </p>
                    {setup ? (
                      <Button asChild>
                        <Link href={setup.href}>Set up in {setup.label} →</Link>
                      </Button>
                    ) : (
                      <p>Follow its docs to set it up.</p>
                    )}
                  </CardContent>
                </Card>
              );
            })()}

          {surface && (specUnavailable || connectionsUnavailable) ? (
            <Card
              role="alert"
              className="border-destructive/40 bg-destructive/5"
            >
              <CardContent className="space-y-3 p-5">
                <p className="text-sm font-medium text-destructive">
                  {authorizationRejected
                    ? "Admin authorization was rejected"
                    : "Integration setup data is incomplete"}
                </p>
                <p className="text-sm leading-6 text-muted-foreground">
                  {authorizationRejected
                    ? "The denied request is unavailable, not an empty provider or workspace. "
                    : ""}
                  {specUnavailable
                    ? "Provider requirements could not be loaded. "
                    : ""}
                  {connectionsUnavailable
                    ? "Existing connections could not be loaded. "
                    : ""}
                  Setup controls are paused so this is not mistaken for an
                  unconfigured provider or used to create a duplicate.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void detailQuery.refetch()}
                >
                  Try again
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {/* Existing connections */}
          {surface && !connectionsUnavailable && connections.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Connections</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {connections.map((c) => {
                  const busy = busyId === c.id;
                  const lifecycleBusy = busyId !== null;
                  const paused = c.status.toLowerCase() === "paused";
                  const disconnected = c.status.toLowerCase() === "disconnected";
                  return (
                    <div
                      key={c.id}
                      className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {c.name || c.provider}
                          </span>
                          <Badge variant={statusVariant(c.status)}>
                            {c.status || "unknown"}
                          </Badge>
                        </div>
                        {c.error_message && (
                          <p
                            className="mt-1 break-words text-xs text-destructive"
                            title={c.error_message}
                          >
                            {c.error_message}
                          </p>
                        )}
                        {disconnected && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Reconnect with the same name and credential reference
                            below to resume the saved checkpoint.
                          </p>
                        )}
                        {/* Surface sync recency so operators can tell a live
                            connection from a stalled one (INTG-048). */}
                        <p className="mt-1 text-xs text-muted-foreground">
                          {c.last_sync_at ? (
                            <>
                              last synced <RelativeTime iso={c.last_sync_at} />
                            </>
                          ) : (
                            "never synced"
                          )}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          loading={busy}
                          disabled={lifecycleBusy || disconnected}
                          onClick={() => void lifecycle(c.id, "sync")}
                        >
                          Sync now
                        </Button>
                        {!paused && !disconnected && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={lifecycleBusy}
                            onClick={() => void lifecycle(c.id, "pause")}
                          >
                            Pause
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={lifecycleBusy || disconnected}
                          className="text-destructive"
                          onClick={() =>
                            setConfirmDisconnect({
                              id: c.id,
                              name: c.name || c.provider,
                            })
                          }
                        >
                          Disconnect
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {/* Connect */}
          {surface && spec && !specUnavailable && !connectionsUnavailable && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {connections.length > 0
                    ? "Add another connection"
                    : "Connect"}
                  {connectKind && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      · {connectKind}
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ConnectPanel
                  key={`${authorityKey}\u001f${spec.provider}`}
                  spec={spec}
                  surface={surface.client}
                  authorityKey={authorityKey}
                  beforeWrite={beforeWrite}
                  onConnected={invalidateIntegrationDetail}
                />
              </CardContent>
            </Card>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmDisconnect !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmDisconnect(null);
        }}
        title="Disconnect integration?"
        description={
          confirmDisconnect
            ? `Moosewave will stop syncing from ${confirmDisconnect.name}. You can reconnect it later.`
            : ""
        }
        confirmLabel="Disconnect"
        onConfirm={async () => {
          if (confirmDisconnect) {
            await lifecycle(confirmDisconnect.id, "disconnect");
          }
          setConfirmDisconnect(null);
        }}
      />
    </DataSurfaceShell>
  );
}

function DetailAccessState({
  kind,
  slug,
  message,
  retrying = false,
  onRetry,
}: {
  kind: "loading" | "error" | "read-only";
  slug: string;
  message?: string;
  retrying?: boolean;
  onRetry?: () => void;
}) {
  return (
    <DataSurfaceShell className="max-w-3xl">
      <Breadcrumb
        items={[
          { label: "Integrations", href: asRoute("/app/integrations") },
          { label: "Catalog", href: asRoute("/app/integrations/catalog") },
          { label: slug || "Integration" },
        ]}
      />
      <Card role={kind === "loading" ? "status" : "alert"}>
        <CardHeader>
          <CardTitle>
            {kind === "loading"
              ? "Checking integration access…"
              : kind === "error"
                ? "Couldn’t verify integration access"
                : "Owner or admin access required"}
          </CardTitle>
          <p className="text-sm leading-6 text-muted-foreground">
            {kind === "loading"
              ? "Moosewave is confirming the current workspace and effective role before requesting protected integration data."
              : kind === "error"
                ? `${message ?? "The identity check failed."} No catalog, provider, or connection request was made.`
                : `${ADMIN_READ_ONLY_MESSAGE} No catalog, provider, or connection request was made.`}
          </p>
        </CardHeader>
        <CardContent className="flex gap-2">
          {kind === "error" && onRetry ? (
            <Button type="button" onClick={onRetry} loading={retrying}>
              {retrying ? "Retrying…" : "Retry access check"}
            </Button>
          ) : null}
          <Button asChild variant="outline">
            <Link href="/app/integrations">Back to integrations</Link>
          </Button>
        </CardContent>
      </Card>
    </DataSurfaceShell>
  );
}

/** Content-shaped loading skeleton matching the hero + cards (INTG-011). */
function DetailSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading integration">
      <span className="sr-only">Loading integration…</span>
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="h-8 w-48 animate-pulse rounded bg-muted/50 motion-reduce:animate-none" />
          <div className="flex gap-2">
            <div className="h-6 w-16 animate-pulse rounded-full bg-muted/50" />
            <div className="h-6 w-20 animate-pulse rounded-full bg-muted/50" />
          </div>
        </div>
        <div className="h-4 w-full max-w-lg animate-pulse rounded bg-muted/40" />
        <div className="flex gap-1.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-5 w-16 animate-pulse rounded-full bg-muted/40"
            />
          ))}
        </div>
      </div>
      <div className="h-32 animate-pulse rounded-lg border bg-muted/30" />
      <div className="h-40 animate-pulse rounded-lg border bg-muted/30" />
    </div>
  );
}
