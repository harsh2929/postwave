// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Tag taxonomy transport — the read projections the Tags page reaches for
 * beyond the versioned registry in `@/lib/audience-admin-api`: usage counts
 * and orphan status, typeahead suggestions for the create form, and the
 * subscribers currently carrying a tag.
 *
 * Every decoder refuses a shape the server does not send rather than
 * inventing a default: an unverifiable payload is an error the page renders,
 * never an empty list it silently trusts.
 */

import { api, isApiError } from "@/lib/api";
import { requireTagMergeAvailable } from "@/lib/tag-merge-availability";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One row of GET /api/v1/tag-taxonomy — a label and how many carry it. */
export interface TagUsage {
  tag: string;
  subscribers: number;
  registered: boolean;
  created_at?: string;
}

/** One row of GET /api/v1/tag-taxonomy/suggest. */
export interface TagSuggestion {
  tag: string;
  subscribers: number;
  registered: boolean;
}

/** One row of GET /api/v1/tag-taxonomy/subscribers. */
export interface TagSubscriber {
  id: string;
  email: string;
  status: string;
  created_at: string;
}

/** Suggestions the create form asks for — the "Did you mean…?" hint. */
export const TAG_SUGGESTION_LIMIT = 5;
/** Server caps the member sample at 200; 50 keeps the detail dialog short. */
export const TAG_SUBSCRIBER_SAMPLE_LIMIT = 50;

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
function iso(v: unknown, field: string): string {
  const s = text(v, field);
  if (!Number.isFinite(Date.parse(s)))
    throw new Error(`The service returned an invalid ${field}.`);
  return s;
}

function decodeUsage(raw: unknown): TagUsage {
  const r = record(raw, "Tag taxonomy service");
  const created = r.created_at;
  return {
    tag: text(r.tag, "tag name"),
    subscribers: count(r.subscribers, "subscriber count"),
    registered: r.registered === true,
    ...(typeof created === "string" && created && Date.parse(created)
      ? { created_at: created }
      : {}),
  };
}

/** GET /api/v1/tag-taxonomy — usage counts for every live label. */
export async function listTagTaxonomy(
  signal?: AbortSignal,
): Promise<TagUsage[]> {
  const r = record(
    await api.get<unknown>("/api/v1/tag-taxonomy", { signal }),
    "Tag taxonomy service",
  );
  if (!Array.isArray(r.items))
    throw new Error("The tag taxonomy service returned an invalid catalogue.");
  return r.items.map(decodeUsage);
}

/**
 * GET /api/v1/tag-taxonomy/suggest?q=&limit= — registry rows whose name
 * contains `q`, ranked by membership. The server echoes `q`; a response for
 * a different query is discarded rather than shown against the wrong input.
 */
export async function suggestTags(
  q: string,
  limit = TAG_SUGGESTION_LIMIT,
  signal?: AbortSignal,
): Promise<TagSuggestion[]> {
  const query = q.trim();
  const r = record(
    await api.get<unknown>("/api/v1/tag-taxonomy/suggest", {
      query: { q: query, limit },
      signal,
    }),
    "Tag suggestion service",
  );
  if (r.q !== query || !Array.isArray(r.items))
    throw new Error("The tag suggestion service returned an unverifiable response.");
  return r.items.map((x) => {
    const s = record(x, "Tag suggestion service");
    return {
      tag: text(s.tag, "tag name"),
      subscribers: count(s.subscribers, "subscriber count"),
      registered: s.registered === true,
    };
  });
}

/**
 * GET /api/v1/tag-taxonomy/subscribers?tag=&limit= — a capped, newest-first
 * sample of the subscribers carrying `tagName`. The server echoes the tag so
 * a stale response cannot be rendered under a different tag's heading.
 */
export async function listSubscribersWithTag(
  tagName: string,
  limit = TAG_SUBSCRIBER_SAMPLE_LIMIT,
  signal?: AbortSignal,
): Promise<TagSubscriber[]> {
  const r = record(
    await api.get<unknown>("/api/v1/tag-taxonomy/subscribers", {
      query: { tag: tagName, limit },
      signal,
    }),
    "Tag subscribers service",
  );
  if (r.tag !== tagName || !Array.isArray(r.items))
    throw new Error("The tag subscribers service returned an unverifiable response.");
  const out = r.items.map((x): TagSubscriber => {
    const s = record(x, "Tag subscribers service");
    const id = text(s.id, "subscriber id");
    if (!UUID.test(id))
      throw new Error("The service returned an invalid subscriber id.");
    return {
      id: id.toLowerCase(),
      email: text(s.email, "subscriber email"),
      status: text(s.status ?? "", "subscriber status", true),
      created_at: iso(s.created_at, "subscriber created time"),
    };
  });
  if (new Set(out.map((x) => x.id)).size !== out.length)
    throw new Error("The tag subscribers service returned duplicate identities.");
  return out;
}

/** What POST /api/v1/tag-taxonomy/merge answers for one `from` → `into`. */
export interface TagMergeReceipt {
  from?: string;
  into: string;
  /** Server-confirmed count; absent when the server omitted it. */
  subscribers_updated?: number;
}

/**
 * POST /api/v1/tag-taxonomy/merge — fold every subscriber carrying `from`
 * into `into` and retire the source registry row. One source per call; a
 * multi-source merge fans out as sequential POSTs against the same target.
 *
 * Release-held: `requireTagMergeAvailable` throws before transport while
 * `TAG_MERGE_AVAILABLE` is false, mirroring desktop's permanently disabled
 * Merge control. The server refuses the same call with 409
 * `unsafe_mutation_disabled` until it has an authoritative impact plan.
 */
export async function mergeTags(
  input: { from: string; into: string },
  signal?: AbortSignal,
): Promise<TagMergeReceipt> {
  requireTagMergeAvailable();
  const from = input.from.trim();
  const into = input.into.trim();
  if (!from || !into) throw new Error("Pick a source tag and a destination.");
  if (tagIdentityKey(from) === tagIdentityKey(into))
    throw new Error("Source and destination tags are identical.");
  const r = record(
    await api.post<unknown>(
      "/api/v1/tag-taxonomy/merge",
      { from, into },
      { signal, requireOnline: true, maxAttempts: 1 },
    ),
    "Tag merge service",
  );
  const receipt: TagMergeReceipt = { into: text(r.into ?? into, "target tag") };
  if (typeof r.from === "string" && r.from) receipt.from = r.from;
  if (r.subscribers_updated !== undefined)
    receipt.subscribers_updated = count(
      r.subscribers_updated,
      "updated subscriber count",
    );
  return receipt;
}

function tagIdentityKey(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase();
}

/**
 * True when a versioned tag write was refused because the tag's ETag moved
 * (HTTP 412). Callers reload the catalogue and keep the operator's draft.
 */
export function isTagVersionConflict(err: unknown): boolean {
  return isApiError(err) && err.status === 412;
}
