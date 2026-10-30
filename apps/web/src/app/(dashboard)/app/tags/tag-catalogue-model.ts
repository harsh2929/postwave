// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure view-model for the Tags catalogue: the colour palette, the identity
 * key that decides whether two labels are "the same tag", client-side
 * search / colour / group filtering, orphan detection (taxonomy ∖ registry),
 * sorting, and paging. No React, no transport — the page composes these over
 * the two list reads it already holds so a filter change never refetches.
 */
import type { TagRecord } from "@/lib/audience-admin-api";
import type { TagUsage } from "@/lib/tags-api";

export const TAG_PALETTE: ReadonlyArray<{
  id: string;
  label: string;
  bg: string;
}> = [
  { id: "slate", label: "Slate", bg: "#64748b" },
  { id: "teal", label: "Teal", bg: "#14b8a6" },
  { id: "sky", label: "Sky", bg: "#0ea5e9" },
  { id: "indigo", label: "Indigo", bg: "#6366f1" },
  { id: "violet", label: "Violet", bg: "#8b5cf6" },
  { id: "rose", label: "Rose", bg: "#f43f5e" },
  { id: "amber", label: "Amber", bg: "#f59e0b" },
  { id: "lime", label: "Lime", bg: "#84cc16" },
];

export const DEFAULT_TAG_COLOR = TAG_PALETTE[0]!.id;

const HEX_COLOR = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/iu;

export interface TagColorPresentation {
  background: string;
  label: string;
  /** The stored value is neither a palette id nor a hex colour. */
  legacy: boolean;
}

/**
 * Converts an untrusted stored colour into a safe visual token. A raw legacy
 * string never reaches a CSS declaration; it renders as neutral slate with a
 * "Legacy colour" badge so the operator can see it needs replacing.
 */
export function tagColorPresentation(
  value: string | null | undefined,
): TagColorPresentation {
  if (!value)
    return {
      background: TAG_PALETTE[0]!.bg,
      label: TAG_PALETTE[0]!.label,
      legacy: false,
    };
  const palette = TAG_PALETTE.find((x) => x.id === value.toLowerCase());
  if (palette)
    return { background: palette.bg, label: palette.label, legacy: false };
  if (HEX_COLOR.test(value))
    return { background: value, label: value.toUpperCase(), legacy: false };
  return {
    background: TAG_PALETTE[0]!.bg,
    label: "Legacy colour shown as neutral slate",
    legacy: true,
  };
}

/** The server compares tag names as citext; mirror that on the client. */
export function tagIdentityKey(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase();
}

export const TAG_PAGE_SIZE = 25;
export const GROUP_FILTER_ALL = "";
/** Sentinel for the "No group" bucket — tags whose group_id is empty. */
export const GROUP_FILTER_UNGROUPED = "none";
export const COLOR_FILTER_ALL = "all";

export type TagSortField = "name" | "subscribers" | "created";
export type TagSortDirection = "asc" | "desc";

export interface TagView {
  query: string;
  color: string;
  group: string;
  sortField: TagSortField;
  sortDirection: TagSortDirection;
  page: number;
}

export const DEFAULT_TAG_VIEW: TagView = {
  query: "",
  color: COLOR_FILTER_ALL,
  group: GROUP_FILTER_ALL,
  sortField: "name",
  sortDirection: "asc",
  page: 1,
};

export function isDefaultTagView(view: TagView): boolean {
  return (
    !view.query.trim() &&
    view.color === COLOR_FILTER_ALL &&
    view.group === GROUP_FILTER_ALL &&
    view.sortField === DEFAULT_TAG_VIEW.sortField &&
    view.sortDirection === DEFAULT_TAG_VIEW.sortDirection &&
    view.page === 1
  );
}

export type TagDisplayRow =
  | { kind: "tag"; name: string; tag: TagRecord; count: number | null }
  | { kind: "orphan"; name: string; usage: TagUsage };

export function tagUsageMap(items: TagUsage[]): Map<string, TagUsage> {
  const map = new Map<string, TagUsage>();
  for (const usage of items) map.set(tagIdentityKey(usage.tag), usage);
  return map;
}

/**
 * Subscriber count for a registered tag: the list's own `subscriber_count`
 * when the server sent one, else the taxonomy's usage row, else unknown.
 * Unknown stays `null` — it is rendered as "—", never as 0.
 */
