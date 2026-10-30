/**
 * tagManage — tag maintenance rules the phone shares with desktop's
 * TagOverlays: the cosmetic PATCH (color / description / group), the group
 * CRUD bodies, and the membership-history feed.
 *
 * DELETION IS DELIBERATELY ABSENT. Both DELETE /tags/{id} and POST
 * /tags/bulk-delete answer an unconditional server-side 409
 * ("unsafe_mutation_disabled" — tags.go Delete, bulk_delete.go): permanent
 * tag deletion is held until it exists with an impact plan and receipt.
 * Desktop's delete modals target the same held routes; this module refuses
 * to grow a verb that always fails.
 *
 * The PATCH is conditional on the tag's strong revision
 * (`"tag:{id}:v{n}"`, parseRequiredTagVersion) — the row's own etag from
 * the catalogue, never re-read.
 *
 * Import-free so every rule runs in the node vitest suite.
 */

/** The server's named colour presets (normalizeTagColor's vocabulary). */
export const TAG_COLOR_CHOICES = [
  "slate",
  "teal",
  "sky",
  "indigo",
  "violet",
  "rose",
  "amber",
  "lime",
] as const;

export interface TagEditDraft {
  /** Preset name; "" = leave untouched. */
  color: string;
  /** "" = leave untouched; a single space cannot be meaningful. */
  description: string;
  /** undefined = untouched; "" = clear the group; else a group id. */
  groupId: string | undefined;
}

/**
 * The PATCH body — pointer semantics, only the touched keys travel
 * (an omitted key inherits; UpdateInput's nils). Null when nothing changed
 * so the caller can refuse an empty patch locally (the server 400s it).
 */
export function buildTagPatch(
  draft: TagEditDraft,
): Record<string, unknown> | null {
  const body: Record<string, unknown> = {};
  if (draft.color) body.color = draft.color;
  if (draft.description.trim()) body.description = draft.description.trim();
  if (draft.groupId !== undefined) body.group_id = draft.groupId;
  return Object.keys(body).length > 0 ? body : null;
}

export interface TagHistoryRow {
  action: string;
  source: string;
  reason: string;
  occurredAt: string;
}

export interface TagHistoryView {
  items: TagHistoryRow[];
  nextCursor: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The GET /tags/{id}/history {items, next_cursor} body, defensively. */
export function parseTagHistory(payload: unknown): TagHistoryView {
  const rec =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const items: TagHistoryRow[] = Array.isArray(rec.items)
    ? rec.items.flatMap((row): TagHistoryRow[] => {
        if (!row || typeof row !== "object") return [];
        const r = row as Record<string, unknown>;
        const action = str(r.action);
        if (!action) return [];
        return [
          {
            action,
            source: str(r.source),
            reason: str(r.reason),
            occurredAt: str(r.occurred_at),
          },
        ];
      })
    : [];
  return { items, nextCursor: str(rec.next_cursor) };
}

/** Human sentence per history action; unknown actions pass through. */
export function tagHistoryLine(row: TagHistoryRow): string {
  const what =
    row.action === "applied"
      ? "Applied to a subscriber"
      : row.action === "unapplied"
        ? "Removed from a subscriber"
        : row.action;
  const via = row.source ? ` via ${row.source}` : "";
  const why = row.reason ? ` — ${row.reason}` : "";
  return `${what}${via}${why}`;
}

/** POST /tag-groups body. */
export function buildGroupCreateBody(name: string): Record<string, unknown> | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  return { name: trimmed, color: "", sort_order: 0 };
}

/** PATCH /tag-groups/{id} body — pointer semantics, rename only here. */
export function buildGroupRenameBody(
  name: string,
): Record<string, unknown> | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  return { name: trimmed };
}
