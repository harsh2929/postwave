/**
 * lib/widgetCommerceSnapshot.ts — the shape and the rules of the COMMERCE
 * record inside the widget's App Group container.
 *
 * WHY IT IS A SECOND RECORD AND NOT FOUR MORE FIELDS ON THE FIRST.
 * `writeWidgetSnapshot` (lib/widgetData.ts) is written by the Dashboard tab
 * and by the background refresh task. Store totals come from a different
 * endpoint, for one chosen store, read at a different moment — so folding them
 * into that transaction would stamp them with the dashboard's `updated_at` and
 * the widget would report a measurement time that is not theirs. A number
 * wearing somebody else's timestamp is precisely the lie this file exists to
 * prevent. The commerce record therefore carries its OWN ready marker, its own
 * schema version, its own measured-at and its own expiry, and the two records
 * are independently valid: a container may hold both, either, or neither.
 *
 * WHERE THE NUMBERS COME FROM, read from the Go source and not from a doc:
 *   GET /api/v1/commerce/integrations/{id}/analytics
 *     mounted behind `apikeys.RequireScope(apikeys.ScopeReadReports)`
 *     (apps/api/internal/commerce/handlers.go:166) → `commerce.Analytics`
 *     (types.go:687-696) → `Repo.Analytics` (repo.go:2565-2610).
 *
 * TWO FACTS ABOUT THAT QUERY THAT THE WIDGET COPY HAS TO RESPECT:
 *
 *  1. IT IS LIFETIME, NOT A WINDOW. `Repo.Analytics` runs
 *     `count(*)` / `COALESCE(sum(total_cents),0)` over `commerce_orders` with
 *     no date predicate at all (repo.go:2576-2584). So "revenue" here means
 *     every order ever ingested for that integration. Labelling it "Revenue"
 *     with no qualifier — the way a dashboard tile might — would read as
 *     today's or this month's. The widget says "all time" out loud.
 *  2. THE CURRENCY IS PER-INTEGRATION AND ONLY MOSTLY REAL. It is
 *     `COALESCE(max(currency),'USD')` over the same rows, so a store whose
 *     orders mix currencies gets whichever code sorts highest. Totals across
 *     stores are therefore never summed anywhere, here or on screen: the
 *     record holds ONE store and names it.
 *
 * MAJOR UNITS, NOT CENTS. `ExtensionStorage` round-trips integers and the
 * shared JS/Swift contract caps them at 2^31-1 (see `MAX_WIDGET_INTEGER` in
 * lib/widgetData.ts). 2^31-1 CENTS is $21.4m of lifetime revenue, which a real
 * store reaches; 2^31-1 major units is $2.1bn, which one does not. So the cents
 * figure is converted once, here, using the same `/100` the rest of the product
 * uses (`centsToMajor`, lib/commerceRollup.ts) rather than a second convention
 * — and a value that still will not fit publishes NOTHING rather than a
 * clamped number that would silently understate a business.
 *
 * DELIBERATELY IMPORT-FREE of react-native so it runs under the node vitest
 * environment; `./utf8` is itself import-free.
 */
import { utf8ByteLength } from "./utf8";

export const WIDGET_COMMERCE_SCHEMA_VERSION = 1;

/**
 * The disclosure window, mirrored from `WIDGET_SNAPSHOT_TTL_MS` in
 * lib/widgetData.ts and re-validated natively in both targets/widget/index.swift
 * and plugins/PostwaveAppIntents.swift. It is a duplicated literal rather than
 * an import because lib/widgetData.ts pulls in react-native and this module
 * must stay loadable in a node test; lib/widgetCommerceContract.test.ts pins
 * all four copies against each other so they cannot drift.
 */
