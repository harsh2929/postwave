/**
 * useCommerceWidgetMirror — publish the selected store's lifetime totals to
 * the home-screen widget, stamped with the moment the server answered.
 *
 * THE ONE DESIGN DECISION WORTH THE COMMENT: `measuredAtMs` is TanStack's
 * `dataUpdatedAt`, not `Date.now()`.
 *
 * The dashboard mirror can use "now" because its writer runs beside a live
 * poll. This one cannot. A phone sitting on the Stores tab with no signal
 * still renders the cached analytics for as long as you look at them, and
 * stamping that render with the current clock would publish a two-hour-old
 * measurement to the home screen as if it had just been taken — which is the
 * exact failure mode the widget's "as of" line exists to prevent. Using the
 * response's own arrival time means a stale screen publishes a stale
 * timestamp, and the widget says so.
 *
 * A missing `dataUpdatedAt` (never fetched) publishes nothing rather than
 * inventing one. An absent measurement is not a zero.
 */
import { useEffect, useRef } from "react";

import type { CommerceAnalytics } from "@/lib/commerceRollup";
import { writeCommerceWidgetSnapshot } from "@/lib/widgetCommerce";
import {
  buildCommerceWidgetPayload,
  shouldPublishCommerceWidget,
  type CommerceWidgetPayload,
} from "@/lib/widgetCommerceSnapshot";

export interface CommerceWidgetMirrorInput {
  /** The integration whose numbers are on screen, or null while none is. */
  storeId: string | null;
  /** Shop domain, else provider — whatever the screen itself is calling it. */
  storeLabel: string | null;
  analytics: CommerceAnalytics | undefined;
  /**
   * TanStack's `dataUpdatedAt` from the analytics query — the moment that
   * response landed. Spelled out rather than quoted as a call expression
   * because src/hooks/online-query-gating.test.ts greps for query calls and a
   * comment is not one.
   */
  dataUpdatedAt: number | undefined;
}

export function useCommerceWidgetMirror({
  storeId,
  storeLabel,
  analytics,
  dataUpdatedAt,
}: CommerceWidgetMirrorInput): void {
  /**
   * The last record this hook actually got into the container. Only updated
   * after a write REPORTS success, so a device that has not opted in — or
   * whose App Group is momentarily unavailable — retries on the next change
   * instead of believing it already published.
   */
  const published = useRef<CommerceWidgetPayload | null>(null);

  // Derived scalars only. `analytics` is a fresh object identity on every
  // successful poll, and depending on it would rewrite the App Group (and
  // spend an iOS WidgetKit reload) every thirty seconds on an idle store.
  const orders = analytics?.orders;
  const revenueCents = analytics?.revenueCents;
  const currency = analytics?.currency;

  useEffect(() => {
    if (analyticsIsAbsent(orders, revenueCents, currency)) return;
    const input = {
      storeId,
      storeLabel,
      orders,
      revenueCents,
      currency,
      measuredAtMs: dataUpdatedAt,
    };
    // Null means the record could not be published honestly — no store named,
    // an unrecognised currency, a figure outside the shared integer contract,
    // or no idea when it was read. Leave whatever is there; it carries its own
    // expiry.
    const next = buildCommerceWidgetPayload(input);
    if (!next) return;
    if (!shouldPublishCommerceWidget(published.current, next)) return;
    published.current = writeCommerceWidgetSnapshot(input);
  }, [storeId, storeLabel, orders, revenueCents, currency, dataUpdatedAt]);
}

/** True while the query has produced no analytics at all. */
function analyticsIsAbsent(
  orders: number | undefined,
  revenueCents: number | undefined,
  currency: string | undefined,
): boolean {
  return (
    orders === undefined || revenueCents === undefined || currency === undefined
  );
}
