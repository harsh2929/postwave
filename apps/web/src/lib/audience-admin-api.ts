// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AudienceList {
  id: number;
  postwave_uuid?: string;
  name: string;
  type: "private" | "public" | "temporary";
  optin: "single" | "double";
  tags: string[];
  description: string;
}
export interface TagRecord {
  id: string;
  name: string;
  color: string;
  description: string;
  group_id: string;
  created_at: string;
  updated_at: string;
  archived_at?: string;
  pii: boolean;
  version: number;
  etag: string;
  subscriber_count?: number;
}
export interface TagGroup {
  id: string;
  name: string;
  color: string;
  sort_order: number;
  created_at: string;
}
export interface TagHistory {
  id: string;
  action: string;
  source: string;
  occurred_at: string;
  subscriber_id?: string;
  actor_id?: string;
  reason?: string;
}
export interface Membership {
  tag_id: string;
  days: number;
  current_count: number;
  added: number;
  removed: number;
  daily: { date: string; net: number }[];
  coverage: {
    completeness: string;
    requested_window_complete: boolean;
    as_of: string;
  };
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
function iso(v: unknown, field: string): string {
  const s = text(v, field);
  if (!Number.isFinite(Date.parse(s)))
    throw new Error(`The service returned an invalid ${field}.`);
  return s;
}
function uuid(v: unknown, field: string): string {
  const s = text(v, field);
  if (!UUID.test(s))
    throw new Error(`The service returned an invalid ${field}.`);
  return s.toLowerCase();
}
function integer(v: unknown, field: string, min = 0): number {
  if (!Number.isSafeInteger(v) || Number(v) < min)
    throw new Error(`The service returned an invalid ${field}.`);
  return Number(v);
}
function stringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
    throw new Error(`The service returned invalid ${field}.`);
  return v as string[];
}

function decodeList(raw: unknown): AudienceList {
  const r = record(raw, "Lists service");
  const type = text(r.type ?? "private", "list type");
  const optin = text(r.optin ?? "single", "list opt-in");
  if (
    !["private", "public", "temporary"].includes(type) ||
    !["single", "double"].includes(optin)
  )
    throw new Error("The lists service returned an unsupported list policy.");
  return {
    id: integer(r.id, "list id", 1),
    ...(r.postwave_uuid === undefined
      ? {}
      : { postwave_uuid: uuid(r.postwave_uuid, "list identity") }),
    name: text(r.name, "list name"),
    type: type as AudienceList["type"],
    optin: optin as AudienceList["optin"],
    tags: r.tags === undefined ? [] : stringArray(r.tags, "list tags"),
    description: text(r.description ?? "", "list description", true),
  };
}
export async function listAudienceLists(
  q = "",
  signal?: AbortSignal,
): Promise<AudienceList[]> {
  const raw = await api.get<unknown>("/api/v1/lists", {
    query: q ? { query: q } : undefined,
    signal,
  });
  const root = record(raw, "Lists service");
  const data = root.data;
  let rows: unknown;
  if (Array.isArray(data)) rows = data;
  else if (data && typeof data === "object")
    rows = (data as Record<string, unknown>).results;
  else rows = root.items ?? root.results;
  if (!Array.isArray(rows))
    throw new Error("The lists service returned an invalid catalogue.");
  const out = rows.map(decodeList);
  if (new Set(out.map((x) => x.id)).size !== out.length)
    throw new Error("The lists service returned duplicate identities.");
  return out;
}
export async function createAudienceList(
  input: {
    name: string;
    type: string;
    optin: string;
    description: string;
    tags: string[];
  },
  key: string,
): Promise<AudienceList> {
  const raw = await api.post<unknown>("/api/v1/lists", input, {
    requireOnline: true,
    idempotencyKey: key,
  });
  return decodeList(record(raw, "Lists service").data);
}

function audienceListPath(id: number): string {
  const canonicalId = integer(id, "list id", 1);
  return `/api/v1/lists/${encodeURIComponent(String(canonicalId))}`;
}

