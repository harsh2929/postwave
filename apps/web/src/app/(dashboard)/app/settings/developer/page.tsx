// SPDX-License-Identifier: AGPL-3.0-only
//
// Developer hub (SETA-006): quickstart, the resources a developer needs next
// (API keys, webhooks, audit), a recent-API-activity view sourced from the
// audit log's API-key actor rows, and the sample-data loader.
"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { KeyRound, ScrollText, Webhook } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyTextButton } from "@/components/copy-text-button";
import { RelativeTime } from "@/components/relative-time";
import { listAuditLog } from "@/lib/audit-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  canAdminInboundWebhooks,
  verifyFreshInboundWebhookAdmin,
} from "@/lib/inbound-webhook-authority";
import { qk, STALE } from "@/lib/query-keys";
import {
  sampleSegmentsKeptMessage,
  type KeptSampleSegment,
  type SampleDataRemoval,
} from "@/lib/sample-data-removal";

const QUICKSTART = `curl https://api.moosewave.com/api/v1/subscribers \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json"`;

// Platform operations is the last card on the page and brings the Mailchimp
// compatibility client with it, so it loads after first paint and keeps the
// route's initial JavaScript inside the bundle budget. The fallback is the
// card in its own loading state, so nothing moves when it mounts.
const PlatformOpsPanel = dynamic(
  () =>
    import("@/components/mailchimp-parity/platform-ops-panel").then(
      (module) => module.PlatformOpsPanel,
    ),
  {
    loading: () => (
      <Card>
        <CardHeader>
          <CardTitle>Developer and platform operations</CardTitle>
          <CardDescription>
            Batch ops, account exports, connected sites, verified domains,
            marketplace, and agency ecosystem surfaces.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground">
            Loading parity data...
          </div>
        </CardContent>
      </Card>
    ),
  },
);

const RESOURCES = [
  {
    href: "/app/settings/api",
    icon: KeyRound,
    title: "API Keys",
    body: "Create and scope keys for the REST API.",
  },
  {
    href: "/app/settings/webhooks",
    icon: Webhook,
    title: "Webhooks",
    body: "Receive signed, real-time event deliveries.",
  },
  {
    href: "/app/settings/audit",
    icon: ScrollText,
    title: "Audit Log",
    body: "Every privileged action, filterable and exportable.",
  },
] as const;

