// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Analytics (audience-92): growth, source mix, engagement breakdown, health
 * history and per-member engagement — five independent reads so one card's
 * failure never blanks the others. Shapes are the Go handlers' (see
 * lists-api.ts); the per-row card scores the first members page because the
 * server needs explicit subscriber ids.
 */
import { useQuery } from "@tanstack/react-query";

import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ENGAGEMENT_WINDOW_DAYS,
  getListEngagementBreakdown,
  getListGrowth,
  getListHealthHistory,
  getListPerRowEngagement,
  getListSourceMix,
  GROWTH_WINDOW_DAYS,
  HEALTH_HISTORY_WINDOW_DAYS,
  listMembers,
  MEMBERS_PAGE_SIZE,
  type AudienceList,
} from "@/lib/lists-api";
import { listKeys, STALE, type RoleKey } from "@/lib/query-keys";

import {
  dateOnly,
  LoadFailure,
  Muted,
  Pending,
  percent,
  Section,
  Stat,
} from "./tab-chrome";

const SOURCE_LABELS: Record<string, string> = {
  form: "Form",
  api: "API",
  csv: "CSV import",
  integration: "Integration",
  admin: "Admin",
  migration: "Migration",
  listmonk_event: "Engine event",
};

function signed(n: number): string {
  return n.toLocaleString(undefined, { signDisplay: "always" });
}

function gradeVariant(grade: string): "success" | "warning" | "destructive" {
  const g = grade.toUpperCase();
  if (g === "A" || g === "B") return "success";
  if (g === "C" || g === "D") return "warning";
  return "destructive";
}