export async function updateAudienceList(
  id: number,
  input: Partial<Omit<AudienceList, "id" | "postwave_uuid">>,
  key: string,
): Promise<void> {
  await api.patch(audienceListPath(id), input, {
    requireOnline: true,
    idempotencyKey: key,
  });
}
export async function deleteAudienceList(
  id: number,
  key: string,
): Promise<void> {
  await api.delete(audienceListPath(id), {
    requireOnline: true,
    idempotencyKey: key,
  });
}

function decodeTag(raw: unknown): TagRecord {
  const r = record(raw, "Tags service");
  const id = uuid(r.id, "tag id"),
    version = integer(r.version, "tag version", 1),
    etag = text(r.etag, "tag ETag");
  if (etag !== `\"tag:${id}:v${version}\"`)
    throw new Error("The tags service returned a mismatched version token.");
  const count = r.subscriber_count;
  return {
    id,
    name: text(r.name, "tag name"),
    color: text(r.color ?? "", "tag color", true),
    description: text(r.description, "tag description", true),
    group_id:
      r.group_id === undefined || r.group_id === ""
        ? ""
        : uuid(r.group_id, "tag group"),
    created_at: iso(r.created_at, "tag created time"),
    updated_at: iso(r.updated_at, "tag updated time"),
    ...(r.archived_at === undefined || r.archived_at === null
      ? {}
      : { archived_at: iso(r.archived_at, "tag archive time") }),
    pii: r.pii === true,
    version,
    etag,
    ...(count === undefined
      ? {}
      : { subscriber_count: integer(count, "subscriber count") }),
  };
}
export async function listTags(
  input: { q?: string; groupId?: string; signal?: AbortSignal } = {},
): Promise<TagRecord[]> {
  const raw = record(
    await api.get<unknown>("/api/v1/tags", {
      query: { q: input.q, group_id: input.groupId, with_counts: true },
      signal: input.signal,
    }),
    "Tags service",
  );
  if (!Array.isArray(raw.items))
    throw new Error("The tags service returned an invalid catalogue.");
  const out = raw.items.map(decodeTag);
  if (new Set(out.map((x) => x.id)).size !== out.length)
    throw new Error("The tags service returned duplicate identities.");
  return out;
}
export async function createTag(
  input: {
    name: string;
    color: string;
    description: string;
    group_id: string;
    pii: boolean;
  },
  key: string,
): Promise<TagRecord> {
  return decodeTag(
    await api.post<unknown>("/api/v1/tags", input, {
      requireOnline: true,
      idempotencyKey: key,
    }),
  );
}
export async function updateTag(
  tag: TagRecord,
  input: Partial<
    Pick<TagRecord, "name" | "color" | "description" | "group_id" | "pii">
  >,
  key: string,
): Promise<TagRecord> {
  return decodeTag(
    await api.patch<unknown>(
      `/api/v1/tags/${encodeURIComponent(tag.id)}`,
      input,
      {
        headers: { "If-Match": tag.etag },
        requireOnline: true,
        idempotencyKey: key,
      },
    ),
  );
}
function decodeGroup(raw: unknown): TagGroup {
  const r = record(raw, "Tag groups service");
  return {
    id: uuid(r.id, "group id"),
    name: text(r.name, "group name"),
    color: text(r.color ?? "", "group color", true),
    sort_order: integer(r.sort_order, "group sort order"),
    created_at: iso(r.created_at, "group created time"),
  };
}
export async function listTagGroups(signal?: AbortSignal): Promise<TagGroup[]> {
  const r = record(
    await api.get<unknown>("/api/v1/tag-groups", { signal }),
    "Tag groups service",
  );
  if (!Array.isArray(r.items))
    throw new Error("The tag groups service returned an invalid catalogue.");
  return r.items.map(decodeGroup);
}
export async function createTagGroup(
  input: { name: string; color: string; sort_order: number },
  key: string,
): Promise<TagGroup> {
  return decodeGroup(
    await api.post<unknown>("/api/v1/tag-groups", input, {
      requireOnline: true,
      idempotencyKey: key,
    }),
  );
}
export async function updateTagGroup(
  id: string,
  input: Partial<Pick<TagGroup, "name" | "color" | "sort_order">>,
  key: string,
): Promise<TagGroup> {
  return decodeGroup(
    await api.patch<unknown>(
      `/api/v1/tag-groups/${encodeURIComponent(id)}`,
      input,
      { requireOnline: true, idempotencyKey: key },
    ),
  );
}
export async function deleteTagGroup(id: string, key: string): Promise<void> {
  const r = record(
    await api.delete<unknown>(`/api/v1/tag-groups/${encodeURIComponent(id)}`, {
      requireOnline: true,
      idempotencyKey: key,
    }),
    "Tag groups service",
  );
  if (r.ok !== true)
    throw new Error("The tag groups service did not confirm deletion.");
}
export async function mutateTagMembership(
  tagId: string,
  subscriberIds: string[],
  mode: "apply" | "unapply",
  key: string,
): Promise<{ applied: number; skipped: number }> {
  const r = record(
    await api.post<unknown>(
      `/api/v1/tags/${encodeURIComponent(tagId)}/${mode}`,
      {
        subscriber_ids: subscriberIds,
        idempotency_key: key,
        source: "web_admin",
      },
      { requireOnline: true, idempotencyKey: key },
    ),
    "Tag membership service",
  );
  const applied = integer(r.applied, "applied count"),
    skipped = integer(r.skipped, "skipped count");
  if (applied + skipped !== subscriberIds.length)
    throw new Error("The tag membership receipt does not match the request.");
  return { applied, skipped };
}
export async function tagHistory(
  id: string,
  signal?: AbortSignal,
): Promise<TagHistory[]> {
  const r = record(
    await api.get<unknown>(`/api/v1/tags/${encodeURIComponent(id)}/history`, {
      query: { limit: 200 },
      signal,
    }),
    "Tag history service",
  );
  if (!Array.isArray(r.items))
    throw new Error("The tag history service returned an invalid page.");
  return r.items.map((x) => {
    const h = record(x, "Tag history service");
    return {
      id: uuid(h.id, "history id"),
      action: text(h.action, "history action"),
      source: text(h.source, "history source"),
      occurred_at: iso(h.occurred_at, "history time"),
      ...(typeof h.subscriber_id === "string" && h.subscriber_id
        ? { subscriber_id: uuid(h.subscriber_id, "subscriber id") }
        : {}),
    };
  });
}
export async function tagMembership(
  id: string,
  days: number,
  signal?: AbortSignal,
): Promise<Membership> {
  const r = record(
    await api.get<unknown>(
      `/api/v1/tag-taxonomy/${encodeURIComponent(id)}/membership`,
      { query: { days }, signal },
    ),
    "Tag membership service",
  );
  const coverage = record(r.coverage, "Tag membership service");
  if (!Array.isArray(r.daily))
    throw new Error("The tag membership service returned invalid history.");
  return {
    tag_id: uuid(r.tag_id, "tag id"),
    days: integer(r.days, "days", 1),
    current_count: integer(r.current_count, "current count"),
    added: integer(r.added, "added count"),
    removed: integer(r.removed, "removed count"),
    daily: r.daily.map((x) => {
      const d = record(x, "Tag membership service");
      return {
        date: text(d.date, "membership date"),
        net:
          integer(Math.abs(Number(d.net)), "membership net") *
          Math.sign(Number(d.net)),
      };
    }),
    coverage: {
      completeness: text(coverage.completeness, "coverage"),
      requested_window_complete: coverage.requested_window_complete === true,
      as_of: iso(coverage.as_of, "coverage time"),
    },
  };
}
export function newWriteKey(kind: string): string {
  return `web-audience:${kind}:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
}
