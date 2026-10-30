// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// "Top sequence funnel" on the Analytics page (desktop AnalyticsHealthPanels
// SequenceFunnelPanel). Takes the workspace's first sequence — the same pick
// desktop's controller makes — and draws its per-step funnel:
//
//   GET /api/v1/voice/sequences              → first sequence id
//   GET /api/v1/voice/sequences/{id}/funnel  → reached / opened / clicked per step
//
// Like desktop, a workspace with no sequences (or a sequence with no funnel
// events yet) renders nothing — there is no funnel to show. A failed read is
// never hidden: it renders the server's sentence with a Retry.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  analyticsAuthorityKey,
  analyticsAuthorityReady,
  analyticsIdentitySuffix,
} from "@/lib/analytics-authority";
import { formatRate } from "@/lib/analytics-format";
import { apiErrorMessage } from "@/lib/api";
import { base, STALE, type RoleKey } from "@/lib/query-keys";
import {
  getSequenceFunnel,
  listVoiceSequenceSummaries,
} from "@/lib/sequence-funnel-api";

export function TopSequenceFunnelPanel({
  tenantId,
  role,
  userId = "unverified",
  viewerMode = false,
}: {
  tenantId: string;
  role: RoleKey;
  userId?: string;
  viewerMode?: boolean;
}) {
  const authority = {
    tenantId,
    userId,
    role,
    viewerMode,
    authorityKey: analyticsAuthorityKey(tenantId, userId, role, viewerMode),
  };
  const ready = analyticsAuthorityReady(authority);
  const identitySuffix = analyticsIdentitySuffix(authority);

  const sequencesQuery = useQuery({
    queryKey: [
      ...base("analytics-top-sequence", tenantId, role),
      ...identitySuffix,
    ],
    queryFn: ({ signal }) => listVoiceSequenceSummaries({ signal }),
    enabled: ready,
    staleTime: STALE.dashboard,
  });
  const sequences = Array.isArray(sequencesQuery.data)
    ? sequencesQuery.data
    : [];
  const top = sequences[0] ?? null;

  const funnelQuery = useQuery({
    queryKey: [
      ...base("analytics-top-sequence-funnel", tenantId, role),
      ...identitySuffix,
      top?.id ?? null,
    ],
    queryFn: ({ signal }) => getSequenceFunnel(top?.id ?? "", { signal }),
    enabled: ready && top !== null,
    staleTime: STALE.dashboard,
  });

  if (!ready) return null;

  const failure = sequencesQuery.isError
    ? {
        text: `Couldn't load your sequences: ${apiErrorMessage(sequencesQuery.error, "the request failed.")}`,
        retry: () => void sequencesQuery.refetch(),
        busy: sequencesQuery.isFetching,
      }
    : funnelQuery.isError
      ? {
          text: `Couldn't load the sequence funnel: ${apiErrorMessage(funnelQuery.error, "the request failed.")}`,
          retry: () => void funnelQuery.refetch(),
          busy: funnelQuery.isFetching,
        }
      : null;

  const steps = funnelQuery.data?.steps ?? null;
  const loading =
    !failure &&
    (sequencesQuery.isPending || (top !== null && funnelQuery.isPending));

  // Desktop parity: nothing to show without a sequence or funnel events.
  if (!failure && !loading && (top === null || !steps || steps.length === 0)) {
    return null;
  }

  const maxReached = steps
    ? Math.max(1, ...steps.map((step) => step.reached))
    : 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top sequence funnel</CardTitle>
        <CardDescription>
          {top ? (
            <>
              How many subscribers each step of{" "}
              <Link
                href={`/app/sequences/${encodeURIComponent(top.id)}`}
                className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {top.name}
              </Link>{" "}
              reached, opened and clicked, and where people dropped off.
            </>
          ) : (
            "Step-by-step reach, opens and clicks for your top sequence."
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {failure ? (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-md border border-warning/40 bg-warning-subtle px-3 py-3 text-sm text-warning-emphasis sm:flex-row sm:items-center sm:justify-between"
          >
            <span>{failure.text}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={failure.busy}
              onClick={failure.retry}
            >
              Retry
            </Button>
          </div>
        ) : loading || !steps ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <ol className="space-y-3" aria-label={`Funnel for ${top?.name ?? "sequence"}`}>
            {steps.map((step, index) => (
              <li
                key={`${step.position}:${step.stepId ?? ""}`}
                data-testid="sequence-funnel-step"
                className="space-y-1"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                  <span className="font-medium">
                    Step {step.position + 1}
                    {step.stepId && step.stepId !== `p${step.position}`
                      ? ` (${step.stepId})`
                      : ""}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {step.reached.toLocaleString()} reached ·{" "}
                    {step.opened.toLocaleString()} opened ·{" "}
                    {step.clicked.toLocaleString()} clicked
                  </span>
                </div>
                <div
                  aria-hidden="true"
                  className="h-2 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className="h-full rounded-full bg-primary/70"
                    style={{
                      width: `${Math.max(2, (step.reached / maxReached) * 100)}%`,
                    }}
                  />
                </div>
                <p className="text-xs tabular-nums text-muted-foreground">
                  Open {formatRate(step.openRate)} · click{" "}
                  {formatRate(step.clickRate)}
                  {index > 0 && step.dropoffPct > 0
                    ? ` · ${formatRate(step.dropoffPct)} dropped off before this step`
                    : ""}
                </p>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
