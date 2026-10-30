// SPDX-License-Identifier: AGPL-3.0-only
//
// One integrations index page covering all three chat platforms
// (Slack / Discord / Teams). Each tab is the same form + list shape;
// the only delta is the URL pattern + the API resource it talks to.
"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MessageSquareText, Plug } from "lucide-react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DataSurfaceShell,
  QueryError,
} from "@/components/integrations/data-surface";
import { IntegrationsPageHeader } from "@/components/integrations/integrations-page-header";
import { RelativeTime } from "@/components/relative-time";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { effectiveAuthRole, whoami, type MeResponse } from "@/lib/auth-api";
import {
  ALL_EVENT_TYPES,
  discordIntegrationsApi,
  slackIntegrationsApi,
  teamsIntegrationsApi,
  type ChatDelivery,
  type ChatIntegration,
} from "@/lib/integrations-api";
import { base, qk, STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";

const CommerceIntegrationsPanel = dynamic(
  () =>
    import("./commerce-integrations-panel").then(
      (module) => module.CommerceIntegrationsPanel,
    ),
  { loading: () => <SecondaryPanelFallback title="Commerce" /> },
);

const CrmLifecyclePanel = dynamic(
  () =>
    import("@/components/integrations/crm-lifecycle-panel").then(
      (mod) => mod.CrmLifecyclePanel,
    ),
  { loading: () => <SecondaryPanelFallback title="CRM" /> },
);

const WritebackTargetsPanel = dynamic(
  () =>
    import("@/components/integrations/writeback-targets-panel").then(
      (mod) => mod.WritebackTargetsPanel,
    ),
  { loading: () => <SecondaryPanelFallback title="Two-way sync" /> },
);

const ConversionKeysPanel = dynamic(
  () =>
    import("@/components/integrations/conversion-keys-panel").then(
      (mod) => mod.ConversionKeysPanel,
    ),
  {
    loading: () => <SecondaryPanelFallback title="Conversion tracking keys" />,
  },
);

const ConversionIngestSecretsPanel = dynamic(
  () =>
    import("@/components/integrations/conversion-ingest-secrets-panel").then(
      (mod) => mod.ConversionIngestSecretsPanel,
    ),
  {
    loading: () => (
      <SecondaryPanelFallback title="Trusted server conversion ingest" />
    ),
  },
);

const MultiChannelOpsPanel = dynamic(
  () =>
    import("@/components/mailchimp-parity/multi-channel-ops-panel").then(
      (mod) => mod.MultiChannelOpsPanel,
    ),
  {
    loading: () => <SecondaryPanelFallback title="Multi-channel operations" />,
  },
);

const PlatformOpsPanel = dynamic(
  () =>
    import("@/components/mailchimp-parity/platform-ops-panel").then(
      (mod) => mod.PlatformOpsPanel,
    ),
  { loading: () => <SecondaryPanelFallback title="Platform operations" /> },
);

type Provider = "slack" | "discord" | "teams";

const CHAT_ADMIN_MESSAGE =
  "Team chat integrations are available only to workspace owners and admins. No protected integration data was requested.";

function chatIdentityFingerprint(identity: MeResponse): string {
  return [
    identity.user_id,
    identity.tenant_id,
    effectiveAuthRole(identity),
    identity.viewer_mode === true ? "viewer" : "member",
  ].join("\u001f");
}

function isChatQueryForTenant(
  queryKey: readonly unknown[],
  tenantId: string,
): boolean {
  return (
    queryKey[0] === "integrations" &&
    queryKey[1] === tenantId &&
    queryKey.includes("chat")
  );
}

const apis = {
  slack: slackIntegrationsApi,
  discord: discordIntegrationsApi,
  teams: teamsIntegrationsApi,
} as const;

// INTG-033 Slice B: self-fetching delivery history for one integration.
function DeliveryHistory({ provider, id }: { provider: Provider; id: string }) {
  const [rows, setRows] = useState<ChatDelivery[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setRows(null);
    setFailed(false);
    apis[provider]
      .deliveries(id)
      .then((r) => active && setRows(r))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [provider, id]);

  if (failed)
    return (
      <p className="mt-2 text-xs text-destructive" role="alert">
        Could not load delivery history.
      </p>
    );
  if (rows === null)
    return (
      <div className="mt-2" role="status" aria-label="Loading delivery history">
        <span className="sr-only">Loading delivery history…</span>
        <div className="h-8 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      </div>
    );
  if (rows.length === 0)
    return (
      <p className="mt-2 text-xs text-muted-foreground">No deliveries yet.</p>
    );
  return (
    <ul className="mt-2 divide-y rounded-md border text-xs">
      {rows.map((d) => (
        <li
          key={d.id}
          className="flex flex-wrap items-center gap-2 px-2 py-1.5"
        >
          <span
            className={
              d.status === "success" ? "text-accent" : "text-destructive"
            }
          >
            {d.status === "success" ? "✓" : "✗"} {d.event_type || "event"}
          </span>
          {d.error ? (
            <span
              className="min-w-0 truncate font-mono text-muted-foreground"
              title={d.error}
            >
              {d.error}
            </span>
          ) : null}
          <RelativeTime iso={d.created_at} className="ml-auto shrink-0" />
        </li>
      ))}
    </ul>
  );
}

const placeholders = {
  slack: "https://hooks.slack.com/services/T.../B.../xxx",
  discord: "https://discord.com/api/webhooks/<channel>/<token>",
  teams: "https://<tenant>.webhook.office.com/webhookb2/...",
} as const;

const labels = {
  slack: "Slack",
  discord: "Discord",
  teams: "Microsoft Teams",
} as const;

// In-page anchor nav so the seven heterogeneous sections are reachable without
// scrolling the whole kitchen-sink page (INTG-020).
const SECTIONS = [
  { id: "chat", label: "Team chat" },
  { id: "crm", label: "CRM" },
  { id: "two-way-sync", label: "Two-way sync" },
  { id: "commerce", label: "Commerce" },
  { id: "conversion-keys", label: "Conversion keys" },
  { id: "multi-channel", label: "Multi-channel" },
  { id: "platform-ops", label: "Platform ops" },
] as const;

export default function IntegrationsPage() {
  const [tab, setTab] = useState<Provider>("slack");

  return (
    <DataSurfaceShell className="max-w-6xl">
      <IntegrationsPageHeader
        icon={Plug}
        title="Integrations"
        description="Pipe Moosewave events into your team chat, connect a CRM, sync audiences two ways, and manage conversion keys — all in one place."
      />
      <p className="text-muted-foreground text-sm">
        Looking for support, reviews, loyalty, subscriptions or analytics
        connectors?{" "}
        <Link
          href="/app/integrations/catalog"
          className="inline-flex min-h-11 items-center rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
        >
          Browse the full integration catalog →
        </Link>
      </p>

      <nav
        aria-label="Sections"
        tabIndex={0}
        className="sticky top-2 z-10 -mx-1 flex gap-1.5 overflow-x-auto rounded-lg border border-border bg-background/90 p-1.5 shadow-sm backdrop-blur focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring supports-[backdrop-filter]:bg-background/75"
      >
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="inline-flex min-h-11 shrink-0 items-center rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
          >
            {s.label}
          </a>
        ))}
      </nav>

      <section id="chat" className="scroll-mt-24">
        <div className="mb-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <MessageSquareText className="h-4 w-4 text-muted-foreground" />
            Team chat
          </h2>
          <p className="text-sm text-muted-foreground">
            Pick events; we format them as native messages and POST to your
            webhook.
          </p>
        </div>
        {/* Radix Tabs gives roving tabindex + arrow-key navigation for free
            (INTG-021/043). */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as Provider)}>
          <TabsList aria-label="Messaging provider" className="mb-4">
            {(["slack", "discord", "teams"] as const).map((p) => (
              <TabsTrigger key={p} value={p}>
                {labels[p]}
              </TabsTrigger>
            ))}
          </TabsList>
          {(["slack", "discord", "teams"] as const).map((provider) => (
            <TabsContent key={provider} value={provider}>
              <IntegrationManager provider={provider} />
            </TabsContent>
          ))}
        </Tabs>
      </section>

      <div id="crm" className="scroll-mt-24">
        <DeferredSecondaryPanel title="CRM">
          <CrmLifecyclePanel />
        </DeferredSecondaryPanel>
      </div>

      <div id="two-way-sync" className="scroll-mt-24">
        <DeferredSecondaryPanel title="Two-way sync">
          <WritebackTargetsPanel />
        </DeferredSecondaryPanel>
      </div>

      <div id="commerce" className="scroll-mt-24">
        <CommerceIntegrationsPanel />
      </div>

      <div id="conversion-keys" className="scroll-mt-24">
        <DeferredSecondaryPanel title="Conversion tracking keys">
          <ConversionKeysPanel />
        </DeferredSecondaryPanel>
        <DeferredSecondaryPanel title="Trusted server conversion ingest">
          <ConversionIngestSecretsPanel />
        </DeferredSecondaryPanel>
      </div>

      <div className="mt-8 space-y-6">
        <div id="multi-channel" className="scroll-mt-24">
          <DeferredSecondaryPanel
            title="Multi-channel operations"
            fallback={<CardPanelFallback title="Multi-channel operations" />}
          >
            <MultiChannelOpsPanel />
          </DeferredSecondaryPanel>
        </div>
        <div id="platform-ops" className="scroll-mt-24">
          <DeferredSecondaryPanel
            title="Platform operations"
            fallback={<CardPanelFallback title="Platform operations" />}
          >
            <PlatformOpsPanel />
          </DeferredSecondaryPanel>
        </div>
      </div>
    </DataSurfaceShell>
  );
}

