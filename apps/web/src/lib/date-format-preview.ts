// SPDX-License-Identifier: AGPL-3.0-only
//
// Renders a live example of a chosen date-format token so the Workspace
// date-format picker shows "what today looks like" instead of raw tokens
// like `MMM D, YYYY` (SETC-048).

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Formats `date` using one of the supported workspace date-format tokens.
 * Returns "" for an unknown token or an invalid date so callers can omit the
 * example rather than render "Invalid Date".
 */
export function formatDateWithToken(token: string, date: Date): string {
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const monthIndex = date.getMonth();
  const day = date.getDate();
  switch (token) {
    case "YYYY-MM-DD":
      return `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
    case "MMM D, YYYY":
      return `${MONTHS_SHORT[monthIndex]} ${day}, ${year}`;
    case "D MMM YYYY":
      return `${day} ${MONTHS_SHORT[monthIndex]} ${year}`;
    case "MM/DD/YYYY":
      return `${pad2(monthIndex + 1)}/${pad2(day)}/${year}`;
    default:
      return "";
  }
}
