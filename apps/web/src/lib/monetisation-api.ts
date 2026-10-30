/**
 * lib/monetisation-api.ts — gifts, paywall tiers, commerce catalogues and
 * acquisition-source quality.
 *
 * Five paths were reached by desktop and by no web file.
 *
 * `growth-source/quality` IS THE ONE THAT MATTERS. It reports, per acquisition
 * source, not just how many subscribers arrived but how they BEHAVED —
 * engagement, bounce and complaint rates. A source that delivers volume and
 * complaints is worse than one that delivers nothing, and a growth screen
 * showing only counts cannot say so.
 *
 * With 12 subscribers and no sends, every rate is 0 — which here means
 * "nothing measured yet", not "perfect quality". The page distinguishes those,
 * because a 0% complaint rate on zero sends is not a compliment.
 *
 * COVERAGE: this module wires every gift and monetisation path the gateway
 * mounts for a dashboard read:
 *   /api/v1/commerce/catalogs
 *   /api/v1/gift-subscriptions            (commerce-33/34: list + query)
 *   /api/v1/gift-subscriptions/{id}       (commerce-35: one record)
 *   /api/v1/gift-subscriptions/stats
 *   /api/v1/growth-source/quality
 *   /api/v1/growth-source/timeseries
 *   /api/v1/paywall/tiers
 * Gift creation, cancellation, redemption, and export are absent because the
 * server does not mount them, not because the client skipped them.
 */
import { api } from "@/lib/api";
import { commerceApi } from "@/lib/commerce-api";
import {
  decodeGiftHistoryPage,
  decodeGiftHistoryRecord,
  GiftHistoryContractError,
  giftHistorySearchPrefix,
  MAX_GIFT_HISTORY_OFFSET,
  MAX_GIFT_HISTORY_PAGE_SIZE,
  type GiftHistoryPage,
  type GiftHistoryRecord,
} from "@/lib/gift-history";

export interface SourceQuality {
  consent_source: string;
  total_subscribers: number;
  engaged: number;
  bounced: number;
  complained: number;
  engagement_rate: number;
  bounce_rate: number;
  complaint_rate: number;
}