export function tagSubscriberCount(
  tag: TagRecord,
  usage: Map<string, TagUsage>,
): number | null {
  if (typeof tag.subscriber_count === "number") return tag.subscriber_count;
  return usage.get(tagIdentityKey(tag.name))?.subscribers ?? null;
}

/**
 * Orphans are labels the taxonomy reports as applied to subscribers that the
 * registry does not list (or reports as unregistered): catalogue ∖ taxonomy.
 */
export function orphanTagUsage(
  rows: TagRecord[],
  usage: Map<string, TagUsage>,
): TagUsage[] {
  const registered = new Set(rows.map((x) => tagIdentityKey(x.name)));
  return [...usage.values()].filter(
    (x) => !x.registered || !registered.has(tagIdentityKey(x.tag)),
  );
}

function matchesQuery(name: string, description: string, query: string) {
  const q = tagIdentityKey(query);
  if (!q) return true;
  return (
    tagIdentityKey(name).includes(q) ||
    description.normalize("NFKC").toLowerCase().includes(q)
  );
}

export function filterTags(rows: TagRecord[], view: TagView): TagRecord[] {
  return rows.filter((tag) => {
    if (
      view.color !== COLOR_FILTER_ALL &&
      (tag.color || DEFAULT_TAG_COLOR).toLowerCase() !== view.color
    )
      return false;
    if (view.group === GROUP_FILTER_UNGROUPED) {
      if (tag.group_id) return false;
    } else if (view.group !== GROUP_FILTER_ALL && tag.group_id !== view.group)
      return false;
    return matchesQuery(tag.name, tag.description, view.query);
  });
}

/**
 * Registered rows that survive the view, followed by orphans. Orphans have
 * neither a colour nor a group, so a colour or group filter hides them; the
 * count of hidden orphans is returned so the page can say so.
 */
export function buildTagDisplayRows(
  rows: TagRecord[],
  usage: Map<string, TagUsage>,
  view: TagView,
): { rows: TagDisplayRow[]; hiddenOrphans: number } {
  const registered: TagDisplayRow[] = filterTags(rows, view).map((tag) => ({
    kind: "tag",
    name: tag.name,
    tag,
    count: tagSubscriberCount(tag, usage),
  }));
  const orphans = orphanTagUsage(rows, usage);
  const orphansAllowed =
    view.color === COLOR_FILTER_ALL && view.group === GROUP_FILTER_ALL;
  const visibleOrphans: TagDisplayRow[] = orphansAllowed
    ? orphans
        .filter((x) => matchesQuery(x.tag, "", view.query))
        .map((x) => ({ kind: "orphan", name: x.tag, usage: x }))
    : [];
  return {
    rows: [...registered, ...visibleOrphans],
    hiddenOrphans: orphansAllowed ? 0 : orphans.length,
  };
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

export function sortTagDisplayRows(
  rows: TagDisplayRow[],
  field: TagSortField,
  direction: TagSortDirection,
): TagDisplayRow[] {
  const sign = direction === "asc" ? 1 : -1;
  const countOf = (row: TagDisplayRow) =>
    row.kind === "tag" ? (row.count ?? -1) : row.usage.subscribers;
  const createdOf = (row: TagDisplayRow) =>
    row.kind === "tag" ? row.tag.created_at : (row.usage.created_at ?? "");
  return [...rows].sort((a, b) => {
    let c = 0;
    if (field === "subscribers") c = countOf(a) - countOf(b);
    else if (field === "created") c = createdOf(a).localeCompare(createdOf(b));
    else c = compareNames(a.name, b.name);
    if (c === 0) c = compareNames(a.name, b.name);
    return c * sign;
  });
}

export function pageOfRows<T>(
  rows: T[],
  page: number,
): { rows: T[]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(rows.length / TAG_PAGE_SIZE));
  const clamped = Math.min(Math.max(1, page), totalPages);
  const start = (clamped - 1) * TAG_PAGE_SIZE;
  return {
    rows: rows.slice(start, start + TAG_PAGE_SIZE),
    page: clamped,
    totalPages,
  };
}

/** The server accepts 1–64 runes; count code points, not UTF-16 units. */
export function runeLength(value: string): number {
  return [...value].length;
}
