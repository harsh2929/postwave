// SPDX-License-Identifier: AGPL-3.0-only
/**
 * List detail workspace transport (/app/lists/[id]).
 *
 * Every route below is mounted in apps/api/internal/lists/lists.go. There is
 * NO `GET /api/v1/lists/{id}` on the gateway, so the detail record is derived
 * from the catalogue read (`GET /api/v1/lists`) exactly the way the lists
 * index already re-reads a record before writing.
 *
 *   PATCH  /api/v1/lists/{id}                       whitelisted body, idempotent group
 *   GET    /api/v1/lists/{id}/subscribers           ?query&status&page&per_page
 *   POST   /api/v1/lists/{id}/subscribers           {subscriber_ids} → {added, skipped}
 *   DELETE /api/v1/lists/{id}/subscribers/{sub_id}  204
 *   GET    /api/v1/subscribers                      picker browse
 *   GET    /api/v1/subscribers/search               picker search (?q)
 *
 * Detail-tab extras (analytics.go, webhooks.go, merge_fields.go,
 * member_suppressions.go, search/handlers.go, list_health.go). Every `{id}`
 * goes through `resolveListUUID`, which accepts the engine bigint, so the
 * route param is the same engine id the workspace already carries. Shapes are
 * the Go handlers' — NOT the desktop api-client's, which drifted (it expects
 * `points[].subscribed`, `slices`, `buckets`, `{items,total}` and so renders
 * every analytics card empty):
 *
 *   GET    /api/v1/lists/{id}/growth?window=30            {window_days, current, points[{date,added,removed,net,total}]}
 *   GET    /api/v1/lists/{id}/source-mix                  {sources: {form,api,csv,…}}
 *   GET    /api/v1/lists/{id}/engagement-breakdown?window {opens,clicks,unsubs,complaints,bounces}
 *   GET    /api/v1/lists/{id}/per-row-engagement?subscriber_ids=a,b  {rows[{id,email,opens,clicks,last_engaged_at?}]}
 *   GET    /api/v1/lists/{id}/health-history?window_days=90         {history[{sampled_at,score,grade,…rates}]}
 *   GET    /api/v1/lists/{id}/activity?limit=             {events[{at,kind,email?,detail?}]} — no page/per_page on the server
 *   GET    /api/v1/lists/{id}/forms                       {forms[…], nextCursor?}
 *   GET    /api/v1/lists/{id}/automations                 {automations[…], nextCursor?}
 *   GET    /api/v1/lists/{id}/suppressions?page&per_page  {items,total,page,per_page}
 *   GET    /api/v1/lists/{id}/inbox-reality?limit=        {items[…]} — server ignores the list id today (tenant-wide)
 *   GET    /api/v1/lists/{id}/merge-fields                {merge_fields[…]}   POST / PATCH {tag} / DELETE {tag}
 *   GET    /api/v1/lists/{id}/webhooks?limit&cursor       {webhooks[…], next_cursor}   (admin scope, every route)
 *   POST   /api/v1/lists/{id}/webhooks                    201 + signing_secret, Idempotency-Key REQUIRED
 *   PATCH  /api/v1/lists/{id}/webhooks/{wid}              partial {url?,description?,events?,active?}
 *   DELETE /api/v1/lists/{id}/webhooks/{wid}              204
 *   POST   /api/v1/lists/{id}/webhooks/{wid}/rotate-secret 200 + signing_secret, Idempotency-Key REQUIRED
 *   POST   /api/v1/lists/{id}/webhooks/{wid}/test         {status_code, signed, filtered, …}
 *   GET    /api/v1/lists/{id}/webhooks/{wid}/deliveries   {deliveries[…], next_cursor}
 *   GET    /api/v1/list-health?tag=&window_days=          Score — keyed by subscriber TAG (tag-as-list), not list id
 */

import { api } from "@/lib/api";
import { listAudienceLists, type AudienceList } from "@/lib/audience-admin-api";

export type { AudienceList } from "@/lib/audience-admin-api";

export const MEMBERS_PAGE_SIZE = 25;
/** Mirrors `maxMembershipBatch` in membership_write.go. */
export const MAX_ADD_MEMBERS = 1000;

export const MEMBER_STATUSES = [
  "enabled",
  "disabled",
  "blocklisted",
  "unconfirmed",
] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/** Mirrors `lists.MemberSubscriber`. */
export interface ListMember {
  id: string;
  email: string;
  status: string;
  source?: string;
  added_at: string;
}

/**
 * How a membership came about, for a person reading the Members tab.
 *
 * The wire values are the `list_subscribers.source` enum (migration 0249), and
 * the column used to print them raw: an operator who had just pressed Add saw
 * "api", which reads as "an integration did this". Each label says who or what
 * added the contact; the hint spells it out for the ones a label cannot.
 *
 * An unrecognised value is humanised rather than hidden — a source the server
 * grows before this table knows about it is still information.
 */
const MEMBER_SOURCE_LABELS: Record<string, { label: string; hint: string }> = {
  admin: { label: "Operator", hint: "Added by someone working in this workspace" },
  api: { label: "API", hint: "Added by a program using an API key" },
  csv: { label: "CSV import", hint: "Added by a CSV import that targeted this list" },
  form: { label: "Signup form", hint: "Joined through a signup form" },
  integration: { label: "Integration", hint: "Added by a connected app or CRM sync" },
  migration: { label: "Migration", hint: "Brought in when this workspace was migrated" },
  listmonk_event: { label: "Sync", hint: "Mirrored from a sending-engine event" },
};

