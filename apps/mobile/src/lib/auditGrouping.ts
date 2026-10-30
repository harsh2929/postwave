/**
 * lib/auditGrouping.ts — the audit log's time vocabulary.
 *
 * Two jobs, both pure so they can be tested in the node environment (this
 * module deliberately imports nothing from react-native or the query layer):
 *
 *   1. WINDOWS. The server accepts a `since` lower bound, so "last 24 hours"
 *      can be a real server-side narrowing rather than a client-side filter
 *      over whatever happened to be fetched. `auditWindowSince` turns a chip
 *      into the RFC3339 string the query sends.
 *   2. DAY GROUPING. A hundred visually identical cards is a wall, not a
 *      log. Grouping by calendar day gives the eye an anchor ("this all
 *      happened yesterday afternoon") and lets each row drop its redundant
 *      date, showing only the time.
 *
 * Generic over the row type on purpose: the concrete AuditRow lives in
 * hooks/useAudit.ts, which transitively imports the SDK client and therefore
 * cannot be loaded in a node test.
 *
 * It also owns the cluster's FRESHNESS vocabulary (see `freshnessSentence`),
 * for the same reason: "is what I am reading current?" is a time question, and
 * the answer has to be assertable without mounting a screen.
 */
import { calendarDate, relativeTime } from "./format";

export type AuditWindowKey = "24h" | "7d" | "30d" | "all";

export interface AuditWindowOption {
  value: AuditWindowKey;
  label: string;
}

/**
 * Ordered narrowest-first: on a phone the useful default is "what just
 * happened", and the wider windows are a deliberate widening.
 */
export const AUDIT_WINDOWS: readonly AuditWindowOption[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

const WINDOW_MS: Record<Exclude<AuditWindowKey, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * The `since` value to send, or undefined for "all" (the server treats a
 * missing bound as unbounded). Undefined rather than "" so the caller can
 * spread it into an exactOptionalPropertyTypes-safe filter object.
 */
export function auditWindowSince(
  key: AuditWindowKey,
  now: number,
): string | undefined {
  if (key === "all") return undefined;
  const ms = WINDOW_MS[key];
  const from = now - ms;
  if (!Number.isFinite(from)) return undefined;
  return new Date(from).toISOString();
}

/** Prose for the "showing the last N" disclosure line. */
export function auditWindowDescription(key: AuditWindowKey): string {
  switch (key) {
    case "24h":
      return "the last 24 hours";
    case "7d":
      return "the last 7 days";
    case "30d":
      return "the last 30 days";
    default:
      return "all recorded history";
  }
}

/**
 * The OLDEST of a set of TanStack `dataUpdatedAt` stamps, or null when none of
 * them has ever loaded.
 *
 * A screen fed by two queries is only as fresh as its STALEST one. Reporting
 * the newest would let a sink list fetched two hours ago hide behind a DLQ
 * count fetched a second ago — a freshness indicator that overstates freshness
 * is worse than none, because it is trusted.
 *
 * Zero is the "never fetched" value TanStack uses, so it is treated as absent
 * rather than as 1970.
 */
export function oldestUpdatedAt(
  stamps: readonly (number | null | undefined)[],
): number | null {
  let out: number | null = null;
  for (const stamp of stamps) {
    if (typeof stamp !== "number" || !Number.isFinite(stamp) || stamp <= 0) {
      continue;
    }
    if (out === null || stamp < out) out = stamp;
  }
  return out;
}

/**
 * "Sink health as of 3m ago." — the sentence a compliance surface owes the
 * reader, and null when there is nothing loaded to date.
 *
 * `subject` is the noun phrase, so the same helper serves "Sink health",
 * "Approvals" and "Export history" without four near-identical strings.
 */
export function freshnessSentence(
  subject: string,
  updatedAt: number | null | undefined,
  now = Date.now(),
): string | null {
  const stamp = oldestUpdatedAt([updatedAt]);
  if (stamp === null) return null;
  const age = relativeTime(stamp, { now, fallback: "" });
  return age ? `${subject} as of ${age}.` : null;
}

export type AuditListItem<T> =
  | { kind: "day"; key: string; label: string; count: number }
  | { kind: "row"; key: string; row: T };

/** Local-calendar day key, e.g. "2026-07-25". Null for an unparseable stamp. */
function dayKey(at: string): string | null {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * "Today" / "Yesterday" / an absolute date. Relative labels only reach back
 * two days on purpose: "5 days ago" is harder to reason about during an
 * incident than the actual date.
 */
export function auditDayLabel(key: string, now: number): string {
  const today = dayKey(new Date(now).toISOString());
  if (key === today) return "Today";
  const yesterday = dayKey(new Date(now - 24 * 60 * 60 * 1000).toISOString());
  if (key === yesterday) return "Yesterday";
  const [y, m, d] = key.split("-").map((part) => Number(part));
  if (!y || !m || !d) return key;
  const asDate = new Date(y, m - 1, d);
  return Number.isNaN(asDate.getTime())
    ? key
    : calendarDate(asDate, { weekday: "short" });
}

/**
 * Flatten rows into `[day header, ...rows, day header, ...rows]` for a
 * FlatList. Rows are assumed to arrive newest-first (the server orders by
 * id DESC) and are NOT re-sorted — reordering would fight the cursor paging
 * and make "load more" append rows above the fold.
 *
 * Rows with an unparseable timestamp are grouped under their own bucket
 * rather than dropped: an event with a broken `at` is exactly the kind of
 * thing an auditor must still be able to see.
 */
export function groupAuditRowsByDay<T extends { at: string }>(
  rows: readonly T[],
  now: number,
  keyOf: (row: T, index: number) => string,
): AuditListItem<T>[] {
  const out: AuditListItem<T>[] = [];
  let currentKey: string | null = null;
  let headerIndex = -1;
  rows.forEach((row, index) => {
    const key = dayKey(row.at ?? "") ?? "unknown";
    if (key !== currentKey) {
      currentKey = key;
      headerIndex = out.length;
      out.push({
        kind: "day",
        key: `day-${key}-${index}`,
        label: key === "unknown" ? "Undated" : auditDayLabel(key, now),
        count: 0,
      });
    }
    const header = out[headerIndex];
    if (header && header.kind === "day") header.count += 1;
    out.push({ kind: "row", key: keyOf(row, index), row });
  });
  return out;
}
