/**
 * lib/widgetCommerce.ts — writing and reading the COMMERCE record in the
 * widget's App Group container.
 *
 * The rules live in lib/widgetCommerceSnapshot.ts (import-free, unit-tested);
 * this file is only the ExtensionStorage boundary, and it inherits every
 * privacy control the dashboard snapshot already carries because it shares the
 * same container, the same consent marker and the same purge list:
 *
 *   - nothing is written until `getWidgetMetricsEnabled()` is true, which is
 *     an exact opt-in marker set only from Settings;
 *   - the keys are in `WIDGET_DATA_KEYS`, so app lock, sign-out, account
 *     deletion and switching the toggle off all remove them;
 *   - `pw_widget_commerce_ready` is a transaction tombstone written 0 before
 *     the fields and 1 only after every one of them lands, so a torn write is
 *     never rendered or spoken; and
 *   - the record states its own measured-at and expires twelve hours later,
 *     natively enforced.
 *
 * WHAT THIS RECORD CANNOT DO, said out loud because the widget's copy depends
 * on it: it is written by the Stores tab (and re-read by the background task
 * for the SAME store), so on a device where nobody opens Stores there is no
 * commerce record at all. The widget's empty state says exactly that rather
 * than showing a zero, and every populated state carries the measurement time.
 */
import { Platform } from "react-native";
import { ExtensionStorage } from "@bacons/apple-targets";

import {
  buildCommerceWidgetPayload,
  WIDGET_COMMERCE_CURRENCY_KEY,
  WIDGET_COMMERCE_EXPIRES_AT_KEY,
  WIDGET_COMMERCE_KEYS,
  WIDGET_COMMERCE_MEASURED_AT_KEY,
  WIDGET_COMMERCE_ORDERS_KEY,
  WIDGET_COMMERCE_READY_KEY,
  WIDGET_COMMERCE_REVENUE_KEY,
  WIDGET_COMMERCE_SCHEMA_KEY,
  WIDGET_COMMERCE_SCHEMA_VERSION,
  WIDGET_COMMERCE_STORE_ID_KEY,
  WIDGET_COMMERCE_STORE_KEY,
  isPublishableStoreId,
  type CommerceWidgetInput,
  type CommerceWidgetPayload,
} from "./widgetCommerceSnapshot";
import {
  acquireWidgetStorage,
  getWidgetMetricsEnabled,
  reportWidgetStorageFailure,
} from "./widgetData";

function markerIsSet(value: unknown): boolean {
  return value === "1" || value === 1;
}

/**
 * Remove the commerce record, leaving the dashboard snapshot alone.
 *
 * Used when consent is absent (upgrade cleanup) and when the server says the
 * store is gone — a 404 means the totals describe an integration that no
 * longer exists, and keeping them until the twelve-hour expiry would leave a
 * home screen reporting a deleted shop.
 */
export function clearCommerceWidgetSnapshot(): boolean {
  if (Platform.OS !== "ios") return true;
  const st = acquireWidgetStorage();
  if (!st) return false;
  let ok = true;
  try {
    // Tombstone first: even if an individual remove below fails, the record
    // is already non-renderable.
    st.set(WIDGET_COMMERCE_READY_KEY, 0);
  } catch {
    ok = false;
  }
  for (const key of WIDGET_COMMERCE_KEYS) {
    try {
      st.remove(key);
    } catch {
      ok = false;
    }
  }
  try {
    ExtensionStorage.reloadWidget();
  } catch {
    ok = false;
  }
  if (!ok) reportWidgetStorageFailure();
  return ok;
}

/**
 * Publish one store's lifetime totals, or refuse.
 *
 * Returns false for every refusal — no consent, no App Group, or a payload
 * that `buildCommerceWidgetPayload` would not vouch for — so the caller can
 * keep the last thing it successfully published instead of assuming a write
 * landed.
 */
export function writeCommerceWidgetSnapshot(
  input: CommerceWidgetInput,
): CommerceWidgetPayload | null {
  if (Platform.OS !== "ios") return null;
  const payload = buildCommerceWidgetPayload(input);
  if (!payload) return null;

  const st = acquireWidgetStorage();
  if (!st) return null;

  try {
    if (!getWidgetMetricsEnabled()) {
      // Consent may have been withdrawn since the last write (app lock, a
      // Settings toggle, a different account). Clear rather than skip, so a
      // previously published store cannot outlive the permission to show it.
      clearCommerceWidgetSnapshot();
      return null;
    }

    st.set(WIDGET_COMMERCE_READY_KEY, 0);
    st.set(WIDGET_COMMERCE_SCHEMA_KEY, WIDGET_COMMERCE_SCHEMA_VERSION);
    st.set(WIDGET_COMMERCE_STORE_ID_KEY, payload.storeId);
    st.set(WIDGET_COMMERCE_STORE_KEY, payload.store);
    st.set(WIDGET_COMMERCE_ORDERS_KEY, payload.orders);
    st.set(WIDGET_COMMERCE_REVENUE_KEY, payload.revenueMajor);
    st.set(WIDGET_COMMERCE_CURRENCY_KEY, payload.currency);
    st.set(WIDGET_COMMERCE_MEASURED_AT_KEY, payload.measuredAt);
    st.set(WIDGET_COMMERCE_EXPIRES_AT_KEY, payload.expiresAt);
    st.set(WIDGET_COMMERCE_READY_KEY, 1);
    ExtensionStorage.reloadWidget();
    return payload;
  } catch {
    try {
      st.set(WIDGET_COMMERCE_READY_KEY, 0);
      ExtensionStorage.reloadWidget();
    } catch {
      // Native's own schema/timestamp validation is the second line of
      // defence; the null return tells the caller nothing was published.
    }
    reportWidgetStorageFailure();
    return null;
  }
}

/**
 * The integration id currently published, or null.
 *
 * This is what lets a background wake refresh the store the PERSON chose
 * without calling `GET /api/v1/commerce/integrations` — which is admin-scoped
 * (commerce/handlers.go:138) and would 403 for most sessions. The per-store
 * analytics route it feeds is `ScopeReadReports` (:166), a read-only scope any
 * session clears, so the refresh works for every role that could see the
 * screen in the first place.
 */
export function readPublishedCommerceStoreId(): string | null {
  if (Platform.OS !== "ios") return null;
  const st = acquireWidgetStorage();
  if (!st) return null;
  try {
    if (!getWidgetMetricsEnabled()) return null;
    if (!markerIsSet(st.get(WIDGET_COMMERCE_READY_KEY))) return null;
    const raw: unknown = st.get(WIDGET_COMMERCE_STORE_ID_KEY);
    if (typeof raw !== "string" || !isPublishableStoreId(raw)) return null;
    return raw.trim();
  } catch {
    reportWidgetStorageFailure();
    return null;
  }
}

/** The store label currently published, so a refresh keeps naming it. */
export function readPublishedCommerceStoreLabel(): string | null {
  if (Platform.OS !== "ios") return null;
  const st = acquireWidgetStorage();
  if (!st) return null;
  try {
    // Consent is re-checked here too, not just in the id reader above. These
    // two are always called together today; a future caller that only wanted
    // the name must not be the one place the opt-in is skipped.
    if (!getWidgetMetricsEnabled()) return null;
    if (!markerIsSet(st.get(WIDGET_COMMERCE_READY_KEY))) return null;
    const raw: unknown = st.get(WIDGET_COMMERCE_STORE_KEY);
    return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
  } catch {
    reportWidgetStorageFailure();
    return null;
  }
}