export function ListAnalyticsTab({
  list,
  tenantId,
  roleKey,
}: {
  list: AudienceList;
  tenantId: string;
  roleKey: RoleKey;
}) {
  const id = list.id;
  const growth = useQuery({
    queryKey: listKeys.analytics(
      tenantId,
      roleKey,
      id,
      "growth",
      GROWTH_WINDOW_DAYS,
    ),
    queryFn: ({ signal }) => getListGrowth(id, GROWTH_WINDOW_DAYS, signal),
    staleTime: STALE.dashboard,
  });
  const mix = useQuery({
    queryKey: listKeys.analytics(tenantId, roleKey, id, "source-mix"),
    queryFn: ({ signal }) => getListSourceMix(id, signal),
    staleTime: STALE.dashboard,
  });
  const engagement = useQuery({
    queryKey: listKeys.analytics(
      tenantId,
      roleKey,
      id,
      "engagement",
      ENGAGEMENT_WINDOW_DAYS,
    ),
    queryFn: ({ signal }) =>
      getListEngagementBreakdown(id, ENGAGEMENT_WINDOW_DAYS, signal),
    staleTime: STALE.dashboard,
  });
  const health = useQuery({
    queryKey: listKeys.analytics(
      tenantId,
      roleKey,
      id,
      "health-history",
      HEALTH_HISTORY_WINDOW_DAYS,
    ),
    queryFn: ({ signal }) =>
      getListHealthHistory(id, HEALTH_HISTORY_WINDOW_DAYS, signal),
    staleTime: STALE.dashboard,
  });
  // Same params object as the Members tab's first page, so the two share one
  // cache entry instead of issuing a second members read.
  const sampleParams = {
    query: undefined,
    status: undefined,
    page: 1,
    perPage: MEMBERS_PAGE_SIZE,
  };
  const sample = useQuery({
    queryKey: listKeys.members(tenantId, roleKey, id, sampleParams),
    queryFn: ({ signal }) => listMembers(id, sampleParams, signal),
    staleTime: STALE.list,
  });
  const sampleIds = Array.isArray(sample.data?.items)
    ? sample.data.items.map((member) => member.id)
    : [];
  const perRow = useQuery({
    queryKey: listKeys.analytics(tenantId, roleKey, id, "per-row", sampleIds),
    queryFn: ({ signal }) => getListPerRowEngagement(id, sampleIds, signal),
    enabled: sample.isSuccess,
    staleTime: STALE.dashboard,
  });

  return (
    <div className="space-y-4">
      <Section
        title="Subscriber growth"
        description={`Daily adds and removals over the last ${growth.data?.window_days ?? GROWTH_WINDOW_DAYS} days.`}
      >
        {growth.isPending ? (
          <Pending label="Loading growth" />
        ) : growth.isError ? (
          <LoadFailure
            what="Growth"
            error={growth.error}
            busy={growth.isFetching}
            onRetry={() => void growth.refetch()}
          />
        ) : growth.data.points.length === 0 ? (
          <Muted>
            No growth data yet. Once subscribers join or leave this list, the
            daily net trend appears here.
          </Muted>
        ) : (
          <GrowthCard data={growth.data} />
        )}
      </Section>

      <Section
        title="Source mix"
        description="How current members joined this list."
      >
        {mix.isPending ? (
          <Pending label="Loading source mix" />
        ) : mix.isError ? (
          <LoadFailure
            what="Source mix"
            error={mix.error}
            busy={mix.isFetching}
            onRetry={() => void mix.refetch()}
          />
        ) : (
          <SourceMixCard sources={mix.data.sources} />
        )}
      </Section>

      <Section
        title="Engagement breakdown"
        description={`Events from current members over the last ${engagement.data?.window_days ?? ENGAGEMENT_WINDOW_DAYS} days.`}
      >
        {engagement.isPending ? (
          <Pending label="Loading engagement" />
        ) : engagement.isError ? (
          <LoadFailure
            what="Engagement breakdown"
            error={engagement.error}
            busy={engagement.isFetching}
            onRetry={() => void engagement.refetch()}
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat
              label="Opens"
              value={engagement.data.opens.toLocaleString()}
            />
            <Stat
              label="Clicks"
              value={engagement.data.clicks.toLocaleString()}
            />
            <Stat
              label="Unsubscribes"
              value={engagement.data.unsubs.toLocaleString()}
            />
            <Stat
              label="Complaints"
              value={engagement.data.complaints.toLocaleString()}
            />
            <Stat
              label="Bounces"
              value={engagement.data.bounces.toLocaleString()}
            />
          </div>
        )}
      </Section>

      <Section
        title="List health over time"
        description={`Daily score (0–100) sampled by the health worker, last ${HEALTH_HISTORY_WINDOW_DAYS} days.`}
      >
        {health.isPending ? (
          <Pending label="Loading health history" />
        ) : health.isError ? (
          <LoadFailure
            what="Health history"
            error={health.error}
            busy={health.isFetching}
            onRetry={() => void health.refetch()}
          />
        ) : (
          <HealthHistoryCard samples={health.data.history} />
        )}
      </Section>

      <Section
        title="Member engagement"
        description={
          sample.data
            ? `Opens and clicks in the last 90 days for the first ${sample.data.items.length.toLocaleString()} of ${sample.data.total.toLocaleString()} members.`
            : "Opens and clicks in the last 90 days, per member."
        }
      >
        {sample.isPending || (sample.isSuccess && perRow.isPending) ? (
          <Pending label="Loading member engagement" />
        ) : sample.isError ? (
          <LoadFailure
            what="Member sample"
            error={sample.error}
            busy={sample.isFetching}
            onRetry={() => void sample.refetch()}
          />
        ) : perRow.isError ? (
          <LoadFailure
            what="Member engagement"
            error={perRow.error}
            busy={perRow.isFetching}
            onRetry={() => void perRow.refetch()}
          />
        ) : sampleIds.length === 0 ? (
          <Muted>No members to score yet.</Muted>
        ) : (
          <PerRowCard rows={Array.isArray(perRow.data) ? perRow.data : []} />
        )}
      </Section>
    </div>
  );
}

