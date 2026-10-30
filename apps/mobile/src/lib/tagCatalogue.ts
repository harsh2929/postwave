/**
 * tagCatalogue — presentation policy for the tag catalogue.
 *
 * The tags screen was rendering `{id, name, created_at}` and discarding the
 * rest of what `GET /api/v1/tags` returns: colour, description, group and
 * the `pii` compliance flag (apps/api/internal/tags/tags.go Tag). Colour is
 * the cheapest possible signal on a chip cloud and it was already on the
 * wire; `pii` is a compliance fact an operator should not need a desktop to
 * see.
 *
 * Pure and RN-free (no react-native, no SDK client) so every rule here is
 * unit-testable under the node environment.
 */

/** The subset of the API's Tag the phone renders. */
export interface TagCatalogueRow {
  id: string;
  name: string;
  color?: string | undefined;
  description?: string | undefined;
  group_id?: string | undefined;
  pii?: boolean | undefined;
  created_at?: string | undefined;
  archived_at?: string | undefined;
  /** The strong revision (`"tag:{id}:v{n}"`) a PATCH must echo as If-Match. */
  etag?: string | undefined;
}

/**
 * The server's named colour presets, resolved to hex. Mirrors desktop's
 * tag colour presentation so the same tag is the same colour on both.
 */
const TAG_COLOR_PRESETS: Record<string, string> = {
  slate: "#64748b",
  teal: "#14b8a6",
  sky: "#0ea5e9",
  indigo: "#6366f1",
  violet: "#8b5cf6",
  rose: "#f43f5e",
  amber: "#f59e0b",
  lime: "#84cc16",
};

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;

/**
 * Resolve a stored colour to a hex string, or null when the tag has none
 * (or carries a value we refuse to trust). The column is a free-text
 * server field: an unvalidated value spliced into a style prop is how you
 * get a silently invisible chip, so anything that is neither a known
 * preset nor a well-formed hex triple is treated as "no colour".
 */
export function resolveTagColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  const preset = TAG_COLOR_PRESETS[raw];
  if (preset) return preset;
  return HEX_RE.test(raw) ? raw : null;
}

/** True when the tag is archived (soft-deleted) rather than active. */
export function isTagArchived(row: TagCatalogueRow): boolean {
  return typeof row.archived_at === "string" && row.archived_at.trim() !== "";
}

/**
 * What VoiceOver says for a chip. Colour is deliberately NOT spoken — it
 * carries no meaning on its own — but the PII flag and the archived state
 * are, because both change what the operator may do with the tag.
 */
export function tagSpokenLabel(
  row: TagCatalogueRow,
  createdText: string,
): string {
  const parts = [`Tag ${row.name || "(unnamed)"}`];
  if (row.description) parts.push(row.description);
  if (row.pii) parts.push("contains personal data");
  if (isTagArchived(row)) parts.push("archived");
  if (createdText) parts.push(`created ${createdText}`);
  // NOT "Long press to copy": a long press is unperformable with VoiceOver, so
  // narrating it advertised a path this user does not have. The chip publishes
  // the menu as `accessibilityActions`, which VoiceOver announces itself as
  // "actions available" — this sentence names the destination and stops there.
  parts.push("Opens the subscribers who carry it");
  return parts.join(". ");
}

export type TagSortMode = "name" | "newest";

export const TAG_SORT_MODES: readonly TagSortMode[] = ["name", "newest"];

/** A stored preference from an older build must never leave the screen in
 *  a sort mode that no longer exists. */
export function asTagSortMode(value: string): TagSortMode {
  return (TAG_SORT_MODES as readonly string[]).includes(value)
    ? (value as TagSortMode)
    : "name";
}

/**
 * Sort a catalogue page. The API applies `query` / `group_id` /
 * `include_archived` but does NOT sort, so ordering stays client-side.
 * Never mutates the input (it is a TanStack cache array).
 */
export function sortTags<T extends TagCatalogueRow>(
  rows: readonly T[],
  mode: TagSortMode,
): T[] {
  const sorted = [...rows];
  if (mode === "name") {
    sorted.sort((a, b) =>
      (a.name ?? "").localeCompare(b.name ?? "", undefined, {
        sensitivity: "base",
      }),
    );
    return sorted;
  }
  // Newest first; rows without a parseable date sink to the bottom.
  sorted.sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : NaN;
    const tb = b.created_at ? Date.parse(b.created_at) : NaN;
    const va = Number.isNaN(ta) ? -Infinity : ta;
    const vb = Number.isNaN(tb) ? -Infinity : tb;
    return vb - va;
  });
  return sorted;
}

/**
 * Normalise the `{items: Tag[]}` envelope (or a bare array from an older
 * gateway) into rows the screen can render. Rows without an id are dropped
 * — they cannot be keyed or routed to.
 */
export function normalizeTagCatalogue(res: unknown): TagCatalogueRow[] {
  const raw = Array.isArray(res)
    ? res
    : Array.isArray((res as { items?: unknown[] } | undefined)?.items)
      ? (res as { items: unknown[] }).items
      : [];
  const out: TagCatalogueRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (row.id == null && typeof row.name !== "string") continue;
    const id = row.id == null ? String(row.name) : String(row.id);
    const color = resolveTagColor(row.color);
    const description =
      typeof row.description === "string" && row.description.trim()
        ? row.description.trim()
        : undefined;
    const groupId =
      typeof row.group_id === "string" && row.group_id.trim()
        ? row.group_id.trim()
        : undefined;
    const createdAt =
      typeof row.created_at === "string" ? row.created_at : undefined;
    const archivedAt =
      typeof row.archived_at === "string" ? row.archived_at : undefined;
    out.push({
      id,
      name: typeof row.name === "string" ? row.name : "",
      // exactOptionalPropertyTypes: spread, never assign `undefined`.
      ...(color ? { color } : {}),
      ...(description ? { description } : {}),
      ...(groupId ? { group_id: groupId } : {}),
      ...(row.pii === true ? { pii: true } : {}),
      ...(createdAt ? { created_at: createdAt } : {}),
      ...(archivedAt ? { archived_at: archivedAt } : {}),
      ...(typeof row.etag === "string" && row.etag
        ? { etag: row.etag }
        : {}),
    });
  }
  return out;
}
