// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import type { Route } from "next";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Database,
  FlaskConical,
  HardDriveDownload,
  Play,
  Plus,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import {
  DataSection,
  DataSurfaceHeader,
  DataSurfaceShell,
  QueryError,
  SectionSkeleton,
  StatusPill,
} from "@/components/integrations/data-surface";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { effectiveAuthRole, whoami, type MeResponse } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { newUUIDv7 } from "@/lib/http-fetch";
import {
  acknowledgeWarehouseProviderCleanup,
  createWarehouseConnection,
  deleteReverseETLMapping,
  disconnectWarehouseConnection,
  getWarehouseCatalog,
  getWarehouseConnection,
  getWarehouseHealth,
  listReverseETLMappings,
  listStreamingRuns,
  listWarehouseConnections,
  listWarehouseMappings,
  listWarehouseProviders,
  listWarehouseRunErrors,
  listWarehouseRuns,
  pauseWarehouseConnection,
  putWarehouseMapping,
  runDueWarehouseConnections,
  runWarehouseConnection,
  saveReverseETLMapping,
  shipStreamingWindow,
  syncReverseETL,
  validateStreamingConfig,
  validateWarehouseConnection,
  type ReverseETLMapping,
  type ReverseETLMappingInput,
  type WarehouseAuthority,
  type WarehouseConnection,
  type WarehouseConnectionInput,
  type WarehouseImportMapping,
  type WarehouseImportMappingInput,
  type WarehouseProvider,
  type WarehouseRun,
} from "@/lib/warehouse-api";

import { WarehouseRunsPanel } from "./warehouse-runs-panel";
import { pluralizeCount } from "@/lib/pluralize";

type Feedback = { tone: "success" | "error"; title: string; detail: string };

type ConnectionMutation = <T>(
  label: string,
  expected: WarehouseConnection,
  task: (
    authority: WarehouseAuthority,
    fresh: WarehouseConnection,
  ) => Promise<T>,
) => Promise<T>;

const EMPTY_CONNECTION: WarehouseConnectionInput = {
  name: "",
  provider: "",
  direction: "export",
  status: "draft",
  config: {},
  object_selection: [],
  cadence: "daily",
  backfill_days: 30,
};

const CLEANUP_ACTIONS = [
  [
    "snowflake_user_or_key_removed_or_rotated",
    "User or key removed or rotated",
  ],
  ["snowflake_roles_or_grants_removed", "Roles or grants removed"],
  [
    "snowflake_stage_or_external_integration_removed",
    "Stage or external integration removed",
  ],
  [
    "snowflake_tasks_streams_or_pipes_removed",
    "Tasks, streams, or pipes removed",
  ],
  [
    "snowflake_tables_or_import_views_reviewed",
    "Tables and import views reviewed",
  ],
  [
    "provider_console_cleanup_reviewed_no_action_due",
    "Provider console reviewed; no action was due",
  ],
] as const;

function authorityFromMe(
  me: MeResponse | undefined,
): WarehouseAuthority | null {
  if (!me || me.viewer_mode) return null;
  const role = effectiveAuthRole(me);
  if (role !== "owner" && role !== "admin") return null;
  return { tenantId: me.tenant_id, userId: me.user_id, role };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

function connectionFingerprint(connection: WarehouseConnection): string {
  return JSON.stringify([
    connection.id,
    connection.version,
    connection.name,
    connection.provider,
    connection.direction,
    connection.status,
  ]);
}

function parseJSONObject(
  value: string,
  label: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseJSONArray(value: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Staged rows must be valid JSON.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > 1_000 ||
    parsed.some((row) => !row || typeof row !== "object" || Array.isArray(row))
  ) {
    throw new Error(
      "Staged rows must be a JSON array containing 1 to 1,000 objects.",
    );
  }
  return parsed as Array<Record<string, unknown>>;
}

function prettyNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "—";
}

