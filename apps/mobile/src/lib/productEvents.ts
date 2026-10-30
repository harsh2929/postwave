/**
 * lib/productEvents.ts — the wire shapes of the product-event (Track) reads,
 * and the ONE place that decides what a malformed payload means.
 *
 * THE SHAPES, read from the Go source rather than from openapi.json:
 *   - `EventCatalogResponse`  apps/api/internal/track/extras.go:204-211
 *   - `CatalogRow`            extras.go:178-187
 *   - `TrackDailyBucket`      extras.go:190-193
 *   - `EventStatsResponse`    extras.go:368-375
 *   - `Event` (raw row)       apps/api/internal/track/repo.go:30-38
 *
 * FOUR SERVER FACTS THAT SHAPE EVERY DECISION ABOVE THIS FILE:
 *
 *  1. THE CATALOG IS WINDOW-SCOPED, AND ABSENCE IS NOT ZERO. The catalog query
 *     is `GROUP BY event_name` over `occurred_at >= cutoff` (extras.go:240-252),
 *     so an event that stopped arriving BEFORE the window is not a row with
 *     count 0 — it is not a row at all. "Which of my events died" therefore
 *     cannot be answered by reading zeroes; it is answered by reading
 *     `lastSeen`, and by widening the window. The UI has to say that out loud,
 *     which is why `catalogNotes` exists in lib/productEventHealth.
 *  2. `firstSeen` / `lastSeen` ARE PERIOD BOUNDS, NOT LIFETIME BOUNDS. They are
 *     MIN/MAX over the same windowed group, and the server says so itself by
 *     shipping `eventBoundsScope: "period"` (extras.go:352). An event first
 *     ingested two years ago reports a `firstSeen` of the window's start.
 *     Labelling that "first seen" without "in this window" is a lie the server
 *     went out of its way to let us avoid.
 *  3. THE ROW COUNT AND THE ROW SPARKLINE USE DIFFERENT WINDOWS. `count` covers
 *     `periodDays` (1-365, default 30); `daily` ALWAYS covers
 *     `dailySeriesPeriodDays`, which is the constant 7 (extras.go:195). Drawing
 *     a 7-day line beside a 90-day number without saying so is the classic
 *     two-windows-one-row mistake.
 *  4. THE ITEM LIST IS CAPPED AT 200 (`LIMIT 200`, extras.go:252) while
 *     `totalDistinctEventNames` is a `COUNT(*) OVER()` computed BEFORE the
 *     limit. `items.length < totalDistinctEventNames` is therefore truncation,
 *     not disagreement, and must be disclosed rather than silently shown.
 *
 * WHY THESE NORMALIZERS THROW. A fetch that succeeded but returned a shape we
 * cannot read is not an empty workspace. Returning `{ items: [] }` for a
 * payload whose `items` is not an array would make the screen state "no
 * product events have ever been received" on the strength of a parser bug.
 * Throwing puts TanStack into `isError`, which `QueryStates` renders as an
 * error rather than as an empty state — house rule 8.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */

/** One day's bucket in a densified daily series. `count` 0 is a measured zero. */
export interface ProductEventDailyBucket {
  /** `YYYY-MM-DD`, always UTC (`trackAggregateTimeZone`, extras.go:197). */
  date: string;
  count: number;
}

export interface ProductEventCatalogRow {
  eventName: string;
  /** Events in `periodDays`. Never 0 — a row only exists if COUNT(*) >= 1. */
  count: number;
  uniqueSubscribers: number;
  /** ISO instant, or "" when the server did not send one. WINDOW-scoped. */
  firstSeen: string;
  /** ISO instant, or "". WINDOW-scoped. The single most important field here. */
  lastSeen: string;
  /** Always `dailySeriesPeriodDays` long (7), oldest-first, densified. */
  daily: ProductEventDailyBucket[];
}

export interface ProductEventCatalog {
  items: ProductEventCatalogRow[];
  /** Distinct names in the window BEFORE the 200-row cap. */
  totalDistinctEventNames: number;
  periodDays: number;
  dailySeriesPeriodDays: number;
  /** "period" when firstSeen/lastSeen are window bounds rather than lifetime. */
  eventBoundsScope: string;
  timeZone: string;
  /** The server's measurement instant. Ages are computed against THIS. */
  asOf: string;
}

export interface ProductEventStats {
  periodDays: number;
  totalEvents: number;
  uniqueSubscribers: number;
  uniqueEventNames: number;
  daily: ProductEventDailyBucket[];
  timeZone: string;
  asOf: string;
}

export interface ProductEventLine {
  id: string;
  eventName: string;
  subscriberId: string;
  occurredAt: string;
  receivedAt: string;
  /** Sorted top-level property names. The values are not rendered — see below. */
  propertyKeys: string[];
  /** Pretty-printed JSON of the row exactly as the server sent it. */
  raw: string;
}

