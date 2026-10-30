/**
 * segments — the read surface behind the mobile Segments screens.
 *
 *   GET /api/v1/segments                     → Segment[]  (a BARE ARRAY)
 *   GET /api/v1/segments/{id}                → Segment
 *   GET /api/v1/segments/{id}/size-history   → { series, note? }
 *   POST /api/v1/segments/{id}/recompute     → 202 { scheduledAt, count }
 *
 * Deliberately NOT using `client.segments.list()` from the SDK: it declares
 * the response as `{ items, next_cursor }`, but the Go handler
 * (apps/api/internal/segments/handlers.go List) writes `Repo.List`'s slice
 * straight out — a bare array. Consuming the SDK type would give an
 * always-empty screen that looks like an empty workspace. The parsers below
 * accept both shapes so this keeps working if the envelope ever lands.
 *
 * The Go JSON is camelCase here (`queryAst`, `lastCount`, `createdAt`),
 * unlike most of the API — worth stating because it is easy to "fix" to
 * snake_case and silently blank every field.
 */
import { getClient } from "@/api/sdkClient";

export interface MobileSegment {
  id: string;
  name: string;
  description: string;
  /** Untrusted rule tree — render it through src/lib/segmentAst.ts. */
  queryAst: unknown;
  /** Last materialised size. Absent = never evaluated (NOT zero). */
  lastCount: number | null;
  lastEvaluatedAt: string | null;
  isTemplate: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SegmentSizePoint {
  at: string;
  count: number;
}

export interface SegmentSizeHistory {
  series: SegmentSizePoint[];
  windowDays: number;
  /**
   * The server's own honesty flag — e.g. "segment_size_history table not
   * yet provisioned; showing live point only". Render it verbatim rather
   * than drawing a one-point line and calling it a trend.
   */
  note: string | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function nullableNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseSegment(raw: unknown): MobileSegment | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = row.id == null ? "" : String(row.id);
  if (!id) return null;
  return {
    id,
    name: str(row.name) || `Segment ${id}`,
    description: str(row.description),
    queryAst: row.queryAst ?? row.query_ast ?? null,
    lastCount: nullableNum(row.lastCount ?? row.last_count),
    lastEvaluatedAt: nullableStr(row.lastEvaluatedAt ?? row.last_evaluated_at),
    isTemplate: row.isTemplate === true || row.is_template === true,
    createdAt: nullableStr(row.createdAt ?? row.created_at),
    updatedAt: nullableStr(row.updatedAt ?? row.updated_at),
  };
}

/** Accepts the bare array the handler returns AND an `{items}` envelope. */
export function parseSegmentList(res: unknown): MobileSegment[] {
  const rows = Array.isArray(res)
    ? res
    : Array.isArray((res as { items?: unknown[] } | undefined)?.items)
      ? (res as { items: unknown[] }).items
      : [];
  const out: MobileSegment[] = [];
  for (const raw of rows) {
    const parsed = parseSegment(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseSizeHistory(res: unknown): SegmentSizeHistory {
  const row = (res ?? {}) as Record<string, unknown>;
  const rawSeries = Array.isArray(row.series) ? row.series : [];
  const series: SegmentSizePoint[] = [];
  for (const raw of rawSeries) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const at = nullableStr(p.evaluated_at ?? p.at);
    const count = nullableNum(p.count);
    if (!at || count == null) continue;
    series.push({ at, count });
  }
  return {
    series,
    windowDays: nullableNum(row.window_days) ?? 90,
    note: nullableStr(row.note),
  };
}

export async function fetchSegments(): Promise<MobileSegment[]> {
  const { client } = getClient();
  return parseSegmentList(
    await client.request<unknown>("GET", "/api/v1/segments"),
  );
}

export async function fetchSegment(id: string): Promise<MobileSegment | null> {
  const { client } = getClient();
  return parseSegment(
    await client.request<unknown>(
      "GET",
      `/api/v1/segments/${encodeURIComponent(id)}`,
    ),
  );
}

export async function fetchSegmentSizeHistory(
  id: string,
  windowDays = 90,
): Promise<SegmentSizeHistory> {
  const { client } = getClient();
  return parseSizeHistory(
    await client.request<unknown>(
      "GET",
      `/api/v1/segments/${encodeURIComponent(id)}/size-history?window=${windowDays}d`,
    ),
  );
}

/**
 * The freshness fields every segment row already renders.
 *
 * `SegmentRow` shows `lastCount` and a relative time since `lastEvaluatedAt`,
 * and says "Size not evaluated yet" when the count is absent — so evaluation
 * state is a headline fact on the list. Until now nothing could act on it: an
 * operator read "evaluated 3 days ago" and had no way to make it say "just
 * now".
 */
export interface SegmentRecomputeResult {
  /** The refreshed member count, straight from the server's own recount. */
  count: number;
  scheduledAt: string;
}

/**
 * Recompute a segment's stored size. `write:subscribers` — editor and above.
 *
 * SYNCHRONOUS DESPITE THE 202. The handler runs the AST compiler in-process and
 * updates `last_count` + `last_evaluated_at` before responding
 * (`preview_count.go`), so the returned count is the new truth rather than an
 * acknowledgement of queued work. The status code says "accepted" but the work
 * is done — which is why the caller can seed the cache with `count` instead of
 * polling for it.
 */
export async function recomputeSegment(
  id: string,
): Promise<SegmentRecomputeResult> {
  const { client } = getClient();
  const raw = await client.request<unknown>(
    "POST",
    `/api/v1/segments/${encodeURIComponent(id)}/recompute`,
  );
  const r = (raw ?? {}) as Record<string, unknown>;
  // The Go field is `count`; tolerate the snake_case sibling in case the
  // envelope is ever normalised, and never surface NaN as a member count.
  const value = typeof r.count === "number" ? r.count : Number(r.count);
  return {
    count: Number.isFinite(value) ? value : 0,
    scheduledAt:
      typeof r.scheduledAt === "string"
        ? r.scheduledAt
        : typeof r.scheduled_at === "string"
          ? r.scheduled_at
          : "",
  };
}
