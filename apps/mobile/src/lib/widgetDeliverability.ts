/**
 * lib/widgetDeliverability.ts — writing and reading the SENDER HEALTH record
 * in the widget's App Group container (DELIVERABILITY#64).
 *
 * The rules live in lib/widgetDeliverabilitySnapshot.ts (import-free,
 * unit-tested); this file is only the ExtensionStorage boundary, and it
 * inherits every privacy control the dashboard snapshot already carries
 * because it shares the same container, the same consent marker and the same
 * purge list:
 *
 *   - nothing is written until `getWidgetMetricsEnabled()` is true, which is
 *     an exact opt-in marker set only from Settings;
 *   - the keys are in `WIDGET_DATA_KEYS`, so app lock, sign-out, account
 *     deletion and switching the toggle off all remove them;
 *   - `pw_widget_deliv_ready` is a transaction tombstone written 0 before the
 *     fields and 1 only after every one of them lands, so a torn write is
 *     never rendered or spoken; and
 *   - the record states its own measured-at and expires twelve hours later,
 *     natively enforced.
 *
 * WHAT THIS RECORD CANNOT DO, said out loud because the widget's copy depends
 * on it: its writer is the Deliverability tab, plus a background re-read that
 * only runs once a record already exists. On a device where nobody has opened
 * that tab there is no sender-health record at all, and the widget says
 * exactly that rather than showing a reassuring "100".
 */
import { Platform } from "react-native";
import { ExtensionStorage } from "@bacons/apple-targets";

import {
  acquireWidgetStorage,
  getWidgetMetricsEnabled,
  reportWidgetStorageFailure,
} from "./widgetData";
import {
  buildDeliverabilityWidgetPayload,
  WIDGET_DELIVERABILITY_BREACHES_KEY,
  WIDGET_DELIVERABILITY_EXPIRES_AT_KEY,
  WIDGET_DELIVERABILITY_GRADE_KEY,
  WIDGET_DELIVERABILITY_KEYS,
  WIDGET_DELIVERABILITY_MEASURED_AT_KEY,
  WIDGET_DELIVERABILITY_READY_KEY,
  WIDGET_DELIVERABILITY_SCHEMA_KEY,
  WIDGET_DELIVERABILITY_SCHEMA_VERSION,
  WIDGET_DELIVERABILITY_SCORE_KEY,
  WIDGET_DELIVERABILITY_SENDS7D_KEY,
  WIDGET_DELIVERABILITY_STATUS_KEY,
  WIDGET_DELIVERABILITY_THROTTLED_KEY,
  type DeliverabilityWidgetInput,
  type DeliverabilityWidgetPayload,
} from "./widgetDeliverabilitySnapshot";

function markerIsSet(value: unknown): boolean {
  return value === "1" || value === 1;
}

/**
 * Remove the sender-health record, leaving the other two alone.
 *
 * Used when consent is absent (upgrade cleanup) and when the hub read fails
 * with a 403 — a role that may no longer read reports must not keep a score on
 * its home screen until the twelve-hour expiry runs out.
 */
export function clearDeliverabilityWidgetSnapshot(): boolean {
  if (Platform.OS !== "ios") return true;
  const st = acquireWidgetStorage();
  if (!st) return false;
  let ok = true;
  try {
    // Tombstone first: even if an individual remove below fails, the record is
    // already non-renderable.
    st.set(WIDGET_DELIVERABILITY_READY_KEY, 0);
  } catch {
    ok = false;
  }
  for (const key of WIDGET_DELIVERABILITY_KEYS) {
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
 * Publish the workspace's sender health, or refuse.
 *
 * Returns null for every refusal — no consent, no App Group, or a payload
 * `buildDeliverabilityWidgetPayload` would not vouch for — so the caller can
 * keep the last thing it successfully published instead of assuming a write
 * landed.
 */
export function writeDeliverabilityWidgetSnapshot(
  input: DeliverabilityWidgetInput,
): DeliverabilityWidgetPayload | null {
  if (Platform.OS !== "ios") return null;
  const payload = buildDeliverabilityWidgetPayload(input);
  if (!payload) return null;

  const st = acquireWidgetStorage();
  if (!st) return null;

  try {
    if (!getWidgetMetricsEnabled()) {
      // Consent may have been withdrawn since the last write (app lock, a
      // Settings toggle, a different account). Clear rather than skip, so a
      // previously published score cannot outlive the permission to show it.
      clearDeliverabilityWidgetSnapshot();
      return null;
    }

    st.set(WIDGET_DELIVERABILITY_READY_KEY, 0);
    st.set(WIDGET_DELIVERABILITY_SCHEMA_KEY, WIDGET_DELIVERABILITY_SCHEMA_VERSION);
    st.set(WIDGET_DELIVERABILITY_SCORE_KEY, payload.score);
    st.set(WIDGET_DELIVERABILITY_GRADE_KEY, payload.grade);
    st.set(WIDGET_DELIVERABILITY_STATUS_KEY, payload.status);
    st.set(WIDGET_DELIVERABILITY_THROTTLED_KEY, payload.throttled);
    st.set(WIDGET_DELIVERABILITY_BREACHES_KEY, payload.breaches);
    st.set(WIDGET_DELIVERABILITY_SENDS7D_KEY, payload.sends7d);
    st.set(WIDGET_DELIVERABILITY_MEASURED_AT_KEY, payload.measuredAt);
    st.set(WIDGET_DELIVERABILITY_EXPIRES_AT_KEY, payload.expiresAt);
    st.set(WIDGET_DELIVERABILITY_READY_KEY, 1);
    ExtensionStorage.reloadWidget();
    return payload;
  } catch {
    try {
      st.set(WIDGET_DELIVERABILITY_READY_KEY, 0);
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
 * True when a sender-health record has already been published on this device.
 *
 * This is the background task's gate, and it is the same shape as the commerce
 * one: a wake refreshes what the PERSON has already asked to see rather than
 * speculatively fetching a workspace-health report for somebody who has never
 * opened the Deliverability tab. Nothing about the record is returned — only
 * whether refreshing it is something this device has been asked to do.
 */
export function hasPublishedDeliverabilityWidget(): boolean {
  if (Platform.OS !== "ios") return false;
  const st = acquireWidgetStorage();
  if (!st) return false;
  try {
    if (!getWidgetMetricsEnabled()) return false;
    return markerIsSet(st.get(WIDGET_DELIVERABILITY_READY_KEY));
  } catch {
    reportWidgetStorageFailure();
    return false;
  }
}
