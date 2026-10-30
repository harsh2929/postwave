/**
 * subscriberCustomObjects — the non-person records attached to one profile
 * (SUB-011 profile↔object links) plus the two catalog computed-traits, on
 * the phone's read-only Data cluster.
 *
 * Desktop shows these as the detail's customObjects tab + the
 * CatalogAttributesPanel; mobile renders both under one card because each is
 * a short list of "what the workspace knows links to this person".
 *
 * WIRE NOTE: the custom-objects service speaks camelCase JSON
 * (ProfileObjectLink in customobjects/types.go), unlike the snake_case
 * subscriber routes — parsed here so no component ever guesses.
 *
 * Import-free so every rule runs in the node vitest suite.
 */

export interface ProfileLinkRow {
  id: string;
  /** "Product", "Warranty" … — the denormalized type label, or the key. */
  typeLabel: string;
  /** The linked record's external id, or its record id when absent. */
  recordLabel: string;
  /** Free-text link relationship ("purchased", "owns", default "related"). */
  relationship: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The GET /subscribers/{id}/custom-objects {items} body, defensively. */
export function parseProfileLinks(payload: unknown): ProfileLinkRow[] {
  const rec =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  if (!Array.isArray(rec.items)) return [];
  return rec.items.flatMap((row): ProfileLinkRow[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const id = str(r.id);
    if (!id) return [];
    return [
      {
        id,
        typeLabel: str(r.objectTypeLabel) || str(r.objectTypeKey) || "Record",
        recordLabel: str(r.externalId) || str(r.objectRecordId),
        relationship: str(r.relationship) || "related",
      },
    ];
  });
}

export interface CatalogAttributeRow {
  label: string;
  value: string;
}

/**
 * The GET /subscribers/{id}/catalog-attributes body → display rows. A trait
 * never computed renders as NOTHING (absence, not "unknown") — the same
 * honesty rule as the demographics card.
 */
export function parseCatalogAttributes(payload: unknown): CatalogAttributeRow[] {
  const rec =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const rows: CatalogAttributeRow[] = [];
  const fav = rec.favorite_category;
  if (fav && typeof fav === "object") {
    const f = fav as Record<string, unknown>;
    const category = str(f.category);
    if (category) {
      const count =
        typeof f.count === "number" && Number.isFinite(f.count) ? f.count : 0;
      rows.push({
        label: "Favorite category",
        value: count > 0 ? `${category} (${count} views)` : category,
      });
    }
  }
  const sku = str(rec.last_viewed_sku);
  if (sku) rows.push({ label: "Last viewed SKU", value: sku });
  return rows;
}