export default function DeveloperSettingsPage() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data;
  const tenantId = identity?.tenant_id ?? "anon";
  const effectiveRole = identity ? effectiveAuthRole(identity) : null;
  const viewerMode = Boolean(identity?.viewer_mode);
  const canAdmin = canAdminInboundWebhooks(identity);

  const sampleKey = useMemo(
    () => [
      ...qk.settings(tenantId, effectiveRole, "sample-data"),
      identity?.user_id ?? "anon",
      viewerMode,
    ],
    [effectiveRole, identity?.user_id, tenantId, viewerMode],
  );
  const sampleQuery = useQuery({
    queryKey: sampleKey,
    queryFn: () =>
      api.get<{ seeded: boolean }>("/api/v1/onboarding/sample-data"),
    enabled: meQuery.isSuccess,
    staleTime: STALE.detail,
  });

  const activityKey = useMemo(
    () => [
      ...qk.settings(tenantId, effectiveRole, "developer-activity"),
      identity?.user_id ?? "anon",
      viewerMode,
    ],
    [effectiveRole, identity?.user_id, tenantId, viewerMode],
  );
  const activityQuery = useQuery({
    queryKey: activityKey,
    queryFn: () => listAuditLog({ action: ".api.v1.api-keys", limit: 8 }),
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
  });

  // Sample segments the last removal had to keep, shown beside the Remove
  // button until a later removal (or a reload) settles it: the toast alone was
  // gone before anyone could act on it, and the page otherwise looked as if
  // nothing had happened.
  const [keptSampleSegments, setKeptSampleSegments] = useState<
    KeptSampleSegment[]
  >([]);

  const loadMutation = useMutation({
    mutationFn: async () => {
      if (!identity || !canAdmin) {
        throw new Error(
          "Only workspace owners and administrators can load sample data.",
        );
      }
      await verifyFreshInboundWebhookAdmin(identity);
      return api.post("/api/v1/onboarding/sample-data", { reset: false });
    },
    onSuccess: () => {
      queryClient.setQueryData(sampleKey, { seeded: true });
      setKeptSampleSegments([]);
      toast.success("Sample data loaded.");
      void queryClient.invalidateQueries({ queryKey: sampleKey });
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes(tenantId),
      });
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Could not load sample data.",
      ),
  });
  const removeMutation = useMutation({
    mutationFn: async () => {
      if (!identity || !canAdmin) {
        throw new Error(
          "Only workspace owners and administrators can remove sample data.",
        );
      }
      await verifyFreshInboundWebhookAdmin(identity);
      return api.delete<SampleDataRemoval>("/api/v1/onboarding/sample-data");
    },
    onSuccess: (result) => {
      const kept = Array.isArray(result?.kept_segments)
        ? result.kept_segments
        : [];
      // A campaign you built on a sample segment still needs it, so the
      // segment stayed and sample data is not fully gone yet; the notice below
      // the button says so for as long as that is true.
      setKeptSampleSegments(kept);
      if (kept.length === 0) {
        queryClient.setQueryData(sampleKey, { seeded: false });
        toast.success("Sample data removed.");
      }
      void queryClient.invalidateQueries({ queryKey: sampleKey });
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Could not remove sample data.",
      ),
  });

  const seeded = sampleQuery.data?.seeded ?? false;
  const busy = loadMutation.isPending || removeMutation.isPending;
  const apiRows = Array.isArray(activityQuery.data?.rows)
    ? activityQuery.data?.rows
    : [];

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h2 className="font-display text-xl font-semibold tracking-tight">
          Developer
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything you need to build on the Moosewave API.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Quickstart</CardTitle>
          <CardDescription>
            Create an API key, then call the REST API. Every request is scoped
            to your workspace and recorded in the audit log below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <pre
              tabIndex={0}
              role="group"
              aria-label="Quickstart snippet"
              className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {QUICKSTART}
            </pre>
            <div className="absolute right-2 top-2">
              <CopyTextButton value={QUICKSTART} label="Copy" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Need a key?{" "}
            <Link
              href="/app/settings/api"
              className="font-medium underline underline-offset-2"
            >
              Create one in API Keys
            </Link>
            .
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-3">
        {RESOURCES.map(({ href, icon: Icon, title, body }) => (
          <Link
            key={href}
            href={href}
            className="group rounded-lg border bg-card p-4 transition-colors hover:border-ring/50 hover:bg-accent/40"
          >
            <Icon className="h-5 w-5 text-primary" aria-hidden />
            <div className="mt-2 font-medium">{title}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{body}</div>
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent API-key changes</CardTitle>
          <CardDescription>
            Key creation, updates, rotation, and revocation in this workspace.
            Request telemetry is available in{" "}
            <Link
              href="/app/api-usage"
              className="underline underline-offset-2"
            >
              API usage
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {activityQuery.isPending ? (
            <div className="space-y-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
            </div>
          ) : activityQuery.isError ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-destructive">
                Could not load recent activity — this is a failed request, not
                an absence of API-key calls.
              </p>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void activityQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : apiRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No API-key changes have been recorded.
            </p>
          ) : (
            <ul className="divide-y text-sm">
              {apiRows.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="font-medium">{r.action}</span>
                    {r.actorLabel ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {r.actorLabel}
                      </span>
                    ) : null}
                  </span>
                  <RelativeTime
                    iso={r.at}
                    className="shrink-0 text-xs text-muted-foreground"
                  />
                </li>
              ))}
              <li className="pt-2">
                <Link
                  href="/app/settings/audit"
                  className="text-xs font-medium underline underline-offset-2"
                >
                  View full audit log
                </Link>
              </li>
            </ul>
          )}
        </CardContent>
      </Card>

      <Card data-testid="sample-data-section">
        <CardHeader>
          <CardTitle>Sample data</CardTitle>
          <CardDescription>
            A small set of subscribers, campaigns, and migration jobs to explore
            Moosewave end-to-end. Safe to load, remove, and reload at any time —
            no real subscriber data is affected.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {sampleQuery.isPending ? (
            <Skeleton className="h-9 w-40" />
          ) : sampleQuery.isError ? (
            <div className="flex flex-col items-start gap-2">
              <p role="alert" className="text-sm text-destructive">
                Could not determine whether sample data is loaded — the request
                failed, so this is unknown, not &ldquo;not loaded&rdquo;.
              </p>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void sampleQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Current state:{" "}
                <strong className="text-foreground">
                  {seeded ? "loaded" : "not loaded"}
                </strong>
              </p>
              {!canAdmin ? (
                <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
                  Only workspace owners and administrators can load or remove
                  sample data. Its current workspace state remains visible to
                  you, but no sample-data write control is available.
                </p>
              ) : seeded ? (
                <ConfirmDialog
                  title="Remove sample data?"
                  description="This removes the sample subscribers, campaigns, segment and sequence. Your own data is untouched, and if one of your campaigns uses the sample segment, that segment stays until you move the campaign."
                  confirmLabel="Remove"
                  onConfirm={() =>
                    removeMutation.mutateAsync().then(() => undefined)
                  }
                  trigger={
                    <Button type="button" variant="outline" disabled={busy}>
                      {removeMutation.isPending
                        ? "Removing…"
                        : "Remove sample data"}
                    </Button>
                  }
                />
              ) : (
                <Button
                  type="button"
                  onClick={() => loadMutation.mutate()}
                  disabled={busy}
                >
                  {loadMutation.isPending ? "Loading…" : "Load sample data"}
                </Button>
              )}
              {keptSampleSegments.length > 0 ? (
                <div
                  role="status"
                  data-testid="sample-data-kept"
                  className="space-y-1 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-sm text-warning-emphasis"
                >
                  <p>{sampleSegmentsKeptMessage(keptSampleSegments)}</p>
                  <ul className="list-disc space-y-0.5 pl-5">
                    {keptSampleSegments.map((kept) => (
                      <li key={kept.id}>
                        <Link
                          href={`/app/subscribers/segments/${encodeURIComponent(kept.id)}`}
                          className="underline underline-offset-2 hover:text-foreground"
                        >
                          See the campaigns using &ldquo;{kept.name}&rdquo;
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {/* Relocated from the Domain & DNS tab (SETC-018). */}
      <PlatformOpsPanel />
    </div>
  );
}
