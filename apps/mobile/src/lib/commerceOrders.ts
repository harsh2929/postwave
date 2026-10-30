/**
 * lib/commerceOrders.ts — the order half of the commerce surface.
 *
 * `lib/commerceRollup` answers "is the pipeline flowing"; this module answers
 * the other half of the same question — "and what came through it". They are
 * separate files rather than one because the rollup is about a CURSOR and this
 * is about ROWS, and because the rollup was already at the size where a second
 * concern would have started hiding the first.
 *
 * THE WIRE, read from Go rather than from a doc:
 *   - `Order`      apps/api/internal/commerce/types.go:596-614
 *   - `OrdersPage` types.go:637-640  → `{items, next_cursor?}`
 *   - `Repo.ListOrders` repo.go:2485 orders by `ordered_at DESC, id DESC` and
 *     keyset-pages on that pair, so the first page IS "most recent orders" and
 *     the client must not re-sort it.
 *
 * FOUR FACTS THAT SHAPE THIS FILE:
 *
 *  1. THE STATUS VOCABULARY IS CLOSED, AND IT IS FOUR WORDS.
 *     Every provider adapter funnels its own vocabulary into exactly
 *     `paid | pending | refunded | cancelled` — shopify.go:285-300,
 *     woocommerce.go:758-769, bigcommerce.go:686-695, stripe.go:885-896,
 *     square.go:1006-1015, paypal.go:1060-1083, razorpay.go:628-635,
 *     adobe_commerce.go:955-965, wix_stores.go:2065-2076,
 *     squarespace.go:931-942. A record POSTed straight through the sync
 *     payload can still carry anything, so an unrecognised status is classed
 *     `other` and shown verbatim rather than coerced into one of the four.
 *
 *  2. MONEY IS INTEGER CENTS WITH A PER-ORDER CURRENCY. `Order.TotalCents` is
 *     an int and `Order.Currency` is per-row (types.go:605-606) — two orders in
 *     one page can legitimately disagree, so nothing here sums across rows
 *     without checking that first.
 *
 *  3. AN AVERAGE OVER ZERO ORDERS IS NOT ZERO. `Repo.Analytics` only assigns
 *     `AverageOrderCents` when `Orders > 0` (repo.go:2588-2590), so the field
 *     arrives as a plain 0 for a store with no orders. Rendering "$0.00" there
 *     states a measurement that was never taken. `averageOrderCentsOrNull`
 *     is the single place that distinction is made.
 *
 *  4. A PAGE IS A SAMPLE, NOT A TOTAL. Campaign attribution computed over the
 *     ~25 rows a phone fetches is a fact about those rows only, which is why
 *     `attributedSlice` returns the sample size alongside the count and the
 *     caller is expected to say "of the last N".
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */

/** The closed status vocabulary, plus the escape hatch for a raw sync payload. */
export type CommerceOrderClass =
  | "paid"
  | "pending"
  | "refunded"
  | "cancelled"
  | "other";

export interface CommerceOrderLine {
  id: string;
  /** Provider-scoped identity, e.g. "shopify://order/450789469". */
  sourceId: string;
  /** The short thing a merchant recognises — the tail of `sourceId`. */
  reference: string;
  /** Lower-cased by the adapters; "" when the order was anonymous. */
  customerEmail: string;
  /** Verbatim server status — never remapped for display. */
  status: string;
  statusClass: CommerceOrderClass;
  /** Integer cents, exactly as the server sent it. */
  totalCents: number;
  currency: string;
  /** ISO timestamp, or "" when the row carried no `ordered_at`. */
  orderedAt: string;
  /** "" unless the order was attributed to a campaign. */
  campaignId: string;
}

export interface CommerceOrdersPage {
  items: CommerceOrderLine[];
  /** "" when the server said there is no further page. */
  nextCursor: string;
}

