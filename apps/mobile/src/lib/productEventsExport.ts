/**
 * productEventsExport — "send me the event feed", from a phone.
 *
 * The Track screen answers "is the integration sending?" and stops there; the
 * API already streams the raw feed as CSV
 * (`GET /api/v1/track/events.csv`, apps/api/internal/track/extras.go:717,
 * mounted at handlers.go:97 behind read:reports + read:subscribers — viewer on
 * the session path). Desktop hands that URL to a file download
 * (apps/desktop/src/pages/Track.tsx:1954, with the same event_name /
 * subscriber_id / occurred_after / limit parameters). A phone has no file to
 * download to, so the text goes to the share sheet — which is exactly why the
 * three rules below are not optional here.
 *
 *  - RE-EMITTED, NOT FORWARDED. The server does neutralise formula leads
 *    (`writeSpreadsheetSafeCSVRecord`, extras.go:844) — this is one of the few
 *    endpoints that does. Every field still goes back out through `csvField`,
 *    because this module cannot see which endpoint version answered and a
 *    guard that depends on the server being new is not a guard. Double
 *    escaping is impossible: a cell the server already prefixed with `'` no
 *    longer starts with a formula character.
 *  - CAPPED, AND THE CAP IS STATED. The server's own ceiling is 10,000 rows
 *    (`productEventCSVHardCap`); a share sheet is not a file, so the phone
 *    asks for far fewer and says so. Rows come back `ORDER BY id DESC`, so a
 *    capped export is the NEWEST events, which is the useful half.
 *  - PROPERTIES ARE DELIBERATELY DROPPED. The server's last column is
 *    `properties_json` — unbounded, attacker-shaped, and the most PII-dense
 *    field in the row. Truncating JSON would produce cells that are no longer
 *    JSON, so the column is omitted entirely and the copy says where the full
 *    payload still lives. (`formSubmissionsExport` drops
 *    `custom_fields_json` for the same two reasons.)
 *
 * Import-free apart from `csvShare` (itself import-free) — node-testable.
 */
import { csvField, parseCsvRows } from "@/lib/csvShare";

/**
 * Rows requested, and rows kept. One number: asking for more than the share
 * sheet can carry would make the truncation notice a guess.
 */
export const PRODUCT_EVENT_EXPORT_MAX_ROWS = 500;

/** The server's ceiling, for the comment that says the web export goes wider. */
export const PRODUCT_EVENT_EXPORT_SERVER_CAP = 10_000;

/**
 * The columns kept, in the server's own order
 * (id, occurred_at, received_at, subscriber_id, event_name, properties_json).
 */
const COLUMNS = [
  "id",
  "occurred_at",
  "received_at",
  "subscriber_id",
  "event_name",
] as const;

/**
 * The request path for the window on screen.
 *
 * `occurred_after` mirrors desktop, which sends the start of the range it is
 * showing. It is computed from the DEVICE clock against a server-side column,
 * so a badly-skewed phone shifts the boundary — acceptable for a feed export
 * (the rows carry their own timestamps and the title names the window), and
 * the alternative is an export whose scope silently differs from the screen's.
 */
export function productEventsExportPath(input: {
  days: number;
  eventName?: string | undefined;
  limit?: number | undefined;
  now?: Date | undefined;
}): string {
  const days = Math.max(1, Math.trunc(input.days) || 0);
  const limit = Math.max(
    1,
    Math.min(
      PRODUCT_EVENT_EXPORT_MAX_ROWS,
      Math.trunc(input.limit ?? PRODUCT_EVENT_EXPORT_MAX_ROWS) || 0,
    ),
  );
  const now = input.now ?? new Date();
  const after = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const params = [
    `occurred_after=${encodeURIComponent(after.toISOString())}`,
    `limit=${limit}`,
  ];
  const eventName = (input.eventName ?? "").trim();
  if (eventName) {
    params.unshift(`event_name=${encodeURIComponent(eventName)}`);
  }
  return `/api/v1/track/events.csv?${params.join("&")}`;
}

