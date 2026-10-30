// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Data-fetching analytics widgets that live on the Overview tab: subscriber-
// growth trend chart, campaign performance leaderboard, an on-demand AI
// narrative, the recent-anomalies list, and the scheduled-digest settings.
// Each is tenant/role-scoped via `base()` and consumes existing backend
// endpoints (ANL-011/012/014/026/041).

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { LineChart } from "@/components/charts/line-chart";
import {
  compareCampaigns,
  getDigestPrefs,
  getSubscriberTimeseries,
  putDigestPrefs,
  type CompareRow,
  type DashboardStats,
  type DigestFrequency,
} from "@/lib/analytics-api";
import { runInlineAI } from "@/lib/mailchimp-compat-api";
import { analyticsNarrativeText } from "@/lib/analytics-narrative";
import { listCampaigns, type Campaign } from "@/lib/campaigns-api";
import { base, STALE, type RoleKey } from "@/lib/query-keys";
import { absoluteTime, timeAgo } from "@/lib/relative-time";
import {
  abortAnalyticsWrite,
  analyticsCanWriteCampaigns,
  assertAnalyticsCampaignWriteAllowed,
  assertAnalyticsSignalActive,
  analyticsAuthorityKey,
  analyticsAuthorityReady,
  analyticsIdentitySuffix,
  beginAnalyticsWrite,
  endAnalyticsWrite,
  verifyAnalyticsAuthority,
  type AnalyticsAuthority,
} from "@/lib/analytics-authority";
import { newUUIDv7 } from "@/lib/http-fetch";
import { useOnline } from "@/lib/use-online";
import { formatRate, rangeDays } from "@/lib/analytics-format";

interface ScopeProps {
  tenantId: string;
  role: RoleKey;
  userId?: string;
  viewerMode?: boolean;
}

function authorityFromScope({
  tenantId,
  role,
  userId = "unverified",
  viewerMode = false,
}: ScopeProps): AnalyticsAuthority {
  return {
    tenantId,
    role,
    userId,
    viewerMode,
    authorityKey: analyticsAuthorityKey(tenantId, userId, role, viewerMode),
  };
}

// ---------------------------------------------------------------------------
// Subscriber-growth trend chart (ANL-012)
// ---------------------------------------------------------------------------

export function SubscriberGrowthChart({
  tenantId,
  role,
  userId = "unverified",
  viewerMode = false,
  range,
}: ScopeProps & { range: string }) {
  const authority = authorityFromScope({
    tenantId,
    role,
    userId,
    viewerMode,
  });
  const query = useQuery({
    queryKey: [
      ...base("subscriber-timeseries", tenantId, role),
      ...analyticsIdentitySuffix(authority),
      range,
    ],
    queryFn: ({ signal }) => getSubscriberTimeseries(range, { signal }),
    enabled: analyticsAuthorityReady(authority),
    staleTime: STALE.dashboard,
  });

  const points = Array.isArray(query.data?.points) ? query.data?.points : [];
  const values = points.map((p) => p.count);
  const labels = points.map((p) => p.date);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audience growth</CardTitle>
        <CardDescription>
          Total contacts over the last {rangeDays(range)} days.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <Skeleton className="h-44 w-full" />
        ) : query.isError ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-warning-emphasis"
          >
            <span>Growth trend couldn&apos;t be loaded.</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <LineChart
            values={values}
            labels={labels}
            height={180}
            colorVar="--chart-1"
            ariaLabel={`Total contacts over the last ${rangeDays(range)} days`}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Campaign performance leaderboard (ANL-014)
// ---------------------------------------------------------------------------

type SortKey =
  | "open_rate"
  | "click_rate"
  | "bounce_rate"
  | "unsub_rate"
  | "total_recipients";

const LEADERBOARD_COLUMNS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "total_recipients", label: "Recipients" },
  { key: "open_rate", label: "Open" },
  { key: "click_rate", label: "Click" },
  { key: "bounce_rate", label: "Bounce" },
  { key: "unsub_rate", label: "Unsub" },
];

