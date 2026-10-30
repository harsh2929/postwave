/**
 * lib/commerceRecovery.ts — the "who are we still waiting to tell" half of the
 * commerce surface.
 *
 * `lib/commerceRollup` answers "is the pipeline flowing" and
 * `lib/commerceOrders` answers "what came through it". Neither can answer the
 * third question the desktop's RecoveryTab exists for: a shopper asked to be
 * told when something came back in stock, the stock arrived, and nobody has
 * been told yet. That is a queue with a clock on it, and a queue with a clock
 * on it belongs on a phone.
 *
 * THE WIRE, read from Go and from the migration rather than from a doc:
 *
 *   GET /api/v1/commerce/integrations/{id}/cart-recovery-links
 *   GET /api/v1/commerce/integrations/{id}/back-in-stock-subscriptions
 *   GET /api/v1/commerce/integrations/{id}/price-drop-watchers
 *       all three mounted behind apikeys.RequireScope(ScopeReadReports)
 *       (commerce/handlers.go:151,153,155). ScopeReadReports IS in
 *       `readOnlyScopes` (apikeys/middleware.go:331-336), so a session of ANY
 *       role may read them — unlike GET /commerce/integrations itself, which
 *       is ScopeAdmin. The CommerceScreen already handles that asymmetry.
 *
 *   Every one of the three returns `{items: [...], next_cursor?: string}` —
 *   `CartRecoveryLinksPage` / `BackInStockSubscriptionsPage` /
 *   `PriceDropWatchersPage`, commerce/types.go:657-670 — via
 *   `listCommerceStatusResource` (handlers.go:2164), which pages with
 *   `ReadParamsWithDefault(q, 50, 200)`.
 *
 * THE STATUS VOCABULARIES ARE CLOSED, AND THEY ARE THREE DIFFERENT LISTS.
 * Read from the CHECK constraints in
 * infra/migrations/0199_klaviyo_commerce_lifecycle_foundation.sql:
 *
 *   cart recovery links     active | converted | expired | disabled       (:340)
 *   back-in-stock subs      waiting | eligible | notified | expired
 *                           | cancelled                                   (:378)
 *   price-drop watchers     watching | eligible | notified | expired
 *                           | cancelled                                   (:438)
 *
 * Three vocabularies with two different words for "nothing has happened yet"
 * (`active`/`waiting`/`watching`) is exactly the kind of detail that makes a
 * three-list screen unreadable. They are mapped onto ONE display class here,
 * and the server's word is still carried verbatim on the row so an unexpected
 * value is shown rather than coerced.
 *
 * THE HEADLINE IS `eligible`, NOT the row count. `eligible` means the server
 * decided the condition was met — the stock arrived, the price dropped — and
 * has not recorded a notification. A backlog of eligible rows is a promise
 * made to a shopper and not yet kept, and it is the only number on this
 * surface that is genuinely urgent. `awaitingNotice` is that number.
 *
 * A PAGE IS A SAMPLE, NOT A TOTAL — same rule as `lib/commerceOrders`. The
 * phone reads one page, so every count derived here is a count OVER THAT PAGE
 * and `RecoveryPage.sampled`/`hasMore` exist so the caller cannot forget to
 * say so.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */

/** Which of the three lists a row came from. */
export type RecoveryKind = "carts" | "back-in-stock" | "price-drops";

/**
 * The three vocabularies collapsed onto one display class.
 *
 * `other` is the escape hatch: a status the server invented after this file
 * was written is shown verbatim rather than silently bucketed.
 */
export type RecoveryStatusClass =
  | "open"
  | "eligible"
  | "notified"
  | "converted"
  | "closed"
  | "other";

export interface RecoveryLine {
  id: string;
  kind: RecoveryKind;
  /** The shopper the row is about; "" when the row carries no email. */
  subject: string;
  /** Verbatim server status — never remapped for display. */
  status: string;
  statusClass: RecoveryStatusClass;
  /** The thing being watched: a cart reference or a product id tail. */
  reference: string;
  /** ISO of when the row started (created_at / requested_at / watched_at). */
  startedAt: string;
  /** ISO of when the server judged it eligible; "" when it never did. */
  eligibleAt: string;
  /** ISO of the notification; "" when nobody has been told. */
  notifiedAt: string;
  /** price-drops only: integer cents, or null when the row is not a watcher. */
  originalPriceCents: number | null;
  targetPriceCents: number | null;
  minDropPercent: number | null;
  /** price-drops only; "" elsewhere. */
  currency: string;
}

export interface RecoveryPage {
  items: RecoveryLine[];
  /** How many rows this page actually held — the denominator of any count. */
  sampled: number;
  /** True when the server said there is another page behind this one. */
  hasMore: boolean;
}

