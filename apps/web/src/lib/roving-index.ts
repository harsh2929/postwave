// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Next index for a roving-tabindex widget — a tablist, a menu, a nav rail.
 *
 * Returns null for keys the widget should not intercept, so a caller only
 * calls preventDefault when focus actually moves.
 *
 * Horizontal widgets (a tablist) take ArrowLeft/ArrowRight; vertical ones (a
 * nav rail) take ArrowUp/ArrowDown. Both take Home and End, and both wrap,
 * which is what the ARIA authoring practices specify for tabs.
 *
 * This arithmetic is written out inline in three other places —
 * nextDashboardNavIndex in dashboard-nav-shell, navigateLibraryTabs in the
 * template browser, and navigateComparisonTabs in the design review — each
 * differing only in which two arrow keys it names. They are correct; they are
 * just copies, and the two widgets that lacked the behaviour entirely
 * (marketing InstallTabs, dashboard notifications) are what copies produce.
 */
export function nextRovingIndex(
  key: string,
  index: number,
  total: number,
  orientation: "horizontal" | "vertical" = "horizontal",
): number | null {
  if (total <= 0) return null;
  const [previous, next] =
    orientation === "vertical"
      ? ["ArrowUp", "ArrowDown"]
      : ["ArrowLeft", "ArrowRight"];
  if (key === next) return (index + 1) % total;
  if (key === previous) return (index - 1 + total) % total;
  if (key === "Home") return 0;
  if (key === "End") return total - 1;
  return null;
}