export interface ProductEventsExport {
  /** The text to hand to the share sheet. */
  body: string;
  /** Share-sheet subject line. */
  title: string;
  /** Data rows (header excluded) that made it in. */
  included: number;
  /** True when rows were dropped — the caller must say so out loud. */
  truncated: boolean;
}

function isHeaderRow(row: readonly string[]): boolean {
  return row.length > 0 && row[0]?.trim().toLowerCase() === "id";
}

/**
 * Which position each kept column sits at, READ FROM THE HEADER the server
 * sent rather than assumed.
 *
 * Positional slicing is what makes the dropped-payload promise breakable: the
 * day `properties_json` moves ahead of `event_name` in the SELECT, a
 * position-5 copy starts shipping the PII-dense payload under a column called
 * `event_name` — silently, to whoever the share sheet was pointed at. Reading
 * the header costs nothing and turns that into a blank cell instead of a leak.
 *
 * A column the header does not name resolves to -1 and is emitted EMPTY: a
 * blank cell under a correct label is visible to the reader, and guessing at
 * its old position is how the wrong data ends up under the right name.
 *
 * Returns null when there is no header (then, and only then, position is all
 * there is).
 */
function columnPositions(
  header: readonly string[] | undefined,
): number[] | null {
  if (!Array.isArray(header) || !isHeaderRow(header)) return null;
  const byName = new Map<string, number>();
  header.forEach((cell, index) => {
    const name = typeof cell === "string" ? cell.trim().toLowerCase() : "";
    // First occurrence wins: a duplicated name must not silently re-point a
    // column at the later copy.
    if (name && !byName.has(name)) byName.set(name, index);
  });
  return COLUMNS.map((column) => byName.get(column) ?? -1);
}

/** Bound and re-emit the server's stream. */
export function productEventsCsv(
  raw: string,
  {
    days,
    eventName = "",
    cap = PRODUCT_EVENT_EXPORT_MAX_ROWS,
  }: { days: number; eventName?: string; cap?: number },
): ProductEventsExport {
  const parsed = parseCsvRows(raw ?? "").filter(
    (row) => row.length > 1 || (row[0] ?? "").trim() !== "",
  );
  const first = parsed[0];
  const positions = columnPositions(first);
  const data = positions === null ? parsed : parsed.slice(1);
  const limit = Math.max(0, Math.trunc(cap));
  const kept = data.slice(0, limit);
  // At-the-cap is treated as truncated for the same reason the suppression
  // export does: a response that exactly fills the requested limit cannot
  // prove the server had nothing more, and "Product events (500)" would
  // present a slice of a busy feed as the whole of it.
  const truncated = data.length > kept.length || (limit > 0 && data.length >= limit);

  const lines: string[] = [COLUMNS.join(",")];
  for (const row of kept) {
    lines.push(
      COLUMNS.map((_, column) => {
        const at = positions === null ? column : positions[column];
        return csvField(at === undefined || at < 0 ? "" : row[at]);
      }).join(","),
    );
  }

  const scope = eventName.trim() ? `${eventName.trim()} · ` : "";
  const window = `last ${Math.max(1, Math.trunc(days) || 0)} days`;
  return {
    body: lines.join("\n"),
    title: truncated
      ? `Product events — ${scope}newest ${kept.length}, ${window}`
      : `Product events — ${scope}${kept.length} in the ${window}`,
    included: kept.length,
    truncated,
  };
}

/**
 * The sentence shown after a share. It names BOTH deviations from what the
 * reader is looking at: the row cap, and the dropped payload column.
 */
export function productEventsExportNotice(result: ProductEventsExport): string {
  if (result.included === 0) {
    return "No events in this window — there was nothing to export.";
  }
  const payload = " Event properties aren't included; the web export has them.";
  return result.truncated
    ? `Shared the newest ${result.included} events — the rest need the web export.${payload}`
    : `Shared ${result.included} event${result.included === 1 ? "" : "s"}.${payload}`;
}
