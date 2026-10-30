/**
 * lib/dateWheel.ts — the option lists behind the schedule sheet's wheels.
 *
 * Three defects lived in the inline versions, and all three were the same
 * mistake: the wheel described a range instead of describing the VALUE.
 *
 *  1. The date column was a fixed 31 entries from today. A campaign already
 *     scheduled 45 days out could not be represented, so merely OPENING the
 *     sheet snapped it into the window — and Save then wrote the snapped date.
 *     The list now always contains the selected day, wherever it is, including
 *     in the past (a campaign scheduled before now must still render as what
 *     it is, not silently become tomorrow).
 *  2. The minute column was 0/5/…/55 and the selection was ROUNDED onto that
 *     grid. A campaign set to 09:07 on desktop reopened as 09:05, and saving
 *     moved the send. The grid stays — it is what makes the column tappable —
 *     but the exact minute is inserted when it is off-grid, so the value
 *     survives a round trip.
 *  3. Nothing scrolled to the selection, which is a rendering concern; the
 *     INDEX it needs is computed here so it can be tested.
 *
 * Import-free by construction so it stays testable in the node environment.
 */

/** How far ahead the date column reaches by default. Six months. */
export const DATE_WHEEL_DAYS = 180;

/** The tappable minute grid. */
export const MINUTE_STEP = 5;

export function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/**
 * The date column: `days` entries from `today`, plus the selected day if it
 * falls outside that range, in chronological order.
 */
export function wheelDateOptions(
  today: Date,
  selected: Date,
  days = DATE_WHEEL_DAYS,
): Date[] {
  const base = startOfDay(today);
  const span = Math.max(1, Math.trunc(days));
  const out: Date[] = [];
  for (let i = 0; i < span; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    out.push(d);
  }
  const pick = startOfDay(selected);
  if (!Number.isFinite(pick.getTime())) return out;
  const pickKey = pick.getTime();
  if (out.some((d) => d.getTime() === pickKey)) return out;
  // Outside the window: keep chronological order so the wheel still reads as
  // a timeline rather than putting a stray date at one end.
  if (pickKey < (out[0]?.getTime() ?? pickKey)) return [pick, ...out];
  return [...out, pick];
}

/**
 * The minute column: the 5-minute grid, plus the selected minute when it is
 * off-grid, in ascending order.
 */
export function wheelMinuteOptions(selectedMinute: number): number[] {
  const grid: number[] = [];
  for (let m = 0; m < 60; m += MINUTE_STEP) grid.push(m);
  const minute = Math.trunc(selectedMinute);
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return grid;
  if (grid.includes(minute)) return grid;
  return [...grid, minute].sort((a, b) => a - b);
}

/**
 * Where to scroll so the selected row is CENTRED in a viewport of
 * `viewportHeight`, clamped to the scrollable range.
 *
 * Returns 0 for a selection at the top and for any non-finite input, so a
 * first frame that has not measured its rows yet cannot scroll to NaN — which
 * RN silently turns into a blank column.
 */
export function wheelScrollOffset(
  selectedIndex: number,
  rowHeight: number,
  viewportHeight: number,
  itemCount: number,
): number {
  if (
    !Number.isFinite(selectedIndex) ||
    !Number.isFinite(rowHeight) ||
    rowHeight <= 0 ||
    selectedIndex <= 0
  ) {
    return 0;
  }
  const contentHeight = Math.max(0, itemCount) * rowHeight;
  const centred = selectedIndex * rowHeight - (viewportHeight - rowHeight) / 2;
  const maxOffset = Math.max(0, contentHeight - viewportHeight);
  return Math.max(0, Math.min(maxOffset, Math.round(centred)));
}

/**
 * The wheel's own height at a given OS text scale.
 *
 * The container was a hard `height: 200`, so at accessibility text sizes the
 * rows grew and the wheel simply clipped them. Growing the container with the
 * text — up to a ceiling, because a picker taller than the sheet is its own
 * failure — is the honest answer. Non-numeric input means "assume the default
 * size", matching the fail-safe in lib/textScale.
 */
export const DATE_WHEEL_BASE_HEIGHT = 200;
export const DATE_WHEEL_MAX_SCALE = 1.6;

export function dateWheelHeight(
  fontScale: unknown,
  base = DATE_WHEEL_BASE_HEIGHT,
): number {
  const scale =
    typeof fontScale === "number" && Number.isFinite(fontScale) && fontScale > 1
      ? Math.min(DATE_WHEEL_MAX_SCALE, fontScale)
      : 1;
  return Math.round(base * scale);
}
