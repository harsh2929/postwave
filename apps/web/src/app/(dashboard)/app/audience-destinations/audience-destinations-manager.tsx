// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  History,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import {
  DataSection,
  QueryError,
  SectionSkeleton,
  StatusPill,
} from "@/components/integrations/data-surface";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  authorizeAudienceActivationAdmin,
  type AudienceActivationAdminAuthority,
} from "@/lib/audience-activation-authority";
import {
  createAudienceDestination,
  disconnectAudienceDestination,
  getAudienceDestinationJobDiagnostics,
  listAudienceDestinationJobs,
  listAudienceDestinations,
  previewAudienceDestination,
  syncAudienceDestination,
  testAudienceDestinationReadiness,
  updateAudienceDestination,
  type AudienceDestination,
  type AudienceDestinationProvider,
  type AudienceDestinationReadiness,
  type DestinationProviders,
} from "@/lib/audience-destinations-api";
import { effectiveAuthRole, whoami, type MeResponse } from "@/lib/auth-api";
import { apiErrorMessage } from "@/lib/api";
import { listLists } from "@/lib/forms-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { base, STALE } from "@/lib/query-keys";
import { listSegments } from "@/lib/segments-api";
import { useOnline } from "@/lib/use-online";

const PROVIDER_LABELS: Record<AudienceDestinationProvider, string> = {
  meta: "Meta",
  google_ads: "Google Ads",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  snap: "Snapchat",
};

interface DestinationManagerProps {
  me: MeResponse;
  providers?: DestinationProviders;
}

type PendingAction =
  | { kind: "disconnect"; destination: AudienceDestination; key: string }
  | { kind: "sync"; destination: AudienceDestination; key: string }
  | { kind: "status"; destination: AudienceDestination; key: string };

type SourceKind = "list" | "segment";

interface DestinationDraft {
  provider: AudienceDestinationProvider;
  sourceKind: SourceKind;
  sourceId: string;
  externalId: string;
  credentialRef: string;
  fields: Record<string, string | boolean>;
}

const EMPTY_DRAFT: DestinationDraft = {
  provider: "meta",
  sourceKind: "list",
  sourceId: "",
  externalId: "",
  credentialRef: "",
  fields: {},
};

function idempotencyKey(kind: string, id = "new"): string {
  return `web:audience-destination:${kind}:${id}:${crypto.randomUUID()}`;
}

function canAdmin(me: MeResponse): boolean {
  const role = effectiveAuthRole(me);
  return !me.viewer_mode && (role === "owner" || role === "admin");
}

function sourceLabel(destination: AudienceDestination): string {
  if (destination.segment_id) {
    return `Segment · ${destination.segment_id.slice(0, 8)}…`;
  }
  if (destination.list_id) {
    return `List · ${destination.list_id.slice(0, 8)}…`;
  }
  return "Unknown source";
}

function draftFor(destination?: AudienceDestination): DestinationDraft {
  if (!destination) return { ...EMPTY_DRAFT, fields: {} };
  const fields: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(destination.config)) {
    if (typeof value === "string" || typeof value === "boolean") {
      fields[key] = value;
    }
  }
  return {
    provider: destination.provider,
    sourceKind: destination.segment_id ? "segment" : "list",
    sourceId: destination.segment_id ?? destination.list_id ?? "",
    externalId: destination.external_audience_id ?? "",
    credentialRef: "",
    fields,
  };
}

function configFor(draft: DestinationDraft): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft.fields)) {
    if (typeof value === "boolean" || String(value).trim() !== "") {
      config[key] = typeof value === "string" ? value.trim() : value;
    }
  }
  if (draft.credentialRef.trim()) {
    config.credential_ref = draft.credentialRef.trim();
  }
  if (draft.provider === "google_ads") {
    config.customer_match_transport =
      config.customer_match_transport || config.transport || "data_manager";
    config.ad_user_data_consent = config.ad_user_data_consent || "granted";
    config.ad_personalization_consent =
      config.ad_personalization_consent || "granted";
    config.customer_match_terms_accepted =
      config.customer_match_terms_accepted === true;
  }
  return config;
}

