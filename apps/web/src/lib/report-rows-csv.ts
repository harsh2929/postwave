// SPDX-License-Identifier: AGPL-3.0-only
//
// CSV of report-builder preview rows (parity with desktop
// components/analytics/report-builder-helpers.ts rowsToCsv + deriveColumns).
//
// Built in the browser from rows already on screen, so it goes through the
// shared guarded `toCsv` (RFC-4180 quoting + the spreadsheet formula guard the
// Go exports apply) — never a hand-joined row.

import { toCsv } from "@/lib/analytics-format";

/** Column order: the columns the table shows, then any extra keys seen. */
export function reportCsvColumns(
  columns: readonly string[] | null | undefined,
  rows: ReadonlyArray<Record<string, unknown>> | null | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (key: unknown) => {
    if (typeof key !== "string" || !key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };
  for (const column of Array.isArray(columns) ? columns : []) push(column);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && typeof row === "object") Object.keys(row).forEach(push);
  }
  return out;
}

/**
 * Raw cell value for a spreadsheet. Unlike the on-screen cell, a missing value
 * is an EMPTY cell (not "—"), so a numeric column stays numeric when opened.
 */
export function reportCsvCellValue(value: unknown): string | number {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Header row + one record per row, CRLF-terminated. */
export function reportRowsToCsv(
  columns: readonly string[] | null | undefined,
  rows: ReadonlyArray<Record<string, unknown>> | null | undefined,
): string {
  const safeRows = Array.isArray(rows) ? rows : [];
  const cols = reportCsvColumns(columns, safeRows);
  if (cols.length === 0) return "";
  const records: Array<Array<string | number>> = [cols];
  for (const row of safeRows) {
    const safe = row && typeof row === "object" ? row : {};
    records.push(cols.map((column) => reportCsvCellValue(safe[column])));
  }
  return `${toCsv(records)}\r\n`;
}

/** "Weekly engagement" → "weekly-engagement-preview-2026-09-12.csv". */
export function reportCsvFilename(
  name: string | null | undefined,
  today: Date = new Date(),
): string {
  const base =
    (name ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "report";
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  return `${base}-preview-${y}-${m}-${d}.csv`;
}
