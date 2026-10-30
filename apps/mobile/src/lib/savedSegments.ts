/**
 * savedSegments — the saved-audience bookmarks (SUB-040), and the honest
 * rule for which of them a PHONE can actually apply.
 *
 * Desktop applies a saved segment by handing its predicate to a directory
 * that understands tag / engagement / custom-field / AST predicates. The
 * mobile list is `GET /api/v1/subscribers?q=&status=&sort=` and understands
 * exactly two of those axes. So "apply the segment" has to mean one of two
 * different things, and conflating them is the failure mode this module
 * exists to prevent:
 *
 *   REDUCIBLE  — the predicate is only free text and/or a status. Setting
 *                the list's q + status reproduces it EXACTLY.
 *   OTHERWISE  — the predicate carries tags, engagement windows, custom
 *                fields, an archive scope or a compiled AST. Setting q +
 *                status would show a DIFFERENT audience under the
 *                segment's name, which is worse than not offering it: the
 *                operator would act on the wrong list believing it was
 *                the saved one.
 *
 * Non-reducible segments are still surfaced (with their live size) — you
 * can see they exist and how big they are — but they are not applicable
 * and say so out loud.
 *
 * Import-free so every rule here is unit-testable in the node environment.
 */
import { plural } from "@/lib/format";


export interface SavedSegmentRow {
  id: string;
  name: string;
  description: string;
  /** "personal" | "workspace"; unknown values pass through untouched. */
  visibility: string;
  isPinned: boolean;
  /** Denormalised live size. null = never evaluated (NOT zero). */
  lastCount: number | null;
  lastEvaluatedAt: string | null;
  /** Untrusted predicate blob; only read through the reducer below. */
  predicate: unknown;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseSavedSegments(raw: unknown): SavedSegmentRow[] {
  const items = Array.isArray(raw) ? raw : (rec(raw)?.items ?? undefined);
  if (!Array.isArray(items)) return [];
  const out: SavedSegmentRow[] = [];
  for (const entry of items) {
    const row = rec(entry);
    if (!row) continue;
    const id = str(row.id).trim();
    const name = str(row.name).trim();
    if (!id || !name) continue;
    out.push({
      id,
      name,
      description: str(row.description).trim(),
      visibility: str(row.visibility_scope).trim(),
      isPinned: row.is_pinned === true,
      lastCount:
        typeof row.last_count === "number" && Number.isFinite(row.last_count)
          ? row.last_count
          : null,
      lastEvaluatedAt: str(row.last_evaluated_at) || null,
      predicate: row.predicate_json ?? null,
    });
  }
  // Pinned first (the server's own picker order), then by name so the row
  // is stable between refreshes.
  return out.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export type SegmentApplication =
  | {
      applicable: true;
      /** Free-text term for the search box. */
      q: string;
      /** UI status chip key ("all" when the segment does not constrain it). */
      statusKey: string;
    }
  | { applicable: false; reason: string };

/** UI status values the mobile chip row can represent. */
const CHIP_KEYS = new Set([
  "all",
  "subscribed",
  "unsubscribed",
  "disabled",
  "unconfirmed",
]);

/** Engine values a saved segment may store, mapped onto a chip key. */
const STATUS_TO_CHIP: Record<string, string> = {
  "": "all",
  all: "all",
  enabled: "subscribed",
  active: "subscribed",
  subscribed: "subscribed",
  blocklisted: "unsubscribed",
  unsubscribed: "unsubscribed",
  disabled: "disabled",
  inactive: "disabled",
  unconfirmed: "unconfirmed",
};

const NON_REDUCIBLE_FILTER_KEYS = [
  "tags",
  "engagement",
  "custom_fields",
  "date_range",
] as const;

/**
 * Decide whether the mobile subscriber list can reproduce this segment
 * exactly, and if so with which q + status.
 *
 * Handles all three shapes the API accepts: the legacy flat `{status, q}`
 * blob, the structured `{filters}` snapshot, and the `{snapshot}` view
 * state (whose `applied_query` is the authoritative directory query).
 */
export function reduceSegmentToListView(
  predicate: unknown,
): SegmentApplication {
  const root = rec(predicate);
  if (!root) {
    return {
      applicable: false,
      reason: "This segment has no stored rule the phone can read.",
    };
  }

  // A compiled AST is evaluated server-side against columns the list
  // endpoint does not expose. There is no honest client-side reduction.
  if (rec(root.ast)) {
    return {
      applicable: false,
      reason:
        "This segment uses a rule tree the mobile list can't evaluate. Open it on the web admin.",
    };
  }

  const filters = rec(root.filters);
  const snapshot = rec(root.snapshot);

  for (const key of NON_REDUCIBLE_FILTER_KEYS) {
    const value = filters?.[key];
    const populated = Array.isArray(value)
      ? value.length > 0
      : rec(value) !== null;
    if (populated) {
      return {
        applicable: false,
        reason: `This segment filters by ${key.replace(/_/g, " ")}, which the mobile list can't apply.`,
      };
    }
  }

  // The archive scope changes which ROWS exist, not just which match, so a
  // reduction that drops it would silently show a smaller audience.
  if (snapshot?.include_archived === true) {
    return {
      applicable: false,
      reason:
        "This segment includes archived contacts, which the mobile list doesn't show.",
    };
  }

  const q = (
    str(snapshot?.applied_query) ||
    str(filters?.q) ||
    str(root.q)
  ).trim();
  const rawStatus = (str(filters?.status) || str(root.status))
    .trim()
    .toLowerCase();
  const statusKey = STATUS_TO_CHIP[rawStatus];

  if (statusKey === undefined || !CHIP_KEYS.has(statusKey)) {
    return {
      applicable: false,
      reason: `This segment's status "${rawStatus}" has no mobile filter chip.`,
    };
  }

  if (!q && statusKey === "all") {
    return {
      applicable: false,
      reason: "This segment has no rule the mobile list can narrow by.",
    };
  }

  return { applicable: true, q, statusKey };
}

/**
 * Spoken label for one segment chip. VoiceOver otherwise gets a bare name
 * with no size and no indication that tapping it will do nothing.
 */
export function savedSegmentLabel(
  row: SavedSegmentRow,
  application: SegmentApplication,
): string {
  const size =
    row.lastCount === null
      ? "size not evaluated yet"
      : plural(row.lastCount, "member");
  if (!application.applicable) {
    return `${row.name}, ${size}. Not available on mobile. ${application.reason}`;
  }
  return `Apply segment ${row.name}, ${size}`;
}
