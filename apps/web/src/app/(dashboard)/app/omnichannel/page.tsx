// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Omnichannel campaigns — which the server currently reports as unavailable.
 *
 * Four `/api/v1/omnichannel/*` paths desktop reached and web did not.
 *
 * `/catalog` answers with an explicit runtime verdict:
 * `runtime_status: "unavailable"`, `execution_enabled: false`, and a written
 * message. Listing the channels without leading on that would invite somebody
 * to compose a campaign that cannot be executed — and the failure would arrive
 * at send time, after the work.
 */

import { useMemo, useState } from "react";
import { Ban, Layers3, RadioTower, RefreshCw, Send } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import {
  DataSection,
  DataSurfaceHeader,
  DataSurfaceShell,
  QueryError,
  SectionSkeleton,
  StatusPill,
} from "@/components/integrations/data-surface";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiErrorMessage } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import {
  getOmnichannelCampaign,
  getOmnichannelCatalog,
  listOmnichannelCampaigns,
  omnichannelIsUnavailable,
} from "@/lib/omnichannel-api";
import { base, STALE } from "@/lib/query-keys";

export default function OmnichannelPage() {
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const keyBase = useMemo(
    () =>
      base(
        "omnichannel",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(
    null,
  );

  const catalog = useQuery({
    queryKey: [...keyBase, "catalog"],
    queryFn: getOmnichannelCatalog,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });

  const runtime = catalog.data?.runtime ?? {};
  const unavailable = omnichannelIsUnavailable(runtime);
  const executionAvailable =
    runtime.execution_enabled === true ||
    ["available", "enabled", "active"].includes(
      String(runtime.runtime_status).toLowerCase(),
    );
  const runtimeUnknown = !unavailable && !executionAvailable;
  const channels = Array.isArray(catalog.data?.channels)
    ? catalog.data.channels
    : [];
  const sendStrategies = Array.isArray(catalog.data?.send_strategies)
    ? catalog.data.send_strategies
    : [];

  const campaigns = useQuery({
    queryKey: [...keyBase, "campaigns"],
    queryFn: listOmnichannelCampaigns,
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
  });
  const campaignRows = Array.isArray(campaigns.data) ? campaigns.data : [];

  if (meQuery.isLoading || meQuery.isError) {
    return (
      <DataSurfaceShell className="max-w-5xl">
        <DataSurfaceHeader
          icon={RadioTower}
          eyebrow="Cross-channel delivery"
          title="Omnichannel"
          description="Review the channels and send strategies this deployment understands before building a campaign across email, SMS, and push."
        />
        {meQuery.isLoading ? (
          <SectionSkeleton rows={3} />
        ) : (
          <QueryError
            title="Workspace identity could not be loaded"
            description="Runtime and campaign requests were not started without a verified workspace context."
            onRetry={() => void meQuery.refetch()}
          />
        )}
      </DataSurfaceShell>
    );
  }

  return (
    <DataSurfaceShell className="max-w-5xl">
      <DataSurfaceHeader
        icon={RadioTower}
        eyebrow="Cross-channel delivery"
        title="Omnichannel"
        description="Review the channels and send strategies this deployment understands before building a campaign across email, SMS, and push."
      />

      {catalog.isLoading ? (
        <section aria-label="Loading omnichannel capabilities">
          <SectionSkeleton rows={3} />
        </section>
      ) : catalog.isError ? (
        <QueryError
          title="Omnichannel capabilities could not be loaded"
          description="Execution availability is unknown. No campaign surface has been presented as runnable."
          onRetry={() => void catalog.refetch()}
        />
      ) : (
        <>
          {unavailable ? (
            <section
              className="flex gap-3 rounded-xl border border-destructive/35 bg-destructive/5 p-4 sm:p-5"
              aria-labelledby="om-runtime-heading"
              aria-live="polite"
            >
              <Ban
                aria-hidden
                className="mt-0.5 size-5 shrink-0 text-destructive"
              />
              <div className="min-w-0">
                <h2 id="om-runtime-heading" className="text-sm font-semibold">
                  Campaign execution is unavailable
                </h2>
                {/* The server's own message, verbatim — it knows why. */}
                <p className="mt-1 break-words text-sm leading-6 text-muted-foreground">
                  {runtime.message ??
                    "Omnichannel campaign execution is unavailable on this deployment."}
                </p>
                {runtime.code ? (
                  <code className="mt-2 inline-block max-w-full break-all rounded bg-background px-2 py-1 text-xs text-muted-foreground">
                    {runtime.code}
                  </code>
                ) : null}
              </div>
            </section>
          ) : executionAvailable ? (
            <section className="flex gap-3 rounded-xl border border-success/30 bg-success-subtle p-4">
              <Send
                aria-hidden
                className="mt-0.5 size-5 shrink-0 text-success"
              />
              <div>
                <h2 className="text-sm font-semibold">Execution available</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  This deployment reports omnichannel execution as enabled.
                </p>
              </div>
            </section>
          ) : (
            <section className="flex gap-3 rounded-xl border border-warning/35 bg-warning-subtle/60 p-4">
              <RadioTower
                aria-hidden
                className="mt-0.5 size-5 shrink-0 text-warning-emphasis"
              />
              <div>
                <h2 className="text-sm font-semibold">
                  Execution availability was not reported
                </h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  The catalog loaded without a positive or negative execution
                  verdict. Channel definitions remain reference-only and are not
                  proof that campaigns can run.
                </p>
              </div>
            </section>
          )}

          <DataSection
            id="om-channels"
            title="Channels and strategies"
            description="Definitions describe what the schema understands; they do not override the execution verdict above."
            aside={
              <span className="text-xs tabular-nums text-muted-foreground">
                {channels.length} channels
              </span>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <CatalogValues
                title="Channels"
                values={channels}
                empty="No channels are offered by this build."
              />
              <CatalogValues
                title="Send strategies"
                values={sendStrategies}
                empty="No send strategies are published."
              />
            </div>
          </DataSection>
        </>
      )}

      <DataSection
        id="oc-campaigns"
        title="Cross-channel campaigns"
        description={
          unavailable
            ? "Existing definitions remain visible for audit, but this deployment cannot execute them."
            : runtimeUnknown
              ? "Existing definitions remain visible for audit, but execution has not been verified."
              : "Campaign definitions that coordinate more than one delivery channel."
        }
        aside={
          campaigns.isSuccess ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {campaignRows.length} campaigns
            </span>
          ) : undefined
        }
      >
        {campaigns.isLoading ? (
          <SectionSkeleton rows={3} />
        ) : campaigns.isError ? (
          <QueryError
            title="Cross-channel campaigns could not be loaded"
            description="The runtime verdict above is separate; campaign definitions are currently unreadable."
            onRetry={() => void campaigns.refetch()}
          />
        ) : campaignRows.length === 0 ? (
          <div className="rounded-xl border border-dashed p-6 text-center">
            <Layers3
              aria-hidden
              className="mx-auto size-7 text-muted-foreground"
            />
            <p className="mt-2 text-sm font-medium">
              No cross-channel campaigns
            </p>
            <p className="mx-auto mt-1 max-w-lg text-sm leading-5 text-muted-foreground">
              {unavailable || runtimeUnknown
                ? "Campaign creation is unavailable until the deployment reports that execution is enabled."
                : "No campaign currently coordinates multiple channels."}
            </p>
          </div>
        ) : (
          <CampaignRows rows={campaignRows} onSelect={setSelectedCampaignId} />
        )}
      </DataSection>

      {selectedCampaignId ? (
        <CampaignDetailDialog
          campaignId={selectedCampaignId}
          keyBase={keyBase}
          onClose={() => setSelectedCampaignId(null)}
        />
      ) : null}
    </DataSurfaceShell>
  );
}

function CatalogValues({
  title,
  values,
  empty,
}: {
  title: string;
  values: unknown[];
  empty: string;
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {values.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-2">
          {values.map((value, index) => {
            const record =
              value && typeof value === "object" && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : null;
            const label =
              record?.label ??
              record?.name ??
              record?.type ??
              record?.key ??
              value;
            return (
              <li
                key={`${String(label)}-${index}`}
                className="max-w-full break-words rounded-full border bg-muted/20 px-2.5 py-1 text-xs capitalize"
              >
                {String(label).replaceAll("_", " ")}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CampaignRows({
  rows,
  onSelect,
}: {
  rows: unknown[];
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="divide-y overflow-hidden rounded-xl border">
      {rows.map((row, index) => {
        const record =
          row && typeof row === "object" && !Array.isArray(row)
            ? (row as Record<string, unknown>)
            : {};
        const id =
          typeof record.id === "string" && record.id.trim()
            ? record.id.trim()
            : null;
        const label = record.name ?? record.title ?? record.id;
        const status = record.status ?? record.state;
        const text = String(label ?? `Campaign ${index + 1}`);
        return (
          <li
            key={`${String(record.id ?? label ?? "campaign")}-${index}`}
            className="grid min-w-0 gap-2 p-3.5 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            {id ? (
              <button
                type="button"
                className="min-w-0 rounded-sm text-left font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSelect(id)}
              >
                <span className="break-words">{text}</span>
              </button>
            ) : (
              // A row without a stored identity cannot be fetched by id.
              <span className="break-words font-medium">{text}</span>
            )}
            {status != null ? <StatusPill status={String(status)} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function basisPointsToPercent(bp: number | undefined): string {
  if (bp === undefined || !Number.isFinite(bp)) return "—";
  return `${(bp / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

/**
 * The stored campaign's path summary. Desktop calls this the "partial path
 * summary" and so does this: the definition's objective, audience, schedule,
 * send strategy, template identity, and settings are not represented.
 */
function CampaignDetailDialog({
  campaignId,
  keyBase,
  onClose,
}: {
  campaignId: string;
  keyBase: readonly unknown[];
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: [...keyBase, "campaign", campaignId],
    queryFn: ({ signal }) => getOmnichannelCampaign(campaignId, signal),
    staleTime: STALE.detail,
  });
  const campaign = detail.data;
  // The server's own sentence for a refusal or a 404 — never an invented one.
  const failure = detail.isError
    ? apiErrorMessage(detail.error, "Campaign definition is unavailable")
    : null;
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {campaign?.name ??
              (failure ? "Definition unavailable" : "Loading campaign…")}
          </DialogTitle>
          <DialogDescription>
            Stored campaign path summary
            {campaign
              ? ` · stored ${campaign.status ?? "unknown"} · created ${formatWireTimestamp(
                  campaign.created_at,
                  "at an unrecorded time",
                )}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div
          role="note"
          className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm"
        >
          <strong className="block">Partial path summary</strong>
          Objective, audience, scheduling, send strategy, template identity,
          settings, dispatch, and delivery readiness are not represented here.
        </div>
        {!campaign && detail.isPending ? (
          <SectionSkeleton rows={3} />
        ) : !campaign && failure ? (
          <QueryError
            title="Campaign definition is unavailable"
            description={failure}
            onRetry={() => void detail.refetch()}
          />
        ) : null}
        {campaign && failure ? (
          <p
            role="status"
            className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm"
          >
            Showing the last loaded definition. Refresh failed: {failure}
          </p>
        ) : null}
        {campaign ? (
          campaign.paths.length === 0 ? (
            <div className="rounded-lg border p-4 text-sm">
              <strong className="block">No path definitions</strong>
              <span className="text-muted-foreground">
                This definition cannot describe a send plan.
              </span>
            </div>
          ) : (
            <TableContainer aria-label="Campaign path definitions">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Path</TableHead>
                    <TableHead>Declared channel</TableHead>
                    <TableHead>Stored status</TableHead>
                    <TableHead>Weight</TableHead>
                    <TableHead>Fallback</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {campaign.paths.map((path) => (
                    <TableRow key={path.path_key}>
                      <TableCell className="tabular-nums">
                        {path.sequence ?? "—"}
                      </TableCell>
                      <TableCell>
                        <span className="block font-medium">{path.name}</span>
                        <code className="text-xs text-muted-foreground">
                          {path.path_key}
                        </code>
                      </TableCell>
                      <TableCell className="capitalize">
                        {path.channel.replaceAll("_", " ")}
                      </TableCell>
                      <TableCell>
                        {path.status ? (
                          <StatusPill status={path.status} />
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {basisPointsToPercent(path.traffic_weight_basis_points)}
                      </TableCell>
                      <TableCell>
                        {path.fallback_path_key ? (
                          <code className="text-xs">
                            {path.fallback_path_key}
                          </code>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={detail.isFetching}
            onClick={() => void detail.refetch()}
          >
            <RefreshCw aria-hidden className="size-4" />{" "}
            {detail.isFetching ? "Refreshing…" : "Refresh definition"}
          </Button>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
