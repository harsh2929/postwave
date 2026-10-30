// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Parses the list id path segment. Kept in its own module (re-exported by
 * lists-api) so routes can validate the segment synchronously on first render
 * without pulling the whole lists API onto their eager bundle.
 */
export function parseListId(raw: string | undefined): number | null {
  if (!raw || !/^[1-9][0-9]*$/u.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}