export function CampaignLeaderboard({
  tenantId,
  role,
  userId = "unverified",
  viewerMode = false,
}: ScopeProps) {
  const [sortKey, setSortKey] = useState<SortKey>("open_rate");
  const authority = authorityFromScope({
    tenantId,
    role,
    userId,
    viewerMode,
  });
  const identitySuffix = analyticsIdentitySuffix(authority);

  const campaignsQuery = useQuery({
    queryKey: [
      ...base("leaderboard-campaigns", tenantId, role),
      ...identitySuffix,
    ],
    queryFn: ({ signal }) => listCampaigns({ limit: 50 }, { signal }),
    enabled: analyticsAuthorityReady(authority),
    staleTime: STALE.dashboard,
  });

  const sentCampaigns: Campaign[] = (
    Array.isArray(campaignsQuery.data) ? campaignsQuery.data : []
  )
    .filter((c) => c.status === "sent")
    .slice(0, 15);
  const ids = sentCampaigns.map((c) => c.id);
  const nameById = new Map(sentCampaigns.map((c) => [c.id, c.name]));

  const compareQuery = useQuery({
    queryKey: [
      ...base("leaderboard-compare", tenantId, role),
      ...identitySuffix,
      ids.join(","),
    ],
    queryFn: ({ signal }) => compareCampaigns(ids, { signal }),
    enabled: analyticsAuthorityReady(authority) && ids.length > 0,
    staleTime: STALE.dashboard,
  });

  const rows: CompareRow[] = useMemo(() => {
    const data = Array.isArray(compareQuery.data) ? compareQuery.data : [];
    return [...data].sort((a, b) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0));
  }, [compareQuery.data, sortKey]);

  // The loading flag has to mirror compareQuery's own `enabled` gate: with no
  // sent campaigns `ids` is empty, the compare query never runs, and a disabled
  // query sits at isPending forever — so counting it unconditionally would pin
  // a workspace with only drafts to skeleton bars and make the empty state
  // below unreachable.
  const loading =
    campaignsQuery.isPending || (ids.length > 0 && compareQuery.isPending);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Campaign leaderboard</CardTitle>
        <CardDescription>
          Your most recent sends ranked by engagement. Click a row for the full
          report. Rates use unique recipients sent, across all time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {campaignsQuery.isError || compareQuery.isError ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-warning-emphasis"
          >
            <span>Comparison couldn&apos;t be loaded.</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void campaignsQuery.refetch();
                void compareQuery.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        ) : loading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : ids.length === 0 ? (
          <div className="rounded-md border border-dashed bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
            No sent campaigns yet. Send a campaign to compare performance here.
          </div>
        ) : (
          <div
            role="region"
            aria-label="Campaign leaderboard"
            tabIndex={0}
            className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-2 text-left font-medium">
                    Campaign
                  </th>
                  {LEADERBOARD_COLUMNS.map((col) => {
                    const active = sortKey === col.key;
                    return (
                      <th
                        key={col.key}
                        scope="col"
                        aria-sort={active ? "descending" : "none"}
                        className="py-2 pl-2 text-right font-medium"
                      >
                        <button
                          type="button"
                          onClick={() => setSortKey(col.key)}
                          className={`rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "text-foreground" : ""}`}
                        >
                          {col.label}
                          {active ? " ↓" : ""}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.campaign_id}
                    className="border-b last:border-0 hover:bg-accent/40"
                  >
                    <td className="py-2 pr-2">
                      <Link
                        href={`/app/campaigns/${row.campaign_id}/analytics`}
                        className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {nameById.get(row.campaign_id) ?? "Untitled campaign"}
                      </Link>
                    </td>
                    <td className="py-2 pl-2 text-right tabular-nums">
                      {row.total_recipients.toLocaleString()}
                    </td>
                    <td className="py-2 pl-2 text-right tabular-nums">
                      {formatRate(
                        row.total_recipients > 0 ? row.open_rate : null,
                      )}
                    </td>
                    <td className="py-2 pl-2 text-right tabular-nums">
                      {formatRate(
                        row.total_recipients > 0 ? row.click_rate : null,
                      )}
                    </td>
                    <td className="py-2 pl-2 text-right tabular-nums">
                      {formatRate(
                        row.total_recipients > 0 ? row.bounce_rate : null,
                      )}
                    </td>
                    <td className="py-2 pl-2 text-right tabular-nums">
                      {formatRate(
                        row.total_recipients > 0 ? row.unsub_rate : null,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// AI narrative — "what changed this period" (ANL-041)
// ---------------------------------------------------------------------------

function narrativePrompt(stats: DashboardStats, range: string): string {
  const prev = stats.previous ?? {};
  return [
    `Summarize this email marketing dashboard for the last ${rangeDays(range)} days in 2-3 sentences, plain language, and call out anything notable.`,
    `Subscribers total: ${stats.subscribers_total}.`,
    `Added: ${stats.subscribers_added_30d} (prev ${prev.subscribers_added ?? 0}).`,
    `Unsubscribed: ${stats.subscribers_unsubbed_30d} (prev ${prev.subscribers_unsubbed ?? 0}).`,
    `Opens: ${stats.opens_total_30d} (prev ${prev.opens_total ?? 0}).`,
    `Clicks: ${stats.clicks_total_30d} (prev ${prev.clicks_total ?? 0}).`,
    `Bounces: ${stats.bounces_total_30d} (prev ${prev.bounces_total ?? 0}).`,
    stats.anomalies && Object.values(stats.anomalies).some(Boolean)
      ? `Anomalies flagged on: ${Object.entries(stats.anomalies)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(", ")}.`
      : "No anomalies flagged.",
  ].join(" ");
}

export function AiNarrativeCard({
  stats,
  range,
  authority,
}: {
  stats: DashboardStats;
  range: string;
  authority: AnalyticsAuthority;
}) {
  const online = useOnline();
  const [summary, setSummary] = useState<string | null>(null);
  const reportKey = narrativePrompt(stats, range);
  const reportRef = useRef(reportKey);
  const authorityRef = useRef(authority.authorityKey);
  const mutationAuthorityRef = useRef<string | null>(null);
  const attemptRef = useRef<{
    fingerprint: string;
    idempotencyKey: string;
  } | null>(null);
  useEffect(() => {
    authorityRef.current = authority.authorityKey;
    reportRef.current = reportKey;
    mutationAuthorityRef.current = null;
    attemptRef.current = null;
    abortAnalyticsWrite();
    setSummary(null);
    return abortAnalyticsWrite;
  }, [authority.authorityKey, reportKey]);

  const mutation = useMutation({
    mutationFn: async () => {
      assertAnalyticsCampaignWriteAllowed(authority);
      const controller = beginAnalyticsWrite();
      if (!controller) {
        throw new Error("Another analytics change is already in progress.");
      }
      const expected = Object.freeze({ ...authority });
      mutationAuthorityRef.current = expected.authorityKey;
      const prompt = narrativePrompt(stats, range);
      const fingerprint = JSON.stringify([
        expected.authorityKey,
        range,
        prompt,
      ]);
      if (attemptRef.current?.fingerprint !== fingerprint) {
        attemptRef.current = {
          fingerprint,
          idempotencyKey: `analytics-narrative:${newUUIDv7()}`,
        };
      }
      const attempt = attemptRef.current;
      if (!attempt) throw new Error("Could not prepare the summary request.");
      try {
        await verifyAnalyticsAuthority(expected, controller.signal);
        const result = await runInlineAI(
          {
            mode: "insight",
            channel: "email",
            prompt,
          },
          {
            signal: controller.signal,
            requireOnline: true,
            maxAttempts: 1,
            idempotencyKey: attempt.idempotencyKey,
          },
        );
        assertAnalyticsSignalActive(controller.signal);
        return {
          authorityKey: expected.authorityKey,
          reportKey,
          text: analyticsNarrativeText(stats, range, result),
        };
      } finally {
        endAnalyticsWrite(controller);
      }
    },
    onSuccess: (res) => {
      if (
        authorityRef.current !== res.authorityKey ||
        reportRef.current !== res.reportKey
      )
        return;
      attemptRef.current = null;
      setSummary(res.text);
    },
    onError: (err) => {
      if (mutationAuthorityRef.current !== authorityRef.current) return;
      toast.error(
        err instanceof Error ? err.message : "Couldn't generate a summary.",
      );
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden />
            <CardTitle>What changed</CardTitle>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={
              mutation.isPending ||
              !analyticsCanWriteCampaigns(authority) ||
              online !== "online"
            }
          >
            {mutation.isPending
              ? "Summarizing…"
              : summary
                ? "Regenerate"
                : "Generate summary"}
          </Button>
        </div>
        <CardDescription>
          A plain-language read on period-over-period changes and anomalies.
        </CardDescription>
        {authority.viewerMode ? (
          <p className="text-xs text-muted-foreground">
            Viewer mode is read-only. Exit viewer mode to generate a summary.
          </p>
        ) : authority.role === "viewer" ? (
          <p className="text-xs text-muted-foreground">
            Your role is read-only. Ask an editor or workspace admin to generate
            a summary.
          </p>
        ) : online !== "online" ? (
          <p className="text-xs text-muted-foreground">
            Connect to the internet to generate a new summary.
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        {summary ? (
          <p
            className="text-sm leading-relaxed text-foreground"
            aria-live="polite"
          >
            {summary}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Generate a summary of this period&apos;s key movements.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Scheduled email digest settings (ANL-011)
// ---------------------------------------------------------------------------

export function DigestSettingsCard({
  tenantId,
  role,
  userId = "unverified",
  viewerMode = false,
}: ScopeProps) {
  const client = useQueryClient();
  const online = useOnline();
  const authority = authorityFromScope({
    tenantId,
    role,
    userId,
    viewerMode,
  });
  const key = [
    ...base("digest-prefs", tenantId, role),
    ...analyticsIdentitySuffix(authority),
  ];
  const authorityKey = authority.authorityKey;
  const authorityRef = useRef(authorityKey);
  const mutationAuthorityRef = useRef<string | null>(null);
  const attemptRef = useRef<{
    fingerprint: string;
    idempotencyKey: string;
  } | null>(null);
  const previousKey = useRef(key);
  useEffect(() => {
    const staleKey = previousKey.current;
    if (staleKey.join("|") !== key.join("|")) {
      void client.cancelQueries({ queryKey: staleKey, exact: true });
      client.removeQueries({ queryKey: staleKey, exact: true });
    }
    previousKey.current = key;
    authorityRef.current = authorityKey;
    mutationAuthorityRef.current = null;
    attemptRef.current = null;
    abortAnalyticsWrite();
    void client.cancelQueries({ queryKey: key });
    return () => {
      abortAnalyticsWrite();
      void client.cancelQueries({ queryKey: key });
    };
  }, [authorityKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getDigestPrefs({ signal }),
    enabled: analyticsAuthorityReady(authority),
    staleTime: STALE.dashboard,
  });

  const mutation = useMutation({
    mutationFn: async (frequency: DigestFrequency) => {
      const controller = beginAnalyticsWrite();
      if (!controller) {
        throw new Error("Another analytics change is already in progress.");
      }
      const expected = Object.freeze({ ...authority });
      mutationAuthorityRef.current = expected.authorityKey;
      const fingerprint = JSON.stringify([expected.authorityKey, frequency]);
      if (attemptRef.current?.fingerprint !== fingerprint) {
        attemptRef.current = {
          fingerprint,
          idempotencyKey: `analytics-digest:${newUUIDv7()}`,
        };
      }
      const attempt = attemptRef.current;
      if (!attempt) throw new Error("Could not prepare the digest update.");
      try {
        await verifyAnalyticsAuthority(expected, controller.signal);
        const result = await putDigestPrefs(frequency, {
          signal: controller.signal,
          idempotencyKey: attempt.idempotencyKey,
        });
        assertAnalyticsSignalActive(controller.signal);
        return { authorityKey: expected.authorityKey, result };
      } finally {
        endAnalyticsWrite(controller);
      }
    },
    onSuccess: (res) => {
      if (authorityRef.current !== res.authorityKey) return;
      attemptRef.current = null;
      client.setQueryData(key, (prev: unknown) =>
        prev && typeof prev === "object"
          ? { ...prev, frequency: res.result.frequency }
          : { frequency: res.result.frequency },
      );
      toast.success(
        res.result.frequency === "off"
          ? "Email digest turned off."
          : `Email digest set to ${res.result.frequency}.`,
      );
    },
    onError: (err) => {
      if (mutationAuthorityRef.current !== authorityRef.current) return;
      toast.error(
        err instanceof Error ? err.message : "Couldn't update digest settings.",
      );
      void query.refetch();
    },
  });

  const frequency: DigestFrequency = query.data?.frequency ?? "off";
  const lastSentAt = query.data?.lastSentAt;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email digest</CardTitle>
        <CardDescription>
          Get a scheduled summary of these stats delivered to your inbox.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isPending ? (
          <Skeleton className="h-9 w-48" />
        ) : (
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Cadence</span>
            <Select
              aria-label="Digest cadence"
              className="w-40"
              value={frequency}
              disabled={
                mutation.isPending ||
                query.isError ||
                viewerMode ||
                online !== "online"
              }
              onChange={(e) =>
                mutation.mutate(e.target.value as DigestFrequency)
              }
            >
              <option value="off">Off</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </Select>
            {mutation.isPending ? (
              <span className="text-xs text-muted-foreground">Saving…</span>
            ) : null}
          </label>
        )}
        {viewerMode ? (
          <p className="text-xs text-muted-foreground">
            Viewer mode is read-only. Exit viewer mode to change the cadence.
          </p>
        ) : online !== "online" ? (
          <p className="text-xs text-muted-foreground">
            Connect to the internet to change the cadence.
          </p>
        ) : null}
        {query.isError ? (
          <p className="text-xs text-destructive">
            Digest settings couldn&apos;t be loaded.
          </p>
        ) : lastSentAt ? (
          <p className="text-xs text-muted-foreground">
            Last sent{" "}
            <span title={absoluteTime(lastSentAt)}>{timeAgo(lastSentAt)}</span>.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
