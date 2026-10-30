/**
 * hooks/useDashboard.ts — typed dashboard-stats query with polling.
 *
 * The Moosewave gateway exposes GET /api/v1/dashboard/stats, which the desktop
 * also consumes. The Go API returns the flat-fields shape (see
 * apps/api/internal/analytics/analytics.go::DashboardStats); older deployments
 * returned a nested shape (subscribers.total, open_rate.rate, …). Both are
 * tolerated via `DashboardStats` and the `pick*` helpers below — the same
 * fallback logic the desktop uses, hoisted into one place so the screen stays
 * declarative.
 *
 * Three properties this hook is responsible for:
 *
 *  - THE REQUEST IS BUILT, NOT FROZEN. `dashboardStatsPath` composes the
 *    server's real query contract (`range` ∈ 7d|30d|90d, `compare`,
 *    `sparklines`), so the screen can offer a reporting window instead of being
 *    permanently pinned to a trailing 30 days. `range` is part of the query key
 *    so two windows never collide in cache.
 *  - AN UNREADABLE RESPONSE IS A FAILURE. The queryFn validates through
 *    lib/dashboardStatsSchema and THROWS rather than substituting `{}`. A
 *    thrown failure routes into the screen's error/retry path; a substituted
 *    empty object silently paints "0 subscribers" beside a green Live badge.
 *  - ABSENCE IS NOT ZERO. Every picker returns `number | null`. Only the screen
 *    decides what an absent measurement looks like (an em-dash), and it can
 *    only do that if the hook stops inventing zeros.
 *
 * Polling: 30s, and only while the screen is focused. Expo Router keeps visited
 * tabs mounted, so an unconditional interval kept hitting the API every 30s
 * while the user browsed Subscribers — 120 needless requests an hour, on
 * cellular, for a screen nobody was looking at.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import {
  dashboardSnapshotSlot,
  dashboardVaultScope,
  readDashboardSnapshot,
  writeDashboardSnapshot,
} from "@/hooks/dashboardSnapshotStore";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { auditActionLabel } from "@/lib/auditActionLabel";
import { isProbablyOnline } from "@/lib/connectivity";
import {
  parseDashboardStats,
  type DashboardAuditEvent,
  type DashboardStats,
} from "@/lib/dashboardStatsSchema";
import { rateFromCounts, rateFromUniqueRecipients } from "@/lib/dashboardMetrics";
import { loadOfflineCapableSnapshot } from "@/lib/offlineSnapshots";

export {
  DashboardPayloadError,
  type DashboardAuditEvent,
  type DashboardPreviousWindow,
  type DashboardStats,
} from "@/lib/dashboardStatsSchema";

export interface AuditLogDashboardSource {
  id?: number | string;
  action?: string;
  actorLabel?: string | null;
  actorType?: string | null;
  at?: string;
}

/** The reporting windows the server accepts (openapi enum, default 30d). */
export const DASHBOARD_RANGES = ["7d", "30d", "90d"] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];
export const DEFAULT_DASHBOARD_RANGE: DashboardRange = "30d";

export function isDashboardRange(value: unknown): value is DashboardRange {
  return (
    typeof value === "string" &&
    (DASHBOARD_RANGES as readonly string[]).includes(value)
  );
}

export interface DashboardStatsPathOptions {
  range?: DashboardRange;
  /** Populate the `previous` window so tiles can show a period-over-period delta. */
  compare?: boolean;
  /**
   * Populate `sparklines` + `anomalies` — ONE server flag, two facts, so this
   * is what makes both the subscribers trend line and the bounce-spike badge
   * possible. It was off, which is why neither existed on the phone.
   *
   * The cost objection was real but is answered upstream: the handler defaults
   * this to true (`q.Get("sparklines") != "false"`, analytics.go), the desktop
   * has always used that default, and the repo serves the buckets from a
   * per-(tenant, window) cache behind a singleflight, so a phone polling every
   * 30s adds no scan the desktop's 2s live stream was not already paying for.
   */
  sparklines?: boolean;
}

export function dashboardStatsPath({
  range = DEFAULT_DASHBOARD_RANGE,
  compare = true,
  sparklines = true,
}: DashboardStatsPathOptions = {}): string {
  const qs = new URLSearchParams({
    range,
    compare: String(compare),
    sparklines: String(sparklines),
  });
  return `/api/v1/dashboard/stats?${qs.toString()}`;
}

export interface DashboardStatsQueryOptions {
  range?: DashboardRange;
  /**
   * Whether the dashboard screen is on-screen. Polling is suspended for an
   * unfocused tab; the query still refetches once on regaining focus through
   * TanStack's normal staleness rules.
   */
  focused?: boolean;
}