export function listMemberSourceLabel(
  source: string | undefined,
): { label: string; hint: string } | null {
  const key = (source ?? "").trim().toLowerCase();
  if (!key) return null;
  return (
    MEMBER_SOURCE_LABELS[key] ?? {
      label: key.replace(/_/gu, " ").replace(/^./u, (c) => c.toUpperCase()),
      hint: "Recorded by the list membership ledger",
    }
  );
}

/** Mirrors `lists.MembersPage`. */
export interface ListMembersPage {
  list_id: string;
  items: ListMember[];
  total: number;
  page: number;
  per_page: number;
}

export interface ListMembersQuery {
  query?: string;
  status?: MemberStatus;
  page?: number;
  perPage?: number;
}

/** PATCH whitelist — mirrors `updateAllowedFields` in lists.go. */
export interface ListUpdateInput {
  name: string;
  type: AudienceList["type"];
  optin: AudienceList["optin"];
  description: string;
  tags: string[];
}

/** Server receipt for POST /api/v1/lists/{id}/subscribers. */
export interface AddMembersResult {
  added: number;
  skipped: number;
}

export interface SubscriberCandidate {
  id: string;
  email: string;
  status: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} returned an invalid response.`);
  return value as Record<string, unknown>;
}
function text(v: unknown, field: string, allowEmpty = false): string {
  if (typeof v !== "string" || (!allowEmpty && !v.trim()))
    throw new Error(`The service returned an invalid ${field}.`);
  return v;
}
function count(v: unknown, field: string): number {
  if (!Number.isSafeInteger(v) || Number(v) < 0)
    throw new Error(`The service returned an invalid ${field}.`);
  return Number(v);
}

/** Route-param → engine id. Only a positive base-10 integer is a list id. */
export { parseListId } from "./list-id";

function engineId(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1)
    throw new Error("The list id is invalid.");
  return encodeURIComponent(String(id));
}

export async function getAudienceList(
  id: number,
  signal?: AbortSignal,
): Promise<AudienceList | null> {
  const rows = await listAudienceLists("", signal);
  return rows.find((x) => x.id === id) ?? null;
}

export async function updateList(
  id: number,
  input: ListUpdateInput,
  key: string,
): Promise<void> {
  await api.patch(`/api/v1/lists/${engineId(id)}`, input, {
    requireOnline: true,
    idempotencyKey: key,
  });
}

function decodeMember(raw: unknown): ListMember {
  const r = record(raw, "List members service");
  return {
    id: text(r.id, "member id"),
    email: text(r.email, "member email"),
    status: text(r.status ?? "", "member status", true),
    ...(typeof r.source === "string" && r.source ? { source: r.source } : {}),
    added_at: text(r.added_at, "member added time"),
  };
}

export async function listMembers(
  id: number,
  q: ListMembersQuery = {},
  signal?: AbortSignal,
): Promise<ListMembersPage> {
  const page = q.page ?? 1;
  const perPage = q.perPage ?? MEMBERS_PAGE_SIZE;
  const raw = record(
    await api.get<unknown>(`/api/v1/lists/${engineId(id)}/subscribers`, {
      query: {
        query: q.query?.trim() || undefined,
        status: q.status,
        page,
        per_page: perPage,
      },
      signal,
    }),
    "List members service",
  );
  if (!Array.isArray(raw.items))
    throw new Error("The list members service returned an invalid page.");
  return {
    list_id: text(raw.list_id ?? "", "list identity", true),
    items: raw.items.map(decodeMember),
    total: count(raw.total, "member total"),
    page: count(raw.page ?? page, "page"),
    per_page: count(raw.per_page ?? perPage, "page size"),
  };
}

export async function removeMember(
  listId: number,
  subscriberId: string,
  key: string,
): Promise<void> {
  const sub = subscriberId.trim();
  if (!sub) throw new Error("The subscriber id is invalid.");
  await api.delete(
    `/api/v1/lists/${engineId(listId)}/subscribers/${encodeURIComponent(sub)}`,
    { requireOnline: true, idempotencyKey: key },
  );
}

export async function addMembers(
  listId: number,
  subscriberIds: string[],
  key: string,
): Promise<AddMembersResult> {
  if (subscriberIds.length === 0)
    throw new Error("Pick at least one subscriber to add.");
  if (subscriberIds.length > MAX_ADD_MEMBERS)
    throw new Error(
      `At most ${MAX_ADD_MEMBERS} subscribers can be added per request.`,
    );
  const r = record(
    await api.post<unknown>(
      `/api/v1/lists/${engineId(listId)}/subscribers`,
      { subscriber_ids: subscriberIds },
      { requireOnline: true, idempotencyKey: key },
    ),
    "List membership service",
  );
  return {
    added: count(r.added, "added count"),
    skipped: count(r.skipped, "skipped count"),
  };
}

function decodeCandidates(raw: unknown): SubscriberCandidate[] {
  const r = record(raw, "Subscribers service");
  const rows = Array.isArray(r.items) ? r.items : r.results;
  if (!Array.isArray(rows))
    throw new Error("The subscribers service returned an invalid page.");
  return rows.flatMap((row) => {
    const s = record(row, "Subscribers service");
    if (typeof s.id !== "string" || !s.id || typeof s.email !== "string")
      return [];
    return [
      {
        id: s.id,
        email: s.email,
        status: typeof s.status === "string" ? s.status : "",
      },
    ];
  });
}

/**
 * Subscriber picker feed. A typed term goes to the search route; an empty
 * term browses the first page so the picker is never blank.
 */
export async function findSubscriberCandidates(
  term: string,
  signal?: AbortSignal,
): Promise<SubscriberCandidate[]> {
  const q = term.trim();
  const raw = q
    ? await api.get<unknown>("/api/v1/subscribers/search", {
        query: { q, page: 1, per_page: 20 },
        signal,
      })
    : await api.get<unknown>("/api/v1/subscribers", {
        query: { page: 1, per_page: 20 },
        signal,
      });
  return decodeCandidates(raw);
}

/* ---------- shared decode helpers for the detail-tab extras -------------- */

function num(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new Error(`The service returned an invalid ${field}.`);
  return v;
}
function optText(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
function arrayOf(v: unknown, label: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${label} returned an invalid page.`);
  return v;
}
function cursor(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/* ---------- catalogue rows with the denormalised subscriber count -------- */

/**
 * The catalogue proxy forwards Listmonk's rows verbatim, which carry
 * `subscriber_count`. `AudienceList` (audience-admin-api) drops it, so the
 * index's stat strip and per-row counts decode the same envelope here with
 * the count kept. Validation mirrors `decodeList` there field for field.
 */
export interface AudienceListRow extends AudienceList {
  subscriber_count?: number;
}

function decodeCatalogueRow(raw: unknown): AudienceListRow {
  const r = record(raw, "Lists service");
  const type = text(r.type ?? "private", "list type");
  const optin = text(r.optin ?? "single", "list opt-in");
  if (
    !["private", "public", "temporary"].includes(type) ||
    !["single", "double"].includes(optin)
  )
    throw new Error("The lists service returned an unsupported list policy.");
  const tags = r.tags === undefined ? [] : r.tags;
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string"))
    throw new Error("The service returned invalid list tags.");
  const id = count(r.id, "list id");
  if (id < 1) throw new Error("The service returned an invalid list id.");
  const uuid = r.postwave_uuid;
  return {
    id,
    ...(typeof uuid === "string" && uuid
      ? { postwave_uuid: uuid.toLowerCase() }
      : {}),
    name: text(r.name, "list name"),
    type: type as AudienceList["type"],
    optin: optin as AudienceList["optin"],
    tags: tags as string[],
    description: text(r.description ?? "", "list description", true),
    ...(Number.isSafeInteger(r.subscriber_count)
      ? { subscriber_count: Number(r.subscriber_count) }
      : {}),
  };
}

export async function listAudienceCatalogue(
  q = "",
  signal?: AbortSignal,
): Promise<AudienceListRow[]> {
  const root = record(
    await api.get<unknown>("/api/v1/lists", {
      query: q ? { query: q } : undefined,
      signal,
    }),
    "Lists service",
  );
  const data = root.data;
  let items: unknown;
  if (Array.isArray(data)) items = data;
  else if (data && typeof data === "object")
    items = (data as Record<string, unknown>).results;
  else items = root.items ?? root.results;
  const out = arrayOf(items, "The lists service").map(decodeCatalogueRow);
  if (new Set(out.map((x) => x.id)).size !== out.length)
    throw new Error("The lists service returned duplicate identities.");
  return out;
}

/* ---------- analytics (audience-92) ------------------------------------- */

export const GROWTH_WINDOW_DAYS = 30;
export const ENGAGEMENT_WINDOW_DAYS = 30;
export const HEALTH_HISTORY_WINDOW_DAYS = 90;

/** Mirrors `lists.GrowthPoint`. */
export interface ListGrowthPoint {
  date: string;
  added: number;
  removed: number;
  net: number;
  total: number;
}
export interface ListGrowth {
  list_id: string;
  window_days: number;
  current: number;
  points: ListGrowthPoint[];
}
export interface ListSourceMix {
  list_id: string;
  /** Always carries the seven known buckets, zero-filled by the server. */
  sources: Record<string, number>;
}
export interface ListEngagementBreakdown {
  list_id: string;
  window_days: number;
  opens: number;
  clicks: number;
  unsubs: number;
  complaints: number;
  bounces: number;
}
export interface ListMemberEngagement {
  id: string;
  email: string;
  opens: number;
  clicks: number;
  last_engaged_at?: string;
}
/** Mirrors `lists.HealthHistoryPoint`. */
export interface ListHealthSample {
  sampled_at: string;
  score: number;
  grade: string;
  bounce_rate: number;
  complaint_rate: number;
  unsubscribe_rate: number;
  engagement_rate: number;
}
export interface ListHealthHistory {
  list_id: string;
  window_days: number;
  history: ListHealthSample[];
}

export async function getListGrowth(
  id: number,
  windowDays = GROWTH_WINDOW_DAYS,
  signal?: AbortSignal,
): Promise<ListGrowth> {
  const r = record(
    await api.get<unknown>(`/api/v1/lists/${engineId(id)}/growth`, {
      query: { window: windowDays },
      signal,
    }),
    "List growth service",
  );
  return {
    list_id: text(r.list_id ?? "", "list identity", true),
    window_days: count(r.window_days ?? windowDays, "window"),
    current: count(r.current ?? 0, "current total"),
    points: arrayOf(r.points ?? [], "The list growth service").map((p) => {
      const g = record(p, "List growth service");
      return {
        date: text(g.date, "growth date"),
        added: num(g.added, "added count"),
        removed: num(g.removed, "removed count"),
        net: num(g.net, "net change"),
        total: num(g.total, "running total"),
      };
    }),
  };
}

export async function getListSourceMix(
  id: number,
  signal?: AbortSignal,
): Promise<ListSourceMix> {
  const r = record(
    await api.get<unknown>(`/api/v1/lists/${engineId(id)}/source-mix`, {
      signal,
    }),
    "List source-mix service",
  );
  const src = record(r.sources ?? {}, "List source-mix service");
  const sources: Record<string, number> = {};
  for (const [k, v] of Object.entries(src)) sources[k] = num(v, `${k} count`);
  return { list_id: text(r.list_id ?? "", "list identity", true), sources };
}

export async function getListEngagementBreakdown(
  id: number,
  windowDays = ENGAGEMENT_WINDOW_DAYS,
  signal?: AbortSignal,
): Promise<ListEngagementBreakdown> {
  const r = record(
    await api.get<unknown>(
      `/api/v1/lists/${engineId(id)}/engagement-breakdown`,
      { query: { window: windowDays }, signal },
    ),
    "List engagement service",
  );
  return {
    list_id: text(r.list_id ?? "", "list identity", true),
    window_days: count(r.window_days ?? windowDays, "window"),
    opens: num(r.opens, "opens"),
    clicks: num(r.clicks, "clicks"),
    unsubs: num(r.unsubs, "unsubscribes"),
    complaints: num(r.complaints, "complaints"),
    bounces: num(r.bounces, "bounces"),
  };
}

/** The server needs explicit ids (≤500); an empty set is answered locally. */
export async function getListPerRowEngagement(
  id: number,
  subscriberIds: string[],
  signal?: AbortSignal,
): Promise<ListMemberEngagement[]> {
  const ids = subscriberIds.map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return [];
  if (ids.length > 500)
    throw new Error("At most 500 subscribers can be scored per request.");
  const r = record(
    await api.get<unknown>(`/api/v1/lists/${engineId(id)}/per-row-engagement`, {
      query: { subscriber_ids: ids.join(",") },
      signal,
    }),
    "List engagement service",
  );
  return arrayOf(r.rows ?? [], "The list engagement service").map((row) => {
    const e = record(row, "List engagement service");
    return {
      id: text(e.id, "subscriber id"),
      email: text(e.email ?? "", "subscriber email", true),
      opens: num(e.opens, "opens"),
      clicks: num(e.clicks, "clicks"),
      ...(optText(e.last_engaged_at)
        ? { last_engaged_at: optText(e.last_engaged_at) }
        : {}),
    };
  });
}

export async function getListHealthHistory(
  id: number,
  windowDays = HEALTH_HISTORY_WINDOW_DAYS,
  signal?: AbortSignal,
): Promise<ListHealthHistory> {
  const r = record(
    await api.get<unknown>(`/api/v1/lists/${engineId(id)}/health-history`, {
      query: { window_days: windowDays },
      signal,
    }),
    "List health-history service",
  );
  return {
    list_id: text(r.list_id ?? "", "list identity", true),
    window_days: count(r.window_days ?? windowDays, "window"),
    history: arrayOf(r.history ?? [], "The list health-history service").map(
      (p) => {
        const h = record(p, "List health-history service");
        return {
          sampled_at: text(h.sampled_at, "sample time"),
          score: num(h.score, "score"),
          grade: text(h.grade ?? "", "grade", true),
          bounce_rate: num(h.bounce_rate ?? 0, "bounce rate"),
          complaint_rate: num(h.complaint_rate ?? 0, "complaint rate"),
          unsubscribe_rate: num(h.unsubscribe_rate ?? 0, "unsubscribe rate"),
          engagement_rate: num(h.engagement_rate ?? 0, "engagement rate"),
        };
      },
    ),
  };
}

/* ---------- activity (audience-93) -------------------------------------- */

/** Server default; the route caps at 500 and has no page/per_page. */
export const ACTIVITY_FETCH_LIMIT = 100;
export const ACTIVITY_PAGE_SIZE = 25;

/** Mirrors `lists.ActivityEvent`. */
export interface ListActivityEvent {
  at: string;
  kind: string;
  email?: string;
  detail?: Record<string, unknown>;
}

export async function getListActivity(
  id: number,
  limit = ACTIVITY_FETCH_LIMIT,
  signal?: AbortSignal,
): Promise<ListActivityEvent[]> {
  const r = record(
    await api.get<unknown>(`/api/v1/lists/${engineId(id)}/activity`, {
      query: { limit },
      signal,
    }),
    "List activity service",
  );
  return arrayOf(r.events ?? [], "The list activity service").map((row) => {
    const e = record(row, "List activity service");
    const detail =
      e.detail && typeof e.detail === "object" && !Array.isArray(e.detail)
        ? (e.detail as Record<string, unknown>)
        : undefined;
    return {
      at: text(e.at, "event time"),
      kind: text(e.kind, "event kind"),
      ...(optText(e.email) ? { email: optText(e.email) } : {}),
      ...(detail ? { detail } : {}),
    };
  });
}

/* ---------- forms & automations (audience-94) --------------------------- */

/** Mirrors `lists.FormSummary`. */
export interface ListFormSummary {
  id: string;
  slug: string;
  name: string;
  status: string;
  opt_in_mode: string;
  updated_at: string;
}
/** Mirrors `lists.AutomationSummary`. */
export interface ListAutomationSummary {
  id: string;
  name: string;
  status: string;
  updated_at: string;
}

export async function listListForms(
  id: number,
  signal?: AbortSignal,
): Promise<ListFormSummary[]> {
  const r = record(
    await api.get<unknown>(`/api/v1/lists/${engineId(id)}/forms`, { signal }),
    "List forms service",
  );
  return arrayOf(r.forms ?? [], "The list forms service").map((row) => {
    const f = record(row, "List forms service");
    return {
      id: text(f.id, "form id"),
      slug: text(f.slug ?? "", "form slug", true),
      name: text(f.name ?? "", "form name", true),
      status: text(f.status ?? "", "form status", true),
      opt_in_mode: text(f.opt_in_mode ?? "", "form opt-in mode", true),
      updated_at: text(f.updated_at ?? "", "form updated time", true),
    };
  });
}

export async function listListAutomations(
  id: number,
  signal?: AbortSignal,
): Promise<ListAutomationSummary[]> {
  const r = record(
    await api.get<unknown>(`/api/v1/lists/${engineId(id)}/automations`, {
      signal,
    }),
    "List automations service",
  );
  return arrayOf(r.automations ?? [], "The list automations service").map(
    (row) => {
      const a = record(row, "List automations service");
      return {
        id: text(a.id, "automation id"),
        name: text(a.name ?? "", "automation name", true),
        status: text(a.status ?? "", "automation status", true),
        updated_at: text(a.updated_at ?? "", "automation updated time", true),
      };
    },
  );
}

/* ---------- suppressions (audience-96) ---------------------------------- */

export const SUPPRESSIONS_PAGE_SIZE = 25;

/** Mirrors `lists.MemberSuppression` (metadata omitted — not rendered). */
export interface ListSuppression {
  email: string;
  reason: string;
  source: string;
  provider_event_id?: string;
  suppressed_at: string;
  expires_at?: string;
  created_at: string;
  source_table?: string;
}
export interface ListSuppressionsPage {
  items: ListSuppression[];
  total: number;
  page: number;
  per_page: number;
}

export async function listListSuppressions(
  id: number,
  q: { page?: number; perPage?: number } = {},
  signal?: AbortSignal,
): Promise<ListSuppressionsPage> {
  const page = q.page ?? 1;
  const perPage = q.perPage ?? SUPPRESSIONS_PAGE_SIZE;
  const r = record(
    await api.get<unknown>(`/api/v1/lists/${engineId(id)}/suppressions`, {
      query: { page, per_page: perPage },
      signal,
    }),
    "List suppressions service",
  );
  return {
    items: arrayOf(r.items ?? [], "The list suppressions service").map(
      (row) => {
        const s = record(row, "List suppressions service");
        return {
          email: text(s.email, "suppressed email"),
          reason: text(s.reason ?? "", "suppression reason", true),
          source: text(s.source ?? "", "suppression source", true),
          ...(optText(s.provider_event_id)
            ? { provider_event_id: optText(s.provider_event_id) }
            : {}),
          suppressed_at: text(s.suppressed_at ?? "", "suppression time", true),
          ...(optText(s.expires_at)
            ? { expires_at: optText(s.expires_at) }
            : {}),
          created_at: text(
            s.created_at ?? "",
            "suppression created time",
            true,
          ),
          ...(optText(s.source_table)
            ? { source_table: optText(s.source_table) }
            : {}),
        };
      },
    ),
    total: count(r.total ?? 0, "suppression total"),
    page: count(r.page ?? page, "page"),
    per_page: count(r.per_page ?? perPage, "page size"),
  };
}

/* ---------- inbox reality (audience-97) --------------------------------- */

/** Server cap (search/handlers.go clamps 1..25, default 10). */
export const INBOX_REALITY_LIMIT = 25;

/** Mirrors `search.InboxRealityRow`. */
export interface ListInboxRealityRow {
  test_id: string;
  subject?: string;
  created_at: string;
  status: string;
  total_seeds: number;
  inbox: number;
  spam: number;
  missing: number;
  inbox_pct: number;
}

export async function listListInboxReality(
  id: number,
  limit = INBOX_REALITY_LIMIT,
  signal?: AbortSignal,
): Promise<ListInboxRealityRow[]> {
  const r = record(
    await api.get<unknown>(`/api/v1/lists/${engineId(id)}/inbox-reality`, {
      query: { limit },
      signal,
    }),
    "Inbox reality service",
  );
  return arrayOf(r.items ?? [], "The inbox reality service").map((row) => {
    const t = record(row, "Inbox reality service");
    return {
      test_id: text(t.test_id, "test id"),
      ...(optText(t.subject) ? { subject: optText(t.subject) } : {}),
      created_at: text(t.created_at ?? "", "test created time", true),
      status: text(t.status ?? "", "test status", true),
      total_seeds: num(t.total_seeds ?? 0, "seed total"),
      inbox: num(t.inbox ?? 0, "inbox count"),
      spam: num(t.spam ?? 0, "spam count"),
      missing: num(t.missing ?? 0, "missing count"),
      inbox_pct: num(t.inbox_pct ?? 0, "inbox percentage"),
    };
  });
}

/* ---------- merge fields (audience-98) ---------------------------------- */

export const MERGE_FIELD_TYPES = [
  "text",
  "number",
  "date",
  "email",
  "phone",
  "address",
] as const;
export type MergeFieldType = (typeof MERGE_FIELD_TYPES)[number];
/** Server limits from merge_fields.go. */
export const MERGE_FIELD_TAG_MAX = 10;
export const MERGE_FIELD_NAME_MAX = 80;
export const MERGE_FIELD_TAG_RE = /^[A-Z][A-Z0-9_]*$/u;

/** Mirrors `lists.MergeField`; keyed by `tag`, there is no id on the wire. */
export interface ListMergeField {
  tag: string;
  type: MergeFieldType;
  name: string;
  required: boolean;
  default?: string;
  help_text?: string;
  created_at?: string;
}
/** POST/PATCH body — the server ignores `tag` in a PATCH body (URL wins). */
export interface MergeFieldInput {
  tag: string;
  type: MergeFieldType;
  name: string;
  required: boolean;
  default?: string;
  help_text?: string;
}

function decodeMergeField(raw: unknown): ListMergeField {
  const f = record(raw, "Merge fields service");
  const type = text(f.type, "merge-field type");
  if (!(MERGE_FIELD_TYPES as readonly string[]).includes(type))
    throw new Error("The merge fields service returned an unknown field type.");
  return {
    tag: text(f.tag, "merge-field tag"),
    type: type as MergeFieldType,
    name: text(f.name ?? "", "merge-field name", true),
    required: f.required === true,
    ...(optText(f.default) ? { default: optText(f.default) } : {}),
    ...(optText(f.help_text) ? { help_text: optText(f.help_text) } : {}),
    ...(optText(f.created_at) ? { created_at: optText(f.created_at) } : {}),
  };
}

function mergeFieldTag(tag: string): string {
  const t = tag.trim().toUpperCase();
  if (!t || t.length > MERGE_FIELD_TAG_MAX || !MERGE_FIELD_TAG_RE.test(t))
    throw new Error(
      `Tag must be 1–${MERGE_FIELD_TAG_MAX} uppercase letters, digits or underscores, starting with a letter.`,
    );
  return t;
}

function mergeFieldBody(input: MergeFieldInput): Record<string, unknown> {
  const name = input.name.trim();
  if (!name || name.length > MERGE_FIELD_NAME_MAX)
    throw new Error(`Name must be 1–${MERGE_FIELD_NAME_MAX} characters.`);
  if (!(MERGE_FIELD_TYPES as readonly string[]).includes(input.type))
    throw new Error("Pick a field type.");
  const body: Record<string, unknown> = {
    tag: mergeFieldTag(input.tag),
    type: input.type,
    name,
    required: input.required === true,
  };
  if (input.default?.trim()) body.default = input.default.trim();
  if (input.help_text?.trim()) body.help_text = input.help_text.trim();
  return body;
}

export async function listMergeFields(
  id: number,
  signal?: AbortSignal,
): Promise<ListMergeField[]> {
  const r = record(
    await api.get<unknown>(`/api/v1/lists/${engineId(id)}/merge-fields`, {
      signal,
    }),
    "Merge fields service",
  );
  return arrayOf(r.merge_fields ?? [], "The merge fields service").map(
    decodeMergeField,
  );
}

export async function createMergeField(
  listId: number,
  input: MergeFieldInput,
  key: string,
): Promise<ListMergeField> {
  return decodeMergeField(
    await api.post<unknown>(
      `/api/v1/lists/${engineId(listId)}/merge-fields`,
      mergeFieldBody(input),
      { requireOnline: true, idempotencyKey: key },
    ),
  );
}

export async function updateMergeField(
  listId: number,
  tag: string,
  input: MergeFieldInput,
  key: string,
): Promise<ListMergeField> {
  const t = mergeFieldTag(tag);
  return decodeMergeField(
    await api.patch<unknown>(
      `/api/v1/lists/${engineId(listId)}/merge-fields/${encodeURIComponent(t)}`,
      mergeFieldBody({ ...input, tag: t }),
      { requireOnline: true, idempotencyKey: key },
    ),
  );
}

export async function deleteMergeField(
  listId: number,
  tag: string,
  key: string,
): Promise<void> {
  const t = mergeFieldTag(tag);
  await api.delete(
    `/api/v1/lists/${engineId(listId)}/merge-fields/${encodeURIComponent(t)}`,
    { requireOnline: true, idempotencyKey: key },
  );
}

/* ---------- list-scoped webhooks (audience-95, admin-only) -------------- */

/** Only the events the list fanout actually emits (webhookEventCatalog). */
export const LIST_WEBHOOK_EVENTS = ["list.subscriber.added"] as const;
export type ListWebhookEvent = (typeof LIST_WEBHOOK_EVENTS)[number];
export const WEBHOOKS_PAGE_LIMIT = 50;
export const DELIVERIES_PAGE_LIMIT = 50;
/** Default rotation grace (webhooks.go: 24h, dual-signed). */
export const WEBHOOK_ROTATION_GRACE_HOURS = 24;

/** Mirrors `lists.ListWebhook` without the shown-once secret. */
export interface ListWebhook {
  id: string;
  url: string;
  description?: string;
  events: string[];
  active: boolean;
  url_status: string;
  auth_config_status: string;
  delivery_policy_status: string;
  created_at: string;
  updated_at: string;
  last_succeeded_at?: string;
  last_failed_at?: string;
}
/** Create and rotate answer with the secret exactly once. */
export interface ListWebhookWithSecret extends ListWebhook {
  signing_secret: string;
}
export interface ListWebhookPage {
  list_id: string;
  webhooks: ListWebhook[];
  next_cursor: string;
}
export interface ListWebhookCreateInput {
  url: string;
  description?: string;
  events: ListWebhookEvent[];
}
export interface ListWebhookUpdateInput {
  url?: string;
  description?: string;
  events?: ListWebhookEvent[];
  active?: boolean;
}
/** Mirrors `outbound_webhooks.Delivery`. */
export interface ListWebhookDelivery {
  id: string;
  webhook_id: string;
  event_type: string;
  attempt_count: number;
  next_attempt_at?: string;
  status: string;
  last_status_code?: number;
  last_response_body_truncated?: string;
  last_error?: string;
  created_at: string;
  delivered_at?: string;
}
export interface ListWebhookDeliveriesPage {
  deliveries: ListWebhookDelivery[];
  next_cursor: string;
}
/** The canonical test-probe receipt (outbound_webhooks Test). */
export interface ListWebhookTestResult {
  webhook_id: string;
  status_code: number;
  signed: boolean;
  signature: string;
  response: string;
  filtered: boolean;
}

function decodeWebhook(raw: unknown): ListWebhook {
  const w = record(raw, "List webhooks service");
  const events = arrayOf(w.events ?? [], "The list webhooks service").map((e) =>
    text(e, "webhook event"),
  );
  return {
    id: text(w.id, "webhook id"),
    url: text(w.url, "webhook url"),
    ...(optText(w.description) ? { description: optText(w.description) } : {}),
    events,
    active: w.active === true,
    url_status: text(w.url_status ?? "", "destination status", true),
    auth_config_status: text(w.auth_config_status ?? "", "auth status", true),
    delivery_policy_status: text(
      w.delivery_policy_status ?? "",
      "policy status",
      true,
    ),
    created_at: text(w.created_at ?? "", "created time", true),
    updated_at: text(w.updated_at ?? "", "updated time", true),
    ...(optText(w.last_succeeded_at)
      ? { last_succeeded_at: optText(w.last_succeeded_at) }
      : {}),
    ...(optText(w.last_failed_at)
      ? { last_failed_at: optText(w.last_failed_at) }
      : {}),
  };
}

function decodeWebhookWithSecret(raw: unknown): ListWebhookWithSecret {
  const w = record(raw, "List webhooks service");
  const secret = w.signing_secret;
  if (typeof secret !== "string" || !secret.trim())
    throw new Error(
      "The service did not return a signing secret. Nothing to store; rotate the secret before relying on receiver verification.",
    );
  return { ...decodeWebhook(raw), signing_secret: secret };
}

/** Route-param guard for `{wid}`; every call site writes its own literal path. */
function webhookId(wid: string): string {
  const w = wid.trim();
  if (!w) throw new Error("The webhook id is invalid.");
  return encodeURIComponent(w);
}

function validateWebhookInput(
  input: ListWebhookCreateInput,
): Record<string, unknown> {
  const url = input.url.trim();
  if (!/^https?:\/\/\S+$/iu.test(url))
    throw new Error("Enter an http(s) URL for the receiver.");
  if (input.events.length === 0) throw new Error("Pick at least one event.");
  for (const e of input.events)
    if (!(LIST_WEBHOOK_EVENTS as readonly string[]).includes(e))
      throw new Error(`Unknown event "${e}".`);
  const body: Record<string, unknown> = {
    url,
    events: [...new Set(input.events)],
  };
  if (input.description?.trim()) body.description = input.description.trim();
  return body;
}

export async function listListWebhooks(
  listId: number,
  q: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal,
): Promise<ListWebhookPage> {
  const r = record(
    await api.get<unknown>(`/api/v1/lists/${engineId(listId)}/webhooks`, {
      query: {
        limit: q.limit ?? WEBHOOKS_PAGE_LIMIT,
        cursor: q.cursor || undefined,
      },
      signal,
    }),
    "List webhooks service",
  );
  return {
    list_id: text(r.list_id ?? "", "list identity", true),
    webhooks: arrayOf(r.webhooks ?? [], "The list webhooks service").map(
      decodeWebhook,
    ),
    next_cursor: cursor(r.next_cursor),
  };
}

/** Idempotency-Key is REQUIRED by the server for this shown-once create. */
export async function createListWebhook(
  listId: number,
  input: ListWebhookCreateInput,
  key: string,
): Promise<ListWebhookWithSecret> {
  return decodeWebhookWithSecret(
    await api.post<unknown>(
      `/api/v1/lists/${engineId(listId)}/webhooks`,
      validateWebhookInput(input),
      { requireOnline: true, idempotencyKey: key },
    ),
  );
}

export async function updateListWebhook(
  listId: number,
  wid: string,
  input: ListWebhookUpdateInput,
  key: string,
): Promise<ListWebhook> {
  const body: Record<string, unknown> = {};
  if (input.url !== undefined) body.url = input.url.trim();
  if (input.description !== undefined) body.description = input.description;
  if (input.events !== undefined) body.events = [...new Set(input.events)];
  if (input.active !== undefined) body.active = input.active;
  if (Object.keys(body).length === 0)
    throw new Error("Nothing to change on this webhook.");
  return decodeWebhook(
    await api.patch<unknown>(
      `/api/v1/lists/${engineId(listId)}/webhooks/${webhookId(wid)}`,
      body,
      { requireOnline: true, idempotencyKey: key },
    ),
  );
}

export async function deleteListWebhook(
  listId: number,
  wid: string,
  key: string,
): Promise<void> {
  await api.delete(
    `/api/v1/lists/${engineId(listId)}/webhooks/${webhookId(wid)}`,
    { requireOnline: true, idempotencyKey: key },
  );
}

/** Idempotency-Key is REQUIRED by the server; the new secret is shown once. */
export async function rotateListWebhookSecret(
  listId: number,
  wid: string,
  key: string,
): Promise<ListWebhookWithSecret> {
  return decodeWebhookWithSecret(
    await api.post<unknown>(
      `/api/v1/lists/${engineId(listId)}/webhooks/${webhookId(wid)}/rotate-secret`,
      {},
      { requireOnline: true, idempotencyKey: key },
    ),
  );
}

/** Fires one signed probe at the receiver; never queued offline. */
export async function testListWebhook(
  listId: number,
  wid: string,
  key: string,
): Promise<ListWebhookTestResult> {
  const r = record(
    await api.post<unknown>(
      `/api/v1/lists/${engineId(listId)}/webhooks/${webhookId(wid)}/test`,
      {},
      { requireOnline: true, idempotencyKey: key },
    ),
    "List webhook test service",
  );
  return {
    webhook_id: text(r.webhook_id ?? "", "webhook id", true),
    status_code: count(r.status_code, "status code"),
    signed: r.signed === true,
    signature: typeof r.signature === "string" ? r.signature : "",
    response: typeof r.response === "string" ? r.response : "",
    filtered: r.filtered === true,
  };
}

export async function listListWebhookDeliveries(
  listId: number,
  wid: string,
  q: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal,
): Promise<ListWebhookDeliveriesPage> {
  const r = record(
    await api.get<unknown>(
      `/api/v1/lists/${engineId(listId)}/webhooks/${webhookId(wid)}/deliveries`,
      {
        query: {
          limit: q.limit ?? DELIVERIES_PAGE_LIMIT,
          cursor: q.cursor || undefined,
        },
        signal,
      },
    ),
    "List webhook deliveries service",
  );
  return {
    deliveries: arrayOf(
      r.deliveries ?? [],
      "The webhook deliveries service",
    ).map((row) => {
      const d = record(row, "List webhook deliveries service");
      return {
        id: text(d.id, "delivery id"),
        webhook_id: text(d.webhook_id ?? "", "webhook id", true),
        event_type: text(d.event_type ?? "", "event type", true),
        attempt_count: count(d.attempt_count ?? 0, "attempt count"),
        ...(optText(d.next_attempt_at)
          ? { next_attempt_at: optText(d.next_attempt_at) }
          : {}),
        status: text(d.status ?? "", "delivery status", true),
        ...(Number.isSafeInteger(d.last_status_code)
          ? { last_status_code: Number(d.last_status_code) }
          : {}),
        ...(optText(d.last_response_body_truncated)
          ? {
              last_response_body_truncated: optText(
                d.last_response_body_truncated,
              ),
            }
          : {}),
        ...(optText(d.last_error) ? { last_error: optText(d.last_error) } : {}),
        created_at: text(d.created_at ?? "", "delivery created time", true),
        ...(optText(d.delivered_at)
          ? { delivered_at: optText(d.delivered_at) }
          : {}),
      };
    }),
    next_cursor: cursor(r.next_cursor),
  };
}

/* ---------- list health (audience-89, index) ---------------------------- */

export const LIST_HEALTH_WINDOW_DAYS = 90;

/** Mirrors `list_health.Score`. */
export interface ListHealthScore {
  tag?: string;
  window_days: number;
  total_subscribers: number;
  active_subscribers: number;
  engaged_subscribers: number;
  blocklisted_count: number;
  bounces: number;
  complaints: number;
  unsubscribes: number;
  bounce_rate: number;
  complaint_rate: number;
  unsubscribe_rate: number;
  engagement_rate: number;
  suppression_rate: number;
  score: number;
  grade: string;
  notes: string[];
}

/**
 * `/api/v1/list-health` scores subscribers carrying a TAG (the tag-as-list
 * pattern), so the index passes each list's name as the tag the way the
 * desktop does. Callers must treat `total_subscribers === 0` as "no data" —
 * the server grades an empty set A/100.
 */
export async function getListHealth(
  tag: string,
  windowDays = LIST_HEALTH_WINDOW_DAYS,
  signal?: AbortSignal,
): Promise<ListHealthScore> {
  const t = tag.trim();
  if (!t) throw new Error("A list name is needed to score its health.");
  const r = record(
    await api.get<unknown>("/api/v1/list-health", {
      query: { tag: t, window_days: windowDays },
      signal,
    }),
    "List health service",
  );
  return {
    ...(optText(r.tag) ? { tag: optText(r.tag) } : {}),
    window_days: count(r.window_days ?? windowDays, "window"),
    total_subscribers: num(r.total_subscribers ?? 0, "subscriber total"),
    active_subscribers: num(r.active_subscribers ?? 0, "active total"),
    engaged_subscribers: num(r.engaged_subscribers ?? 0, "engaged total"),
    blocklisted_count: num(r.blocklisted_count ?? 0, "blocklisted total"),
    bounces: num(r.bounces ?? 0, "bounces"),
    complaints: num(r.complaints ?? 0, "complaints"),
    unsubscribes: num(r.unsubscribes ?? 0, "unsubscribes"),
    bounce_rate: num(r.bounce_rate ?? 0, "bounce rate"),
    complaint_rate: num(r.complaint_rate ?? 0, "complaint rate"),
    unsubscribe_rate: num(r.unsubscribe_rate ?? 0, "unsubscribe rate"),
    engagement_rate: num(r.engagement_rate ?? 0, "engagement rate"),
    suppression_rate: num(r.suppression_rate ?? 0, "suppression rate"),
    score: num(r.score, "health score"),
    grade: text(r.grade, "health grade"),
    notes: arrayOf(r.notes ?? [], "The list health service").map((n) =>
      text(n, "health note"),
    ),
  };
}
