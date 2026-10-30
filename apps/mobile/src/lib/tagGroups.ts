/**
 * tagGroups — the tenant's tag groups (`GET /api/v1/tag-groups`).
 *
 * On a large taxonomy, GROUP is the primary navigational axis: desktop
 * ships a dedicated group sidebar. Mobile's tags screen offered only a
 * search box and an A–Z/Newest toggle, so a thousand-tag workspace was a
 * flat chip cloud you could only get through by typing.
 *
 * The tags endpoint has always accepted `group_id`, and useTagCatalogue
 * already forwards it — the only missing piece was the list of groups to
 * choose from.
 *
 * Import-free, so parsing and ordering are unit-testable.
 */

export interface TagGroup {
  id: string;
  name: string;
  sortOrder: number;
}

export function parseTagGroups(raw: unknown): TagGroup[] {
  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (raw as { items?: unknown }).items
      : undefined;
  if (!Array.isArray(items)) return [];
  const out: TagGroup[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!id || !name) continue;
    out.push({
      id,
      name,
      sortOrder:
        typeof row.sort_order === "number" && Number.isFinite(row.sort_order)
          ? row.sort_order
          : 0,
    });
  }
  // The handler promises sort/name order; re-apply it so a gateway that
  // forgets does not reshuffle the chip row between refreshes.
  return out.sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
}

/** Resolve the selected group id back to its name, for the count line. */
export function tagGroupName(
  groups: readonly TagGroup[],
  groupId: string,
): string {
  if (!groupId) return "";
  return groups.find((g) => g.id === groupId)?.name ?? "";
}