export const WIDGET_COMMERCE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * How long a published record may keep its original measured-at before the
 * writer re-stamps it from a newer fetch.
 *
 * Not a freshness claim — `measuredAt` is always the moment the ANALYTICS
 * RESPONSE landed (TanStack's `dataUpdatedAt`), never `Date.now()`, so sitting
 * on the Stores tab with no network cannot make the record look newer than the
 * data behind it. This only stops an open screen rewriting the container on
 * every render when nothing has moved.
 */
export const WIDGET_COMMERCE_RESTAMP_SECONDS = 5 * 60;

export const WIDGET_COMMERCE_SCHEMA_KEY = "pw_widget_commerce_schema";
export const WIDGET_COMMERCE_READY_KEY = "pw_widget_commerce_ready";
export const WIDGET_COMMERCE_STORE_KEY = "pw_widget_commerce_store";
export const WIDGET_COMMERCE_STORE_ID_KEY = "pw_widget_commerce_store_id";
export const WIDGET_COMMERCE_ORDERS_KEY = "pw_widget_commerce_orders";
export const WIDGET_COMMERCE_REVENUE_KEY = "pw_widget_commerce_revenue";
export const WIDGET_COMMERCE_CURRENCY_KEY = "pw_widget_commerce_currency";
export const WIDGET_COMMERCE_MEASURED_AT_KEY = "pw_widget_commerce_measured_at";
export const WIDGET_COMMERCE_EXPIRES_AT_KEY = "pw_widget_commerce_expires_at";

/**
 * Every commerce key, so lib/widgetData.ts can fold them into the ONE purge
 * list that opt-out, app lock, sign-out and account deletion already drive.
 * A second record with a second purge path is a second thing to forget.
 */
export const WIDGET_COMMERCE_KEYS = [
  WIDGET_COMMERCE_SCHEMA_KEY,
  WIDGET_COMMERCE_READY_KEY,
  WIDGET_COMMERCE_STORE_KEY,
  WIDGET_COMMERCE_STORE_ID_KEY,
  WIDGET_COMMERCE_ORDERS_KEY,
  WIDGET_COMMERCE_REVENUE_KEY,
  WIDGET_COMMERCE_CURRENCY_KEY,
  WIDGET_COMMERCE_MEASURED_AT_KEY,
  WIDGET_COMMERCE_EXPIRES_AT_KEY,
] as const;

export const MAX_COMMERCE_WIDGET_INTEGER = 2_147_483_647;
/** A shop domain ("acme.myshopify.com") comfortably fits; an essay does not. */
export const MAX_COMMERCE_STORE_BYTES = 64;

export interface CommerceWidgetInput {
  /** Integration id, so a later background wake can refresh the SAME store. */
  storeId: string | null | undefined;
  /** Shop domain, else provider name. Rendered. */
  storeLabel: string | null | undefined;
  /** `Analytics.Orders` — a genuine count(*), so 0 is a measurement. */
  orders: number | null | undefined;
  /** `Analytics.RevenueCents` — integer minor units, exactly off the wire. */
  revenueCents: number | null | undefined;
  /** `Analytics.Currency` — ISO-4217 alpha-3 for THIS integration. */
  currency: string | null | undefined;
  /**
   * When the analytics response actually landed, in unix milliseconds.
   * TanStack's `dataUpdatedAt`, never `Date.now()`.
   */
  measuredAtMs: number | null | undefined;
}

export interface CommerceWidgetPayload {
  storeId: string;
  store: string;
  orders: number;
  /** Whole MAJOR currency units, rounded. */
  revenueMajor: number;
  currency: string;
  /** Unix SECONDS the analytics were measured. */
  measuredAt: number;
  /** Unix SECONDS the disclosure lapses. */
  expiresAt: number;
}

/**
 * Integration ids are uuids on the wire (`integration_id::text` throughout
 * apps/api/internal/commerce/repo.go). Pinning the shape here means the value
 * the background refresh interpolates into a request path can only ever be an
 * id, whatever a torn write happens to leave in the container.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isPublishableStoreId(raw: unknown): boolean {
  return typeof raw === "string" && UUID_RE.test(raw.trim());
}

/** Control characters out, whitespace collapsed, bounded in BYTES not chars. */
export function normalizeStoreLabel(raw: unknown): string {
  const value = typeof raw === "string" ? raw : "";
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  if (utf8ByteLength(cleaned) <= MAX_COMMERCE_STORE_BYTES) return cleaned;
  let out = "";
  for (const character of cleaned) {
    if (utf8ByteLength(out + character) > MAX_COMMERCE_STORE_BYTES) break;
    out += character;
  }
  return out;
}

/**
 * ISO-4217 alpha-3, or null.
 *
 * Null rather than a "USD" fallback on purpose: the widget renders a currency
 * SYMBOL, and defaulting an unrecognised code to dollars is how a euro store's
 * lifetime revenue ends up on a home screen with the wrong mark on the front
 * of it. No code means no record.
 */
export function normalizeWidgetCurrency(raw: unknown): string | null {
  const value = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(value) ? value : null;
}

function wholeInRange(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > MAX_COMMERCE_WIDGET_INTEGER) return null;
  return rounded;
}

