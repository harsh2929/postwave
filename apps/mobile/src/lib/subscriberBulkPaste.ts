/**
 * subscriberBulkPaste — "add the handful of addresses I collected at the
 * event", pasted once instead of typed five times.
 *
 * Desktop's SubscriberAddModal bulk tab translated. The server
 * (`POST /api/v1/subscribers/bulk-paste`, editor) receives the RAW paste and
 * does its own splitting; this module mirrors that split (bulk_paste.go
 * parseBulkPasteEmails: newline/comma/semicolon/tab/space, case-insensitive
 * de-dupe, first occurrence wins) purely so the sheet can show an honest
 * count and refuse an over-cap paste locally instead of round-tripping into
 * a 422.
 *
 * Every pasted contact is created `unconfirmed` — the same non-sendability
 * stance as the single-create path, stated before the button, not after.
 *
 * Import-free so every rule runs in the node vitest suite.
 */

/** Mirrors bulk_paste.go MaxBulkPasteEmails. Larger lists are the CSV path. */
export const MAX_BULK_PASTE = 100;

/** The server's split, mirrored: see module doc for why. */
export function parsePastedEmails(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const field of raw.split(/[\n\r,;\t ]+/)) {
    const trimmed = field.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Why the paste cannot be submitted RIGHT NOW, or null when it can. The
 * sentences match desktop's refusals in intent; the offline clause exists
 * because a hundred-contact create is deliberately not queued — the per-row
 * receipt (created/updated/failed) is the point of the verb, and an outbox
 * replay has no one to show it to.
 */
export function bulkPasteProblem(raw: string, online: boolean): string | null {
  if (!online) {
    return "You're offline. Pasted contacts need a connection so you can see which addresses were accepted.";
  }
  const count = parsePastedEmails(raw).length;
  if (count === 0) {
    return "Paste at least one address (one per line or comma-separated).";
  }
  if (count > MAX_BULK_PASTE) {
    return `That's ${count} addresses — the paste box is capped at ${MAX_BULK_PASTE}. Use the web admin's CSV import for larger lists.`;
  }
  return null;
}

export interface BulkPasteRow {
  email: string;
  /** "created" | "updated" | "skipped" | "error" */
  status: string;
  error: string;
}

export interface BulkPasteResult {
  parsed: number;
  created: number;
  updated: number;
  skipped: number;
  errored: number;
  rows: BulkPasteRow[];
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** The BulkPasteResponse body, defensively. Junk becomes an empty result. */
export function parseBulkPasteResult(payload: unknown): BulkPasteResult {
  const rec =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const rows = Array.isArray(rec.rows)
    ? rec.rows.flatMap((row): BulkPasteRow[] => {
        if (!row || typeof row !== "object") return [];
        const r = row as Record<string, unknown>;
        const email = typeof r.email === "string" ? r.email : "";
        if (!email) return [];
        return [
          {
            email,
            status: typeof r.status === "string" ? r.status : "",
            error: typeof r.error === "string" ? r.error : "",
          },
        ];
      })
    : [];
  return {
    parsed: num(rec.parsed),
    created: num(rec.created),
    updated: num(rec.updated),
    skipped: num(rec.skipped),
    errored: num(rec.errored),
    rows,
  };
}

/** The rows worth showing after a submit: the failures, oldest first. */
export function bulkPasteFailedRows(result: BulkPasteResult): BulkPasteRow[] {
  return result.rows.filter((row) => row.status === "error");
}

/**
 * The one-sentence receipt. Every non-zero counter is named — "8 added"
 * silently swallowing 2 failures is how a paste loses people.
 */
export function bulkPasteReceipt(result: BulkPasteResult): string {
  const parts = [
    result.created ? `${result.created} added` : "",
    result.updated ? `${result.updated} already existed and were updated` : "",
    result.skipped ? `${result.skipped} skipped` : "",
    result.errored ? `${result.errored} failed` : "",
  ].filter(Boolean);
  const summary = parts.length > 0 ? parts.join(", ") : "Nothing was added";
  return `${summary} — of ${result.parsed} pasted address${result.parsed === 1 ? "" : "es"}.`;
}
