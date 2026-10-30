// SPDX-License-Identifier: AGPL-3.0-only
//
// Brand-color hex validation + normalisation for the Workspace settings color
// field (SETC-025). Keeps the bare text input, a live swatch, and a native
// <input type="color"> in sync, and blocks an invalid hex before save.

/** True for an exact 6-digit hex, with or without a leading `#`. */
export function isValidHexColor(value: string): boolean {
  return /^#?[0-9a-fA-F]{6}$/.test(value.trim());
}

/**
 * Canonicalises a hex string to `#rrggbb` (lowercase) — the shape
 * `<input type="color">` requires. Accepts 3- or 6-digit input, with or
 * without `#`. Returns null when the value can't be a hex color, so callers
 * can show an inline error and refuse to save.
 */
export function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
    return `#${trimmed.toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [r, g, b] = trimmed.toLowerCase().split("");
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return null;
}
