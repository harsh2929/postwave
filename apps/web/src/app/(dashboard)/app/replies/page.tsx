// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageSquareReply } from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import { whoami } from "@/lib/auth-api";
import { canAdminCampaigns } from "@/lib/campaign-write-authority";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { base, STALE } from "@/lib/query-keys";
import {
  bandResidual,
  getReplySummary,
  getReplyTimeseries,
  getTopReplySenders,
  windowsDisagree,
} from "@/lib/replies-api";
import {
  EngagementEmpty,
  EngagementIdentityGate,
  EngagementLoading,
  EngagementMetric,
  EngagementPageHeader,
  EngagementQueryError,
  EngagementSurface,
} from "../_engagement/engagement-ui";
import { ReplyMailboxManager } from "../deliverability/reply-mailbox-manager";

export default function RepliesPage() {
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const canLoad = Boolean(meQuery.data);
  const canReadReplyIdentity = canAdminCampaigns(meQuery.data);
  const keyBase = useMemo(
    () =>
      base(
        "replies",
        meQuery.data?.tenant_id ?? "pending",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  const summary = useQuery({
    queryKey: [...keyBase, "summary"],
    queryFn: getReplySummary,
    staleTime: STALE.list,
    enabled: canLoad,
  });
  const series = useQuery({
    queryKey: [...keyBase, "timeseries"],
    queryFn: getReplyTimeseries,
    staleTime: STALE.list,
    enabled: canLoad,
  });
  const senders = useQuery({
    queryKey: [...keyBase, "top-senders"],
    queryFn: getTopReplySenders,
    staleTime: STALE.list,
    enabled: canLoad && canReadReplyIdentity,
  });

  const report = summary.data;
  const residual = report ? bandResidual(report) : 0;
  const senderWindow = senders.data?.window_days ?? 0;
  const mismatch = report
    ? windowsDisagree(report.window_days, senderWindow)
    : false;
  const points = Array.isArray(series.data?.points) ? series.data.points : [];
  const senderRows = Array.isArray(senders.data?.senders)
    ? senders.data.senders
    : [];
  const maxReplies = Math.max(0, ...points.map((point) => point.replies));
  const totalInSeries = points.reduce(
    (total, point) => total + Math.max(0, point.replies),
    0,
  );

  return (
    <PageShell className="max-w-6xl">
      <EngagementPageHeader
        eyebrow="Conversation intelligence"
        title="Replies"
        description="Separate confirmed human responses, automated replies, unknown classifications, and subscriber matching before using inbound activity as engagement."
        icon={<MessageSquareReply aria-hidden />}
      />

      <EngagementIdentityGate
        pending={meQuery.isPending}
        error={meQuery.isError || !meQuery.data}
        retrying={meQuery.isFetching}
        onRetry={() => void meQuery.refetch()}
      >
        <EngagementSurface
          id="rep-summary"
          title="Reply classification"
          description="Human, automated, and unclassified are three independent bands. Matching to a subscriber answers a separate question."
        >
          {summary.isPending ? (
            <EngagementLoading label="Loading reply classification" rows={4} />
          ) : summary.isError || !report ? (
            <EngagementQueryError
              title="Reply classification could not be loaded"
              description="No reply is being assumed human, automated, matched, or unmatched while the summary is unavailable."
              retrying={summary.isFetching}
              onRetry={() => void summary.refetch()}
            />
          ) : (
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                Last {report.window_days.toLocaleString()} days.
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <EngagementMetric
                  label="Replies received"
                  value={report.total.toLocaleString()}
                />
                <EngagementMetric
                  label="Confirmed human"
                  value={report.human_replies.toLocaleString()}
                  tone="positive"
                />
                <EngagementMetric
                  label="Automated or bot"
                  value={report.excluded_non_human.toLocaleString()}
                />
                <EngagementMetric
                  label="Not yet classified"
                  value={report.unclassified_replies.toLocaleString()}
                  tone={report.unclassified_replies > 0 ? "warning" : "default"}
                />
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <EngagementMetric
                  label="Matched subscriber"
                  value={report.matched.toLocaleString()}
                />
                <EngagementMetric
                  label="No subscriber match"
                  value={report.unmatched.toLocaleString()}
                />
              </div>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                Engagement reporting uses only the{" "}
                {report.human_replies.toLocaleString()} confirmed human{" "}
                {report.human_replies === 1 ? "reply" : "replies"}. Unclassified
                replies are counted as neither human nor automated.
              </p>
              {residual !== 0 ? (
                <p
                  role="status"
                  className="mt-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm leading-relaxed text-muted-foreground"
                >
                  {Math.abs(residual).toLocaleString()}{" "}
                  {Math.abs(residual) === 1 ? "reply is" : "replies are"} not
                  accounted for by the three classification bands. The
                  discrepancy is preserved instead of assigned to a category.
                </p>
              ) : null}
            </>
          )}
        </EngagementSurface>

        <div className="grid gap-6 lg:grid-cols-2">
          <EngagementSurface
            id="rep-senders"
            title="Most frequent senders"
            description="A separate server-reported window; it may cover a longer period than the classification above."
          >
            {!canReadReplyIdentity ? (
              <EngagementEmpty
                title="Sender identities are restricted"
                description="A workspace owner or admin can see reply addresses. Aggregate reply totals remain available without access to private correspondence."
              />
            ) : senders.isPending ? (
              <EngagementLoading label="Loading frequent reply senders" />
            ) : senders.isError ? (
              <EngagementQueryError
                title="Frequent senders could not be loaded"
                description="A failed sender query is not presented as a window with no repeat correspondents."
                retrying={senders.isFetching}
                onRetry={() => void senders.refetch()}
              />
            ) : senderRows.length === 0 ? (
              <EngagementEmpty
                title="No repeat senders in this window"
                description={`The request completed successfully for the last ${senderWindow.toLocaleString()} days.${mismatch ? ` This is a different period from the ${report?.window_days.toLocaleString()}-day classification summary above.` : ""}`}
              />
            ) : (
              <>
                {mismatch ? (
                  <p className="mb-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm leading-relaxed text-muted-foreground">
                    These senders cover {senderWindow.toLocaleString()} days;
                    classification covers {report?.window_days.toLocaleString()}
                    . This is a different period, so the counts are not directly
                    comparable.
                  </p>
                ) : null}
                <ol
                  className="divide-y rounded-lg border"
                  aria-label="Most frequent reply senders"
                >
                  {senderRows.map((sender, index) => (
                    <li
                      key={`${sender.recipient_email}:${index}`}
                      className="flex min-w-0 items-start justify-between gap-3 p-3"
                    >
                      <div className="min-w-0">
                        <p className="break-all text-sm font-medium">
                          {sender.recipient_email ||
                            `Unknown sender ${index + 1}`}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Last reply{" "}
                          {formatWireTimestamp(sender.last_at, "not recorded")}
                        </p>
                      </div>
                      <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                        {sender.replies.toLocaleString()} repl
                        {sender.replies === 1 ? "y" : "ies"}
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </EngagementSurface>

          <EngagementSurface
            id="rep-series"
            title="Daily reply volume"
            description="Every returned day remains visible, including recorded zeroes."
          >
            {series.isPending ? (
              <EngagementLoading label="Loading daily reply volume" rows={5} />
            ) : series.isError ? (
              <EngagementQueryError
                title="Daily reply volume could not be loaded"
                description="The missing series is not being reduced to zero daily replies."
                retrying={series.isFetching}
                onRetry={() => void series.refetch()}
              />
            ) : points.length === 0 ? (
              <EngagementEmpty
                title="No daily series returned"
                description="The request completed without any dated points; this is different from dated points whose count is zero."
              />
            ) : (
              <>
                <p className="mb-3 text-sm text-muted-foreground">
                  {totalInSeries.toLocaleString()} replies across{" "}
                  {points.length.toLocaleString()} returned days in a{" "}
                  {series.data?.window_days.toLocaleString()}-day window.
                </p>
                <div
                  role="region"
                  aria-label="Daily reply counts"
                  tabIndex={0}
                  className="max-h-80 overflow-y-auto rounded-md pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ol className="space-y-2">
                    {points.map((point, index) => (
                      <li
                        key={`${point.date}:${index}`}
                        className="grid grid-cols-[minmax(6rem,auto)_1fr_auto] items-center gap-3 text-xs"
                      >
                        <time
                          dateTime={point.date}
                          className="text-muted-foreground"
                        >
                          {formatWireTimestamp(
                            point.date,
                            "Date unavailable",
                            (date) =>
                              date.toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                              }),
                          )}
                        </time>
                        <span className="h-2 overflow-hidden rounded-full bg-muted">
                          <span
                            className="block h-full rounded-full bg-primary"
                            style={{
                              width: `${maxReplies > 0 ? Math.max(2, (point.replies / maxReplies) * 100) : 0}%`,
                            }}
                          />
                        </span>
                        <span className="w-8 text-right font-medium tabular-nums">
                          {point.replies.toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              </>
            )}
          </EngagementSurface>
        </div>
        {meQuery.data ? <ReplyMailboxManager identity={meQuery.data} /> : null}
      </EngagementIdentityGate>
    </PageShell>
  );
}
