// SPDX-License-Identifier: AGPL-3.0-only
//
// Tiny pluralization helpers so count labels read as finished copy ("1 blocker"
// / "2 blockers") instead of the placeholder "(s)" that shipped on the pilot
// tiles (GOV-052). Dependency-free and unit-tested.

/**
 * "1 blocker" / "2 blockers". Pass an irregular plural as the third arg.
 * The count is included in the returned string.
 */
export function pluralize(
  count: number,
  singular: string,
  plural: string = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * The same rule with the count grouped for reading: "1 contact",
 * "1,200 contacts".
 *
 * It exists next to `pluralize` because most people-facing counts in the
 * product are unbounded — contacts, rows, members — and were written as
 * `${n.toLocaleString()} contacts`, which says "1 contacts" for the single
 * item a person is most likely to act on one at a time. Use this wherever a
 * count is shown to a person; `pluralize` stays for the small, bounded counts
 * whose digits never need grouping.
 */
export function pluralizeCount(
  count: number,
  singular: string,
  plural: string = `${singular}s`,
): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/**
 * Compact "N blocker(s), M warning(s)" phrasing with correct pluralization —
 * the standard readiness summary used across the pilot tiles/rows.
 */
export function blockerWarningLabel(blockers: number, warnings: number): string {
  return `${pluralize(blockers, "blocker")}, ${pluralize(warnings, "warning")}`;
}