const POLL_INTERVAL_MS = 30_000;

/**
 * Single live source of truth for the dashboard.
 *
 * OFFLINE: the query is enabled whenever an identity scope exists, not only
 * when the network is usable, and the queryFn routes through
 * `loadOfflineCapableSnapshot`. A cold launch in airplane mode therefore
 * paints the last counts this device saw instead of six em-dashes — behind
 * the screen's existing "cached" notice, which is what keeps it honest.
 *
 * Only a MINIMISED projection reaches the disk (see
 * lib/dashboardOfflineProjection.ts): counts and the previous window, never
 * `recent_audit`, which carries teammate identities the dashboard already
 * refuses to fetch for exactly this reason.
 */
export function useDashboardStatsQuery({
  range = DEFAULT_DASHBOARD_RANGE,
  focused = true,
}: DashboardStatsQueryOptions = {}) {
  const gate = useOnlineQueryGate();
  const vaultScope = dashboardVaultScope(gate);
  const slot = dashboardSnapshotSlot(range);

  return useQuery({
    queryKey: [
      "dashboard-stats",
      gate.tenantId,
      range,
      // The cached answer and the live one are different facts; sharing a key
      // would let a snapshot read satisfy a later online mount's staleness.
      gate.enabled ? "network" : "snapshot",
    ],
    // Either half is sufficient. Requiring the SNAPSHOT identity alone would
    // have switched the home screen off entirely in API-key mode, which has
    // no human user or role and therefore no vault scope — a session that can
    // read the API perfectly well and simply has nothing to cache.
    enabled:
      (gate.enabled && Boolean(gate.tenantId)) ||
      (gate.canReadOfflineSnapshots && Boolean(vaultScope)),
    // Without this TanStack pauses the query while the device is offline and
    // the snapshot path never runs — the exact case it exists for.
    networkMode: "always",
    queryFn: async (): Promise<DashboardStats> => {
      const fetchStats = async (): Promise<DashboardStats> => {
        const { client } = getClient();
        const res = await client.request<unknown>(
          "GET",
          dashboardStatsPath({ range }),
        );
        return parseDashboardStats(res);
      };
      return loadOfflineCapableSnapshot<DashboardStats>({
        canUseNetwork: gate.enabled && Boolean(gate.tenantId),
        loadNetwork: fetchStats,
        readSnapshot: () => readDashboardSnapshot(slot, vaultScope),
        writeSnapshot: (stats) =>
          writeDashboardSnapshot(slot, vaultScope, stats),
        networkAvailable: isProbablyOnline,
        unavailableMessage: "No saved dashboard snapshot is available offline.",
      });
    },
    refetchInterval: focused && gate.enabled ? POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });
}

/* --------- derivation helpers (mirror desktop's deriveStats) -------- */