/**
 * Build the record, or null when it cannot be published honestly.
 *
 * Every null return is a case where writing SOMETHING would be worse than
 * writing nothing: no store to name, no currency to price it in, a count that
 * was never measured, a revenue figure too large for the shared integer
 * contract, or no idea when any of it was read.
 */
export function buildCommerceWidgetPayload(
  input: CommerceWidgetInput,
): CommerceWidgetPayload | null {
  const storeId = typeof input.storeId === "string" ? input.storeId.trim() : "";
  if (!isPublishableStoreId(storeId)) return null;

  const store = normalizeStoreLabel(input.storeLabel);
  if (!store) return null;

  const currency = normalizeWidgetCurrency(input.currency);
  if (currency === null) return null;

  const orders = wholeInRange(input.orders);
  if (orders === null) return null;

  // Same `/100` the rest of the product applies (`centsToMajor`,
  // lib/commerceRollup.ts). Diverging here is how one surface disagrees with
  // every other about what a store earned.
  const cents = input.revenueCents;
  if (typeof cents !== "number" || !Number.isFinite(cents) || cents < 0) {
    return null;
  }
  const revenueMajor = wholeInRange(cents / 100);
  if (revenueMajor === null) return null;

  const measuredAtMs = input.measuredAtMs;
  if (
    typeof measuredAtMs !== "number" ||
    !Number.isFinite(measuredAtMs) ||
    measuredAtMs <= 0
  ) {
    return null;
  }
  const measuredAt = Math.floor(measuredAtMs / 1000);
  const expiresAt = Math.floor((measuredAtMs + WIDGET_COMMERCE_TTL_MS) / 1000);

  return { storeId, store, orders, revenueMajor, currency, measuredAt, expiresAt };
}

/**
 * Everything except the timestamps. Two reads of an unchanged store produce
 * the same fingerprint, so an open Stores tab does not rewrite the App Group
 * (and spend an iOS WidgetKit reload) on every poll.
 */
export function commerceWidgetFingerprint(
  payload: CommerceWidgetPayload,
): string {
  return [
    payload.storeId,
    payload.store,
    payload.orders,
    payload.revenueMajor,
    payload.currency,
  ].join(" ");
}

/**
 * Publish when the numbers moved, when the store changed, or when the
 * published measurement is old enough that re-stamping it is worth a reload.
 *
 * The last clause is what keeps a quiet store's widget alive: the record
 * expires twelve hours after it was MEASURED, so a shop with no new orders
 * would otherwise go blank while somebody was actively looking at its page.
 */
export function shouldPublishCommerceWidget(
  last: CommerceWidgetPayload | null,
  next: CommerceWidgetPayload,
): boolean {
  if (last === null) return true;
  if (commerceWidgetFingerprint(last) !== commerceWidgetFingerprint(next)) {
    return true;
  }
  return next.measuredAt - last.measuredAt >= WIDGET_COMMERCE_RESTAMP_SECONDS;
}