export function AudienceDestinationsManager({
  me,
  providers,
}: DestinationManagerProps) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const identity = `${me.tenant_id}:${me.user_id}:${effectiveAuthRole(me)}:${me.viewer_mode === true}`;
  const generationRef = useRef(0);
  const controllersRef = useRef(new Set<AbortController>());
  const mutationRef = useRef(false);
  const [formTarget, setFormTarget] = useState<
    AudienceDestination | null | undefined
  >(undefined);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [historyFor, setHistoryFor] = useState<AudienceDestination | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const admin = canAdmin(me);
  const role = effectiveAuthRole(me);
  const keyBase = useMemo(
    () => base("audience-destinations", me.tenant_id, role),
    [me.tenant_id, role],
  );
  const listKey = [...keyBase, "inventory"] as const;

  useEffect(() => {
    const controllers = controllersRef.current;
    generationRef.current += 1;
    mutationRef.current = false;
    setBusy(null);
    setPending(null);
    setFormTarget(undefined);
    setHistoryFor(null);
    for (const controller of controllers) controller.abort();
    controllers.clear();
    return () => {
      generationRef.current += 1;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, [identity]);

  const inventory = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) =>
      listAudienceDestinations({ tenantId: me.tenant_id, signal }),
    staleTime: STALE.list,
    gcTime: 0,
  });

  async function authority(
    generation: number,
  ): Promise<AudienceActivationAdminAuthority> {
    const current = await whoami();
    if (generation !== generationRef.current) {
      throw new Error("Workspace identity changed while the action was pending.");
    }
    return authorizeAudienceActivationAdmin(
      current,
      me.tenant_id,
      me.user_id,
    );
  }

  async function runMutation<T>(
    label: string,
    operation: (
      authority: AudienceActivationAdminAuthority,
      signal: AbortSignal,
    ) => Promise<T>,
    success: (receipt: T) => string,
  ): Promise<T | undefined> {
    if (!admin || online !== "online" || mutationRef.current) return undefined;
    if (inventory.isError) {
      toast.error("Refresh destination inventory successfully before making changes.");
      return undefined;
    }
    const generation = generationRef.current;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    mutationRef.current = true;
    setBusy(label);
    try {
      const freshAuthority = await authority(generation);
      const receipt = await operation(freshAuthority, controller.signal);
      await authority(generation);
      if (generation !== generationRef.current) return undefined;
      toast.success(success(receipt));
      await queryClient.invalidateQueries({ queryKey: listKey });
      return receipt;
    } catch (error) {
      if (controller.signal.aborted || generation !== generationRef.current) {
        return undefined;
      }
      toast.error(apiErrorMessage(error, "Audience destination action failed."));
      await queryClient.invalidateQueries({ queryKey: listKey });
      return undefined;
    } finally {
      controllersRef.current.delete(controller);
      if (generation === generationRef.current) {
        mutationRef.current = false;
        setBusy(null);
      }
    }
  }

  async function confirmAction(): Promise<void> {
    const action = pending;
    if (!action) return;
    const current = action.destination;
    if (action.kind === "sync") {
      const receipt = await runMutation(
        `sync:${current.id}`,
        (freshAuthority, signal) =>
          syncAudienceDestination({
            authority: freshAuthority,
            current,
            idempotencyKey: action.key,
            signal,
          }),
        (receipt) =>
          receipt.status === "succeeded"
            ? `Sync completed: ${receipt.job.members_synced.toLocaleString()} members sent.`
            : `Sync recorded as ${receipt.status.replace(/_/gu, " ")}; inspect history before retrying.`,
      );
      if (!receipt) throw new Error("The sync outcome was not verified. Refresh history before retrying.");
    } else if (action.kind === "status") {
      const next = current.status === "active" ? "paused" : "active";
      const receipt = await runMutation(
        `status:${current.id}`,
        (freshAuthority, signal) =>
          updateAudienceDestination({
            authority: freshAuthority,
            current,
            patch: { status: next },
            idempotencyKey: action.key,
            signal,
          }),
        () => `Destination ${next === "active" ? "enabled" : "paused"}.`,
      );
      if (!receipt) throw new Error("The status outcome was not verified. Refresh before retrying.");
    } else {
      const receipt = await runMutation(
        `disconnect:${current.id}`,
        (freshAuthority, signal) =>
          disconnectAudienceDestination({
            authority: freshAuthority,
            current,
            idempotencyKey: action.key,
            signal,
          }),
        () => "Destination disconnected in Moosewave.",
      );
      if (receipt) {
        toast.warning("Provider cleanup is still required", {
          description:
            receipt.provider_cleanup.provider_console_actions[0] ??
            "Review the provider console and revoke credentials if no longer used.",
          duration: 12_000,
        });
      }
      if (!receipt) throw new Error("The disconnect outcome was not verified. Refresh before retrying.");
    }
    setPending(null);
  }

  const rows = Array.isArray(inventory.data) ? inventory.data : [];
  return (
    <>
      <DataSection
        id="ad-dests"
        title="Configured destinations"
        description="Tenant-scoped ad-platform destinations. Every outbound run is consent-filtered before hashed identifiers leave Moosewave."
        aside={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {inventory.isFetching && inventory.data ? (
              <span className="text-xs text-muted-foreground" role="status">
                Refreshing verified inventory…
              </span>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={inventory.isFetching}
              onClick={() => void inventory.refetch()}
            >
              <RefreshCw aria-hidden className="size-4" />
              Refresh
            </Button>
            {admin ? (
              <Button
                type="button"
                size="sm"
                disabled={
                  online !== "online" || busy !== null || inventory.isError
                }
                onClick={() => setFormTarget(null)}
              >
                <Plus aria-hidden className="size-4" />
                New destination
              </Button>
            ) : null}
          </div>
        }
      >
        {online !== "online" ? (
          <Alert className="mb-4">
            <AlertTriangle aria-hidden className="size-4" />
            <AlertTitle>Read-only while offline</AlertTitle>
            <AlertDescription>
              Cached inventory may remain visible, but configuration and sync
              actions require a verified live server.
            </AlertDescription>
          </Alert>
        ) : null}
        {!admin ? (
          <Alert className="mb-4">
            <AlertTitle>Read-only access</AlertTitle>
            <AlertDescription>
              Only workspace owners and admins outside viewer mode can create,
              configure, run, pause, or disconnect destinations.
            </AlertDescription>
          </Alert>
        ) : null}
        {inventory.isError && inventory.data ? (
          <Alert variant="destructive" className="mb-4">
            <AlertTitle>Refresh failed; showing stale verified data</AlertTitle>
            <AlertDescription>
              No action is inferred from the failed refresh. Refresh again
              before changing a destination.
            </AlertDescription>
          </Alert>
        ) : null}
        {inventory.isLoading ? (
          <SectionSkeleton rows={3} />
        ) : inventory.isError && !inventory.data ? (
          <QueryError
            title="Destination inventory could not be verified"
            description="The list has not been represented as empty and all destination actions remain unavailable."
            onRetry={() => void inventory.refetch()}
          />
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-dashed p-6 text-center">
            <p className="text-sm font-medium">Verified empty inventory</p>
            <p className="mx-auto mt-1 max-w-xl text-sm leading-5 text-muted-foreground">
              This workspace has no connected ad-platform destination. Provider
              availability alone does not imply credentials or platform approval.
            </p>
            {admin ? (
              <Button
                type="button"
                className="mt-4"
                disabled={online !== "online" || inventory.isError}
                onClick={() => setFormTarget(null)}
              >
                <Plus aria-hidden className="size-4" />
                Configure destination
              </Button>
            ) : null}
          </div>
        ) : (
          <ul className="space-y-3">
            {rows.map((destination) => {
              const capability = providers?.capabilities[destination.provider];
              const syncing = busy === `sync:${destination.id}`;
              return (
                <li key={destination.id} className="rounded-xl border p-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-medium">
                          {PROVIDER_LABELS[destination.provider]}
                        </h3>
                        <StatusPill status={destination.status} />
                        {destination.credential_reference_set ? (
                          <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                            credential reference stored
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 break-all text-xs text-muted-foreground">
                        {sourceLabel(destination)}
                        {destination.external_audience_id
                          ? ` · audience ${destination.external_audience_id}`
                          : " · audience assigned on first successful run"}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Last synced {destination.last_synced_at ? formatWireTimestamp(destination.last_synced_at, "unknown") : "never"}
                        {capability?.diagnostics
                          ? " · provider diagnostics available"
                          : " · persisted job evidence only"}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setHistoryFor(destination)}
                      >
                        <History aria-hidden className="size-4" />
                        History
                      </Button>
                      {admin ? (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={online !== "online" || busy !== null || inventory.isError || destination.status !== "active"}
                            onClick={() => setPending({ kind: "sync", destination, key: idempotencyKey("sync", destination.id) })}
                          >
                            <Play aria-hidden className="size-4" />
                            {syncing ? "Syncing…" : "Sync now"}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={online !== "online" || busy !== null || inventory.isError || destination.status === "syncing"}
                            onClick={() => setPending({ kind: "status", destination, key: idempotencyKey("status", destination.id) })}
                          >
                            {destination.status === "active" ? (
                              <Pause aria-hidden className="size-4" />
                            ) : (
                              <Play aria-hidden className="size-4" />
                            )}
                            {destination.status === "active" ? "Pause" : "Enable"}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={online !== "online" || busy !== null || inventory.isError || destination.status === "syncing"}
                            onClick={() => setFormTarget(destination)}
                          >
                            <Settings2 aria-hidden className="size-4" />
                            Configure
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={online !== "online" || busy !== null || inventory.isError || destination.status === "syncing"}
                            onClick={() => setPending({ kind: "disconnect", destination, key: idempotencyKey("disconnect", destination.id) })}
                          >
                            <Trash2 aria-hidden className="size-4" />
                            Disconnect
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </DataSection>

      {formTarget !== undefined ? (
        <DestinationFormDialog
          me={me}
          destination={formTarget}
          providers={providers}
          online={online === "online"}
          busy={busy !== null}
          runMutation={runMutation}
          onClose={() => setFormTarget(undefined)}
        />
      ) : null}
      {historyFor ? (
        <DestinationHistoryDialog
          destination={historyFor}
          tenantId={me.tenant_id}
          diagnostics={
            providers?.capabilities[historyFor.provider]?.diagnostics === true
          }
          queryKeyBase={keyBase}
          onClose={() => setHistoryFor(null)}
        />
      ) : null}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && busy === null) setPending(null);
        }}
        title={
          pending?.kind === "disconnect"
            ? "Disconnect this destination?"
            : pending?.kind === "sync"
              ? "Send this audience now?"
              : pending?.destination.status === "active"
                ? "Pause this destination?"
                : "Enable this destination?"
        }
        description={
          pending?.kind === "disconnect" ? (
            <>
              Moosewave will stop future delivery and retain job evidence. It
              will not delete the provider-side audience, memberships, account
              link, app grant, or token; those require provider-console review.
            </>
          ) : pending?.kind === "sync" ? (
            <>
              Eligible members will be hashed and sent to {pending ? PROVIDER_LABELS[pending.destination.provider] : "the provider"} after the consent and suppression firewall runs. Provider effects cannot be undone from Moosewave.
            </>
          ) : (
            "This changes whether the destination can receive manual or scheduled delivery."
          )
        }
        confirmLabel={
          pending?.kind === "disconnect"
            ? "Disconnect"
            : pending?.kind === "sync"
              ? "Sync audience"
              : pending?.destination.status === "active"
                ? "Pause"
                : "Enable"
        }
        confirmVariant={pending?.kind === "disconnect" ? "destructive" : "default"}
        confirmationToken={
          pending?.kind === "disconnect"
            ? PROVIDER_LABELS[pending.destination.provider]
            : undefined
        }
        onConfirm={confirmAction}
      />
    </>
  );
}

function DestinationFormDialog({
  me,
  destination,
  providers,
  online,
  busy,
  runMutation,
  onClose,
}: {
  me: MeResponse;
  destination: AudienceDestination | null;
  providers?: DestinationProviders;
  online: boolean;
  busy: boolean;
  runMutation: <T>(
    label: string,
    operation: (
      authority: AudienceActivationAdminAuthority,
      signal: AbortSignal,
    ) => Promise<T>,
    success: (receipt: T) => string,
  ) => Promise<T | undefined>;
  onClose: () => void;
}) {
  const editing = destination !== null;
  const [draft, setDraft] = useState(() => draftFor(destination ?? undefined));
  const [readiness, setReadiness] = useState<AudienceDestinationReadiness | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const readinessController = useRef<AbortController | null>(null);
  const operationKey = useRef(
    idempotencyKey(editing ? "edit" : "create", destination?.id),
  );
  const initial = useRef(JSON.stringify(draft));
  const dirty = JSON.stringify(draft) !== initial.current;
  const sources = useQuery({
    queryKey: ["audience-destination-sources", me.tenant_id],
    queryFn: async () => {
      const [lists, segments] = await Promise.all([listLists(), listSegments()]);
      return { lists, segments };
    },
    enabled: !editing,
    staleTime: STALE.list,
    gcTime: 0,
  });
  const sourceLists = Array.isArray(sources.data?.lists)
    ? sources.data.lists
    : [];
  const sourceSegments = Array.isArray(sources.data?.segments)
    ? sources.data.segments
    : [];
  useEffect(
    () => () => {
      readinessController.current?.abort();
      readinessController.current = null;
    },
    [],
  );

  function patch(next: Partial<DestinationDraft>) {
    setDraft((current) => ({ ...current, ...next }));
    setReadiness(null);
    setReadinessError(null);
  }

  async function testReadiness(): Promise<void> {
    if (!online || testing) return;
    const controller = new AbortController();
    readinessController.current = controller;
    setTesting(true);
    setReadiness(null);
    setReadinessError(null);
    try {
      authorizeAudienceActivationAdmin(
        await whoami(),
        me.tenant_id,
        me.user_id,
      );
      if (controller.signal.aborted) return;
      const result = await testAudienceDestinationReadiness({
        provider: draft.provider,
        config: configFor(draft),
        signal: controller.signal,
      });
      authorizeAudienceActivationAdmin(
        await whoami(),
        me.tenant_id,
        me.user_id,
      );
      if (!controller.signal.aborted) setReadiness(result);
    } catch (error) {
      if (!controller.signal.aborted) {
        setReadinessError(
          apiErrorMessage(error, "Readiness could not be verified."),
        );
      }
    } finally {
      if (readinessController.current === controller) {
        readinessController.current = null;
        setTesting(false);
      }
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(null);
    if (!editing && !draft.sourceId) {
      setFormError("Choose a source list or segment.");
      return;
    }
    const result = await runMutation(
      editing ? `edit:${destination.id}` : "create",
      (freshAuthority, signal) =>
        editing
          ? updateAudienceDestination({
              authority: freshAuthority,
              current: destination,
              patch: {
                external_audience_id: draft.externalId.trim(),
                config: configFor(draft),
              },
              idempotencyKey: operationKey.current,
              signal,
            })
          : createAudienceDestination({
              authority: freshAuthority,
              destination: {
                provider: draft.provider,
                ...(draft.sourceKind === "list"
                  ? { list_id: draft.sourceId }
                  : { segment_id: draft.sourceId }),
                ...(draft.externalId.trim()
                  ? { external_audience_id: draft.externalId.trim() }
                  : {}),
                config: configFor(draft),
              },
              idempotencyKey: operationKey.current,
              signal,
            }),
      () => (editing ? "Destination configuration updated." : "Destination created as a draft."),
    );
    if (result) onClose();
  }

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy && !testing) {
            if (dirty) setDiscard(true);
            else onClose();
          }
        }}
      >
        <DialogContent className="max-w-2xl" closeDisabled={busy || testing}>
          <DialogHeader>
            <DialogTitle>{editing ? "Configure destination" : "New audience destination"}</DialogTitle>
            <DialogDescription>
              Credential references are write-only and are never echoed or cached by this page. Raw tokens and provider host overrides are rejected.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-5" onSubmit={(event) => void submit(event)}>
            {formError ? (
              <Alert variant="destructive">
                <AlertTitle>Destination was not saved</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Provider" htmlFor="destination-provider">
                <Select
                  id="destination-provider"
                  disabled={editing}
                  value={draft.provider}
                  onChange={(event) =>
                    patch({
                      provider: event.target.value as AudienceDestinationProvider,
                      credentialRef: "",
                      fields: {},
                    })
                  }
                >
                  {(providers?.providers ?? ["meta", "google_ads", "tiktok", "linkedin", "snap"]).map((provider) => (
                    <option key={provider} value={provider}>
                      {PROVIDER_LABELS[provider]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="External audience ID" htmlFor="external-audience-id" hint="Optional; usually assigned after the first successful sync.">
                <Input
                  id="external-audience-id"
                  value={draft.externalId}
                  maxLength={2_048}
                  onChange={(event) => patch({ externalId: event.target.value })}
                />
              </Field>
            </div>
            {!editing ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Source type" htmlFor="destination-source-kind">
                  <Select
                    id="destination-source-kind"
                    value={draft.sourceKind}
                    onChange={(event) => patch({ sourceKind: event.target.value as SourceKind, sourceId: "" })}
                  >
                    <option value="list">List</option>
                    <option value="segment">Segment</option>
                  </Select>
                </Field>
                <Field label={draft.sourceKind === "list" ? "Source list" : "Source segment"} htmlFor="destination-source">
                  {sources.isError ? (
                    <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
                      Sources could not be loaded. Creation remains unavailable.
                    </div>
                  ) : (
                    <Select
                      id="destination-source"
                      required
                      disabled={sources.isLoading}
                      value={draft.sourceId}
                      onChange={(event) => patch({ sourceId: event.target.value })}
                    >
                      <option value="">
                        {sources.isLoading ? "Loading…" : "Select…"}
                      </option>
                      {draft.sourceKind === "list"
                        ? sourceLists.map((list) => (
                            <option key={list.id} value={String(list.id)}>
                              {list.name}
                            </option>
                          ))
                        : sourceSegments.map((segment) => (
                            <option key={segment.id} value={segment.id}>
                              {segment.name}
                            </option>
                          ))}
                    </Select>
                  )}
                </Field>
              </div>
            ) : (
              <p className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
                Provider and source are immutable after creation. Disconnect and recreate the destination to change either.
              </p>
            )}
            <ProviderFields draft={draft} editing={editing} patch={patch} />
            <div className="rounded-xl border p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">Connection readiness</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    This validates configuration and credential resolution. It does not certify provider app review or account approval.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!online || testing || busy}
                  onClick={() => void testReadiness()}
                >
                  <Activity aria-hidden className="size-4" />
                  {testing ? "Testing…" : "Test readiness"}
                </Button>
              </div>
              {readiness ? (
                <div className="mt-3" role="status">
                  <StatusPill status={readiness.ready ? "ready" : readiness.status} />
                  <p className="mt-2 text-sm text-muted-foreground">{readiness.detail}</p>
                  {readiness.missing.length ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Missing: {readiness.missing.join(", ")}
                    </p>
                  ) : null}
                </div>
              ) : readinessError ? (
                <p className="mt-3 text-sm text-destructive" role="alert">
                  {readinessError}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy || testing}
                onClick={() => (dirty ? setDiscard(true) : onClose())}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!online || busy || testing || (!editing && sources.isError)}
              >
                {busy ? "Saving…" : editing ? "Save configuration" : "Create draft"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        title="Discard unsaved destination changes?"
        description="Provider configuration and credential-reference fields entered in this dialog will be cleared from memory."
        confirmLabel="Discard changes"
        onConfirm={onClose}
      />
    </>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function ProviderFields({
  draft,
  editing,
  patch,
}: {
  draft: DestinationDraft;
  editing: boolean;
  patch: (next: Partial<DestinationDraft>) => void;
}) {
  const setField = (key: string, value: string | boolean) =>
    patch({ fields: { ...draft.fields, [key]: value } });
  const text = (key: string, label: string, hint?: string) => {
    const id = `provider-${key}`;
    return (
      <Field key={key} label={label} htmlFor={id} hint={hint}>
        <Input
          id={id}
          value={String(draft.fields[key] ?? "")}
          maxLength={2_048}
          autoComplete="off"
          onChange={(event) => setField(key, event.target.value)}
        />
      </Field>
    );
  };
  return (
    <fieldset className="rounded-xl border p-4">
      <legend className="px-1 text-sm font-medium">
        {PROVIDER_LABELS[draft.provider]} configuration
      </legend>
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        <Field
          label="Credential reference"
          htmlFor="provider-credential-ref"
          hint={
            editing
              ? "Leave blank to keep the stored reference. Re-enter that resolver key to include it in a readiness test; never paste a raw token or secret."
              : "A resolver key only. Never paste an access token, developer token, API key, or secret."
          }
        >
          <Input
            id="provider-credential-ref"
            value={draft.credentialRef}
            maxLength={512}
            autoComplete="off"
            placeholder="vault://audience/provider"
            onChange={(event) => patch({ credentialRef: event.target.value })}
          />
        </Field>
        {draft.provider === "meta" ? text("audience_id", "Meta audience ID") : null}
        {draft.provider === "google_ads" ? (
          <>
            {text("customer_id", "Google Ads customer ID")}
            {text("user_list_id", "Customer Match user list ID")}
            <Field label="Transport" htmlFor="provider-transport">
              <Select
                id="provider-transport"
                value={String(
                  draft.fields.customer_match_transport ??
                    draft.fields.transport ??
                    "data_manager",
                )}
                onChange={(event) =>
                  setField("customer_match_transport", event.target.value)
                }
              >
                <option value="data_manager">Data Manager</option>
                <option value="offline_user_data_job">Offline user data job</option>
              </Select>
            </Field>
            <Field label="Ad user data consent" htmlFor="provider-ad-user-data-consent">
              <Select
                id="provider-ad-user-data-consent"
                value={String(draft.fields.ad_user_data_consent ?? "granted")}
                onChange={(event) =>
                  setField("ad_user_data_consent", event.target.value)
                }
              >
                <option value="granted">Granted</option>
                <option value="denied">Denied</option>
              </Select>
            </Field>
            <Field label="Ad personalization consent" htmlFor="provider-ad-personalization-consent">
              <Select
                id="provider-ad-personalization-consent"
                value={String(
                  draft.fields.ad_personalization_consent ?? "granted",
                )}
                onChange={(event) =>
                  setField("ad_personalization_consent", event.target.value)
                }
              >
                <option value="granted">Granted</option>
                <option value="denied">Denied</option>
              </Select>
            </Field>
            <label className="flex min-h-11 items-center gap-3 rounded-md border px-3 text-sm">
              <input
                type="checkbox"
                checked={draft.fields.customer_match_terms_accepted === true}
                onChange={(event) => setField("customer_match_terms_accepted", event.target.checked)}
              />
              Customer Match terms accepted
            </label>
          </>
        ) : null}
        {draft.provider === "tiktok" ? (
          <>
            {text("advertiser_id", "TikTok advertiser ID")}
            {text("audience_id", "TikTok audience ID")}
            {text("custom_audience_name", "New audience name", "Used when an audience ID has not been assigned.")}
          </>
        ) : null}
        {draft.provider === "linkedin" ? (
          <>
            {text("account_id", "LinkedIn account ID")}
            {text("segment_id", "LinkedIn segment ID")}
          </>
        ) : null}
        {draft.provider === "snap" ? (
          <>
            {text("ad_account_id", "Snap ad account ID")}
            {text("segment_id", "Snap segment ID")}
          </>
        ) : null}
      </div>
    </fieldset>
  );
}

function DestinationHistoryDialog({
  destination,
  tenantId,
  diagnostics,
  queryKeyBase,
  onClose,
}: {
  destination: AudienceDestination;
  tenantId: string;
  diagnostics: boolean;
  queryKeyBase: readonly unknown[];
  onClose: () => void;
}) {
  const [diagnosticsJob, setDiagnosticsJob] = useState<string | null>(null);
  const jobs = useQuery({
    queryKey: [...queryKeyBase, "jobs", destination.id],
    queryFn: ({ signal }) =>
      listAudienceDestinationJobs({
        tenantId,
        destinationId: destination.id,
        signal,
      }),
    staleTime: STALE.list,
    gcTime: 0,
  });
  const preview = useQuery({
    queryKey: [...queryKeyBase, "preview", destination.id],
    queryFn: ({ signal }) =>
      previewAudienceDestination({
        tenantId,
        destinationId: destination.id,
        signal,
      }),
    staleTime: STALE.detail,
    gcTime: 0,
  });
  const diagnostic = useQuery({
    queryKey: [...queryKeyBase, "diagnostics", destination.id, diagnosticsJob],
    queryFn: ({ signal }) =>
      getAudienceDestinationJobDiagnostics({
        tenantId,
        destinationId: destination.id,
        jobId: diagnosticsJob ?? "",
        signal,
      }),
    enabled: diagnostics && diagnosticsJob !== null,
    staleTime: 0,
    gcTime: 0,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Sync history · {PROVIDER_LABELS[destination.provider]}</DialogTitle>
          <DialogDescription>
            Persisted Moosewave run evidence is authoritative. Provider diagnostics are an additional live lookup where supported.
          </DialogDescription>
        </DialogHeader>
        {preview.isLoading ? (
          <SectionSkeleton rows={1} />
        ) : preview.isError ? (
          <QueryError
            title="Exclusion preview unavailable"
            description="No zero count has been inferred. Refresh before deciding whether to sync."
            onRetry={() => void preview.refetch()}
          />
        ) : preview.data ? (
          <div className="grid grid-cols-3 gap-2 rounded-xl border bg-muted/20 p-3 text-center text-sm">
            <div><strong className="block text-lg">{preview.data.total_members.toLocaleString()}</strong>source</div>
            <div><strong className="block text-lg">{preview.data.excluded_count.toLocaleString()}</strong>excluded</div>
            <div><strong className="block text-lg">{preview.data.deliverable.toLocaleString()}</strong>deliverable</div>
          </div>
        ) : null}
        {jobs.isLoading ? (
          <SectionSkeleton rows={3} />
        ) : jobs.isError ? (
          <QueryError
            title="Sync history could not be loaded"
            description="The destination remains visible, but no empty history has been inferred."
            onRetry={() => void jobs.refetch()}
          />
        ) : jobs.data?.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            Verified empty history. No sync job has been recorded for this destination.
          </p>
        ) : (
          <ul className="space-y-2">
            {jobs.data?.map((job) => (
              <li key={job.id} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={job.status} />
                      <span>{job.members_synced.toLocaleString()} sent</span>
                      <span className="text-muted-foreground">{formatWireTimestamp(job.started_at, "unknown")}</span>
                    </div>
                    {job.error ? <p className="mt-2 break-words text-destructive">{job.error}</p> : null}
                    {job.provider_status ? <p className="mt-1 text-muted-foreground">Provider: {job.provider_status}</p> : null}
                  </div>
                  {diagnostics && job.external_job_id ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setDiagnosticsJob(job.id)}
                    >
                      Diagnostics
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {diagnosticsJob ? (
          <div className="rounded-xl border p-3" aria-live="polite">
            {diagnostic.isLoading ? (
              <p className="text-sm text-muted-foreground">Retrieving provider diagnostics…</p>
            ) : diagnostic.isError ? (
              <QueryError
                title="Provider diagnostics unavailable"
                description="Persisted job evidence above remains available and has not been overwritten."
                onRetry={() => void diagnostic.refetch()}
              />
            ) : diagnostic.data ? (
              <div className="text-sm">
                <StatusPill status={diagnostic.data.diagnostics.provider_status ?? "unknown"} />
                <p className="mt-2 text-muted-foreground">
                  {diagnostic.data.diagnostics.provider_message || "Provider returned no additional message."}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