function GrowthCard({
  data,
}: {
  data: Awaited<ReturnType<typeof getListGrowth>>;
}) {
  const added = data.points.reduce((a, p) => a + p.added, 0);
  const removed = data.points.reduce((a, p) => a + p.removed, 0);
  const net = added - removed;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Added" value={added.toLocaleString()} />
        <Stat label="Removed" value={removed.toLocaleString()} />
        <Stat label="Net change" value={signed(net)} />
        <Stat label="Members now" value={data.current.toLocaleString()} />
      </div>
      <details className="rounded-md border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
          Daily buckets ({data.points.length})
        </summary>
        <TableContainer
          aria-label="Daily growth buckets"
          className="rounded-none border-0 border-t"
        >
          <Table className="min-w-[520px]">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Date</TableHead>
                <TableHead scope="col" className="text-right">
                  Added
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Removed
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Net
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Total
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.points.map((p) => (
                <TableRow key={p.date}>
                  <TableCell className="font-mono text-xs">{p.date}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.added.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.removed.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {signed(p.net)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.total.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </details>
    </div>
  );
}

function SourceMixCard({ sources }: { sources: Record<string, number> }) {
  const entries = Object.entries(sources).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, n]) => a + n, 0);
  if (total === 0)
    return <Muted>No source attribution recorded yet for this list.</Muted>;
  return (
    <ul className="space-y-2" aria-label="Member source mix">
      {entries.map(([source, n]) => {
        const share = n / total;
        return (
          <li key={source} className="text-sm">
            <div className="flex items-center justify-between gap-3">
              <span>{SOURCE_LABELS[source] ?? source}</span>
              <span className="tabular-nums text-muted-foreground">
                {n.toLocaleString()} · {percent(share, 0)}
              </span>
            </div>
            <div
              className="mt-1 h-1.5 w-full overflow-hidden rounded bg-muted"
              aria-hidden
            >
              <div
                className="h-full rounded bg-primary"
                style={{ width: `${Math.max(share * 100, n > 0 ? 1 : 0)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function HealthHistoryCard({
  samples,
}: {
  samples: Awaited<ReturnType<typeof getListHealthHistory>>["history"];
}) {
  if (samples.length === 0)
    return (
      <Muted>
        No scored days yet. The daily health worker records one sample per day
        once this list has members.
      </Muted>
    );
  const latest = samples[samples.length - 1]!;
  const first = samples[0]!;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Latest score"
          value={
            <span className="inline-flex items-center gap-2">
              {latest.score}
              <Badge variant={gradeVariant(latest.grade)}>
                {latest.grade || "?"}
              </Badge>
            </span>
          }
          hint={`Sampled ${dateOnly(latest.sampled_at)}`}
        />
        <Stat
          label="Change over window"
          value={samples.length >= 2 ? signed(latest.score - first.score) : "—"}
          hint={
            samples.length >= 2
              ? `Since ${dateOnly(first.sampled_at)}`
              : "Needs at least two scored days before a trend can be shown."
          }
        />
        <Stat
          label="Engagement"
          value={percent(latest.engagement_rate)}
          hint="Latest sample"
        />
      </div>
      <TableContainer aria-label="Health history samples">
        <Table className="min-w-[640px]">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Sampled</TableHead>
              <TableHead scope="col" className="text-right">
                Score
              </TableHead>
              <TableHead scope="col">Grade</TableHead>
              <TableHead scope="col" className="text-right">
                Bounce
              </TableHead>
              <TableHead scope="col" className="text-right">
                Complaint
              </TableHead>
              <TableHead scope="col" className="text-right">
                Unsubscribe
              </TableHead>
              <TableHead scope="col" className="text-right">
                Engagement
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...samples].reverse().map((s) => (
              <TableRow key={s.sampled_at}>
                <TableCell className="font-mono text-xs">
                  {dateOnly(s.sampled_at)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {s.score}
                </TableCell>
                <TableCell>
                  <Badge variant={gradeVariant(s.grade)}>
                    {s.grade || "?"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {percent(s.bounce_rate, 2)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {percent(s.complaint_rate, 3)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {percent(s.unsubscribe_rate, 2)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {percent(s.engagement_rate)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </div>
  );
}

function PerRowCard({
  rows,
}: {
  rows: Awaited<ReturnType<typeof getListPerRowEngagement>>;
}) {
  if (rows.length === 0)
    return (
      <Muted>
        No engagement recorded for these members yet. Rows appear once campaigns
        have been delivered to them.
      </Muted>
    );
  const sorted = [...rows].sort(
    (a, b) =>
      b.opens + b.clicks - (a.opens + a.clicks) ||
      a.email.localeCompare(b.email),
  );
  return (
    <TableContainer aria-label="Member engagement">
      <Table className="min-w-[560px]">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Email</TableHead>
            <TableHead scope="col" className="text-right">
              Opens
            </TableHead>
            <TableHead scope="col" className="text-right">
              Clicks
            </TableHead>
            <TableHead scope="col">Last engaged</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="max-w-[280px] truncate" title={r.email}>
                {r.email || r.id}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {r.opens.toLocaleString()}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {r.clicks.toLocaleString()}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {r.last_engaged_at ? (
                  <RelativeTime iso={r.last_engaged_at} />
                ) : (
                  "—"
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