/** Rows whose condition fired and who have NOT been told. */
export function awaitingNotice(rows: readonly RecoveryLine[]): number {
  return rows.reduce(
    (total, row) => (row.statusClass === "eligible" ? total + 1 : total),
    0,
  );
}

/**
 * How long the oldest un-notified eligible row has been waiting, in ms.
 *
 * Returns null when there is nothing eligible OR when no eligible row carried
 * an `eligible_at` — a missing measurement is not a zero-length wait.
 */
export function longestWaitMs(
  rows: readonly RecoveryLine[],
  now: number,
): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    if (row.statusClass !== "eligible" || !row.eligibleAt) continue;
    const at = Date.parse(row.eligibleAt);
    if (Number.isNaN(at)) continue;
    if (oldest === null || at < oldest) oldest = at;
  }
  if (oldest === null) return null;
  return Math.max(0, now - oldest);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function isoOf(value: unknown): string {
  const raw = str(value);
  if (!raw) return "";
  return Number.isNaN(Date.parse(raw)) ? "" : raw;
}

/**
 * The tail of an opaque id, which is the only part a human recognises.
 *
 * Product ids on this surface are uuids — the server joins no product title
 * onto these three lists — so the honest thing is a short, stable handle plus
 * the row's own subject, NOT an invented product name.
 */
export function shortRef(value: string): string {
  const raw = value.trim();
  if (raw.length <= 12) return raw;
  const tail = raw.slice(-8);
  return `…${tail}`;
}

function classify(kind: RecoveryKind, status: string): RecoveryStatusClass {
  const s = status.toLowerCase();
  if (kind === "carts") {
    if (s === "active") return "open";
    if (s === "converted") return "converted";
    if (s === "expired" || s === "disabled") return "closed";
    return "other";
  }
  // back-in-stock and price-drops share four of five words; only the initial
  // state differs (`waiting` vs `watching`).
  if (s === "waiting" || s === "watching") return "open";
  if (s === "eligible") return "eligible";
  if (s === "notified") return "notified";
  if (s === "expired" || s === "cancelled") return "closed";
  return "other";
}

function itemsOf(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object") return [];
  const items = (payload as { items?: unknown }).items;
  return Array.isArray(items) ? items : [];
}

function nextCursorOf(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  return str((payload as { next_cursor?: unknown }).next_cursor);
}

function lineOf(kind: RecoveryKind, raw: unknown): RecoveryLine | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = str(row.id);
  if (!id) return null;
  const status = str(row.status);
  const line: RecoveryLine = {
    id,
    kind,
    subject:
      kind === "carts" ? str(row.customer_email) : str(row.subscriber_email),
    status,
    statusClass: classify(kind, status),
    reference:
      kind === "carts"
        ? shortRef(str(row.source_cart_id))
        : shortRef(str(row.variant_id) || str(row.product_id)),
    startedAt: isoOf(
      kind === "carts"
        ? row.created_at
        : kind === "back-in-stock"
          ? row.requested_at
          : row.watched_at,
    ),
    eligibleAt: isoOf(row.eligible_at),
    notifiedAt: isoOf(row.notified_at),
    originalPriceCents:
      kind === "price-drops" ? intOrNull(row.original_price_cents) : null,
    targetPriceCents:
      kind === "price-drops" ? intOrNull(row.target_price_cents) : null,
    minDropPercent:
      kind === "price-drops" ? intOrNull(row.min_drop_percent) : null,
    currency: kind === "price-drops" ? str(row.currency).toUpperCase() : "",
  };
  return line;
}

/**
 * Parse one of the three list responses.
 *
 * Rows without an id are DROPPED rather than rendered with a synthetic key:
 * a row this client cannot identify is a row it cannot be trusted to
 * de-duplicate across a refetch.
 */
export function normalizeRecoveryPage(
  kind: RecoveryKind,
  payload: unknown,
): RecoveryPage {
  const items: RecoveryLine[] = [];
  for (const raw of itemsOf(payload)) {
    const line = lineOf(kind, raw);
    if (line) items.push(line);
  }
  return {
    items,
    sampled: items.length,
    hasMore: nextCursorOf(payload) !== "",
  };
}

/**
 * The single sentence a section header carries.
 *
 * Never says "0 waiting to be told" when the list simply has no rows: an
 * empty queue and a queue of rows that are all already notified are different
 * facts, and only the second one is worth the words.
 */
export function recoverySummary(page: RecoveryPage): string {
  if (page.sampled === 0) return "";
  const waiting = awaitingNotice(page.items);
  const scope = page.hasMore
    ? `the newest ${page.sampled}`
    : `${page.sampled === 1 ? "the only row" : `all ${page.sampled} rows`}`;
  if (waiting === 0) {
    return `Nothing is waiting to be told, across ${scope}.`;
  }
  return `${waiting} of ${scope} ${waiting === 1 ? "is" : "are"} waiting to be told.`;
}