export interface ProductEventSample {
  items: ProductEventLine[];
  /** The `limit` that was asked for, so the caller can disclose truncation. */
  requested: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A count. Absent → 0 is correct HERE and only here: every numeric field on
 * these three payloads is a SQL `COUNT(*)`, so the server always sends one and
 * a zero is a measured zero. Timestamps get the opposite treatment (""), which
 * the formatters turn into an em-dash.
 */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

/** `id` is a Go int64; keep it as text so a large bigserial cannot lose digits. */
function identifier(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return str(value);
}

function dailySeries(value: unknown): ProductEventDailyBucket[] {
  if (!Array.isArray(value)) return [];
  const out: ProductEventDailyBucket[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const date = str(entry["date"]);
    if (!date) continue;
    out.push({ date, count: count(entry["count"]) });
  }
  return out;
}

function catalogRow(value: unknown): ProductEventCatalogRow | null {
  if (!isRecord(value)) return null;
  const eventName = str(value["eventName"]);
  if (!eventName) return null;
  return {
    eventName,
    count: count(value["count"]),
    uniqueSubscribers: count(value["uniqueSubscribers"]),
    firstSeen: str(value["firstSeen"]),
    lastSeen: str(value["lastSeen"]),
    daily: dailySeries(value["daily"]),
  };
}

/**
 * `GET /api/v1/track/catalog?days=N`.
 *
 * Throws when the payload is not an object or `items` is not an array — see
 * the header. `totalDistinctEventNames` is floored at the number of rows we
 * actually received: a server that reported fewer names than it sent rows
 * would otherwise make the truncation note read backwards.
 */
export function normalizeProductEventCatalog(raw: unknown): ProductEventCatalog {
  if (!isRecord(raw) || !Array.isArray(raw["items"])) {
    throw new Error(
      "The event catalogue came back in a shape this app can't read.",
    );
  }
  const items = raw["items"]
    .map(catalogRow)
    .filter((row): row is ProductEventCatalogRow => row !== null);
  return {
    items,
    totalDistinctEventNames: Math.max(
      count(raw["totalDistinctEventNames"]),
      items.length,
    ),
    periodDays: count(raw["periodDays"]),
    dailySeriesPeriodDays: count(raw["dailySeriesPeriodDays"]),
    eventBoundsScope: str(raw["eventBoundsScope"]),
    timeZone: str(raw["timeZone"]),
    asOf: str(raw["asOf"]),
  };
}

/** `GET /api/v1/track/stats?days=N[&event_name=]`. */
export function normalizeProductEventStats(raw: unknown): ProductEventStats {
  if (!isRecord(raw) || !Array.isArray(raw["daily"])) {
    throw new Error(
      "The product-event activity came back in a shape this app can't read.",
    );
  }
  return {
    periodDays: count(raw["periodDays"]),
    totalEvents: count(raw["totalEvents"]),
    uniqueSubscribers: count(raw["uniqueSubscribers"]),
    uniqueEventNames: count(raw["uniqueEventNames"]),
    daily: dailySeries(raw["daily"]),
    timeZone: str(raw["timeZone"]),
    asOf: str(raw["asOf"]),
  };
}

function propertyKeys(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.keys(value).sort();
}

function eventLine(value: unknown): ProductEventLine | null {
  if (!isRecord(value)) return null;
  const id = identifier(value["id"]);
  if (!id) return null;
  return {
    id,
    eventName: str(value["eventName"]),
    subscriberId: str(value["subscriberId"]),
    occurredAt: str(value["occurredAt"]),
    receivedAt: str(value["receivedAt"]),
    propertyKeys: propertyKeys(value["properties"]),
    // The ORIGINAL row, not the normalized one. This string exists to be
    // pasted into a bug report next to whatever the integration claims it
    // sent, so re-serialising our own interpretation of it would defeat it.
    raw: safeJson(value),
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "";
  }
}

/**
 * `GET /api/v1/track/events?event_name=…&limit=N`.
 *
 * `ListEvents` answers `{"items": [...]}` (handlers.go:312) with no cursor and
 * no total, so the ONLY thing the caller can honestly say about the result is
 * "the newest `limit`". `requested` is carried through for exactly that.
 */
export function normalizeProductEventSample(
  raw: unknown,
  requested: number,
): ProductEventSample {
  if (!isRecord(raw) || !Array.isArray(raw["items"])) {
    throw new Error(
      "The recent events came back in a shape this app can't read.",
    );
  }
  return {
    items: raw["items"]
      .map(eventLine)
      .filter((line): line is ProductEventLine => line !== null),
    requested: Math.max(0, Math.trunc(requested)),
  };
}

/**
 * What a row-tap COPIES: exactly what the row SHOWS. The panel withholds
 * property values (they carry whatever the sender put in an event — names,
 * emails, order totals) and the CSV export drops them; copying `raw` handed
 * every withheld value to the clipboard on one tap, which the 2026-09 review
 * recorded. Keys stay, so support can still see the event's shape.
 */
export function shownEventText(line: ProductEventLine): string {
  return JSON.stringify(
    {
      id: line.id,
      event_name: line.eventName,
      subscriber_id: line.subscriberId,
      occurred_at: line.occurredAt,
      received_at: line.receivedAt,
      property_keys: line.propertyKeys,
    },
    null,
    2,
  );
}
