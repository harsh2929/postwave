// Pure helpers extracted from the four audit view-mode components
// (AuditHeatmap, AuditTimeline, AuditCalendar). Lifted into a sibling
// .ts file so vitest (which runs in `node` env without JSX support)
// can import + test them without pulling JSX through the parser.
//
// audit-2026 session-replay-deeplink (UX, P1).

import type { AuditRow } from "../../lib/api-client";
import { classifyAction, type AuditSeverity } from "./AuditSeverity";

/* ---------- Heatmap ------------------------------------------------- */

export function computeHeatmapData(
  rows: AuditRow[],
): { values: number[][]; vMax: number; total: number } {
  const values: number[][] = Array.from({ length: 7 }, () =>
    new Array<number>(24).fill(0),
  );
  let vMax = 0;
  let total = 0;
  for (const r of rows) {
    const d = new Date(r.at);
    if (Number.isNaN(d.getTime())) continue;
    const dow = d.getUTCDay();
    const hour = d.getUTCHours();
    values[dow][hour] += 1;
    total += 1;
    if (values[dow][hour] > vMax) vMax = values[dow][hour];
  }
  return { values, vMax, total };
}

/* ---------- Timeline ------------------------------------------------ */

export interface TimelineEvent {
  row: AuditRow;
  pos: number;
  severity: AuditSeverity;
}

export function projectTimeline(rows: AuditRow[]): {
  minMs: number;
  maxMs: number;
  events: TimelineEvent[];
} {
  if (rows.length === 0) {
    const now = Date.now();
    return { minMs: now - 3_600_000, maxMs: now, events: [] };
  }
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  const parsed: { row: AuditRow; ms: number }[] = [];
  for (const r of rows) {
    const ms = new Date(r.at).getTime();
    if (Number.isNaN(ms)) continue;
    parsed.push({ row: r, ms });
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  }
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) {
    const now = Date.now();
    return { minMs: now - 3_600_000, maxMs: now, events: [] };
  }
  const span = Math.max(1, maxMs - minMs);
  const events: TimelineEvent[] = parsed.map(({ row, ms }) => ({
    row,
    pos: (ms - minMs) / span,
    severity: classifyAction(row.action),
  }));
  return { minMs, maxMs, events };
}

/* ---------- Calendar ------------------------------------------------ */

export interface CalendarDay {
  date: string; // YYYY-MM-DD UTC
  inMonth: boolean;
  count: number;
  mix: Record<AuditSeverity, number>;
}

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function buildCalendar(
  rows: AuditRow[],
  anchor: Date,
): { days: CalendarDay[]; monthLabel: string } {
  const monthStart = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1),
  );
  const monthLabel = monthStart.toLocaleString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  const bucket = new Map<string, CalendarDay>();
  for (const r of rows) {
    const d = new Date(r.at);
    if (Number.isNaN(d.getTime())) continue;
    const k = ymd(d);
    let cell = bucket.get(k);
    if (!cell) {
      cell = {
        date: k,
        inMonth: true,
        count: 0,
        mix: { destructive: 0, auth: 0, export: 0, ops: 0 },
      };
      bucket.set(k, cell);
    }
    cell.count += 1;
    cell.mix[classifyAction(r.action)] += 1;
  }

  const days: CalendarDay[] = [];
  const firstDow = monthStart.getUTCDay();
  const start = new Date(monthStart);
  start.setUTCDate(start.getUTCDate() - firstDow);
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const k = ymd(d);
    const existing = bucket.get(k);
    days.push(
      existing
        ? { ...existing, inMonth: d.getUTCMonth() === monthStart.getUTCMonth() }
        : {
            date: k,
            inMonth: d.getUTCMonth() === monthStart.getUTCMonth(),
            count: 0,
            mix: { destructive: 0, auth: 0, export: 0, ops: 0 },
          },
    );
  }
  return { days, monthLabel };
}
