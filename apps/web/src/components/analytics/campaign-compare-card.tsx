// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Compare campaigns (desktop CampaignCompareCard). Where the leaderboard ranks
// the latest sends automatically, this card lets the reader HAND-PICK up to
// six delivered campaigns and compares their recipient-normalized rates via
//
//   GET /api/v1/analytics/campaigns/compare?ids=<id>,<id>,…
//
// Each column's leader is tested against its runner-up with a two-proportion
// z-test (lib/stats) and labelled honestly: "Best · 95%" / "Best · 99%" only
// when the lead is significant, "leads — not significant" or "leads — low
// sample" otherwise, so a dozen recipients can never crown a winner. Reload
// re-reads both the candidates and the comparison.
//
// Read-only (`read:reports`); a refusal renders the server's own sentence.

import { useId, useState, type ReactNode } from "react";
import { Check, RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { compareCampaigns, type CompareRow } from "@/lib/analytics-api";
import {
  analyticsAuthorityKey,
  analyticsAuthorityReady,
  analyticsIdentitySuffix,
} from "@/lib/analytics-authority";
import { formatRate } from "@/lib/analytics-format";
import { apiErrorMessage } from "@/lib/api";
import { listCampaigns, type Campaign } from "@/lib/campaigns-api";
import { base, STALE, type RoleKey } from "@/lib/query-keys";
import {
  confidenceLabel,
  formatPValue,
  ztest,
  type ConfidenceLabel,
} from "@/lib/stats";
import { cn } from "@/lib/utils";

export const MAX_COMPARE_SELECTED = 6;
const CANDIDATE_LIMIT = 20;
const DEFAULT_SELECTED = 3;

/** Statuses that have recipients, so the compare endpoint has data. */
const DELIVERED = new Set(["sent", "sending", "paused"]);

type RateKey =
  | "open_rate"
  | "click_rate"
  | "bounce_rate"
  | "complaint_rate"
  | "unsub_rate";

export const RATE_COLUMNS: ReadonlyArray<{
  key: RateKey;
  label: string;
  /** Lower is better. */
  invert: boolean;
}> = [
  { key: "open_rate", label: "Open", invert: false },
  { key: "click_rate", label: "Click", invert: false },
  { key: "bounce_rate", label: "Bounce", invert: true },
  { key: "complaint_rate", label: "Complaint", invert: true },
  { key: "unsub_rate", label: "Unsub", invert: true },
];

export interface ColumnVerdict {
  /** campaign_id of the column's observed leader. */
  leader: string;
  confidence: ConfidenceLabel;
  p: number;
}

/**
 * The observed leader of each rate column and how confident we can be that it
 * beats the runner-up (two-proportion z-test, n = total_recipients; rates are
 * fractions on the wire). Columns with fewer than two finite values get none.
 */
export function compareColumnVerdicts(
  rows: CompareRow[],
): Map<RateKey, ColumnVerdict> {
  const out = new Map<RateKey, ColumnVerdict>();
  for (const column of RATE_COLUMNS) {
    const comparable = rows.filter(
      (row) =>
        row.total_recipients > 0 && Number.isFinite(Number(row[column.key])),
    );
    if (comparable.length < 2) continue;
    const ordered = [...comparable].sort((a, b) => {
      const av = Number(a[column.key]);
      const bv = Number(b[column.key]);
      return column.invert ? av - bv : bv - av;
    });
    const top = ordered[0];
    const runnerUp = ordered[1];
    if (!top || !runnerUp) continue;
    const result = ztest(
      Number(top[column.key]),
      top.total_recipients,
      Number(runnerUp[column.key]),
      runnerUp.total_recipients,
    );
    out.set(column.key, {
      leader: top.campaign_id,
      confidence: confidenceLabel(
        result,
        top.total_recipients,
        runnerUp.total_recipients,
      ),
      p: result.p,
    });
  }
  return out;
}

function campaignName(campaign: Campaign): string {
  return (
    campaign.name?.trim() || campaign.subject?.trim() || "Untitled campaign"
  );
}

export function CampaignCompareCard({
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

  // Same key + request as the leaderboard, so the two share one list read.
  const campaignsQuery = useQuery({
    queryKey: [
      ...base("leaderboard-campaigns", tenantId, role),
      ...identitySuffix,
    ],
    queryFn: ({ signal }) => listCampaigns({ limit: 50 }, { signal }),
    enabled: ready,
    staleTime: STALE.dashboard,
  });
  const candidates: Campaign[] = (
    Array.isArray(campaignsQuery.data) ? campaignsQuery.data : []
  )
    .filter((c) => DELIVERED.has(c.status))
    .slice(0, CANDIDATE_LIMIT);
  const candidateIds = new Set(candidates.map((c) => c.id));
  const nameById = new Map(candidates.map((c) => [c.id, campaignName(c)]));

  // null = the reader hasn't picked yet: preselect the most recent few.
  const [picked, setPicked] = useState<string[] | null>(null);
  const selected = (
    picked ?? candidates.slice(0, DEFAULT_SELECTED).map((c) => c.id)
  ).filter((id) => candidateIds.has(id));
  const atLimit = selected.length >= MAX_COMPARE_SELECTED;

  const compareQuery = useQuery({
    queryKey: [
      ...base("campaign-compare", tenantId, role),
      ...identitySuffix,
      selected.join(","),
    ],
    queryFn: ({ signal }) => compareCampaigns(selected, { signal }),
    enabled: ready && selected.length >= 2,
    staleTime: STALE.dashboard,
  });
  const rows: CompareRow[] = Array.isArray(compareQuery.data)
    ? compareQuery.data
    : [];
  const verdicts = compareColumnVerdicts(rows);

  function toggle(id: string) {
    setPicked(() => {
      if (selected.includes(id)) return selected.filter((x) => x !== id);
      if (selected.length >= MAX_COMPARE_SELECTED) return selected;
      return [...selected, id];
    });
  }

  function reload() {
    void campaignsQuery.refetch();
    if (selected.length >= 2) void compareQuery.refetch();
  }

  const limitNoticeId = useId();
  const reloading = campaignsQuery.isFetching || compareQuery.isFetching;

  let body: ReactNode;
  if (!ready || campaignsQuery.isPending) {
    body = <Skeleton className="h-40 w-full" />;
  } else if (campaignsQuery.isError) {
    body = (
      <ErrorRow
        message={`Couldn't load your campaigns: ${apiErrorMessage(campaignsQuery.error, "the request failed.")}`}
        onRetry={() => void campaignsQuery.refetch()}
        busy={campaignsQuery.isFetching}
      />
    );
  } else if (candidates.length < 2) {
    body = (
      <p className="text-sm text-muted-foreground">
        Send at least two campaigns to compare them side by side.
      </p>
    );
  } else {
    body = (
      <div className="space-y-4">
        <div
          role="group"
          aria-label="Campaigns included in the comparison"
          className="flex flex-wrap gap-1.5"
        >
          {candidates.map((campaign) => {
            const on = selected.includes(campaign.id);
            const blocked = !on && atLimit;
            const label = campaignName(campaign);
            return (
              <button
                key={campaign.id}
                type="button"
                aria-pressed={on}
                aria-disabled={blocked || undefined}
                aria-describedby={blocked ? limitNoticeId : undefined}
                title={label}
                onClick={() => {
                  if (!blocked) toggle(campaign.id);
                }}
                className={cn(
                  "inline-flex min-h-11 max-w-[12rem] items-center gap-1 truncate rounded-full border px-3 text-xs sm:min-h-8",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  on
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent",
                  blocked && "cursor-not-allowed opacity-50",
                )}
              >
                {on ? <Check className="h-3 w-3 shrink-0" aria-hidden /> : null}
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </div>
        {atLimit ? (
          <p id={limitNoticeId} className="text-xs text-muted-foreground">
            Comparison limit reached ({MAX_COMPARE_SELECTED}). Remove a selected
            campaign before adding another.
          </p>
        ) : null}

        {selected.length < 2 ? (
          <p role="status" className="text-sm text-muted-foreground">
            Select at least two campaigns to compare their recipient-normalized
            rates.
          </p>
        ) : compareQuery.isError ? (
          <ErrorRow
            message={`Comparison failed: ${apiErrorMessage(compareQuery.error, "the request failed.")}`}
            onRetry={() => void compareQuery.refetch()}
            busy={compareQuery.isFetching}
          />
        ) : compareQuery.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : rows.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            No event data for the selected campaigns yet.
          </p>
        ) : (
          <div
            role="region"
            aria-label="Campaign comparison"
            tabIndex={0}
            className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-2 text-left font-medium">
                    Campaign
                  </th>
                  <th scope="col" className="py-2 pl-2 text-right font-medium">
                    Recipients
                  </th>
                  {RATE_COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      className="py-2 pl-2 text-right font-medium"
                    >
                      {column.label}
                      {column.invert ? (
                        <span className="block text-[10px] font-normal">
                          lower is better
                        </span>
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.campaign_id} className="border-b last:border-0">
                    <th
                      scope="row"
                      className="max-w-[12rem] truncate py-2 pr-2 text-left font-medium"
                    >
                      {nameById.get(row.campaign_id) ?? "Untitled campaign"}
                    </th>
                    <td className="py-2 pl-2 text-right tabular-nums">
                      {Number(row.total_recipients).toLocaleString()}
                    </td>
                    {RATE_COLUMNS.map((column) => (
                      <RateCell
                        key={column.key}
                        value={
                          row.total_recipients > 0
                            ? Number(row[column.key])
                            : NaN
                        }
                        verdict={
                          verdicts.get(column.key)?.leader === row.campaign_id
                            ? verdicts.get(column.key)
                            : undefined
                        }
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <CardTitle>Compare campaigns</CardTitle>
            <CardDescription>
              Pick up to {MAX_COMPARE_SELECTED} campaigns. A leader is marked
              best only when a two-proportion z-test says it beats the
              runner-up. Rates use unique recipients sent as the denominator,
              across all time; campaign reports use delivered recipients for
              open and click rates.
              {candidates.length >= 2
                ? ` ${selected.length} of ${MAX_COMPARE_SELECTED} selected.`
                : ""}
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!ready || reloading}
            onClick={reload}
          >
            <RefreshCw
              className={cn(
                "h-4 w-4 motion-reduce:animate-none",
                reloading && "animate-spin",
              )}
              aria-hidden
            />
            {reloading ? "Reloading…" : "Reload"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function RateCell({
  value,
  verdict,
}: {
  value: number;
  verdict: ColumnVerdict | undefined;
}) {
  const significant =
    verdict?.confidence === "95" || verdict?.confidence === "99";
  return (
    <td className="py-2 pl-2 text-right tabular-nums">
      <span className="inline-flex flex-col items-end gap-0.5">
        <span>{formatRate(Number.isFinite(value) ? value : null)}</span>
        {verdict && significant ? (
          <Badge
            variant="success"
            title={`Significantly better than the runner-up (p ${formatPValue(verdict.p)}, two-proportion z-test)`}
          >
            Best · {verdict.confidence}%
          </Badge>
        ) : verdict ? (
          <span className="text-[10px] text-muted-foreground">
            {verdict.confidence === "low_sample"
              ? "leads — low sample"
              : "leads — not significant"}
          </span>
        ) : null}
      </span>
    </td>
  );
}

function ErrorRow({
  message,
  onRetry,
  busy,
}: {
  message: string;
  onRetry: () => void;
  busy: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-md border border-warning/40 bg-warning-subtle px-3 py-3 text-sm text-warning-emphasis sm:flex-row sm:items-center sm:justify-between"
    >
      <span>{message}</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        loading={busy}
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}