function firstCount(...candidates: unknown[]): number | null {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function pickSubscribersTotal(
  d: DashboardStats | undefined,
): number | null {
  if (!d) return null;
  return firstCount(d.subscribers_total, d.subscribers?.total);
}

export function pickSubscribersDelta30d(
  d: DashboardStats | undefined,
): number | null {
  if (!d) return null;
  if (
    typeof d.subscribers_added_30d === "number" &&
    typeof d.subscribers_unsubbed_30d === "number"
  ) {
    return d.subscribers_added_30d - d.subscribers_unsubbed_30d;
  }
  if (typeof d.subscribers?.delta_30d === "number") {
    return d.subscribers.delta_30d;
  }
  // Older flat deployments did not return unsubscribes; retain their gross
  // value only as a backwards-compatible last resort.
  if (typeof d.subscribers_added_30d === "number") {
    return d.subscribers_added_30d;
  }
  return null;
}

export function pickOpenRate(d: DashboardStats | undefined): number | null {
  if (!d) return null;
  // The flat contract is authoritative: unique opens over unique delivered
  // recipients, falling back to unique sent. Gross open-event counts include
  // repeat opens and privacy-proxy activity, so they must never be a numerator.
  const fromCounts = rateFromUniqueRecipients(
    d.unique_opens_30d,
    d.unique_delivered_30d,
    d.unique_sent_30d,
  );
  if (fromCounts !== null) return fromCounts;
  // Legacy deployments may return a precomputed fractional rate. Clamp it to
  // the valid domain; values above 1 are not whole percentages.
  const legacy = d.open_rate?.rate;
  if (typeof legacy === "number" && Number.isFinite(legacy)) {
    return Math.min(1, Math.max(0, legacy));
  }
  return null;
}

/** Unique clicks over unique delivered recipients (sent as fallback). */
export function pickClickRate(d: DashboardStats | undefined): number | null {
  if (!d) return null;
  return rateFromUniqueRecipients(
    d.unique_clicks_30d,
    d.unique_delivered_30d,
    d.unique_sent_30d,
  );
}

/**
 * Unique bounces over unique SENT. Delivered is never the denominator here: a
 * bounce is by definition a message that was not delivered, so dividing by
 * delivered would inflate the rate.
 */
export function pickBounceRate(d: DashboardStats | undefined): number | null {
  if (!d) return null;
  return rateFromCounts(d.unique_bounces_30d, d.unique_sent_30d);
}

export function pickCampaignsSent30d(
  d: DashboardStats | undefined,
): number | null {
  if (!d) return null;
  return firstCount(d.campaigns_sent_30d, d.campaigns_sent?.this_month);
}

export function pickActiveSequences(
  d: DashboardStats | undefined,
): number | null {
  if (!d) return null;
  return firstCount(d.active_sequences_count, d.active_sequences?.count);
}

/* ---------------- previous-window (compare=true) helpers ---------------- */

export function pickPreviousSubscribersDelta(
  d: DashboardStats | undefined,
): number | null {
  const previous = d?.previous;
  if (!previous) return null;
  if (
    typeof previous.subscribers_added === "number" &&
    typeof previous.subscribers_unsubbed === "number"
  ) {
    return previous.subscribers_added - previous.subscribers_unsubbed;
  }
  return firstCount(previous.subscribers_added);
}

export function pickPreviousOpenRate(
  d: DashboardStats | undefined,
): number | null {
  const previous = d?.previous;
  if (!previous) return null;
  return rateFromUniqueRecipients(
    previous.unique_opens,
    previous.unique_delivered,
    previous.unique_sent,
  );
}

export function pickPreviousClickRate(
  d: DashboardStats | undefined,
): number | null {
  const previous = d?.previous;
  if (!previous) return null;
  return rateFromUniqueRecipients(
    previous.unique_clicks,
    previous.unique_delivered,
    previous.unique_sent,
  );
}

export function pickPreviousBounceRate(
  d: DashboardStats | undefined,
): number | null {
  const previous = d?.previous;
  if (!previous) return null;
  return rateFromCounts(previous.unique_bounces, previous.unique_sent);
}

export function pickPreviousCampaignsSent(
  d: DashboardStats | undefined,
): number | null {
  const previous = d?.previous;
  if (!previous) return null;
  return firstCount(previous.campaigns_sent);
}

/* ------------- sparklines + anomalies (?sparklines=true) ------------- */

/**
 * Fewer than two points is a dot, not a trend, and `sparklinePoints` centres a
 * constant series — so a one-day-old workspace would draw a confident flat line
 * across the tile. Below the floor the caller renders no chart at all.
 */
export const MIN_SPARKLINE_POINTS = 3;

/**
 * The daily series the server buckets, keyed exactly as
 * `dashboardSparklinesTx` emits them (analytics.go).
 *
 * `subscribers` is the only one currently charted, and deliberately: opens,
 * clicks and bounces are GROSS EVENT COUNTS, while the tiles beside them show
 * unique-recipient RATES. Drawing a gross-count trend under a rate is the
 * mismatch the desktop's own grid refuses to make.
 */
export type DashboardSparklineMetric =
  | "subscribers"
  | "opens"
  | "clicks"
  | "bounces";

export function pickSparkline(
  d: DashboardStats | undefined,
  metric: DashboardSparklineMetric,
): number[] | null {
  const series = d?.sparklines?.[metric];
  if (!Array.isArray(series) || series.length < MIN_SPARKLINE_POINTS) {
    return null;
  }
  return series;
}

/**
 * True only for an explicit `true`. The server populates this map ONLY with
 * `sparklines=true`, so an absent flag means "not evaluated", which must read
 * as "no spike detected" and never as a spike.
 */
export function pickAnomaly(
  d: DashboardStats | undefined,
  metric: DashboardSparklineMetric,
): boolean {
  return d?.anomalies?.[metric] === true;
}

export function mapAuditRowToDashboardEvent(
  row: AuditLogDashboardSource,
): DashboardAuditEvent {
  const actor =
    typeof row.actorLabel === "string" && row.actorLabel.trim()
      ? row.actorLabel.trim()
      : typeof row.actorType === "string" && row.actorType.trim()
        ? row.actorType.trim()
        : "system";
  const action =
    typeof row.action === "string" && row.action.trim()
      ? row.action.trim()
      : "activity";
  const event: DashboardAuditEvent = {
    action,
    actor,
    description: auditActionLabel(row.action),
  };
  if (row.id != null) event.id = String(row.id);
  if (row.at != null) event.at = row.at;
  return event;
}
