// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";
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
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { qk, STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";
import {
  authorizeWorkspaceExportDownload,
  createWorkspaceExport,
  getWorkspaceExport,
  listWorkspaceExports,
  WORKSPACE_EXPORT_RESOURCES,
  type WorkspaceExport,
  type WorkspaceExportResource,
} from "@/lib/workspace-exports-api";

const ALL_RESOURCES = WORKSPACE_EXPORT_RESOURCES.map(
  (resource) => resource.value,
);

export function WorkspaceExportsCard() {
  const queryClient = useQueryClient();
  const identityQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });
  const identity = identityQuery.data;
  const role = identity ? effectiveAuthRole(identity) : null;
  const canWrite = Boolean(identity && !identity.viewer_mode && roleCanWrite(role));
  const exportsKey = useMemo(
    () => qk.settings(identity?.tenant_id ?? "unverified", role, "workspace-exports"),
    [identity?.tenant_id, role],
  );
  const exportsQuery = useQuery({
    queryKey: exportsKey,
    queryFn: ({ signal }) => listWorkspaceExports({ signal }),
    enabled: identityQuery.isSuccess && canWrite,
    staleTime: STALE.detail,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.some(
        (item) => item.status === "queued" || item.status === "running",
      )
        ? 5_000
        : false,
  });

  const [selected, setSelected] = useState<WorkspaceExportResource[]>([
    ...ALL_RESOURCES,
  ]);
  const [creating, setCreating] = useState(false);
  const [downloadingID, setDownloadingID] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const activeRef = useRef(true);
  const actionRef = useRef<AbortController | null>(null);
  const creatingRef = useRef(false);
  const selectionRef = useRef(selected);
  selectionRef.current = selected;
  const selectionDirty =
    selected.length !== ALL_RESOURCES.length ||
    ALL_RESOURCES.some((resource) => !selected.includes(resource));
  useUnsavedChangesGuard(selectionDirty && !creating);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      actionRef.current?.abort();
    };
  }, []);

  function toggle(resource: WorkspaceExportResource, checked: boolean): void {
    setError(null);
    setReceipt(null);
    setSelected((current) => {
      if (checked) {
        return ALL_RESOURCES.filter(
          (candidate) => candidate === resource || current.includes(candidate),
        );
      }
      return current.filter((candidate) => candidate !== resource);
    });
  }

  async function create(): Promise<void> {
    if (
      !identity ||
      !canWrite ||
      selected.length === 0 ||
      creatingRef.current ||
      downloadingID !== null
    )
      return;
    const submitted = [...selected];
    const controller = new AbortController();
    actionRef.current?.abort();
    actionRef.current = controller;
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    setReceipt(null);
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      const created = await createWorkspaceExport(submitted, {
        signal: controller.signal,
      });
      const verified = await getWorkspaceExport(created.id, {
        signal: controller.signal,
        fresh: true,
      });
      if (!sameResources(verified.include, submitted)) {
        throw new Error(
          "The queued export did not contain the resources you selected. No success was claimed; refresh before retrying.",
        );
      }
      if (!activeRef.current) return;
      queryClient.setQueryData<WorkspaceExport[]>(exportsKey, (current = []) => [
        verified,
        ...current.filter((item) => item.id !== verified.id),
      ]);
      if (sameResources(selectionRef.current, submitted)) {
        setSelected([...ALL_RESOURCES]);
      }
      const message = `Workspace export ${shortID(created.id)} queued and read back from the server.`;
      setReceipt(message);
      toast.success("Workspace export queued.");
    } catch (caught) {
      if (!activeRef.current || controller.signal.aborted) return;
      setError(apiErrorMessage(caught, "Could not queue the workspace export."));
    } finally {
      if (activeRef.current && actionRef.current === controller) {
        creatingRef.current = false;
        setCreating(false);
      }
      if (actionRef.current === controller) actionRef.current = null;
    }
  }

  async function download(item: WorkspaceExport): Promise<void> {
    if (!identity || !canWrite || downloadingID || creatingRef.current) return;
    const controller = new AbortController();
    actionRef.current?.abort();
    actionRef.current = controller;
    setDownloadingID(item.id);
    setError(null);
    setReceipt(null);
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      const fresh = await getWorkspaceExport(item.id, {
        signal: controller.signal,
        fresh: true,
      });
      const path = await authorizeWorkspaceExportDownload(fresh, {
        signal: controller.signal,
      });
      if (!activeRef.current) return;
      startBrowserDownload(path);
      setReceipt(
        `Download authorized for export ${shortID(item.id)}. The server will recheck access and expiry while streaming.`,
      );
    } catch (caught) {
      if (!activeRef.current || controller.signal.aborted) return;
      setError(apiErrorMessage(caught, "Could not authorize this export download."));
      await exportsQuery.refetch();
    } finally {
      if (activeRef.current && actionRef.current === controller) {
        setDownloadingID(null);
      }
      if (actionRef.current === controller) actionRef.current = null;
    }
  }

  return (
    <Card aria-labelledby="workspace-exports-title">
      <CardHeader>
        <CardTitle id="workspace-exports-title">Selective workspace exports</CardTitle>
        <CardDescription>
          Choose exactly which workspace datasets to package, monitor the
          asynchronous job, and download the private ZIP before its retention
          deadline.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <Alert role="note">
          <AlertTitle>Private, tenant-bound downloads</AlertTitle>
          <AlertDescription>
            Bundles are stored outside the public asset/CDN path. Each download
            requires current admin authority, a recent possession proof, ready
            status, and an unexpired server deadline. The response is never
            cacheable and no bearer object URL is exposed.
          </AlertDescription>
        </Alert>

        {identityQuery.isPending ? (
          <Loading label="Verifying workspace authority" />
        ) : identityQuery.isError ? (
          <Failure
            message="Workspace authority could not be verified. No export data was requested."
            onRetry={() => void identityQuery.refetch()}
            retrying={identityQuery.isFetching}
          />
        ) : !canWrite ? (
          <Alert>
            <AlertTitle>Owner or admin access required</AlertTitle>
            <AlertDescription>
              Selective workspace exports can contain personal and compliance
              data, so this surface is not fetched in viewer mode.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <fieldset className="space-y-3" disabled={creating}>
              <legend className="text-sm font-medium">Datasets to include</legend>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setSelected([...ALL_RESOURCES])}
                  disabled={selected.length === ALL_RESOURCES.length}
                >
                  Select all
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelected([])}
                  disabled={selected.length === 0}
                >
                  Clear
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {WORKSPACE_EXPORT_RESOURCES.map((resource) => {
                  const id = `workspace-export-resource-${resource.value}`;
                  return (
                    <div
                      key={resource.value}
                      className="flex min-h-11 items-center gap-3 rounded-md border p-3"
                    >
                      <Checkbox
                        id={id}
                        checked={selected.includes(resource.value)}
                        onChange={(event) =>
                          toggle(resource.value, event.currentTarget.checked)
                        }
                      />
                      <Label htmlFor={id} className="cursor-pointer font-normal">
                        {resource.label}
                      </Label>
                    </div>
                  );
                })}
              </div>
            </fieldset>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {selected.length} of {ALL_RESOURCES.length} datasets selected.
              </p>
              <Button
                type="button"
                onClick={() => void create()}
                loading={creating}
                disabled={creating || selected.length === 0}
              >
                {creating ? "Queueing…" : "Queue selective export"}
              </Button>
            </div>

            {error ? (
              <Alert variant="destructive" role="alert">
                <AlertTitle>Export action failed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            {receipt ? (
              <Alert role="status">
                <AlertTitle>Server receipt</AlertTitle>
                <AlertDescription>{receipt}</AlertDescription>
              </Alert>
            ) : null}

            <section aria-labelledby="workspace-export-history-title" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 id="workspace-export-history-title" className="text-sm font-semibold">
                    Export history
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Queued and running rows refresh every five seconds.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void exportsQuery.refetch()}
                  disabled={exportsQuery.isFetching}
                >
                  <RefreshCw
                    className={`mr-2 size-4 ${exportsQuery.isFetching ? "animate-spin" : ""}`}
                    aria-hidden="true"
                  />
                  Refresh
                </Button>
              </div>

              {exportsQuery.isPending ? (
                <Loading label="Loading workspace exports" />
              ) : exportsQuery.isError ? (
                <Failure
                  message={apiErrorMessage(
                    exportsQuery.error,
                    "Workspace export history could not be loaded.",
                  )}
                  onRetry={() => void exportsQuery.refetch()}
                  retrying={exportsQuery.isFetching}
                />
              ) : exportsQuery.data.length === 0 ? (
                <EmptyState
                  title="No workspace exports"
                  description="Choose one or more datasets above to create the first private export bundle."
                />
              ) : (
                <div className="space-y-3">
                  {exportsQuery.data.map((item) => (
                    <ExportRow
                      key={item.id}
                      item={item}
                      downloading={downloadingID === item.id}
                      disabled={creating || Boolean(downloadingID)}
                      onDownload={() => void download(item)}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ExportRow({
  item,
  downloading,
  disabled,
  onDownload,
}: {
  item: WorkspaceExport;
  downloading: boolean;
  disabled: boolean;
  onDownload: () => void;
}) {
  const canDownload = item.status === "ready" && item.downloadPath !== "";
  return (
    <article className="space-y-3 rounded-md border p-4" aria-label={`Export ${item.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{shortID(item.id)}</span>
            <Badge variant={statusVariant(item.status)}>{item.status}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Requested {formatWireTimestamp(item.createdAt, "unknown")}
            {item.requestedByEmail ? ` by ${item.requestedByEmail}` : ""}
          </p>
        </div>
        {canDownload ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            loading={downloading}
            disabled={disabled}
            onClick={onDownload}
          >
            <Download className="mr-2 size-4" aria-hidden="true" />
            {downloading ? "Authorizing…" : "Download ZIP"}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {item.include.map((resource) => (
          <Badge key={resource} variant="outline">
            {resourceLabel(resource)}
          </Badge>
        ))}
      </div>
      <dl className="grid gap-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Rows</dt>
          <dd>{item.rowsTotal.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Bundle size</dt>
          <dd>{formatBytes(item.bytesTotal)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Expires</dt>
          <dd>
            {item.expiresAt
              ? formatWireTimestamp(item.expiresAt, "unknown")
              : "Not assigned yet"}
          </dd>
        </div>
      </dl>
      {item.status === "expired" ? (
        <p className="text-xs text-muted-foreground">
          The authenticated link is gone and the retention sweep removes the
          private object.
        </p>
      ) : null}
      {item.error ? (
        <p className="break-words text-xs text-destructive" role="alert">
          {item.error}
        </p>
      ) : null}
    </article>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="space-y-2" aria-label={label} aria-busy="true">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

function Failure({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>Could not load exports</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{message}</p>
        <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function sameResources(
  left: readonly WorkspaceExportResource[],
  right: readonly WorkspaceExportResource[],
): boolean {
  return (
    left.length === right.length &&
    left.every((resource) => right.includes(resource))
  );
}

function resourceLabel(resource: WorkspaceExportResource): string {
  return (
    WORKSPACE_EXPORT_RESOURCES.find((option) => option.value === resource)
      ?.label ?? resource
  );
}

function statusVariant(status: WorkspaceExport["status"]) {
  if (status === "failed") return "destructive" as const;
  if (status === "ready") return "success" as const;
  if (status === "expired") return "secondary" as const;
  return "outline" as const;
}

function shortID(id: string): string {
  return id.slice(0, 8);
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function startBrowserDownload(path: string): void {
  if (typeof document === "undefined") return;
  const anchor = document.createElement("a");
  anchor.href = path;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
