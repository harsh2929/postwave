import type { ApiResult } from "./result";

interface FeedSourcesRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

/** Transport boundary injected by the api-client facade. */
export type FeedSourcesRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: FeedSourcesRequestOptions,
) => Promise<ApiResult<T>>;

/** Mirrors feed_ingest.FeedSource. */
export interface FeedSource {
  id: string;
  name: string;
  url: string;
  /** "manual" | "daily" | "weekly" */
  schedule: "manual" | "daily" | "weekly";
  template_id?: string | null;
  list_id?: string | null;
  segment_id?: string | null;
  subject_template: string;
  enabled: boolean;
  last_polled_at?: string | null;
  last_item_guid?: string;
  created_at: string;
  updated_at: string;
}

export interface FeedSourceCreateInput {
  name: string;
  url: string;
  schedule: "manual" | "daily" | "weekly";
  template_id?: string | null;
  list_id?: string | null;
  segment_id?: string | null;
  subject_template: string;
  enabled?: boolean;
}

export interface FeedSourceUpdateInput {
  name?: string;
  url?: string;
  schedule?: "manual" | "daily" | "weekly";
  template_id?: string | null;
  list_id?: string | null;
  segment_id?: string | null;
  subject_template?: string;
  enabled?: boolean;
}

/**
 * Synchronous-bounded manual poll outcome (feed_ingest.Poller).
 * A failed poll is still HTTP 200 with status:"failed" + `error` text.
 */
export interface FeedPollResult {
  run_id: string;
  /** "ok" | "no_new_items" | "failed" (render, don't switch exhaustively). */
  status: string;
  items_seen: number;
  new_items: number;
  campaign_id?: string;
  error?: string;
}

/** One historical poll run (feed_ingest.Run). */
export interface FeedIngestRun {
  id: string;
  feed_source_id: string;
  status: string;
  items_seen: number;
  new_items: number;
  campaign_id?: string;
  error?: string;
  started_at: string;
  finished_at?: string | null;
}

export interface FeedSourcesApi {
  list(): Promise<ApiResult<{ items: FeedSource[] }>>;
  create(input: FeedSourceCreateInput): Promise<ApiResult<FeedSource>>;
  get(id: string): Promise<ApiResult<FeedSource>>;
  update(
    id: string,
    patch: FeedSourceUpdateInput,
  ): Promise<ApiResult<FeedSource>>;
  remove(id: string): Promise<ApiResult<void>>;
  poll(id: string): Promise<ApiResult<FeedPollResult>>;
  listRuns(id: string): Promise<ApiResult<{ items: FeedIngestRun[] }>>;
}

/** Build the feed-ingestion method bag against the facade's shared transport. */
export function createFeedSourcesApi(
  request: FeedSourcesRequester,
): FeedSourcesApi {
  return {
    list() {
      return request<{ items: FeedSource[] }>("/api/v1/feed-sources");
    },
    create(input) {
      return request<FeedSource>("/api/v1/feed-sources", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    get(id) {
      return request<FeedSource>(
        `/api/v1/feed-sources/${encodeURIComponent(id)}`,
      );
    },
    update(id, patch) {
      return request<FeedSource>(
        `/api/v1/feed-sources/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      );
    },
    remove(id) {
      return request<void>(`/api/v1/feed-sources/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    },
    poll(id) {
      return request<FeedPollResult>(
        `/api/v1/feed-sources/${encodeURIComponent(id)}/poll`,
        { method: "POST", body: "{}" },
        { timeoutMs: 30_000, maxAttempts: 1, requireOnline: true },
      );
    },
    listRuns(id) {
      return request<{ items: FeedIngestRun[] }>(
        `/api/v1/feed-sources/${encodeURIComponent(id)}/runs`,
      );
    },
  };
}