export interface CommerceAttributionSlice {
  /** Orders IN THE SAMPLE that carry a campaign_id. */
  count: number;
  /**
   * Revenue of the attributed orders that are also `paid`. Refunded and
   * cancelled orders are excluded because counting them as revenue is how a
   * campaign gets credited for money that came back.
   */
  revenueCents: number;
  /** Currency of that revenue, or "" when the sample mixes currencies. */
  currency: string;
  /** How many rows the slice was computed over. Never present it as a total. */
  sampled: number;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

/**
 * Classify a status without ever discarding it.
 *
 * The four canonical words come back as themselves; anything else is `other`,
 * which the UI renders in neutral chrome with the raw word still visible. The
 * alternative — folding an unknown status into "pending" — would tell someone
 * an order is still coming when nobody knows that.
 */
export function orderStatusClass(status: unknown): CommerceOrderClass {
  switch (str(status).toLowerCase()) {
    case "paid":
      return "paid";
    case "pending":
      return "pending";
    case "refunded":
      return "refunded";
    case "cancelled":
      return "cancelled";
    default:
      return "other";
  }
}

/**
 * "shopify://order/450789469" → "450789469".
 *
 * The scheme prefix is the adapter's namespacing (`sourceID` in shopify.go /
 * `wooCommerceSourceID` in woocommerce.go and friends), not something a
 * merchant ever typed. What they recognise is the tail. A source id with no
 * separator is already the tail and passes through untouched.
 */
export function orderReference(sourceId: unknown): string {
  const raw = str(sourceId);
  if (!raw) return "";
  const tail = raw.slice(raw.lastIndexOf("/") + 1);
  return tail || raw;
}

/** Unwrap `{items}` and tolerate the bare array shape. */
function unwrapItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const env = payload as { items?: unknown };
  return Array.isArray(env.items) ? env.items : [];
}

export function normalizeCommerceOrders(payload: unknown): CommerceOrdersPage {
  const items: CommerceOrderLine[] = [];
  for (const entry of unwrapItems(payload)) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const id = str(row.id);
    if (!id) continue;
    const status = str(row.status);
    const sourceId = str(row.source_id);
    items.push({
      id,
      sourceId,
      reference: orderReference(sourceId) || id.slice(0, 8),
      customerEmail: str(row.customer_email),
      status,
      statusClass: orderStatusClass(status),
      totalCents: int(row.total_cents),
      currency: str(row.currency) || "USD",
      orderedAt: str(row.ordered_at),
      campaignId: str(row.campaign_id),
    });
  }
  const envelope = (payload && typeof payload === "object" ? payload : {}) as {
    next_cursor?: unknown;
  };
  return { items, nextCursor: str(envelope.next_cursor) };
}

/**
 * The average order value, or null when there is no average to state.
 *
 * See fact 3 in the file header: the server leaves the field at 0 for a store
 * with no orders, and 0 is a number a customer will read as a measurement.
 */
export function averageOrderCentsOrNull(analytics: {
  orders: number;
  averageOrderCents: number;
}): number | null {
  return analytics.orders > 0 ? analytics.averageOrderCents : null;
}

/**
 * Campaign-attributed orders WITHIN a fetched page.
 *
 * Currency is only reported when every counted order agrees on one; a mixed
 * sample returns "" so the caller shows the count without a money figure
 * rather than adding euros to dollars.
 */
export function attributedSlice(
  orders: readonly CommerceOrderLine[],
): CommerceAttributionSlice {
  let count = 0;
  let revenueCents = 0;
  let currency = "";
  let mixed = false;
  for (const order of orders) {
    if (!order.campaignId) continue;
    count += 1;
    if (order.statusClass !== "paid") continue;
    revenueCents += order.totalCents;
    if (!currency) currency = order.currency;
    else if (currency !== order.currency) mixed = true;
  }
  return {
    count,
    revenueCents,
    currency: mixed ? "" : currency,
    sampled: orders.length,
  };
}