export function WarehouseManager() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const operationRef = useRef(false);
  const runDueKeyRef = useRef(newUUIDv7());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: 30_000,
  });
  const authority = useMemo(
    () => authorityFromMe(meQuery.data),
    [meQuery.data],
  );
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const tenantId = meQuery.data?.tenant_id ?? null;
  const queryRoot = useMemo(
    () => ["warehouse-manager", tenantId ?? "unverified", role ?? "unknown"],
    [role, tenantId],
  );
  const readsEnabled = meQuery.isSuccess && Boolean(tenantId);

  const providersQuery = useQuery({
    queryKey: [...queryRoot, "providers"],
    queryFn: ({ signal }) =>
      listWarehouseProviders({ tenantId: tenantId!, signal }),
    enabled: readsEnabled,
    staleTime: 5 * 60_000,
  });
  const catalogQuery = useQuery({
    queryKey: [...queryRoot, "catalog"],
    queryFn: ({ signal }) =>
      getWarehouseCatalog({ tenantId: tenantId!, signal }),
    enabled: readsEnabled,
    staleTime: 5 * 60_000,
  });
  const connectionsQuery = useQuery({
    queryKey: [...queryRoot, "connections", "connected"],
    queryFn: ({ signal }) =>
      listWarehouseConnections({ tenantId: tenantId!, signal }),
    enabled: readsEnabled,
  });
  const disconnectedQuery = useQuery({
    queryKey: [...queryRoot, "connections", "disconnected"],
    queryFn: ({ signal }) =>
      listWarehouseConnections({
        tenantId: tenantId!,
        status: "disconnected",
        signal,
      }),
    enabled: readsEnabled,
  });
  const runsQuery = useQuery({
    queryKey: [...queryRoot, "runs"],
    queryFn: ({ signal }) => listWarehouseRuns({ tenantId: tenantId!, signal }),
    enabled: readsEnabled,
  });

  const connections = Array.isArray(connectionsQuery.data)
    ? connectionsQuery.data
    : [];
  const disconnected = Array.isArray(disconnectedQuery.data)
    ? disconnectedQuery.data
    : [];
  const allConnections = [...connections, ...disconnected];
  const runs = Array.isArray(runsQuery.data) ? runsQuery.data : [];
  const providers = Array.isArray(providersQuery.data)
    ? providersQuery.data
    : [];
  const catalogObjects = Array.isArray(catalogQuery.data?.objects)
    ? catalogQuery.data.objects
    : [];
  const failedRuns = runs.filter((run) => run.status === "failed").length;

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryRoot });
  }, [queryClient, queryRoot]);

  const reauthorize = useCallback(
    async (expected: WarehouseAuthority): Promise<WarehouseAuthority> => {
      const current = authorityFromMe(await whoami());
      if (
        !current ||
        current.tenantId !== expected.tenantId ||
        current.userId !== expected.userId ||
        current.role !== expected.role
      ) {
        throw new Error(
          "Your workspace, account, or effective administrator role changed. Refresh before making this change.",
        );
      }
      return current;
    },
    [],
  );

  const execute = useCallback(
    async <T,>(
      label: string,
      task: () => Promise<T>,
      success: string,
    ): Promise<T> => {
      if (operationRef.current) {
        throw new Error("Another warehouse operation is still in progress.");
      }
      operationRef.current = true;
      setBusyLabel(label);
      setFeedback(null);
      try {
        const result = await task();
        await invalidate();
        if (mountedRef.current) {
          setFeedback({
            tone: "success",
            title: success,
            detail: "The latest workspace state has been reloaded.",
          });
        }
        return result;
      } catch (error) {
        if (mountedRef.current) {
          setFeedback({
            tone: "error",
            title: `${label} could not be completed`,
            detail: errorMessage(
              error,
              "The warehouse service did not complete this operation.",
            ),
          });
        }
        throw error;
      } finally {
        operationRef.current = false;
        if (mountedRef.current) setBusyLabel(null);
      }
    },
    [invalidate],
  );

  const mutateGlobal = useCallback(
    async <T,>(
      label: string,
      success: string,
      task: (freshAuthority: WarehouseAuthority) => Promise<T>,
    ): Promise<T> => {
      if (!authority) throw new Error("Administrator access is required.");
      return execute(
        label,
        async () => task(await reauthorize(authority)),
        success,
      );
    },
    [authority, execute, reauthorize],
  );

  const mutateConnection = useCallback<ConnectionMutation>(
    async (label, expected, task) => {
      if (!authority) throw new Error("Administrator access is required.");
      return execute(
        label,
        async () => {
          const freshAuthority = await reauthorize(authority);
          const fresh = await getWarehouseConnection({
            tenantId: freshAuthority.tenantId,
            id: expected.id,
          });
          if (
            connectionFingerprint(fresh) !== connectionFingerprint(expected)
          ) {
            throw new Error(
              "This connection changed after it was loaded. The latest state is being reloaded; review it before trying again.",
            );
          }
          return task(freshAuthority, fresh);
        },
        `${label} completed`,
      );
    },
    [authority, execute, reauthorize],
  );

  const runDueNow = useCallback(async (): Promise<void> => {
    const key = runDueKeyRef.current;
    await mutateGlobal(
      "Run due connections",
      "Due connections were processed",
      (freshAuthority) =>
        runDueWarehouseConnections({
          authority: freshAuthority,
          limit: 25,
          idempotencyKey: key,
        }),
    );
    // Rotate only after a confirmed success. An ambiguous failure keeps the
    // same key so an operator retry cannot execute the batch twice.
    runDueKeyRef.current = newUUIDv7();
  }, [mutateGlobal]);

  if (meQuery.isLoading || meQuery.isError) {
    return (
      <DataSurfaceShell className="max-w-7xl">
        <DataSurfaceHeader
          icon={Database}
          eyebrow="Data operations"
          title="Data warehouse"
          description="Manage governed exports, imports, reverse ETL, streaming windows, and their audit evidence."
        />
        {meQuery.isLoading ? (
          <SectionSkeleton rows={4} />
        ) : (
          <QueryError
            title="Workspace identity could not be loaded"
            description="No warehouse data was requested without a verified workspace context."
            onRetry={() => void meQuery.refetch()}
          />
        )}
      </DataSurfaceShell>
    );
  }

  return (
    <DataSurfaceShell className="max-w-7xl">
      <DataSurfaceHeader
        icon={Database}
        eyebrow="Data operations"
        title="Data warehouse"
        description="Create and validate connections, control lifecycle and runs, manage import and reverse-ETL mappings, and inspect redacted operational evidence."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild type="button" variant="outline">
              <Link href={"/app/cdp-transforms" as Route}>
                <FlaskConical aria-hidden /> Transform preview
              </Link>
            </Button>
            {authority ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  loading={busyLabel === "Run due connections"}
                  disabled={Boolean(busyLabel)}
                  onClick={() => void runDueNow().catch(() => undefined)}
                >
                  <Play aria-hidden /> Run due
                </Button>
                <Button
                  type="button"
                  disabled={Boolean(busyLabel) || providersQuery.isError}
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus aria-hidden /> New connection
                </Button>
              </>
            ) : null}
          </div>
        }
      />

      {!authority ? (
        <Alert>
          <ShieldCheck aria-hidden />
          <AlertTitle>Read-only warehouse access</AlertTitle>
          <AlertDescription>
            Your effective {role ?? "unknown"} role can inspect configuration
            and evidence. An owner or admin must perform warehouse mutations.
          </AlertDescription>
        </Alert>
      ) : null}

      {feedback ? (
        <Alert variant={feedback.tone === "error" ? "destructive" : "default"}>
          <AlertTitle>{feedback.title}</AlertTitle>
          <AlertDescription>{feedback.detail}</AlertDescription>
        </Alert>
      ) : null}

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        {[
          [
            "Active/configured",
            connectionsQuery.isSuccess ? connections.length : "—",
          ],
          [
            "Disconnected evidence",
            disconnectedQuery.isSuccess ? disconnected.length : "—",
          ],
          [
            "Available providers",
            providersQuery.isSuccess ? (providersQuery.data?.length ?? 0) : "—",
          ],
          ["Failed recent runs", runsQuery.isSuccess ? failedRuns : "—"],
        ].map(([label, value]) => (
          <div
            key={String(label)}
            className="min-w-0 rounded-xl border bg-card p-3 shadow-pw-sm sm:p-4"
          >
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {label}
            </dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <ConnectionsSection
        active={connections}
        disconnected={disconnected}
        loading={connectionsQuery.isLoading || disconnectedQuery.isLoading}
        error={connectionsQuery.isError || disconnectedQuery.isError}
        providers={providers}
        onRetry={() => {
          void connectionsQuery.refetch();
          void disconnectedQuery.refetch();
        }}
        onSelect={setSelectedId}
      />

      <WarehouseRunsPanel
        runs={runs}
        loading={runsQuery.isLoading}
        error={runsQuery.isError}
        refreshing={runsQuery.isFetching}
        onRefresh={() => runsQuery.refetch()}
        connectionNames={
          new Map(allConnections.map((row) => [row.id, row.name]))
        }
        authority={authority}
        queryRoot={queryRoot}
      />

      <CapabilitiesSection
        providers={providers}
        catalog={catalogQuery.data}
        loading={providersQuery.isLoading || catalogQuery.isLoading}
        error={providersQuery.isError || catalogQuery.isError}
        onRetry={() => {
          void providersQuery.refetch();
          void catalogQuery.refetch();
        }}
      />

      {authority ? (
        <CreateConnectionDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          providers={providers}
          catalogObjects={catalogObjects}
          busy={Boolean(busyLabel)}
          mutateGlobal={mutateGlobal}
        />
      ) : null}

      {selectedId && tenantId ? (
        <ConnectionDialog
          open
          onOpenChange={(open) => {
            if (!open && !busyLabel) setSelectedId(null);
          }}
          tenantId={tenantId}
          connectionId={selectedId}
          authority={authority}
          busyLabel={busyLabel}
          queryRoot={queryRoot}
          mutateConnection={mutateConnection}
        />
      ) : null}
    </DataSurfaceShell>
  );
}

function ConnectionsSection({
  active,
  disconnected,
  loading,
  error,
  providers,
  onRetry,
  onSelect,
}: {
  active: WarehouseConnection[];
  disconnected: WarehouseConnection[];
  loading: boolean;
  error: boolean;
  providers: WarehouseProvider[];
  onRetry: () => void;
  onSelect: (id: string) => void;
}) {
  const rows = [...active, ...disconnected];
  return (
    <DataSection
      id="warehouse-connections"
      title="Connections"
      description="Configured data boundaries. Disconnected rows stay visible as retained audit evidence."
      aside={
        <span className="text-xs tabular-nums text-muted-foreground">
          {rows.length} total
        </span>
      }
    >
      {loading ? (
        <SectionSkeleton rows={3} />
      ) : error ? (
        <QueryError
          title="Warehouse connections could not be loaded"
          description="The page will not represent an unknown connection state as empty."
          onRetry={onRetry}
        />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center">
          <HardDriveDownload
            aria-hidden
            className="mx-auto size-7 text-muted-foreground"
          />
          <p className="mt-2 text-sm font-medium">No warehouse connection</p>
          <p className="mx-auto mt-1 max-w-xl text-sm leading-5 text-muted-foreground">
            {providers.length
              ? `${providers.length} provider definitions are available. An administrator can validate and create the first connection.`
              : "No provider definitions were returned by this deployment."}
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((connection) => (
            <li
              key={connection.id}
              className="flex min-w-0 flex-col rounded-xl border p-4 text-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words font-medium">{connection.name}</p>
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {connection.provider.replaceAll("_", " ")} ·{" "}
                    {connection.direction} · {connection.cadence}
                  </p>
                </div>
                <StatusPill status={connection.status} />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <dt className="text-muted-foreground">Objects</dt>
                  <dd className="mt-0.5 font-medium tabular-nums">
                    {connection.object_selection.length}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Version</dt>
                  <dd className="mt-0.5 font-medium tabular-nums">
                    {connection.version}
                  </dd>
                </div>
              </dl>
              <Button
                type="button"
                variant="outline"
                className="mt-4 w-full"
                onClick={() => onSelect(connection.id)}
              >
                <Settings2 aria-hidden /> Manage and inspect
              </Button>
            </li>
          ))}
        </ul>
      )}
    </DataSection>
  );
}