export interface GiftStats {
  total: number;
  pending: number;
  paid: number;
  granted: number;
  canceled: number;
  expired: number;
  refunded: number;
  conversionRate: number;
  generated_at?: string;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function num(v: unknown): number {
  return Number.isFinite(v) ? Number(v) : 0;
}

export async function getSourceQuality(): Promise<{
  sources: SourceQuality[];
  window_days: number;
}> {
  const res = await api.get<{ sources?: unknown; window_days?: unknown }>(
    "/api/v1/growth-source/quality",
  );
  return {
    sources: asArray<SourceQuality>(res?.sources).map((s) => ({
      consent_source: String(s?.consent_source ?? ""),
      total_subscribers: num(s?.total_subscribers),
      engaged: num(s?.engaged),
      bounced: num(s?.bounced),
      complained: num(s?.complained),
      engagement_rate: num(s?.engagement_rate),
      bounce_rate: num(s?.bounce_rate),
      complaint_rate: num(s?.complaint_rate),
    })),
    window_days: num(res?.window_days),
  };
}

export async function getGiftStats(): Promise<GiftStats> {
  const res = await api.get<GiftStats>("/api/v1/gift-subscriptions/stats");
  return {
    total: num(res?.total),
    pending: num(res?.pending),
    paid: num(res?.paid),
    granted: num(res?.granted),
    canceled: num(res?.canceled),
    expired: num(res?.expired),
    refunded: num(res?.refunded),
    conversionRate: num(res?.conversionRate),
    generated_at: res?.generated_at,
  };
}

export interface GiftHistoryListOptions {
  limit?: number;
  offset?: number;
  /** 8–32 hexadecimal characters of the opaque record id, or nothing. */
  q?: string;
  filter?:
    | "all"
    | "open"
    | "pending"
    | "redeemed"
    | "closed"
    | "cancelled"
    | "expired"
    | "refunded";
  sort?: "newest" | "oldest" | "duration" | "status";
}

/**
 * One page of the sanitized gift archive.
 *
 * Every parameter is clamped to the bounds the handler enforces
 * (gift_history.go:115-155) rather than passed through: an out-of-range limit
 * or offset is a 400 there, and a 400 on a paging control would read to the
 * operator as "the archive is broken" rather than "the previous page is the
 * last one".
 *
 * `q` is dropped unless it is a valid record prefix. That is deliberate and it
 * is the difference between a bounded reporting scope and an oracle: a typed
 * email address must produce no request, not a request that silently returns
 * the whole archive.
 */
export async function listGiftSubscriptions(
  opts: GiftHistoryListOptions = {},
): Promise<GiftHistoryPage> {
  const params = new URLSearchParams();
  if (typeof opts.limit === "number") {
    params.set(
      "limit",
      String(
        Math.min(
          MAX_GIFT_HISTORY_PAGE_SIZE,
          Math.max(1, Math.trunc(opts.limit)),
        ),
      ),
    );
  }
  if (typeof opts.offset === "number") {
    params.set(
      "offset",
      String(
        Math.min(MAX_GIFT_HISTORY_OFFSET, Math.max(0, Math.trunc(opts.offset))),
      ),
    );
  }
  if (opts.q) {
    const prefix = giftHistorySearchPrefix(opts.q);
    if (prefix) params.set("q", prefix);
  }
  if (opts.filter && opts.filter !== "all") params.set("filter", opts.filter);
  if (opts.sort && opts.sort !== "newest") params.set("sort", opts.sort);
  const qs = params.toString();
  const page = decodeGiftHistoryPage(
    await api.get<unknown>(
      `/api/v1/gift-subscriptions${qs ? `?${qs}` : ""}`,
    ),
  );
  if (!page.recognized) throw new GiftHistoryContractError("gift history");
  return page;
}

/**
 * One archive record, re-read from the server.
 *
 * The identity check is not ceremony. The list row and the detail read are two
 * separate responses, and rendering the second under the first one's heading
 * without checking would let a mismatched response be presented as evidence
 * about a record it does not describe.
 */
export async function getGiftSubscription(
  id: string,
): Promise<GiftHistoryRecord> {
  const res = await api.get<unknown>(
    `/api/v1/gift-subscriptions/${encodeURIComponent(id)}`,
  );
  if (res === null || typeof res !== "object" || Array.isArray(res)) {
    throw new GiftHistoryContractError("gift record");
  }
  const record = decodeGiftHistoryRecord(res as Record<string, unknown>, 0);
  if (record.sourceRecordID?.toLowerCase() !== id.toLowerCase()) {
    throw new GiftHistoryContractError("gift record");
  }
  return record;
}

export async function listPaywallTiers(): Promise<unknown[]> {
  const res = await api.get<{ tiers?: unknown }>("/api/v1/paywall/tiers");
  return asArray(res?.tiers);
}

/**
 * First page of commerce catalogs, for surfaces that only count them. The
 * transport lives in `commerceApi.listCatalogs` (the Commerce workspace pages
 * through it with a cursor); this stays a thin view over it so there is one
 * literal path.
 */
export async function listCommerceCatalogs(): Promise<unknown[]> {
  const res = await commerceApi.listCatalogs();
  return asArray(res?.items);
}

/** True when a source has subscribers but no measured outcomes yet. */
export function hasNoOutcomesYet(s: SourceQuality): boolean {
  return (
    s.total_subscribers > 0 &&
    s.engaged === 0 &&
    s.bounced === 0 &&
    s.complained === 0
  );
}

export interface GrowthSourcePoint {
  date: string;
  consent_source: string;
  count: number;
}

/**
 * Daily signups by consent source.
 *
 * AN EMPTY `consent_source` IS NOT A CATEGORY. 29 of this workspace's 30
 * points carry `""` with a count of zero — that is the shape the series uses
 * for "nothing happened that day", not an "unknown source" bucket. Grouping
 * by the raw field would invent a large unattributed segment out of quiet
 * days, and it would grow every day nobody signs up.
 */
export async function getGrowthSourceTimeseries(): Promise<{
  points: GrowthSourcePoint[];
  window_days: number;
}> {
  const r = await api.get<Record<string, unknown>>(
    "/api/v1/growth-source/timeseries",
  );
  const arr = Array.isArray(r?.points) ? r.points : [];
  return {
    points: arr.map((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      return {
        date: typeof o.date === "string" ? o.date : "",
        consent_source:
          typeof o.consent_source === "string" ? o.consent_source : "",
        count:
          typeof o.count === "number" && Number.isFinite(o.count) ? o.count : 0,
      };
    }),
    window_days:
      typeof r?.window_days === "number" && Number.isFinite(r.window_days)
        ? r.window_days
        : 0,
  };
}

/** Points that actually attribute a signup, excluding quiet-day placeholders. */
export function attributedPoints(
  points: GrowthSourcePoint[],
): GrowthSourcePoint[] {
  return points.filter((p) => p.count > 0 && p.consent_source !== "");
}
