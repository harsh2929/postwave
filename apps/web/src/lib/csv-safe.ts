// SPDX-License-Identifier: AGPL-3.0-only
//
// Spreadsheet-safe CSV cell escaping for CSVs the BROWSER builds and downloads.
//
// The Go API already neutralises formula injection on every server-generated
// export (apps/api/internal/track/extras.go `spreadsheetSafeCSVCell`), and the
// marketing site publishes that behaviour as a product guarantee:
//
//   "CSV cells starting with =, +, -, or @ are prefixed with a quote to
//    neutralise spreadsheet formula injection on open."
//
// Client-side exports (affiliate conversions/payouts, analytics overview,
// campaign custom reports, migration verification) are assembled in the browser
// and never pass through that Go path, so they did not uphold the guarantee.
// This module ports the server's exact semantics so both surfaces agree.

const FORMULA_LEAD = new Set(["=", "+", "-", "@"]);
// Cc = control, Cf = format (BOM, zero-width, bidi marks). A leading rune from
// either class can hide a formula marker from a human reviewer.
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
// Go's unicode.IsSpace is the Unicode White_Space property.
const WHITE_SPACE = /\p{White_Space}/u;

/**
 * Prefix a literal apostrophe when the first meaningful rune could start a
 * formula. Spreadsheets then treat the cell as text; machine consumers recover
 * the source value by dropping that single prefix.
 *
 * Mirrors Go's `spreadsheetSafeCSVCell`, including the rune ordering: control
 * and format runes are tested BEFORE whitespace, because a tab is both, and
 * skipping it as whitespace would let "\t=cmd" through.
 */
export function spreadsheetSafeCell(value: string): string {
  // for..of iterates code points, matching Go's `for range` over runes.
  for (const rune of value) {
    if (FORMULA_LEAD.has(rune)) return `'${value}`;
    if (CONTROL_OR_FORMAT.test(rune)) return `'${value}`;
    if (WHITE_SPACE.test(rune)) continue;
    return value;
  }
  // All-whitespace (or empty) carries no formula.
  return value;
}

/**
 * RFC-4180 cell with the formula guard applied FIRST, so the apostrophe lands
 * inside the quoted field rather than outside it.
 */
export function safeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const guarded = spreadsheetSafeCell(
    typeof value === "number" ? String(value) : value,
  );
  return /[",\n\r]/.test(guarded)
    ? `"${guarded.replace(/"/g, '""')}"`
    : guarded;
}