function CapabilitiesSection({
  providers,
  catalog,
  loading,
  error,
  onRetry,
}: {
  providers: WarehouseProvider[];
  catalog: Awaited<ReturnType<typeof getWarehouseCatalog>> | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  return (
    <DataSection
      id="warehouse-capabilities"
      title="Deployment capabilities"
      description="The live catalog distinguishes available, partial, delegated, and planned provider runtimes."
    >
      {loading ? (
        <SectionSkeleton rows={3} />
      ) : error || !catalog ? (
        <QueryError
          title="Warehouse capabilities could not be verified"
          description="Creation stays unavailable until the live provider and object catalogs can be checked."
          onRetry={onRetry}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Providers
            </h3>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {providers.map((provider) => (
                <li
                  key={provider.provider}
                  className="rounded-lg border p-3 text-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium">{provider.name}</span>
                    <StatusPill status={provider.runtime_status} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {provider.auth_mode.replaceAll("_", " ")} ·{" "}
                    {provider.managed ? "managed" : "operator managed"}
                  </p>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Objects and workers
            </h3>
            <ul className="mt-2 space-y-2">
              {[...catalog.objects, ...catalog.workers].map((item) => (
                <li
                  key={`${item.key}:${item.label}`}
                  className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
                >
                  <span>{item.label}</span>
                  <StatusPill status={item.runtime_status} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </DataSection>
  );
}

type GlobalMutation = <T>(
  label: string,
  success: string,
  task: (authority: WarehouseAuthority) => Promise<T>,
) => Promise<T>;

function CreateConnectionDialog({
  open,
  onOpenChange,
  providers,
  catalogObjects,
  busy,
  mutateGlobal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: WarehouseProvider[];
  catalogObjects: Array<{ key: string; label: string; runtime_status: string }>;
  busy: boolean;
  mutateGlobal: GlobalMutation;
}) {
  const [draft, setDraft] =
    useState<WarehouseConnectionInput>(EMPTY_CONNECTION);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [validation, setValidation] = useState<Awaited<
    ReturnType<typeof validateWarehouseConnection>
  > | null>(null);
  const [validationStamp, setValidationStamp] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [createKey, setCreateKey] = useState(() => newUUIDv7());
  const selectedProvider =
    providers.find((provider) => provider.provider === draft.provider) ?? null;

  const reset = useCallback(() => {
    setDraft(EMPTY_CONNECTION);
    setFields({});
    setValidation(null);
    setValidationStamp(null);
    setLocalError(null);
    setCreateKey(newUUIDv7());
  }, []);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  function changed(next: WarehouseConnectionInput, nextFields = fields) {
    setDraft(next);
    setFields(nextFields);
    setValidation(null);
    setValidationStamp(null);
    setLocalError(null);
    setCreateKey(newUUIDv7());
  }

  function materialize(): WarehouseConnectionInput {
    if (!selectedProvider) throw new Error("Choose a provider.");
    const config: Record<string, unknown> = {};
    let credentialsRef = "";
    for (const [key, raw] of Object.entries(fields)) {
      const value = raw.trim();
      if (!value) continue;
      if (key === "credentials_ref") {
        credentialsRef = value;
      } else if (
        key === "batch_size" ||
        key === "import_limit" ||
        key === "port"
      ) {
        const number = Number(value);
        if (!Number.isInteger(number))
          throw new Error(`${key.replaceAll("_", " ")} must be an integer.`);
        config[key] = number;
      } else if (key === "field_filters") {
        config[key] = value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
      } else {
        config[key] = value;
      }
    }
    return {
      ...draft,
      ...(credentialsRef ? { credentials_ref: credentialsRef } : {}),
      config,
    };
  }

  async function validateDraft() {
    setLocalError(null);
    setValidating(true);
    try {
      const input = materialize();
      const result = await mutateGlobal(
        "Validate connection",
        "Connection validation completed",
        (authority) =>
          validateWarehouseConnection({ authority, connection: input }),
      );
      setValidation(result);
      setValidationStamp(JSON.stringify(input));
    } catch (error) {
      setLocalError(errorMessage(error, "Connection validation failed."));
    } finally {
      setValidating(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);
    try {
      const input = materialize();
      if (!validation?.valid || validationStamp !== JSON.stringify(input)) {
        throw new Error(
          "Validate this exact draft successfully before creating it.",
        );
      }
      await mutateGlobal(
        "Create connection",
        "Warehouse connection created",
        async (authority) => {
          const revalidated = await validateWarehouseConnection({
            authority,
            connection: input,
          });
          if (!revalidated.valid)
            throw new Error(
              revalidated.errors.join(" ") ||
                "The connection is no longer valid.",
            );
          return createWarehouseConnection({
            authority,
            connection: input,
            idempotencyKey: createKey,
          });
        },
      );
      onOpenChange(false);
    } catch (error) {
      setLocalError(
        errorMessage(error, "The connection could not be created."),
      );
    }
  }

  const providerFields = selectedProvider
    ? [
        ...selectedProvider.required_settings,
        ...selectedProvider.optional_settings,
      ]
    : [];

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-3xl" closeDisabled={busy}>
        <DialogHeader>
          <DialogTitle>New warehouse connection</DialogTitle>
          <DialogDescription>
            Store only a vault or secret-manager reference here—never paste raw
            passwords, keys, tokens, or service-account JSON.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-5" onSubmit={submit}>
          {localError ? (
            <Alert variant="destructive">
              <AlertTitle>Draft needs attention</AlertTitle>
              <AlertDescription>{localError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Connection name" htmlFor="warehouse-name">
              <Input
                id="warehouse-name"
                value={draft.name}
                maxLength={160}
                required
                disabled={busy}
                onChange={(event) =>
                  changed({ ...draft, name: event.target.value })
                }
              />
            </Field>
            <Field label="Provider" htmlFor="warehouse-provider">
              <Select
                id="warehouse-provider"
                value={draft.provider}
                required
                disabled={busy}
                onChange={(event) => {
                  const provider = providers.find(
                    (item) => item.provider === event.target.value,
                  );
                  changed(
                    {
                      ...draft,
                      provider: event.target.value,
                      direction:
                        event.target.value === "streaming_export"
                          ? "export"
                          : draft.direction,
                      cadence:
                        event.target.value === "streaming_export"
                          ? "hourly"
                          : draft.cadence,
                      object_selection: Array.isArray(provider?.sync_objects)
                        ? provider.sync_objects.slice(0, 2)
                        : [],
                    },
                    {},
                  );
                }}
              >
                <option value="">Choose a provider</option>
                {providers.map((provider) => (
                  <option key={provider.provider} value={provider.provider}>
                    {provider.name} — {provider.runtime_status}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Direction" htmlFor="warehouse-direction">
              <Select
                id="warehouse-direction"
                value={draft.direction}
                disabled={busy || draft.provider === "streaming_export"}
                onChange={(event) =>
                  changed({
                    ...draft,
                    direction: event.target
                      .value as WarehouseConnectionInput["direction"],
                  })
                }
              >
                <option value="export">Export</option>
                <option value="import">Import</option>
                <option value="bidirectional">Bidirectional</option>
              </Select>
            </Field>
            <Field label="Cadence" htmlFor="warehouse-cadence">
              <Select
                id="warehouse-cadence"
                value={draft.cadence}
                disabled={busy || draft.provider === "streaming_export"}
                onChange={(event) =>
                  changed({
                    ...draft,
                    cadence: event.target
                      .value as WarehouseConnectionInput["cadence"],
                  })
                }
              >
                <option value="manual">Manual</option>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </Select>
            </Field>
            <Field label="Initial status" htmlFor="warehouse-status">
              <Select
                id="warehouse-status"
                value={draft.status}
                disabled={busy}
                onChange={(event) =>
                  changed({
                    ...draft,
                    status: event.target
                      .value as WarehouseConnectionInput["status"],
                  })
                }
              >
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
              </Select>
            </Field>
            <Field label="Backfill days" htmlFor="warehouse-backfill">
              <Input
                id="warehouse-backfill"
                type="number"
                min={1}
                max={3650}
                value={draft.backfill_days}
                disabled={busy}
                onChange={(event) =>
                  changed({
                    ...draft,
                    backfill_days: Number(event.target.value),
                  })
                }
              />
            </Field>
          </div>

          {selectedProvider ? (
            <div className="rounded-xl border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold">
                    {selectedProvider.name} settings
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Authentication mode:{" "}
                    {selectedProvider.auth_mode.replaceAll("_", " ")}
                  </p>
                </div>
                <StatusPill status={selectedProvider.runtime_status} />
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {providerFields.map((field) => (
                  <Field
                    key={field.key}
                    label={`${field.label}${field.required ? " *" : ""}`}
                    htmlFor={`warehouse-field-${field.key}`}
                    help={field.help}
                  >
                    <Input
                      id={`warehouse-field-${field.key}`}
                      value={fields[field.key] ?? ""}
                      required={field.required}
                      autoComplete="off"
                      disabled={busy}
                      onChange={(event) =>
                        changed(draft, {
                          ...fields,
                          [field.key]: event.target.value,
                        })
                      }
                    />
                  </Field>
                ))}
              </div>
            </div>
          ) : null}

          <fieldset
            className="rounded-xl border p-4"
            disabled={busy || !selectedProvider}
          >
            <legend className="px-1 text-sm font-semibold">Objects</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {catalogObjects
                .filter((item) =>
                  selectedProvider?.sync_objects?.includes(item.key),
                )
                .map((item) => {
                  const checked = draft.object_selection.includes(item.key);
                  return (
                    <Label
                      key={item.key}
                      className="flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 font-normal"
                    >
                      <Checkbox
                        checked={checked}
                        onChange={(event) =>
                          changed({
                            ...draft,
                            object_selection: event.currentTarget.checked
                              ? [...draft.object_selection, item.key]
                              : draft.object_selection.filter(
                                  (key) => key !== item.key,
                                ),
                          })
                        }
                      />
                      <span className="min-w-0">
                        <span className="block text-sm">{item.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {item.runtime_status}
                        </span>
                      </span>
                    </Label>
                  );
                })}
            </div>
          </fieldset>

          {validation ? (
            <Alert variant={validation.valid ? "default" : "destructive"}>
              <AlertTitle>
                {validation.valid ? "Validation passed" : "Validation failed"}
              </AlertTitle>
              <AlertDescription>
                {[...validation.errors, ...validation.warnings].length ? (
                  <ul className="list-disc space-y-1 pl-5">
                    {[...validation.errors, ...validation.warnings].map(
                      (message, index) => (
                        <li key={`${index}:${message}`}>{message}</li>
                      ),
                    )}
                  </ul>
                ) : (
                  "No validation issues were reported."
                )}
              </AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="secondary"
              loading={validating}
              disabled={busy || !selectedProvider}
              onClick={() => void validateDraft()}
            >
              Validate draft
            </Button>
            <Button
              type="submit"
              loading={busy && !validating}
              disabled={busy || !validation?.valid}
            >
              Create connection
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  help,
  children,
}: {
  label: string;
  htmlFor: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {help ? (
        <p className="text-xs leading-5 text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}

function ConnectionDialog({
  open,
  onOpenChange,
  tenantId,
  connectionId,
  authority,
  busyLabel,
  queryRoot,
  mutateConnection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  connectionId: string;
  authority: WarehouseAuthority | null;
  busyLabel: string | null;
  queryRoot: readonly string[];
  mutateConnection: ConnectionMutation;
}) {
  const [providerCheck, setProviderCheck] = useState(false);
  const [runDirection, setRunDirection] = useState<"export" | "import">(
    "export",
  );
  const [runMode, setRunMode] = useState<"manual" | "dry_run" | "retry">(
    "manual",
  );
  const [cleanupActions, setCleanupActions] = useState<string[]>([]);
  const [cleanupNotes, setCleanupNotes] = useState("");
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const actionKeysRef = useRef(new Map<string, string>());
  const detailQuery = useQuery({
    queryKey: [...queryRoot, "connection", connectionId],
    queryFn: ({ signal }) =>
      getWarehouseConnection({ tenantId, id: connectionId, signal }),
    enabled: open,
  });
  const connection = detailQuery.data;
  const healthQuery = useQuery({
    queryKey: [
      ...queryRoot,
      "connection",
      connectionId,
      "health",
      providerCheck,
    ],
    queryFn: ({ signal }) =>
      getWarehouseHealth({ tenantId, connectionId, providerCheck, signal }),
    enabled: open,
  });
  const mappingsQuery = useQuery({
    queryKey: [...queryRoot, "connection", connectionId, "mappings"],
    queryFn: ({ signal }) =>
      listWarehouseMappings({ tenantId, connectionId, signal }),
    enabled: open,
  });
  const reverseQuery = useQuery({
    queryKey: [...queryRoot, "connection", connectionId, "reverse-etl"],
    queryFn: ({ signal }) =>
      listReverseETLMappings({ tenantId, connectionId, signal }),
    enabled: open,
  });
  const runsQuery = useQuery({
    queryKey: [...queryRoot, "connection", connectionId, "runs"],
    queryFn: ({ signal }) =>
      listWarehouseRuns({ tenantId, connectionId, signal }),
    enabled: open,
  });
  const streamingQuery = useQuery({
    queryKey: [...queryRoot, "connection", connectionId, "streaming-runs"],
    queryFn: ({ signal }) =>
      listStreamingRuns({ tenantId, connectionId, signal }),
    enabled: open && connection?.provider === "streaming_export",
  });
  const busy = Boolean(busyLabel);

  useEffect(() => {
    actionKeysRef.current.clear();
  }, [connectionId]);

  async function runWithStableKey<T>(
    identity: string,
    task: (idempotencyKey: string) => Promise<T>,
  ): Promise<T> {
    let key = actionKeysRef.current.get(identity);
    if (!key) {
      key = newUUIDv7();
      actionKeysRef.current.set(identity, key);
    }
    const result = await task(key);
    // Preserve the key across errors (including an ambiguous transport
    // failure), and rotate it only once the server confirms success.
    actionKeysRef.current.delete(identity);
    return result;
  }

  useEffect(() => {
    if (!connection) return;
    if (connection.direction === "import") setRunDirection("import");
    else setRunDirection("export");
  }, [connection]);

  async function runNow() {
    if (!connection) return;
    await runWithStableKey(
      `run:${connection.version}:${runDirection}:${runMode}`,
      (idempotencyKey) =>
        mutateConnection(
          "Run connection",
          connection,
          (freshAuthority, fresh) =>
            runWarehouseConnection({
              authority: freshAuthority,
              current: fresh,
              direction: runDirection,
              runMode,
              idempotencyKey,
            }),
        ),
    );
  }

  async function acknowledgeCleanup() {
    if (!connection) return;
    const payloadIdentity = JSON.stringify({
      version: connection.version,
      actions: [...cleanupActions].sort(),
      notes: cleanupNotes.trim(),
    });
    await runWithStableKey(`cleanup:${payloadIdentity}`, (idempotencyKey) =>
      mutateConnection(
        "Acknowledge provider cleanup",
        connection,
        (freshAuthority, fresh) =>
          acknowledgeWarehouseProviderCleanup({
            authority: freshAuthority,
            current: fresh,
            completedActions: cleanupActions,
            notes: cleanupNotes,
            idempotencyKey,
          }),
      ),
    );
    setCleanupActions([]);
    setCleanupNotes("");
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-6xl" closeDisabled={busy}>
        <DialogHeader>
          <DialogTitle>
            {connection?.name ?? "Warehouse connection"}
          </DialogTitle>
          <DialogDescription>
            Lifecycle, health, mappings, reverse ETL, streaming windows, and
            redacted run evidence for this tenant-bound connection.
          </DialogDescription>
        </DialogHeader>
        {detailQuery.isLoading ? (
          <SectionSkeleton rows={5} />
        ) : detailQuery.isError || !connection ? (
          <QueryError
            title="Connection details could not be loaded"
            description="No mutation controls are available until the current version is verified."
            onRetry={() => void detailQuery.refetch()}
          />
        ) : (
          <Tabs defaultValue="overview">
            <TabsList aria-label="Warehouse connection areas">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="imports">Import mappings</TabsTrigger>
              {connection.provider !== "streaming_export" ? (
                <TabsTrigger value="reverse">Reverse ETL</TabsTrigger>
              ) : null}
              <TabsTrigger value="runs">Runs</TabsTrigger>
              {connection.provider === "streaming_export" ? (
                <TabsTrigger value="streaming">Streaming</TabsTrigger>
              ) : null}
            </TabsList>
            <TabsContent value="overview">
              <ConnectionOverview
                connection={connection}
                health={healthQuery.data}
                healthLoading={healthQuery.isLoading || healthQuery.isFetching}
                healthError={healthQuery.isError}
                providerCheck={providerCheck}
                onProviderCheck={() => {
                  if (providerCheck) void healthQuery.refetch();
                  else setProviderCheck(true);
                }}
                authority={authority}
                busy={busy}
                runDirection={runDirection}
                runMode={runMode}
                setRunDirection={setRunDirection}
                setRunMode={setRunMode}
                onRun={() => runNow()}
                onPause={async () => {
                  await runWithStableKey(
                    `pause:${connection.version}`,
                    (idempotencyKey) =>
                      mutateConnection(
                        "Pause connection",
                        connection,
                        (freshAuthority, fresh) =>
                          pauseWarehouseConnection({
                            authority: freshAuthority,
                            current: fresh,
                            idempotencyKey,
                          }),
                      ),
                  );
                }}
                onDisconnect={async () => {
                  await runWithStableKey(
                    `disconnect:${connection.version}:${connection.name}`,
                    (idempotencyKey) =>
                      mutateConnection(
                        "Disconnect connection",
                        connection,
                        (freshAuthority, fresh) =>
                          disconnectWarehouseConnection({
                            authority: freshAuthority,
                            current: fresh,
                            idempotencyKey,
                          }),
                      ),
                  );
                }}
                cleanupActions={cleanupActions}
                setCleanupActions={setCleanupActions}
                cleanupNotes={cleanupNotes}
                setCleanupNotes={setCleanupNotes}
                cleanupOpen={cleanupOpen}
                setCleanupOpen={setCleanupOpen}
                onCleanup={acknowledgeCleanup}
              />
            </TabsContent>
            <TabsContent value="imports">
              <ImportMappingsPanel
                connection={connection}
                mappings={
                  Array.isArray(mappingsQuery.data) ? mappingsQuery.data : []
                }
                loading={mappingsQuery.isLoading}
                error={mappingsQuery.isError}
                onRetry={() => void mappingsQuery.refetch()}
                authority={authority}
                busy={busy}
                mutateConnection={mutateConnection}
              />
            </TabsContent>
            {connection.provider !== "streaming_export" ? (
              <TabsContent value="reverse">
                <ReverseETLPanel
                  connection={connection}
                  mappings={
                    Array.isArray(reverseQuery.data) ? reverseQuery.data : []
                  }
                  loading={reverseQuery.isLoading}
                  error={reverseQuery.isError}
                  onRetry={() => void reverseQuery.refetch()}
                  authority={authority}
                  busy={busy}
                  mutateConnection={mutateConnection}
                />
              </TabsContent>
            ) : null}
            <TabsContent value="runs">
              <ConnectionRunsPanel
                connection={connection}
                runs={Array.isArray(runsQuery.data) ? runsQuery.data : []}
                loading={runsQuery.isLoading}
                error={runsQuery.isError}
                onRetry={() => void runsQuery.refetch()}
                authority={authority}
                tenantId={tenantId}
                queryRoot={queryRoot}
              />
            </TabsContent>
            {connection.provider === "streaming_export" ? (
              <TabsContent value="streaming">
                <StreamingPanel
                  connection={connection}
                  data={streamingQuery.data}
                  loading={streamingQuery.isLoading}
                  error={streamingQuery.isError}
                  onRetry={() => void streamingQuery.refetch()}
                  authority={authority}
                  busy={busy}
                  mutateConnection={mutateConnection}
                />
              </TabsContent>
            ) : null}
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConnectionOverview({
  connection,
  health,
  healthLoading,
  healthError,
  providerCheck,
  onProviderCheck,
  authority,
  busy,
  runDirection,
  runMode,
  setRunDirection,
  setRunMode,
  onRun,
  onPause,
  onDisconnect,
  cleanupActions,
  setCleanupActions,
  cleanupNotes,
  setCleanupNotes,
  cleanupOpen,
  setCleanupOpen,
  onCleanup,
}: {
  connection: WarehouseConnection;
  health: Awaited<ReturnType<typeof getWarehouseHealth>> | undefined;
  healthLoading: boolean;
  healthError: boolean;
  providerCheck: boolean;
  onProviderCheck: () => void;
  authority: WarehouseAuthority | null;
  busy: boolean;
  runDirection: "export" | "import";
  runMode: "manual" | "dry_run" | "retry";
  setRunDirection: (value: "export" | "import") => void;
  setRunMode: (value: "manual" | "dry_run" | "retry") => void;
  onRun: () => Promise<void>;
  onPause: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  cleanupActions: string[];
  setCleanupActions: (value: string[]) => void;
  cleanupNotes: string;
  setCleanupNotes: (value: string) => void;
  cleanupOpen: boolean;
  setCleanupOpen: (value: boolean) => void;
  onCleanup: () => Promise<void>;
}) {
  const active = connection.status === "active";
  const canExport = connection.direction !== "import";
  const canImport = connection.direction !== "export";
  return (
    <div className="space-y-5 pt-2">
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Detail label="Status">
          <StatusPill status={connection.status} />
        </Detail>
        <Detail label="Provider">
          {connection.provider.replaceAll("_", " ")}
        </Detail>
        <Detail label="Direction">{connection.direction}</Detail>
        <Detail label="Exact version">{connection.version}</Detail>
        <Detail label="Cadence">{connection.cadence}</Detail>
        <Detail label="Backfill">{connection.backfill_days} days</Detail>
        <Detail label="Credential reference">
          {connection.credential_ref_present ? "Configured" : "Not configured"}
        </Detail>
        <Detail label="Last update">
          {formatWireTimestamp(connection.updated_at, "Unknown")}
        </Detail>
      </dl>

      <section
        aria-labelledby="warehouse-health-heading"
        className="rounded-xl border p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 id="warehouse-health-heading" className="text-sm font-semibold">
              Connection health
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Provider checks return only bounded state and counts; statements
              and raw errors stay server-side.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={healthLoading}
            onClick={onProviderCheck}
          >
            <Activity aria-hidden />{" "}
            {providerCheck ? "Refresh provider check" : "Run provider check"}
          </Button>
        </div>
        {healthError ? (
          <div className="mt-3">
            <QueryError
              description="Health evidence could not be loaded."
              onRetry={onProviderCheck}
            />
          </div>
        ) : healthLoading && !health ? (
          <div className="mt-3">
            <SectionSkeleton rows={2} />
          </div>
        ) : health ? (
          <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Detail label="Health">
              <StatusPill status={health.health} />
            </Detail>
            <Detail label="Last run">{health.last_run_status ?? "None"}</Detail>
            <Detail label="Warnings">{health.warning_count}</Detail>
            <Detail label="Provider execution">
              {health.provider_health?.executable
                ? "Executable"
                : (health.provider_runtime_status ?? "Not attached")}
            </Detail>
          </dl>
        ) : null}
      </section>

      {authority ? (
        <section
          aria-labelledby="warehouse-actions-heading"
          className="rounded-xl border p-4"
        >
          <h3 id="warehouse-actions-heading" className="text-sm font-semibold">
            Operational controls
          </h3>
          {/* Without this the run controls read as disabled for an unknown
              reason — role, an in-flight operation, and a non-active
              connection all look identical once the button is greyed out. */}
          {!active ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Runs are only available while this connection is active — it is
              currently {connection.status.replaceAll("_", " ")}.
            </p>
          ) : null}
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <Field label="Direction" htmlFor="warehouse-run-direction">
              <Select
                id="warehouse-run-direction"
                value={runDirection}
                disabled={busy || !active}
                onChange={(event) =>
                  setRunDirection(event.target.value as "export" | "import")
                }
              >
                {canExport ? <option value="export">Export</option> : null}
                {canImport ? <option value="import">Import</option> : null}
              </Select>
            </Field>
            <Field label="Run mode" htmlFor="warehouse-run-mode">
              <Select
                id="warehouse-run-mode"
                value={runMode}
                disabled={busy || !active}
                onChange={(event) =>
                  setRunMode(
                    event.target.value as "manual" | "dry_run" | "retry",
                  )
                }
              >
                <option value="manual">Manual</option>
                <option value="dry_run">Dry run</option>
                <option value="retry">Retry</option>
              </Select>
            </Field>
            <Button
              type="button"
              className="self-end"
              disabled={busy || !active}
              loading={busy}
              onClick={() => void onRun().catch(() => undefined)}
            >
              <Play aria-hidden /> Run now
            </Button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {connection.status !== "paused" &&
            connection.status !== "disconnected" ? (
              <ConfirmDialog
                trigger={
                  <Button type="button" variant="outline" disabled={busy}>
                    Pause connection
                  </Button>
                }
                title={`Pause ${connection.name}?`}
                description="Scheduled work will stop. Configuration, mappings, and run evidence remain retained."
                confirmLabel="Pause connection"
                confirmVariant="default"
                onConfirm={onPause}
              />
            ) : null}
            {connection.status !== "disconnected" ? (
              <ConfirmDialog
                trigger={
                  <Button type="button" variant="destructive" disabled={busy}>
                    <Trash2 aria-hidden /> Disconnect
                  </Button>
                }
                title={`Disconnect ${connection.name}?`}
                description="New work will be blocked, while connection, mapping, run, and row-error evidence remains retained. Provider-side resources are not deleted automatically."
                confirmationToken={connection.name}
                confirmLabel="Disconnect and retain evidence"
                onConfirm={onDisconnect}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {authority &&
      connection.provider === "snowflake" &&
      connection.status === "disconnected" ? (
        <section
          aria-labelledby="warehouse-cleanup-heading"
          className="rounded-xl border border-warning/40 p-4"
        >
          <h3 id="warehouse-cleanup-heading" className="text-sm font-semibold">
            Provider-console cleanup evidence
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            After independently reviewing Snowflake, record exactly what was
            completed. This does not execute provider-side deletion.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {CLEANUP_ACTIONS.map(([key, label]) => (
              <Label
                key={key}
                className="flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 font-normal"
              >
                <Checkbox
                  checked={cleanupActions.includes(key)}
                  disabled={busy}
                  onChange={(event) =>
                    setCleanupActions(
                      event.currentTarget.checked
                        ? [...cleanupActions, key]
                        : cleanupActions.filter((item) => item !== key),
                    )
                  }
                />
                <span>{label}</span>
              </Label>
            ))}
          </div>
          <Field label="Operator notes" htmlFor="warehouse-cleanup-notes">
            <Textarea
              id="warehouse-cleanup-notes"
              value={cleanupNotes}
              maxLength={2000}
              disabled={busy}
              onChange={(event) => setCleanupNotes(event.target.value)}
            />
          </Field>
          <Button
            type="button"
            className="mt-3"
            disabled={busy || (!cleanupActions.length && !cleanupNotes.trim())}
            onClick={() => setCleanupOpen(true)}
          >
            Review acknowledgement
          </Button>
          <ConfirmDialog
            open={cleanupOpen}
            onOpenChange={setCleanupOpen}
            title="Record Snowflake cleanup evidence?"
            description="This immutable operator acknowledgement advances the connection version. It asserts only the checked provider-console work."
            confirmationToken={connection.name}
            confirmLabel="Record acknowledgement"
            confirmVariant="default"
            onConfirm={onCleanup}
          />
        </section>
      ) : null}
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/25 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium">{children}</dd>
    </div>
  );
}

const EMPTY_IMPORT_MAPPING: WarehouseImportMappingInput = {
  target_event_name: "",
  profile_key_column: "email",
  occurred_at_column: "occurred_at",
  property_map: {},
  validation_rules: {},
  status: "draft",
};

function ImportMappingsPanel({
  connection,
  mappings,
  loading,
  error,
  onRetry,
  authority,
  busy,
  mutateConnection,
}: {
  connection: WarehouseConnection;
  mappings: WarehouseImportMapping[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  authority: WarehouseAuthority | null;
  busy: boolean;
  mutateConnection: ConnectionMutation;
}) {
  const [editing, setEditing] = useState<
    WarehouseImportMapping | null | undefined
  >(undefined);
  const [sourceObject, setSourceObject] = useState("");
  const [draft, setDraft] =
    useState<WarehouseImportMappingInput>(EMPTY_IMPORT_MAPPING);
  const [propertyMap, setPropertyMap] = useState("{}");
  const [validationRules, setValidationRules] = useState("{}");
  const [localError, setLocalError] = useState<string | null>(null);
  const [saveKey, setSaveKey] = useState(() => newUUIDv7());

  function begin(current?: WarehouseImportMapping) {
    setEditing(current ?? null);
    setSourceObject(current?.source_object ?? "");
    setDraft(
      current
        ? {
            target_event_name: current.target_event_name,
            profile_key_column: current.profile_key_column,
            occurred_at_column: current.occurred_at_column,
            property_map: current.property_map,
            validation_rules: current.validation_rules,
            status: current.status,
          }
        : EMPTY_IMPORT_MAPPING,
    );
    setPropertyMap(JSON.stringify(current?.property_map ?? {}, null, 2));
    setValidationRules(
      JSON.stringify(current?.validation_rules ?? {}, null, 2),
    );
    setLocalError(null);
    setSaveKey(newUUIDv7());
  }

  function change(next: WarehouseImportMappingInput) {
    setDraft(next);
    setSaveKey(newUUIDv7());
    setLocalError(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      const input: WarehouseImportMappingInput = {
        ...draft,
        property_map: parseJSONObject(propertyMap, "Property map"),
        validation_rules: parseJSONObject(validationRules, "Validation rules"),
      };
      await mutateConnection(
        "Save import mapping",
        connection,
        (freshAuthority, fresh) =>
          putWarehouseMapping({
            authority: freshAuthority,
            connection: fresh,
            sourceObject,
            ...(editing ? { current: editing } : {}),
            mapping: input,
            idempotencyKey: saveKey,
          }),
      );
      setEditing(undefined);
    } catch (cause) {
      setLocalError(
        errorMessage(cause, "The import mapping could not be saved."),
      );
    }
  }

  if (loading) return <SectionSkeleton rows={4} />;
  if (error)
    return (
      <QueryError
        description="Import mappings could not be loaded."
        onRetry={onRetry}
      />
    );

  return (
    <div className="space-y-4 pt-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Warehouse import mappings</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Map a source object to a product event using exact-version writes.
          </p>
        </div>
        {authority ? (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => begin()}
          >
            <Plus aria-hidden /> Add mapping
          </Button>
        ) : null}
      </div>
      {mappings.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No import mapping is configured for this connection.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {mappings.map((mapping) => (
            <li key={mapping.id} className="rounded-xl border p-4 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-all font-mono text-xs font-semibold">
                    {mapping.source_object}
                  </p>
                  <p className="mt-1 break-words text-muted-foreground">
                    → {mapping.target_event_name}
                  </p>
                </div>
                <StatusPill status={mapping.status} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Profile key {mapping.profile_key_column} · time{" "}
                {mapping.occurred_at_column} · version {mapping.version}
              </p>
              {authority ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  disabled={busy}
                  onClick={() => begin(mapping)}
                >
                  Edit exact version
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {editing !== undefined ? (
        <form
          className="space-y-4 rounded-xl border bg-muted/10 p-4"
          onSubmit={save}
        >
          <div>
            <h4 className="text-sm font-semibold">
              {editing ? `Edit ${editing.source_object}` : "New import mapping"}
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              A source object is immutable after creation; create a separate
              mapping to use a different source.
            </p>
          </div>
          {localError ? (
            <Alert variant="destructive">
              <AlertTitle>Mapping needs attention</AlertTitle>
              <AlertDescription>{localError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Source object" htmlFor="import-source-object">
              <Input
                id="import-source-object"
                value={sourceObject}
                required
                maxLength={128}
                disabled={busy || Boolean(editing)}
                onChange={(event) => {
                  setSourceObject(event.target.value);
                  setSaveKey(newUUIDv7());
                }}
              />
            </Field>
            <Field label="Target event name" htmlFor="import-event-name">
              <Input
                id="import-event-name"
                value={draft.target_event_name}
                required
                maxLength={160}
                disabled={busy}
                onChange={(event) =>
                  change({ ...draft, target_event_name: event.target.value })
                }
              />
            </Field>
            <Field label="Profile key column" htmlFor="import-profile-key">
              <Input
                id="import-profile-key"
                value={draft.profile_key_column}
                required
                maxLength={128}
                disabled={busy}
                onChange={(event) =>
                  change({ ...draft, profile_key_column: event.target.value })
                }
              />
            </Field>
            <Field label="Occurred-at column" htmlFor="import-occurred-at">
              <Input
                id="import-occurred-at"
                value={draft.occurred_at_column}
                required
                maxLength={128}
                disabled={busy}
                onChange={(event) =>
                  change({ ...draft, occurred_at_column: event.target.value })
                }
              />
            </Field>
            <Field label="Status" htmlFor="import-status">
              <Select
                id="import-status"
                value={draft.status}
                disabled={busy}
                onChange={(event) =>
                  change({
                    ...draft,
                    status: event.target
                      .value as WarehouseImportMappingInput["status"],
                  })
                }
              >
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Field
              label="Property map (JSON object)"
              htmlFor="import-property-map"
            >
              <Textarea
                id="import-property-map"
                value={propertyMap}
                rows={7}
                spellCheck={false}
                disabled={busy}
                onChange={(event) => {
                  setPropertyMap(event.target.value);
                  setSaveKey(newUUIDv7());
                }}
              />
            </Field>
            <Field
              label="Validation rules (JSON object)"
              htmlFor="import-validation-rules"
            >
              <Textarea
                id="import-validation-rules"
                value={validationRules}
                rows={7}
                spellCheck={false}
                disabled={busy}
                onChange={(event) => {
                  setValidationRules(event.target.value);
                  setSaveKey(newUUIDv7());
                }}
              />
            </Field>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setEditing(undefined)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={busy}>
              Save mapping
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

const EMPTY_REVERSE_MAPPING: ReverseETLMappingInput = {
  source_table: "",
  profile_key_column: "email",
  profile_key_target: "email",
  source_column: "",
  target_field_key: "",
  cast_type: "string",
  status: "draft",
};

function ReverseETLPanel({
  connection,
  mappings,
  loading,
  error,
  onRetry,
  authority,
  busy,
  mutateConnection,
}: {
  connection: WarehouseConnection;
  mappings: ReverseETLMapping[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  authority: WarehouseAuthority | null;
  busy: boolean;
  mutateConnection: ConnectionMutation;
}) {
  const [editing, setEditing] = useState<ReverseETLMapping | null | undefined>(
    undefined,
  );
  const [draft, setDraft] = useState<ReverseETLMappingInput>(
    EMPTY_REVERSE_MAPPING,
  );
  const [saveKey, setSaveKey] = useState(() => newUUIDv7());
  const [localError, setLocalError] = useState<string | null>(null);
  const [sourceTableFilter, setSourceTableFilter] = useState("");
  const [stagedRows, setStagedRows] = useState(
    '[\n  {\n    "email": "subscriber@example.com"\n  }\n]',
  );
  const [syncKey, setSyncKey] = useState(() => newUUIDv7());
  const [syncResult, setSyncResult] = useState<Awaited<
    ReturnType<typeof syncReverseETL>
  > | null>(null);
  const deleteKeys = useRef(new Map<string, string>());

  function begin(current?: ReverseETLMapping) {
    setEditing(current ?? null);
    setDraft(
      current
        ? {
            source_table: current.source_table,
            profile_key_column: current.profile_key_column,
            profile_key_target: "email",
            source_column: current.source_column,
            target_field_key: current.target_field_key,
            cast_type: current.cast_type,
            status: current.status,
          }
        : EMPTY_REVERSE_MAPPING,
    );
    setSaveKey(newUUIDv7());
    setLocalError(null);
  }

  function change(next: ReverseETLMappingInput) {
    setDraft(next);
    setSaveKey(newUUIDv7());
    setLocalError(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await mutateConnection(
        "Save reverse-ETL mapping",
        connection,
        (freshAuthority, fresh) =>
          saveReverseETLMapping({
            authority: freshAuthority,
            connection: fresh,
            ...(editing ? { current: editing } : {}),
            mapping: draft,
            idempotencyKey: saveKey,
          }),
      );
      setEditing(undefined);
    } catch (cause) {
      setLocalError(
        errorMessage(cause, "The reverse-ETL mapping could not be saved."),
      );
    }
  }

  async function remove(mapping: ReverseETLMapping) {
    let key = deleteKeys.current.get(mapping.id);
    if (!key) {
      key = newUUIDv7();
      deleteKeys.current.set(mapping.id, key);
    }
    await mutateConnection(
      "Delete reverse-ETL mapping",
      connection,
      (freshAuthority, fresh) =>
        deleteReverseETLMapping({
          authority: freshAuthority,
          connection: fresh,
          current: mapping,
          idempotencyKey: key!,
        }),
    );
    deleteKeys.current.delete(mapping.id);
  }

  async function runSync(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);
    try {
      const rows = parseJSONArray(stagedRows);
      const result = await mutateConnection(
        "Run reverse ETL",
        connection,
        (freshAuthority, fresh) =>
          syncReverseETL({
            authority: freshAuthority,
            connection: fresh,
            sourceTable: sourceTableFilter,
            rows,
            idempotencyKey: syncKey,
          }),
      );
      setSyncResult(result);
      setSyncKey(newUUIDv7());
    } catch (cause) {
      setLocalError(
        errorMessage(cause, "The reverse-ETL sync could not be completed."),
      );
    }
  }

  if (loading) return <SectionSkeleton rows={4} />;
  if (error)
    return (
      <QueryError
        description="Reverse-ETL mappings could not be loaded."
        onRetry={onRetry}
      />
    );

  return (
    <div className="space-y-5 pt-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Reverse ETL</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Map staged warehouse values onto subscriber custom fields. Browser
            execution is deliberately bounded to 1,000 rows.
          </p>
        </div>
        {authority ? (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => begin()}
          >
            <Plus aria-hidden /> Add mapping
          </Button>
        ) : null}
      </div>
      {mappings.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No reverse-ETL mapping is configured.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {mappings.map((mapping) => (
            <li key={mapping.id} className="rounded-xl border p-4 text-sm">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 break-all font-mono text-xs font-semibold">
                  {mapping.source_table}.{mapping.source_column} →{" "}
                  {mapping.target_field_key}
                </p>
                <StatusPill status={mapping.status} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Match by {mapping.profile_key_column} · cast {mapping.cast_type}{" "}
                · version {mapping.version} · last{" "}
                {mapping.last_synced_at
                  ? formatWireTimestamp(mapping.last_synced_at, "unknown")
                  : "never"}
              </p>
              {authority ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => begin(mapping)}
                  >
                    Edit
                  </Button>
                  <ConfirmDialog
                    trigger={
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={busy}
                      >
                        Delete
                      </Button>
                    }
                    title={`Delete mapping to ${mapping.target_field_key}?`}
                    description="Future reverse-ETL runs will stop writing this target field. Prior subscriber changes and audit evidence remain."
                    confirmationToken={mapping.target_field_key}
                    onConfirm={() => remove(mapping)}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {editing !== undefined ? (
        <form
          className="space-y-4 rounded-xl border bg-muted/10 p-4"
          onSubmit={save}
        >
          <h4 className="text-sm font-semibold">
            {editing
              ? `Edit ${editing.target_field_key}`
              : "New reverse-ETL mapping"}
          </h4>
          {localError ? (
            <Alert variant="destructive">
              <AlertTitle>Mapping needs attention</AlertTitle>
              <AlertDescription>{localError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Source table" htmlFor="reverse-source-table">
              <Input
                id="reverse-source-table"
                value={draft.source_table}
                required
                maxLength={256}
                disabled={busy}
                onChange={(event) =>
                  change({ ...draft, source_table: event.target.value })
                }
              />
            </Field>
            <Field label="Profile key column" htmlFor="reverse-profile-column">
              <Input
                id="reverse-profile-column"
                value={draft.profile_key_column}
                required
                maxLength={128}
                disabled={busy}
                onChange={(event) =>
                  change({ ...draft, profile_key_column: event.target.value })
                }
              />
            </Field>
            <Field label="Source column" htmlFor="reverse-source-column">
              <Input
                id="reverse-source-column"
                value={draft.source_column}
                required
                maxLength={256}
                disabled={busy}
                onChange={(event) =>
                  change({ ...draft, source_column: event.target.value })
                }
              />
            </Field>
            <Field
              label="Target custom-field key"
              htmlFor="reverse-target-field"
            >
              <Input
                id="reverse-target-field"
                value={draft.target_field_key}
                required
                maxLength={128}
                disabled={busy || Boolean(editing)}
                onChange={(event) =>
                  change({ ...draft, target_field_key: event.target.value })
                }
              />
            </Field>
            <Field label="Cast type" htmlFor="reverse-cast">
              <Select
                id="reverse-cast"
                value={draft.cast_type}
                disabled={busy}
                onChange={(event) =>
                  change({
                    ...draft,
                    cast_type: event.target
                      .value as ReverseETLMappingInput["cast_type"],
                  })
                }
              >
                {[
                  "string",
                  "number",
                  "boolean",
                  "date",
                  "datetime",
                  "json",
                ].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Status" htmlFor="reverse-status">
              <Select
                id="reverse-status"
                value={draft.status}
                disabled={busy}
                onChange={(event) =>
                  change({
                    ...draft,
                    status: event.target
                      .value as ReverseETLMappingInput["status"],
                  })
                }
              >
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
              </Select>
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setEditing(undefined)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={busy}>
              Save mapping
            </Button>
          </div>
        </form>
      ) : null}

      {authority ? (
        <form className="space-y-4 rounded-xl border p-4" onSubmit={runSync}>
          <div>
            <h4 className="text-sm font-semibold">Run against staged rows</h4>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Rows are submitted directly from this form; this surface does not
              claim to fetch remote warehouse rows. Active mappings match
              subscribers by email.
            </p>
          </div>
          {syncResult ? (
            <Alert>
              <AlertTitle>Sync receipt</AlertTitle>
              <AlertDescription>
                {prettyNumber(syncResult.rows_scanned)} scanned ·{" "}
                {prettyNumber(syncResult.subscribers_matched)} matched ·{" "}
                {prettyNumber(syncResult.fields_written)} fields written
              </AlertDescription>
            </Alert>
          ) : null}
          <Field
            label="Optional source-table filter"
            htmlFor="reverse-sync-source"
          >
            <Input
              id="reverse-sync-source"
              value={sourceTableFilter}
              maxLength={256}
              disabled={busy}
              onChange={(event) => {
                setSourceTableFilter(event.target.value);
                setSyncKey(newUUIDv7());
              }}
            />
          </Field>
          <Field
            label="Staged rows (JSON array, maximum 1,000)"
            htmlFor="reverse-sync-rows"
          >
            <Textarea
              id="reverse-sync-rows"
              value={stagedRows}
              rows={10}
              spellCheck={false}
              disabled={busy}
              onChange={(event) => {
                setStagedRows(event.target.value);
                setSyncKey(newUUIDv7());
              }}
            />
          </Field>
          {connection.status !== "active" ? (
            <p className="text-xs leading-5 text-muted-foreground">
              A bounded sync only runs while the connection is active — it is
              currently {connection.status.replaceAll("_", " ")}.
            </p>
          ) : null}
          <Button
            type="submit"
            loading={busy}
            disabled={busy || connection.status !== "active"}
          >
            <Play aria-hidden /> Run bounded sync
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function ConnectionRunsPanel({
  connection,
  runs,
  loading,
  error,
  onRetry,
  authority,
  tenantId,
  queryRoot,
}: {
  connection: WarehouseConnection;
  runs: WarehouseRun[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  authority: WarehouseAuthority | null;
  tenantId: string;
  queryRoot: readonly string[];
}) {
  const [selectedRun, setSelectedRun] = useState<WarehouseRun | null>(null);
  const evidenceQuery = useQuery({
    queryKey: [...queryRoot, "run", selectedRun?.id ?? "none", "errors"],
    queryFn: ({ signal }) =>
      listWarehouseRunErrors({
        authority: authority!,
        runId: selectedRun!.id,
        signal,
      }),
    enabled: Boolean(authority && selectedRun),
  });

  if (loading) return <SectionSkeleton rows={5} />;
  if (error)
    return (
      <QueryError
        description="Connection run history could not be loaded."
        onRetry={onRetry}
      />
    );
  return (
    <div className="space-y-4 pt-2">
      <div>
        <h3 className="text-sm font-semibold">Run evidence</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Counts and status are visible to readers. Redacted per-row failure
          evidence requires current administrator authority.
        </p>
      </div>
      {runs.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          This connection has no run history.
        </p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border">
          {runs.map((run) => (
            <li
              key={run.id}
              className="grid gap-3 p-3.5 text-sm md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center"
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {run.direction} · {run.run_mode}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatWireTimestamp(run.created_at, "Unknown time")} ·{" "}
                  {prettyNumber(run.rows_scanned)} scanned ·{" "}
                  {prettyNumber(run.rows_exported + run.rows_imported)} moved ·{" "}
                  {prettyNumber(run.rows_failed)} failed
                </p>
              </div>
              <StatusPill status={run.status} />
              {authority && (run.issue_present || run.rows_failed > 0) ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedRun(run)}
                >
                  Inspect error evidence
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {run.issue_present ? "Issue recorded" : "No issue"}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={Boolean(selectedRun)}
        onOpenChange={(open) => !open && setSelectedRun(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Redacted row-error evidence</DialogTitle>
            <DialogDescription>
              Raw rows and provider messages are never returned. These records
              identify the source, position, code, and whether a message exists.
            </DialogDescription>
          </DialogHeader>
          {evidenceQuery.isLoading ? (
            <SectionSkeleton rows={3} />
          ) : evidenceQuery.isError ? (
            <QueryError
              description="Error evidence could not be loaded under the current administrator context."
              onRetry={() => void evidenceQuery.refetch()}
            />
          ) : (evidenceQuery.data?.length ?? 0) === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No row-level evidence was recorded for this run.
            </p>
          ) : (
            <ul className="max-h-96 divide-y overflow-y-auto rounded-lg border">
              {evidenceQuery.data?.map((item) => (
                <li key={item.id} className="p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="break-all font-mono text-xs">
                      {item.error_code}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      row {item.row_number}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.source_object} · message{" "}
                    {item.message_present
                      ? "retained server-side"
                      : "not recorded"}{" "}
                    · {formatWireTimestamp(item.created_at, "unknown time")}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="sr-only">
            Workspace {tenantId}; connection {connection.id}
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setSelectedRun(null)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StreamingPanel({
  connection,
  data,
  loading,
  error,
  onRetry,
  authority,
  busy,
  mutateConnection,
}: {
  connection: WarehouseConnection;
  data: Awaited<ReturnType<typeof listStreamingRuns>> | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  authority: WarehouseAuthority | null;
  busy: boolean;
  mutateConnection: ConnectionMutation;
}) {
  const [validation, setValidation] = useState<Awaited<
    ReturnType<typeof validateStreamingConfig>
  > | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [shipKey, setShipKey] = useState(() => newUUIDv7());

  async function validate() {
    if (!authority) return;
    setLocalError(null);
    try {
      const result = await mutateConnection(
        "Validate streaming configuration",
        connection,
        (freshAuthority) =>
          validateStreamingConfig({
            authority: freshAuthority,
            config: connection.config,
          }),
      );
      setValidation(result);
    } catch (cause) {
      setLocalError(
        errorMessage(cause, "Streaming configuration validation failed."),
      );
    }
  }

  async function ship() {
    await mutateConnection(
      "Ship streaming window",
      connection,
      (freshAuthority, fresh) =>
        shipStreamingWindow({
          authority: freshAuthority,
          connection: fresh,
          idempotencyKey: shipKey,
        }),
    );
    setShipKey(newUUIDv7());
  }

  if (loading) return <SectionSkeleton rows={5} />;
  if (error)
    return (
      <QueryError
        description="Streaming shipment evidence could not be loaded."
        onRetry={onRetry}
      />
    );
  const runs = Array.isArray(data?.items) ? data.items : [];
  return (
    <div className="space-y-5 pt-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Hourly streaming export</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Shipments use tenant-bound Moosewave workspace storage. Exact
            cursors ensure failed or overflowed batches do not skip events.
          </p>
        </div>
        {authority ? (
          <div className="flex flex-wrap items-center gap-2">
            {connection.status !== "active" ? (
              <p className="basis-full text-xs leading-5 text-muted-foreground">
                Shipping is only available while the connection is active — it
                is currently {connection.status.replaceAll("_", " ")}.
              </p>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void validate()}
            >
              Validate config
            </Button>
            <ConfirmDialog
              trigger={
                <Button
                  type="button"
                  disabled={busy || connection.status !== "active"}
                >
                  <Play aria-hidden /> Ship next window
                </Button>
              }
              title={`Ship the next ${connection.name} window?`}
              description="The worker will claim this connection, ship one bounded cursor window synchronously, and advance only after successful storage."
              confirmLabel="Ship window"
              confirmVariant="default"
              onConfirm={ship}
            />
          </div>
        ) : null}
      </div>
      {localError ? (
        <Alert variant="destructive">
          <AlertTitle>Streaming operation failed</AlertTitle>
          <AlertDescription>{localError}</AlertDescription>
        </Alert>
      ) : null}
      {validation ? (
        <Alert variant={validation.valid ? "default" : "destructive"}>
          <AlertTitle>
            {validation.valid
              ? "Streaming configuration is valid"
              : "Streaming configuration is invalid"}
          </AlertTitle>
          <AlertDescription>
            {[...validation.errors, ...validation.warnings].join(" ") ||
              "No issues were reported."}
          </AlertDescription>
        </Alert>
      ) : null}
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Detail label="Format">
          {String(connection.config.format ?? "parquet")}
        </Detail>
        <Detail label="Compression">
          {String(connection.config.compression ?? "snappy")}
        </Detail>
        <Detail label="Batch size">
          {String(connection.config.batch_size ?? "10,000")}
        </Detail>
        <Detail label="Last completed window">
          {data?.lastShippedAt
            ? formatWireTimestamp(data.lastShippedAt, "Unknown")
            : "None"}
        </Detail>
      </dl>
      {runs.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No streaming window has been recorded.
        </p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border">
          {runs.map((run) => (
            <li
              key={run.id}
              className="grid gap-3 p-3.5 text-sm md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {formatWireTimestamp(run.window_start, "Unknown")} →{" "}
                  {formatWireTimestamp(run.window_end, "Unknown")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  cursor {run.cursor_from.toLocaleString()}–
                  {run.cursor_to.toLocaleString()} ·{" "}
                  {pluralizeCount(run.rows_shipped, "row")} ·{" "}
                  {prettyNumber(run.bytes_shipped)} bytes
                  {run.has_more ? " · continuation required" : ""}
                </p>
              </div>
              <StatusPill status={run.status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
