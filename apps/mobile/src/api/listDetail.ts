/**
 * listDetail — the per-list endpoints behind the mobile list detail screen.
 *
 *   GET /api/v1/lists/{id}/subscribers?page=&per_page=&query=&status=
 *   GET /api/v1/lists/{id}/growth?window=30d
 *   GET /api/v1/lists/{id}/deliverability?window_days=30
 *
 * All three are mounted in Go (apps/api/internal/lists) and accept BOTH the
 * Listmonk bigint list id and the Moosewave UUID — `resolveListUUID` maps
 * the former through `list_id_map`.
 *
 * IMPORTANT: do NOT reach for the SDK's `list_id` param on
 * GET /api/v1/subscribers. It is declared in the TS SDK but the Go handler
 * never reads it, so a "members of list X" screen built on it would return
 * the ENTIRE tenant while looking correct.
 *
 * Parsers are pure and exported so the wire contract is unit-testable.
 */
import { getClient } from "@/api/sdkClient";

export interface ListMember {
  id: string;
  email: string;
  status: string;
  source?: string;
  added_at?: string;
}

export interface ListMembersPage {
  items: ListMember[];
  total: number;
  page: number;
  perPage: number;
}

export interface ListGrowthPoint {
  date: string;
  added: number;
  removed: number;
  net: number;
  total: number;
}

export interface ListGrowth {
  current: number | null;
  windowDays: number;
  points: ListGrowthPoint[];
}

const MEMBERS_PER_PAGE = 25;

export function listMembersPath(
  listId: string,
  page: number,
  query: string,
): string {
  const qs = new URLSearchParams();
  qs.set("page", String(Math.max(1, page)));
  qs.set("per_page", String(MEMBERS_PER_PAGE));
  const q = query.trim();
  if (q) qs.set("query", q);
  return `/api/v1/lists/${encodeURIComponent(listId)}/subscribers?${qs.toString()}`;
}

function int(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseMembersPage(res: unknown, page: number): ListMembersPage {
  const row = (res ?? {}) as Record<string, unknown>;
  const rawItems = Array.isArray(row.items) ? row.items : [];
  const items: ListMember[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    if (typeof m.email !== "string") continue;
    const source = typeof m.source === "string" ? m.source : undefined;
    const addedAt = typeof m.added_at === "string" ? m.added_at : undefined;
    items.push({
      id: m.id == null ? m.email : String(m.id),
      email: m.email,
      status: typeof m.status === "string" ? m.status : "",
      ...(source ? { source } : {}),
      ...(addedAt ? { added_at: addedAt } : {}),
    });
  }
  return {
    items,
    total: int(row.total, items.length),
    page: int(row.page, page),
    perPage: int(row.per_page, MEMBERS_PER_PAGE),
  };
}

export function parseGrowth(res: unknown): ListGrowth {
  const row = (res ?? {}) as Record<string, unknown>;
  const rawPoints = Array.isArray(row.points) ? row.points : [];
  const points: ListGrowthPoint[] = [];
  for (const raw of rawPoints) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.date !== "string") continue;
    points.push({
      date: p.date,
      added: int(p.added, 0),
      removed: int(p.removed, 0),
      net: int(p.net, 0),
      total: int(p.total, 0),
    });
  }
  return {
    current:
      typeof row.current === "number" && Number.isFinite(row.current)
        ? row.current
        : null,
    windowDays: int(row.window_days, 30),
    points,
  };
}

export async function fetchListMembers(
  listId: string,
  page: number,
  query: string,
): Promise<ListMembersPage> {
  const { client } = getClient();
  return parseMembersPage(
    await client.request<unknown>("GET", listMembersPath(listId, page, query)),
    page,
  );
}

export async function fetchListGrowth(
  listId: string,
  windowDays = 30,
): Promise<ListGrowth> {
  const { client } = getClient();
  return parseGrowth(
    await client.request<unknown>(
      "GET",
      `/api/v1/lists/${encodeURIComponent(listId)}/growth?window=${windowDays}d`,
    ),
  );
}

export async function fetchListDeliverability(
  listId: string,
  windowDays = 30,
): Promise<unknown> {
  const { client } = getClient();
  return client.request<unknown>(
    "GET",
    `/api/v1/lists/${encodeURIComponent(listId)}/deliverability?window_days=${windowDays}`,
  );
}

export { MEMBERS_PER_PAGE };