function DeferredSecondaryPanel({
  children,
  fallback,
  title,
}: {
  children: ReactNode;
  fallback?: ReactNode;
  title: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (ready) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setReady(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setReady(true);
          observer.disconnect();
        }
      },
      { rootMargin: "640px 0px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [ready]);

  return (
    <div ref={ref}>
      {ready
        ? children
        : (fallback ?? <SecondaryPanelFallback title={title} />)}
    </div>
  );
}

function SecondaryPanelFallback({ title }: { title: string }) {
  return (
    <section className="mt-8 border-t border-border pt-6" aria-busy="true">
      <div className="mb-4 space-y-2">
        <div className="text-lg font-semibold">{title}</div>
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    </section>
  );
}

function CardPanelFallback({ title }: { title: string }) {
  return (
    <section
      className="rounded-lg border border-border bg-card p-6"
      aria-busy="true"
    >
      <div className="mb-4 space-y-2">
        <div className="text-lg font-semibold">{title}</div>
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    </section>
  );
}

function IntegrationManager({ provider }: { provider: Provider }) {
  const queryClient = useQueryClient();
  const apiClient = apis[provider];
  const [actionError, setActionError] = useState<string | null>(null);
  // INTG-033: per-integration test-send state.
  const [testingId, setTestingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [testFeedback, setTestFeedback] = useState<{
    id: string;
    ok: boolean;
    message: string;
  } | null>(null);
  // INTG-033 Slice B: which integration's delivery history is expanded.
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [draftURL, setDraftURL] = useState("");
  const [draftHint, setDraftHint] = useState("");
  const [draftEvents, setDraftEvents] = useState<string[]>([
    "subscriber.unsubscribed",
    "campaign.sent",
  ]);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ChatIntegration | null>(
    null,
  );
  // State is not synchronous enough to stop two clicks in the same event
  // turn. This lock is acquired before any await and spans every page-owned
  // chat mutation so duplicate or overlapping writes cannot leave the list in
  // an ambiguous state.
  const operationRef = useRef<{
    kind: string;
    controller: AbortController;
  } | null>(null);
  const authorityControllerRef = useRef<AbortController | null>(null);
  const latestIdentityFingerprintRef = useRef<string | null>(null);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const effectiveRole = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const viewerMode = meQuery.data?.viewer_mode === true;
  const canAdmin =
    meQuery.isSuccess &&
    Boolean(meQuery.data) &&
    !viewerMode &&
    roleCanWrite(effectiveRole);
  const identityFingerprint = meQuery.data
    ? chatIdentityFingerprint(meQuery.data)
    : null;
  latestIdentityFingerprintRef.current = identityFingerprint;
  const integrationsBaseKey = useMemo(
    () => base("integrations", tenantId, effectiveRole),
    [effectiveRole, tenantId],
  );
  const chatKey = useMemo(
    () =>
      [
        ...integrationsBaseKey,
        "chat",
        provider,
        meQuery.data?.user_id ?? "anon",
        viewerMode ? "viewer" : "member",
      ] as const,
    [integrationsBaseKey, meQuery.data?.user_id, provider, viewerMode],
  );
  const chatQuery = useQuery({
    queryKey: chatKey,
    queryFn: () => apiClient.list(),
    // The API protects even this list with ScopeAdmin. Editors and viewers
    // must not probe it and must not infer an empty workspace from a 403.
    enabled: canAdmin,
    retry: false,
    staleTime: STALE.list,
  });
  const items = Array.isArray(chatQuery.data) ? chatQuery.data : [];
  const loading = meQuery.isLoading || (chatQuery.isPending && !chatQuery.data);
  const loadError =
    chatQuery.error instanceof Error
      ? chatQuery.error.message
      : meQuery.error instanceof Error
        ? meQuery.error.message
        : chatQuery.isError
          ? "Could not load chat integrations — this is a failed request, not an empty list."
          : null;

  const error = actionError ?? loadError;

  useEffect(() => {
    authorityControllerRef.current?.abort();
    authorityControllerRef.current = null;
    operationRef.current = null;

    if (!canAdmin && meQuery.data) {
      // Remove every role/viewer variant for this tenant. In particular, an
      // owner who enters viewer mode must not retain an admin list that a
      // later render could accidentally reuse.
      queryClient.removeQueries({
        predicate: (query) =>
          isChatQueryForTenant(query.queryKey, meQuery.data.tenant_id),
      });
      setShowNew(false);
      setDeleteTarget(null);
      setHistoryFor(null);
      setTestFeedback(null);
      setCreating(false);
      setTestingId(null);
      setTogglingId(null);
    }
  }, [canAdmin, identityFingerprint, meQuery.data, queryClient]);

  useEffect(
    () => () => {
      authorityControllerRef.current?.abort();
      authorityControllerRef.current = null;
      operationRef.current = null;
    },
    [],
  );

  useEffect(() => {
    // Provider-specific query keys handle list isolation; reset only local form
    // state when switching tabs.
    setActionError(null);
    setShowNew(false);
    setDraftURL("");
    setDraftHint("");
  }, [provider]);

  function beginAdminOperation(kind: string): {
    controller: AbortController;
    fingerprint: string;
    identity: MeResponse;
    key: typeof chatKey;
    token: { kind: string; controller: AbortController };
  } | null {
    if (
      !canAdmin ||
      !meQuery.data ||
      !identityFingerprint ||
      operationRef.current
    ) {
      return null;
    }
    const controller = new AbortController();
    const token = { kind, controller };
    operationRef.current = token;
    authorityControllerRef.current = controller;
    return {
      controller,
      fingerprint: identityFingerprint,
      identity: meQuery.data,
      key: chatKey,
      token,
    };
  }

  function authorityStillMatches(fingerprint: string): boolean {
    return latestIdentityFingerprintRef.current === fingerprint;
  }

  function finishAdminOperation(token: {
    kind: string;
    controller: AbortController;
  }): boolean {
    if (operationRef.current !== token) return false;
    operationRef.current = null;
    if (authorityControllerRef.current === token.controller) {
      authorityControllerRef.current = null;
    }
    return true;
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!canAdmin || !meQuery.data) return;
    // unvalidated-form: give the empty-events case visible feedback instead of a silent no-op.
    if (!draftURL.trim()) {
      setActionError("Webhook URL is required.");
      return;
    }
    if (draftEvents.length === 0) {
      setActionError("Select at least one event to deliver.");
      return;
    }
    const operation = beginAdminOperation("create");
    if (!operation) return;
    const intent = {
      url: draftURL.trim(),
      channel_hint: draftHint.trim() || undefined,
      events: [...draftEvents],
    };
    setCreating(true);
    setActionError(null);
    try {
      await verifyFreshAdminAuthority(
        operation.identity,
        operation.controller.signal,
      );
      const created = await apiClient.create(intent);
      if (!authorityStillMatches(operation.fingerprint)) {
        queryClient.removeQueries({ queryKey: operation.key, exact: true });
        return;
      }
      queryClient.setQueryData<ChatIntegration[]>(operation.key, (cur) => [
        created,
        ...(cur ?? []),
      ]);
      setShowNew(false);
      setDraftURL("");
      setDraftHint("");
      void queryClient.invalidateQueries({
        queryKey: operation.key,
        exact: false,
      });
    } catch (e) {
      if (!operation.controller.signal.aborted) {
        setActionError(e instanceof Error ? e.message : "Create failed");
      }
    } finally {
      if (finishAdminOperation(operation.token)) setCreating(false);
    }
  }

  async function onDelete(id: string) {
    const operation = beginAdminOperation(`delete:${id}`);
    if (!operation) return;
    const targetId = id;
    setActionError(null);
    try {
      await verifyFreshAdminAuthority(
        operation.identity,
        operation.controller.signal,
      );
      await apiClient.delete(targetId);
      if (!authorityStillMatches(operation.fingerprint)) {
        queryClient.removeQueries({ queryKey: operation.key, exact: true });
        return;
      }
      queryClient.setQueryData<ChatIntegration[]>(operation.key, (cur) =>
        (cur ?? []).filter((item) => item.id !== targetId),
      );
      void queryClient.invalidateQueries({
        queryKey: operation.key,
        exact: false,
      });
    } catch (e) {
      if (!operation.controller.signal.aborted) {
        setActionError(e instanceof Error ? e.message : "Delete failed");
      }
    } finally {
      finishAdminOperation(operation.token);
    }
  }

  async function onToggle(item: ChatIntegration) {
    const operation = beginAdminOperation(`toggle:${item.id}`);
    if (!operation) return;
    const intent = { id: item.id, enabled: !item.enabled };
    setTogglingId(intent.id);
    setActionError(null);
    try {
      await verifyFreshAdminAuthority(
        operation.identity,
        operation.controller.signal,
      );
      const updated = await apiClient.update(intent.id, {
        enabled: intent.enabled,
      });
      if (!authorityStillMatches(operation.fingerprint)) {
        queryClient.removeQueries({ queryKey: operation.key, exact: true });
        return;
      }
      queryClient.setQueryData<ChatIntegration[]>(operation.key, (cur) =>
        (cur ?? []).map((candidate) =>
          candidate.id === intent.id ? updated : candidate,
        ),
      );
      void queryClient.invalidateQueries({
        queryKey: operation.key,
        exact: false,
      });
    } catch (e) {
      if (!operation.controller.signal.aborted) {
        setActionError(e instanceof Error ? e.message : "Update failed");
      }
    } finally {
      if (finishAdminOperation(operation.token)) setTogglingId(null);
    }
  }

  // INTG-033: send a synthetic test notification and surface the outcome.
  async function onTest(id: string) {
    const operation = beginAdminOperation(`test:${id}`);
    if (!operation) return;
    const targetId = id;
    setActionError(null);
    setTestFeedback(null);
    setTestingId(targetId);
    try {
      await verifyFreshAdminAuthority(
        operation.identity,
        operation.controller.signal,
      );
      const res = await apiClient.test(targetId);
      if (!authorityStillMatches(operation.fingerprint)) {
        queryClient.removeQueries({ queryKey: operation.key, exact: true });
        return;
      }
      setTestFeedback(
        res.ok
          ? { id: targetId, ok: true, message: "Test notification delivered." }
          : {
              id: targetId,
              ok: false,
              message: res.error ?? "Delivery failed.",
            },
      );
      // Refresh so the last-delivery status reflects this attempt.
      void queryClient.invalidateQueries({
        queryKey: operation.key,
        exact: false,
      });
    } catch (e) {
      if (!operation.controller.signal.aborted) {
        setTestFeedback({
          id: targetId,
          ok: false,
          message: e instanceof Error ? e.message : "Delivery failed.",
        });
      }
    } finally {
      if (finishAdminOperation(operation.token)) setTestingId(null);
    }
  }

  function toggleEvent(ev: string) {
    if (!canAdmin || operationRef.current) return;
    setDraftEvents((prev) =>
      prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev],
    );
  }

  if (meQuery.isLoading) {
    return (
      <div
        className="space-y-2"
        role="status"
        aria-label="Loading chat integrations"
      >
        <span className="sr-only">Loading chat integrations…</span>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (meQuery.isError) {
    return (
      <QueryError
        title="Workspace identity could not be loaded"
        description="Chat integration reads and mutations are paused until the workspace context is verified."
        onRetry={() => void meQuery.refetch()}
      />
    );
  }

  if (!canAdmin || !meQuery.data) {
    return (
      <div
        className="rounded-xl border border-border bg-muted/20 p-4 text-sm text-muted-foreground"
        role="status"
        data-testid={`chat-admin-only-${provider}`}
      >
        <p className="font-medium text-foreground">Admin access required</p>
        <p className="mt-1">{CHAT_ADMIN_MESSAGE}</p>
        <p className="mt-1 text-xs">
          Current effective role: {effectiveRole ?? "unknown"}
          {viewerMode ? " (viewer mode)" : ""}.
        </p>
      </div>
    );
  }

  if (chatQuery.isError) {
    return (
      <QueryError
        title={`${labels[provider]} integrations could not be loaded`}
        description={
          chatQuery.error instanceof Error
            ? chatQuery.error.message
            : "The protected integration list could not be verified. Create and mutation controls remain unavailable."
        }
        onRetry={() => void chatQuery.refetch()}
      />
    );
  }

  return (
    <div>
      {chatQuery.isSuccess && (showNew || items.length > 0) ? (
        <div className="mb-4 flex justify-end">
          <Button
            type="button"
            onClick={() => setShowNew(!showNew)}
            aria-expanded={showNew}
            disabled={operationRef.current !== null}
            className="w-full sm:w-auto"
          >
            {showNew ? "Cancel" : `New ${labels[provider]} integration`}
          </Button>
        </div>
      ) : null}

      {showNew && (
        <form
          onSubmit={onCreate}
          className="mb-6 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"
          aria-label={`New ${labels[provider]} integration`}
        >
          <div>
            {/* a11y: pair label↔input so the input has an accessible name and the label is clickable */}
            <label
              htmlFor="integration-webhook-url"
              className="block text-sm text-muted-foreground mb-1"
            >
              Webhook URL
            </label>
            <input
              id="integration-webhook-url"
              type="url"
              value={draftURL}
              onChange={(e) => setDraftURL(e.target.value)}
              placeholder={placeholders[provider]}
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-base transition-colors focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:text-sm"
              required
            />
            <p className="text-xs text-muted-foreground mt-1">
              Stored encrypted. We never show it again after this point.
            </p>
          </div>
          <div>
            {/* a11y: pair label↔input so the input has an accessible name and the label is clickable */}
            <label
              htmlFor="integration-channel-hint"
              className="block text-sm text-muted-foreground mb-1"
            >
              Channel hint (optional)
            </label>
            <input
              id="integration-channel-hint"
              value={draftHint}
              onChange={(e) => setDraftHint(e.target.value)}
              placeholder="#marketing-alerts"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-base transition-colors focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-muted-foreground mb-2">
              Events
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {ALL_EVENT_TYPES.map((ev) => (
                <label
                  key={ev}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-muted/40 focus-within:ring-2 focus-within:ring-ring"
                >
                  <Checkbox
                    checked={draftEvents.includes(ev)}
                    onChange={() => toggleEvent(ev)}
                  />
                  {/* break long mono event names so they don't force horizontal overflow on small phones */}
                  <span className="font-mono text-xs break-all">{ev}</span>
                </label>
              ))}
            </div>
          </div>
          <Button
            type="submit"
            // unvalidated-form: also block submit when no events are selected (mirrors the onCreate guard).
            disabled={
              !canAdmin ||
              creating ||
              operationRef.current !== null ||
              draftEvents.length === 0
            }
            title={
              draftEvents.length === 0
                ? "Select at least one event first"
                : undefined
            }
            loading={creating}
            className="w-full sm:w-auto"
          >
            {creating ? "Creating..." : "Create"}
          </Button>
        </form>
      )}

      {error && (
        <div
          className="mb-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
          role="alert"
        >
          {error}
        </div>
      )}
      {loading && (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}
      {!loading && chatQuery.isSuccess && items.length === 0 && !showNew && (
        <EmptyState
          icon={MessageSquareText}
          title={`No ${labels[provider]} integrations yet`}
          description={`Add a ${labels[provider]} webhook to receive selected Moosewave events as native chat messages.`}
          action={
            <Button
              size="sm"
              onClick={() => {
                if (canAdmin && !operationRef.current) setShowNew(true);
              }}
            >
              New {labels[provider]} integration
            </Button>
          }
        />
      )}

      <div className="space-y-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="rounded-xl border border-border bg-card p-4"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="font-medium text-sm">
                  {item.channel_hint || "(no channel hint)"}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {item.events.length} events ·{" "}
                  {item.last_delivery_status === "failed" ? (
                    <span className="text-destructive">
                      last delivery failed
                    </span>
                  ) : item.last_delivery_status === "success" ? (
                    <span className="text-accent">last delivery ok</span>
                  ) : (
                    "no deliveries yet"
                  )}
                </div>
                {item.last_delivery_error && (
                  <div className="mt-1 break-words text-xs text-destructive font-mono">
                    {item.last_delivery_error}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <Button
                  type="button"
                  onClick={() => onToggle(item)}
                  loading={togglingId === item.id}
                  disabled={
                    !canAdmin ||
                    Boolean(operationRef.current && togglingId !== item.id)
                  }
                  variant="outline"
                  size="sm"
                  className={
                    item.enabled
                      ? "border-success/30 bg-success-subtle text-success-emphasis"
                      : "text-muted-foreground"
                  }
                >
                  {item.enabled ? "Enabled" : "Disabled"}
                </Button>
                <Button
                  type="button"
                  onClick={() => void onTest(item.id)}
                  loading={testingId === item.id}
                  disabled={
                    !canAdmin ||
                    Boolean(operationRef.current && testingId !== item.id)
                  }
                  variant="ghost"
                  size="sm"
                >
                  {testingId === item.id ? "Sending…" : "Send test"}
                </Button>
                <Button
                  type="button"
                  onClick={() =>
                    setHistoryFor((cur) => (cur === item.id ? null : item.id))
                  }
                  aria-expanded={historyFor === item.id}
                  variant="ghost"
                  size="sm"
                >
                  {historyFor === item.id ? "Hide history" : "History"}
                </Button>
                <Button
                  type="button"
                  onClick={() => setDeleteTarget(item)}
                  disabled={!canAdmin || operationRef.current !== null}
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                >
                  Remove
                </Button>
              </div>
            </div>
            {testFeedback && testFeedback.id === item.id ? (
              <p
                className={`mt-2 text-xs ${
                  testFeedback.ok ? "text-success" : "text-destructive"
                }`}
                role="status"
              >
                {testFeedback.message}
              </p>
            ) : null}
            {historyFor === item.id ? (
              <DeliveryHistory provider={provider} id={item.id} />
            ) : null}
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next && !operationRef.current) setDeleteTarget(null);
        }}
        title={`Remove this ${labels[provider]} integration?`}
        description="It will stop receiving events immediately. This cannot be undone."
        confirmLabel="Remove"
        onConfirm={async () => {
          const targetId = deleteTarget?.id;
          const openedFingerprint = identityFingerprint;
          if (!canAdmin || !targetId || !openedFingerprint) return;
          await onDelete(targetId);
          if (authorityStillMatches(openedFingerprint)) {
            setDeleteTarget(null);
          }
        }}
      />
    </div>
  );
}
