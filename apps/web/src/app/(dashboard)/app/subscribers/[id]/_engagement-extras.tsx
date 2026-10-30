// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Engagement-tab sections desktop's slide-over renders and web did not
// (desktop parity rows audience-54/55/63/80):
//
//   * Contact performance — the 90-day send/open/click/reply counters and
//     attributed revenue, per currency (never a cross-currency sum, never an
//     assumed currency).
//   * Best send times — every channel's learned hour-of-week, falling back to
//     the channel-agnostic aggregate and saying so.
//   * RFM & predictive profile — recency/frequency, churn risk, predicted
//     orders and cadence; CLV and monetary scores are withheld because the
//     API attaches no currency to them.
//   * Event log — the raw subscriber_events feed with "Load older" + retry.
//
// All four are reads open to every role, exactly as the server mounts them
// (read-subscribers / read-reports scopes), so nothing here is role-gated.

import Link from "next/link";
import { useId, type ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiErrorMessage, isApiError } from "@/lib/api";
import { formatCents } from "@/lib/format-currency";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import { base } from "@/lib/query-keys";
import { absoluteTime, timeAgo } from "@/lib/relative-time";
import {
  SEND_TIME_CHANNELS,
  getSubscriberContactPerformance,
  getSubscriberPredictiveProfile,
  getSubscriberSendTimes,
  hourOfWeekLabel,
  listSubscriberActivity,
  predictiveProfileIsLowConfidence,
  type SubscriberActivityRow,
  type SubscriberContactPerformance,
  type SubscriberCurrencyRevenue,
  type SubscriberSendTimes,
} from "@/lib/subscriber-detail-extras-api";

function errorText(err: unknown, fallback: string): string {
  if (isApiError(err)) return apiErrorMessage(err, fallback);
  return err instanceof Error && err.message.trim() ? err.message : fallback;
}

interface SectionProps {
  id: string;
  tenantId: string;
  role: string | null;
}

function LoadError({
  message,
  retryLabel,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
      <span>{message}</span>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}

function Caveat({ title, children }: { title: string; children: string }) {
  return (
    <div className="flex gap-2 rounded-md border border-warning/40 bg-warning-subtle p-3 text-xs text-warning-emphasis">
      <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        <span className="font-medium">{title}.</span> {children}
      </p>
    </div>
  );
}

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={absoluteTime(iso)}>
      {timeAgo(iso)}
    </time>
  );
}

/* ========================== Contact performance ========================== */

function countLabel(value: number | null): string {
  return value === null ? "Unavailable" : value.toLocaleString();
}

function revenueLabel(item: SubscriberCurrencyRevenue): string {
  if (
    item.revenue_cents_saturated ||
    !Number.isSafeInteger(item.revenue_cents)
  ) {
    return "Exceeds display range";
  }
  try {
    return formatCents(item.revenue_cents, item.currency);
  } catch {
    return `${(item.revenue_cents / 100).toFixed(2)} ${item.currency}`;
  }
}

