/**
 * subscriberIdentity — turn the identity fields the API already returns
 * into the two things a phone row needs: a human name and a stable
 * coloured initial.
 *
 * GET /api/v1/subscribers returns first_name / last_name / full_name /
 * display_name on every row (apps/api/internal/subscribers/types.go), and
 * mobile discarded all four at its type boundary, rendering a raw email
 * address as the primary text. Desktop ships an avatar + name by default.
 *
 * Pure and RN-free so it can be unit tested; the view layer lives in
 * src/components/subscriber/Avatar.tsx.
 */

export interface SubscriberIdentityFields {
  email?: string | undefined;
  first_name?: string | null | undefined;
  last_name?: string | null | undefined;
  full_name?: string | null | undefined;
  display_name?: string | null | undefined;
}

function clean(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The best available human name, or "" when the record carries none.
 * Precedence matches desktop's column catalogue: full_name wins, then
 * display_name, then first+last.
 */
export function subscriberName(row: SubscriberIdentityFields): string {
  const full = clean(row.full_name);
  if (full) return full;
  const display = clean(row.display_name);
  if (display) return display;
  const composed = [clean(row.first_name), clean(row.last_name)]
    .filter(Boolean)
    .join(" ");
  return composed;
}

/**
 * What the row's primary line shows: the name when we have one, else the
 * email. Never empty for a record that has an email.
 */
export function subscriberPrimaryLabel(row: SubscriberIdentityFields): string {
  return subscriberName(row) || clean(row.email);
}

/**
 * The muted second line. Empty when the primary line is ALREADY the email
 * — rendering the address twice is noise.
 */
export function subscriberSecondaryLabel(
  row: SubscriberIdentityFields,
): string {
  return subscriberName(row) ? clean(row.email) : "";
}

/**
 * One or two initials for the avatar. Falls back to the first character
 * of the email, then to "?" so the circle is never blank.
 *
 * Uses Array.from so an emoji or an astral-plane character counts as one
 * glyph rather than half a surrogate pair.
 */
export function subscriberInitials(row: SubscriberIdentityFields): string {
  const name = subscriberName(row);
  if (name) {
    const parts = name.split(/\s+/u).filter(Boolean);
    const first = Array.from(parts[0] ?? "")[0] ?? "";
    const last = parts.length > 1 ? (Array.from(parts.at(-1) ?? "")[0] ?? "") : "";
    const initials = `${first}${last}`.trim();
    if (initials) return initials.toUpperCase();
  }
  const email = clean(row.email);
  const firstEmailGlyph = Array.from(email)[0];
  return firstEmailGlyph ? firstEmailGlyph.toUpperCase() : "?";
}

/**
 * A stable hue in [0, 360) derived from the identity. Same person → same
 * colour on every screen and across restarts; different people are spread
 * across the wheel by an FNV-1a hash rather than by string order.
 *
 * Keyed on the email (stable) rather than the display name (editable), so
 * renaming someone doesn't move their colour.
 */
export function subscriberAvatarHue(row: SubscriberIdentityFields): number {
  const seed = (clean(row.email) || subscriberName(row)).toLowerCase();
  if (!seed) return 210;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    // FNV-1a 32-bit prime, applied with >>> 0 to stay in uint32.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}
