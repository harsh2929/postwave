/** Read-only transport for the privacy-minimized Gift history archive. */
import {
  isGiftHistoryID,
  giftHistoryQueryPrefix,
  nextGiftHistoryOffset,
  normalizeGiftHistoryPage,
  normalizeGiftHistoryRecord,
  normalizeGiftHistoryStats,
  sanitizeGiftHistoryQuery,
  type GiftHistoryFilter,
  type GiftHistoryPage,
  type GiftHistoryRecord,
  type GiftHistorySort,
  type GiftHistoryStats,
} from "@/lib/giftSubscriptions";

import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

export const GIFT_HISTORY_PAGE_SIZE = 24;

export class GiftRequestError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "GiftRequestError";
  }
}

export class GiftContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GiftContractError";
  }
}

async function giftRequest<T>(path: string, label: string): Promise<T | null> {
  const response = await rawRequest<T>("GET", path, undefined);
  if (response.error) throw new GiftRequestError(response.error, label);
  return response.data;
}

export function isGiftAccessDenied(error: unknown): boolean {
  return error instanceof GiftRequestError
    ? error.status === 403
    : typeof error === "object" &&
        error !== null &&
        (error as { status?: unknown }).status === 403;
}

export interface GiftHistoryListOptions {
  offset?: number;
  limit?: number;
  query?: string;
  filter?: GiftHistoryFilter;
  sort?: GiftHistorySort;
}

export async function listGiftSubscriptions(
  options: GiftHistoryListOptions = {},
): Promise<GiftHistoryPage> {
  const params = new URLSearchParams();
  params.set(
    "limit",
    String(
      Math.min(
        100,
        Math.max(1, Math.trunc(options.limit ?? GIFT_HISTORY_PAGE_SIZE)),
      ),
    ),
  );
  params.set(
    "offset",
    String(Math.min(10_000, Math.max(0, Math.trunc(options.offset ?? 0)))),
  );
  const query = giftHistoryQueryPrefix(
    sanitizeGiftHistoryQuery(options.query ?? ""),
  );
  if (query) params.set("q", query);
  if (options.filter && options.filter !== "all") {
    params.set("filter", options.filter);
  }
  if (options.sort && options.sort !== "newest") {
    params.set("sort", options.sort);
  }
  const raw = await giftRequest<unknown>(
    `/api/v1/gift-subscriptions?${params.toString()}`,
    "Loading gift history",
  );
  const page = normalizeGiftHistoryPage(raw);
  if (!page.recognized) {
    throw new GiftContractError(
      "Gift history returned an unsupported response.",
    );
  }
  return page;
}

export async function fetchGiftStats(): Promise<GiftHistoryStats> {
  const raw = await giftRequest<unknown>(
    "/api/v1/gift-subscriptions/stats",
    "Loading gift statistics",
  );
  const stats = normalizeGiftHistoryStats(raw);
  if (!stats || stats.issues.length > 0) {
    throw new GiftContractError("Gift statistics failed integrity checks.");
  }
  return stats;
}

export async function fetchGiftSubscription(
  id: string,
): Promise<GiftHistoryRecord | null> {
  const trimmed = id.trim();
  if (!isGiftHistoryID(trimmed)) {
    throw new Error("A valid gift record id is required.");
  }
  try {
    const raw = await giftRequest<unknown>(
      `/api/v1/gift-subscriptions/${encodeURIComponent(trimmed)}`,
      "Loading the gift record",
    );
    const record = normalizeGiftHistoryRecord(raw);
    if (!record) {
      throw new GiftContractError(
        "Gift detail returned an unsupported response.",
      );
    }
    if (record.id.toLocaleLowerCase() !== trimmed.toLocaleLowerCase()) {
      throw new GiftContractError(
        "Gift detail did not match the requested record.",
      );
    }
    return record;
  } catch (error) {
    if (error instanceof GiftRequestError && error.status === 404) return null;
    throw error;
  }
}

export { nextGiftHistoryOffset };