function Metric({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <dt className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {label}
        {children}
      </dt>
      <dd className="mt-1 text-base font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function PerformanceBody({
  performance,
}: {
  performance: SubscriberContactPerformance;
}) {
  const counts = performance.counts;
  const breakdown = Array.isArray(counts.revenue_by_currency)
    ? counts.revenue_by_currency
    : [];
  const primary = breakdown[0];
  const revenueValue = primary
    ? revenueLabel(primary)
    : counts.legacy_unlabelled_revenue
      ? "Currency unavailable"
      : "No attributed revenue";
  const saturated = breakdown.some(
    (item) =>
      item.revenue_cents_saturated || !Number.isSafeInteger(item.revenue_cents),
  );
  return (
    <div className="space-y-3">
      <dl
        data-testid="contact-performance-metrics"
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5"
      >
        <Metric label="Sends" value={countLabel(counts.sends)} />
        <Metric label="Opens" value={countLabel(counts.opens)} />
        <Metric label="Clicks" value={countLabel(counts.clicks)} />
        <Metric label="Replies" value={countLabel(counts.replies)} />
        <Metric
          label={counts.mixed_currency ? "Leading revenue" : "Revenue"}
          value={revenueValue}
        >
          {primary ? <Badge variant="outline">{primary.currency}</Badge> : null}
          {counts.mixed_currency ? (
            <Badge variant="warning">Mixed</Badge>
          ) : null}
        </Metric>
      </dl>

      {breakdown.length > 1 ? (
        <details className="rounded-md border bg-card p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            Revenue by currency · {breakdown.length.toLocaleString()} currencies
          </summary>
          <ul
            aria-label="Attributed revenue by currency"
            className="mt-2 divide-y"
          >
            {breakdown.map((item) => (
              <li
                key={item.currency}
                className="flex flex-wrap items-baseline justify-between gap-2 py-1.5"
              >
                <span>
                  <span className="font-medium">{item.currency}</span>{" "}
                  <span className="text-muted-foreground">
                    · {item.conversions.toLocaleString()} conversion
                    {item.conversions === 1 ? "" : "s"}
                  </span>
                </span>
                <span className="tabular-nums">{revenueLabel(item)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {counts.legacy_unlabelled_revenue ? (
        <Caveat title="Revenue currency unavailable">
          The server returned an amount without a currency. It is hidden rather
          than shown in an assumed currency.
        </Caveat>
      ) : null}
      {counts.unclassified_monetary_conversions > 0 ? (
        <Caveat title="Some conversions were excluded">
          {`${counts.unclassified_monetary_conversions.toLocaleString()} amount-bearing conversion${
            counts.unclassified_monetary_conversions === 1 ? " was" : "s were"
          } missing a recognised currency and ${
            counts.unclassified_monetary_conversions === 1 ? "is" : "are"
          } not included in the revenue totals.`}
        </Caveat>
      ) : null}
      {saturated ? (
        <Caveat title="A total exceeds the display range">
          The exact amount can&apos;t be represented safely here, so no rounded
          total is shown.
        </Caveat>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {performance.opens_30d !== null || performance.clicks_30d !== null ? (
          <>
            Last 30 days: {countLabel(performance.opens_30d ?? 0)} open
            {performance.opens_30d === 1 ? "" : "s"} ·{" "}
            {countLabel(performance.clicks_30d ?? 0)} click
            {performance.clicks_30d === 1 ? "" : "s"}.{" "}
          </>
        ) : null}
        Computed <When iso={performance.computed_at} />.
      </p>
    </div>
  );
}

export function ContactPerformanceSection({
  id,
  tenantId,
  role,
}: SectionProps) {
  const headingId = useId();
  const query = useQuery({
    queryKey: [...base("subscriber-contact-performance", tenantId, role), id],
    queryFn: ({ signal }) => getSubscriberContactPerformance(id, signal),
    staleTime: 60_000,
  });
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div>
        <h3 id={headingId} className="text-sm font-medium">
          Contact performance
          {query.data ? ` · ${query.data.window_days} days` : ""}
        </h3>
        <p className="text-xs text-muted-foreground">
          Successful sends, recipient engagement, and safely denominated
          attributed revenue over the trailing window.
        </p>
      </div>
      {query.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : query.isError ? (
        <LoadError
          message={errorText(query.error, "Couldn't load contact performance.")}
          retryLabel="Retry contact performance"
          onRetry={() => void query.refetch()}
        />
      ) : (
        <PerformanceBody performance={query.data} />
      )}
    </section>
  );
}

/* ============================ Best send times ============================ */

const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  sms: "SMS",
  push: "Push",
  whatsapp: "WhatsApp",
  rcs: "RCS",
};

const DAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"] as const;

function DayStrip({ hourOfWeek }: { hourOfWeek: number | null }) {
  const day = hourOfWeek === null ? null : Math.floor(hourOfWeek / 24);
  return (
    <span aria-hidden className="inline-flex gap-0.5">
      {DAY_INITIALS.map((initial, index) => (
        <span
          key={index}
          className={
            index === day
              ? "flex h-4 w-4 items-center justify-center rounded-sm bg-primary text-[9px] text-primary-foreground"
              : "flex h-4 w-4 items-center justify-center rounded-sm bg-muted text-[9px] text-muted-foreground"
          }
        >
          {initial}
        </span>
      ))}
    </span>
  );
}

function SendTimesTable({ data }: { data: SubscriberSendTimes }) {
  const byChannel = new Map(data.channels.map((row) => [row.channel, row]));
  const aggregate = data.aggregate_best_send_hour;
  return (
    <>
      <TableContainer aria-label="Best send time per channel">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Channel</TableHead>
              <TableHead>Best send time</TableHead>
              <TableHead>Day</TableHead>
              <TableHead className="text-right">Computed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SEND_TIME_CHANNELS.map((channel) => {
              const row = byChannel.get(channel);
              const own = row?.best_send_hour ?? null;
              const usingAggregate = own === null && aggregate !== null;
              const hour = own ?? aggregate;
              const computedAt = usingAggregate
                ? data.aggregate_best_send_hour_at
                : (row?.best_send_hour_at ?? null);
              return (
                <TableRow key={channel} data-channel={channel}>
                  <TableCell>{CHANNEL_LABEL[channel] ?? channel}</TableCell>
                  <TableCell>
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <span className="tabular-nums">
                        {hour === null
                          ? "Not learned yet"
                          : hourOfWeekLabel(hour)}
                      </span>
                      {usingAggregate ? (
                        <Badge
                          variant="outline"
                          title="No per-channel signal yet — this is the aggregate best hour across all channels."
                        >
                          aggregate
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell>
                    <DayStrip hourOfWeek={hour} />
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {computedAt ? <When iso={computedAt} /> : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <p className="text-xs text-muted-foreground">
        {aggregate !== null ? (
          <>
            Aggregate best hour:{" "}
            <span className="font-medium text-foreground">
              {hourOfWeekLabel(aggregate)}
            </span>{" "}
            (all channels). Channels marked &ldquo;aggregate&rdquo; have no
            per-channel signal yet.
          </>
        ) : (
          "No best hour learned yet — sends to this subscriber use the workspace default until enough engagement accrues."
        )}
      </p>
    </>
  );
}

export function SendTimesSection({ id, tenantId, role }: SectionProps) {
  const headingId = useId();
  const query = useQuery({
    queryKey: [...base("subscriber-send-times", tenantId, role), id],
    queryFn: ({ signal }) => getSubscriberSendTimes(id, signal),
    staleTime: 5 * 60_000,
  });
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div>
        <h3 id={headingId} className="text-sm font-medium">
          Best send times by channel
        </h3>
        <p className="text-xs text-muted-foreground">
          The hour of the week each channel reaches this person best, learned
          from their engagement history (UTC).
        </p>
      </div>
      {query.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : query.isError ? (
        <LoadError
          message={errorText(query.error, "Couldn't load send times.")}
          retryLabel="Retry send times"
          onRetry={() => void query.refetch()}
        />
      ) : (
        <SendTimesTable data={query.data} />
      )}
    </section>
  );
}

/* =========================== Predictive profile ========================== */

function fractionLabel(value: number | null): string {
  return value === null ? "Unavailable" : `${Math.round(value * 100)}%`;
}

function numberLabel(value: number | null, suffix = ""): string {
  return value === null
    ? "Unavailable"
    : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${suffix}`;
}

function dateLabel(value: string | null): string {
  return value === null ? "Unavailable" : absoluteTime(value);
}

function StatRow({
  label,
  value,
  sub,
  estimate,
}: {
  label: string;
  value: string;
  sub?: string;
  estimate?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-md bg-muted/50 px-3 py-1.5">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {label}
        {estimate ? <Badge variant="info">Estimate</Badge> : null}
      </dt>
      <dd className="text-right text-sm tabular-nums">
        {value}
        {sub ? (
          <span className="ml-1.5 text-xs text-muted-foreground">{sub}</span>
        ) : null}
      </dd>
    </div>
  );
}

export function PredictiveProfileSection({
  id,
  email,
  tenantId,
  role,
}: SectionProps & { email: string }) {
  const headingId = useId();
  const address = email.trim();
  const query = useQuery({
    queryKey: [
      ...base("subscriber-predictive-profile", tenantId, role),
      id,
      address.toLowerCase(),
    ],
    queryFn: ({ signal }) =>
      getSubscriberPredictiveProfile(address, id, signal),
    enabled: address !== "",
    staleTime: 5 * 60_000,
  });
  const profile = query.data ?? null;
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="text-sm font-medium">
        RFM &amp; predictive profile
      </h3>
      {address === "" ? (
        <p className="text-sm text-muted-foreground">
          This subscriber has no email address, so no predictive profile can be
          looked up.
        </p>
      ) : query.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : query.isError ? (
        <LoadError
          message={errorText(
            query.error,
            "Couldn't load the predictive profile.",
          )}
          retryLabel="Retry predictive profile"
          onRetry={() => void query.refetch()}
        />
      ) : profile === null ? (
        <p className="text-sm text-muted-foreground">
          No predictive profile for this subscriber yet — RFM and prediction
          scores exist only after a recompute has run over subscribers with
          order history.
        </p>
      ) : (
        <div className="space-y-3" data-testid="predictive-profile">
          <p className="text-xs text-muted-foreground">
            Lifetime value and monetary scores are not shown: the predictive
            service attaches no currency to them, so they are withheld rather
            than shown in an assumed currency.
          </p>
          <div className="space-y-1.5">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Observed purchase signals
            </h4>
            <dl className="space-y-1">
              <StatRow
                label="Recency"
                value={
                  profile.rfm.recency_score === null
                    ? "Unavailable"
                    : `R${profile.rfm.recency_score}`
                }
                sub={
                  profile.rfm.recency_days === null
                    ? "recency unavailable"
                    : `${profile.rfm.recency_days.toLocaleString()} days since last order`
                }
              />
              <StatRow
                label="Frequency"
                value={
                  profile.rfm.frequency_score === null
                    ? "Unavailable"
                    : `F${profile.rfm.frequency_score}`
                }
                sub={
                  profile.rfm.frequency === null
                    ? "count unavailable"
                    : `${profile.rfm.frequency.toLocaleString()} order${profile.rfm.frequency === 1 ? "" : "s"}`
                }
              />
            </dl>
            {profile.rfm.calculated_at ? (
              <p className="text-xs text-muted-foreground">
                RFM computed <When iso={profile.rfm.calculated_at} />.
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Cadence &amp; churn projections
            </h4>
            <dl className="space-y-1">
              <StatRow
                label="Churn risk"
                value={fractionLabel(profile.prediction.churn_risk)}
                estimate
              />
              <StatRow
                label="Predicted orders / yr"
                value={numberLabel(profile.prediction.predicted_order_count)}
                estimate
              />
              <StatRow
                label="Average order cadence"
                value={numberLabel(
                  profile.prediction.average_days_between_orders,
                  " days",
                )}
                estimate
              />
              <StatRow
                label="Expected next order"
                value={dateLabel(profile.prediction.expected_next_order_at)}
                estimate
              />
              <StatRow
                label="Confidence"
                value={fractionLabel(profile.prediction.confidence)}
                sub={profile.prediction.data_sufficiency || undefined}
              />
            </dl>
            {predictiveProfileIsLowConfidence(profile) ? (
              <Caveat title="Low confidence">
                There is too little order history behind these projections to
                act on them; treat every figure above as a placeholder.
              </Caveat>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

/* ================================ Event log =============================== */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function eventLabel(type: string): string {
  const text = type.replaceAll("_", " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Event";
}

function ActivityItem({ row }: { row: SubscriberActivityRow }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 p-3">
      <span className="min-w-0">
        <span className="font-medium">{eventLabel(row.event_type)}</span>
        {row.campaign_id ? (
          <span className="text-muted-foreground">
            {" "}
            ·{" "}
            {UUID_RE.test(row.campaign_id) ? (
              <Link
                href={`/app/campaigns/${encodeURIComponent(row.campaign_id)}`}
                className="underline underline-offset-2 hover:text-foreground"
              >
                Campaign
              </Link>
            ) : (
              "Campaign"
            )}
          </span>
        ) : null}
        {row.link_url ? (
          <span className="block break-all text-xs text-muted-foreground">
            {row.link_url.length > 200
              ? `${row.link_url.slice(0, 200)}…`
              : row.link_url}
          </span>
        ) : null}
      </span>
      <span className="text-xs text-muted-foreground">
        <When iso={row.at} />
      </span>
    </li>
  );
}

export function ActivityLogSection({ id, tenantId, role }: SectionProps) {
  const headingId = useId();
  const query = useInfiniteQuery({
    queryKey: [...base("subscriber-activity", tenantId, role), id],
    queryFn: ({ pageParam, signal }) =>
      listSubscriberActivity(id, {
        before: pageParam ?? undefined,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_before,
    staleTime: 30_000,
  });
  const pages = Array.isArray(query.data?.pages) ? query.data.pages : [];
  const seen = new Set<number>();
  const rows = pages
    .flatMap((page) => page.items)
    .filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div>
        <h3 id={headingId} className="text-sm font-medium">
          Event log
        </h3>
        <p className="text-xs text-muted-foreground">
          Every recorded engagement event for this subscriber, newest first —
          the raw feed behind the timeline.
        </p>
      </div>
      {query.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : query.isError && rows.length === 0 ? (
        <LoadError
          message={errorText(query.error, "Couldn't load the event log.")}
          retryLabel="Retry event log"
          onRetry={() => void query.refetch()}
        />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity recorded.</p>
      ) : (
        <>
          <ol
            aria-label="Subscriber event log"
            className="divide-y rounded-md border bg-card text-sm"
          >
            {rows.map((row) => (
              <ActivityItem key={row.id} row={row} />
            ))}
          </ol>
          {query.isFetchNextPageError ? (
            <p role="alert" className="text-sm text-destructive-emphasis">
              {errorText(query.error, "Older events couldn't be loaded.")} The
              events above are still current.
            </p>
          ) : null}
          {query.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={query.isFetchingNextPage}
              aria-busy={query.isFetchingNextPage}
              onClick={() => void loadNextQueryPage(query, query.isEnabled)}
            >
              {query.isFetchingNextPage
                ? "Loading older events…"
                : query.isFetchNextPageError
                  ? "Retry loading older events"
                  : "Load older events"}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
