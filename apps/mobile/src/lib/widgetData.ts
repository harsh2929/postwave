/**
 * Privacy-gated home-screen widget data bridge.
 *
 * Workspace metrics are sensitive even when they are aggregate numbers: a
 * widget sits outside Moosewave's in-app authentication gate and can appear in
 * screenshots, device previews, or over somebody's shoulder. The bridge is
 * therefore fail-closed:
 *
 *   - metrics are OFF until the user explicitly opts in;
 *   - enabling the app lock or tearing down an account removes that consent;
 *   - a ready marker prevents WidgetKit from reading a partial write;
 *   - every snapshot has a short, native-enforced expiry; and
 *   - a failed purge first writes privacy tombstones, so leftover values are
 *     not renderable even if physical deletion needs a retry.
 *
 * The native ExtensionStorage module only exists in an iOS build containing
 * the widget target. Android is an intentional no-op. iOS construction or
 * purge failures are observable through the boolean/strict APIs so account
 * cleanup can retry instead of silently claiming success.
 */
import { Platform } from "react-native";
import { ExtensionStorage } from "@bacons/apple-targets";

import {
  WIDGET_MEASURED_KEYS,
  buildWidgetPayload,
  type WidgetSnapshotInput,
} from "./widgetPayload";
import { WIDGET_COMMERCE_KEYS } from "./widgetCommerceSnapshot";
import { WIDGET_DELIVERABILITY_KEYS } from "./widgetDeliverabilitySnapshot";

import { BUILD_PROFILE } from "@/lib/config";
import { demoModeEnabled } from "@/lib/demoMode";

const DEMO_MODE = demoModeEnabled(
  { EXPO_PUBLIC_DEV_DEMO: process.env.EXPO_PUBLIC_DEV_DEMO },
  BUILD_PROFILE,
);

/**
 * The payload contract lives in lib/widgetPayload.ts (pure, import-free) and is
 * re-exported here so every caller still has one module to know about.
 */
export {
  buildWidgetPayload,
  type WidgetPayload,
  type WidgetSnapshotInput,
} from "./widgetPayload";

const APP_GROUP = "group.com.moosewave.app";
const WIDGET_OPT_IN_KEY = "pw_widget_metrics_opt_in_v1";
const WIDGET_READY_KEY = "pw_widget_ready";
const WIDGET_SCHEMA_KEY = "pw_widget_schema";
const WIDGET_SCHEMA_VERSION = 1;

/**
 * FRESHNESS vs EXPIRY — they were the same number, and that was the bug
 * (DASHBOARD#50 / NATIVE#19).
 *
 * The snapshot's only writer runs while the Dashboard tab is on screen. With a
 * single fifteen-minute lifetime, the widget therefore read
 * "Data expired · Open Moosewave to refresh" for essentially the entire day for
 * anyone who does not open that tab every quarter of an hour — i.e. everyone.
 * A widget that is blank by default is worse than no widget.
 *
 * Two windows now, because they answer two different questions:
 *
 *   FRESH  — how long a snapshot reads as CURRENT. Past it the widget still
 *            shows the numbers, with the time they were measured ("2h ago").
 *            Stating staleness is more honest than hiding a measurement we
 *            still hold, and it is the same staleness-at-read-time rule the
 *            rest of the product follows.
 *   TTL    — the DISCLOSURE window, after which the values are removed and
 *            refuse to render. This is the privacy control.
 *
 * Twelve hours for the disclosure window is a deliberate loosening of the
 * original fifteen minutes, and it is bounded by everything that already
 * guarded it: metrics are off until an explicit opt-in, the values are
 * `.privacySensitive()` so iOS redacts them on a locked device, and enabling
 * the app lock / signing out / deleting the account all purge the container.
 * What it gives up is the case where a phone is found unlocked more than
 * fifteen minutes but less than twelve hours after Moosewave was last used.
 *
 * Both numbers are re-validated natively (targets/widget/index.swift) and
 * pinned by lib/nativePrivacyContracts.test.ts, so JS and Swift cannot drift.
 */
export const WIDGET_SNAPSHOT_FRESH_MS = 15 * 60 * 1000;
export const WIDGET_SNAPSHOT_TTL_MS = 12 * 60 * 60 * 1000;

const WIDGET_DATA_KEYS = [
  "pw_widget_subs",
  "pw_widget_open_rate",
  "pw_widget_sent30d",
  "pw_widget_pending",
  "pw_widget_workspace",
  "pw_widget_updated_at",
  "pw_widget_expires_at",
  // ABSENCE MARKERS (DASHBOARD#72) — see the long note above `isMeasured`.
  // They travel with the disclosure and are purged with it: on their own they
  // say nothing about the workspace, but leaving them behind would let a later
  // partial write be read against a stale "this was measured".
  ...WIDGET_MEASURED_KEYS,
  WIDGET_SCHEMA_KEY,
  WIDGET_READY_KEY,
  // The COMMERCE record (lib/widgetCommerceSnapshot.ts) is a second,
  // independently-timestamped transaction in the same container. It is folded
  // into this ONE list on purpose: opt-out, app lock, sign-out and account
  // deletion all purge through here, and a second record with its own purge
  // path is a second thing to forget when consent is withdrawn.
  ...WIDGET_COMMERCE_KEYS,
  // The SENDER HEALTH record (lib/widgetDeliverabilitySnapshot.ts) is a third
  // one, on the same terms and for the same reason — it is stamped with the
  // server's `computed_at` rather than with the dashboard poll's clock.
  ...WIDGET_DELIVERABILITY_KEYS,
] as const;

const WIDGET_ALL_KEYS = [WIDGET_OPT_IN_KEY, ...WIDGET_DATA_KEYS] as const;

let storage: ExtensionStorage | null = null;

function getStorage(): ExtensionStorage | null {
  if (Platform.OS !== "ios") return null;
  if (storage) return storage;
  try {
    storage = new ExtensionStorage(APP_GROUP);
    return storage;
  } catch {
    // Do not permanently memoize a transient native/App-Group failure. A
    // later cleanup attempt must be able to retry.
    storage = null;
    return null;
  }
}

function resetStorageAfterFailure(): void {
  storage = null;
}

/**
 * The same memoized App Group handle, for the COMMERCE record's writer
 * (lib/widgetCommerce.ts).
 *
 * Exported rather than duplicated because a second `new ExtensionStorage(...)`
 * would be a second place the App Group name is spelled, and a second cache to
 * invalidate after a native failure. Consent still has to be re-checked by the
 * caller — holding the handle grants nothing.
 */
export function acquireWidgetStorage(): ExtensionStorage | null {
  return getStorage();
}

/** Drop the memoized handle so a later attempt can retry a transient failure. */
export function reportWidgetStorageFailure(): void {
  resetStorageAfterFailure();
}

function optInValueIsEnabled(value: unknown): boolean {
  return value === "1" || value === 1;
}

/** Metrics are visible only after an exact explicit opt-in marker. */
export function getWidgetMetricsEnabled(): boolean {
  if (Platform.OS !== "ios") return false;
  const st = getStorage();
  if (!st) return false;
  try {
    return optInValueIsEnabled(st.get(WIDGET_OPT_IN_KEY));
  } catch {
    resetStorageAfterFailure();
    return false;
  }
}

function removeAndVerifyKeys(
  st: ExtensionStorage,
  keys: readonly string[],
): boolean {
  let success = true;
  for (const key of keys) {
    try {
      st.remove(key);
    } catch {
      success = false;
    }
  }
  for (const key of keys) {
    try {
      if (st.get(key) !== null) success = false;
    } catch {
      success = false;
    }
  }
  return success;
}

/**
 * Remove consent and all snapshot fields.
 *
 * Privacy tombstones are written before physical deletion. WidgetKit checks
 * both markers, so even if an individual remove fails it cannot render the
 * leftover snapshot. Returns false on iOS when purge/reload verification was
 * incomplete; callers performing account cleanup should use the strict API.
 */
export function clearWidgetSnapshot(): boolean {
  if (Platform.OS !== "ios") return true;
  const st = getStorage();
  if (!st) return false;

  let privacyBarrierWritten = true;
  try {
    st.set(WIDGET_OPT_IN_KEY, 0);
    st.set(WIDGET_READY_KEY, 0);
    ExtensionStorage.reloadWidget();
  } catch {
    privacyBarrierWritten = false;
  }

  const removed = removeAndVerifyKeys(st, WIDGET_ALL_KEYS);
  let reloaded = true;
  try {
    ExtensionStorage.reloadWidget();
  } catch {
    reloaded = false;
  }
  if (!privacyBarrierWritten || !removed || !reloaded) {
    resetStorageAfterFailure();
    return false;
  }
  return true;
}

/** Reject account-cleanup completion unless the App Group purge verified. */
export async function clearWidgetSnapshotStrict(): Promise<void> {
  // DEMO MODE: an App Group that was never provisioned holds nothing to wipe.
  //
  // A simulator build signed with no development team gets an EMPTY
  // entitlements dict (verified with `codesign -d --entitlements`), so
  // `group.com.moosewave.app` does not exist and this clear can only fail. That
  // failure is reported as an incomplete sign-out, which sets the DURABLE
  // `SECURE_KEY_CLEANUP_PENDING` marker, which refuses every later sign-in --
  // so one unprovisioned container permanently locks the app out of itself.
  //
  // Production is unaffected: demoModeEnabled() is false there, and a real
  // failure to wipe a REAL container must still fail loudly. See lib/demoMode.
  if (DEMO_MODE) return;
  if (!clearWidgetSnapshot()) {
    throw new Error("Widget App Group cleanup is incomplete");
  }
}

/**
 * Commit the user's widget disclosure choice.
 *
 * Enabling starts from an empty snapshot so a prior account can never flash
 * in the widget. Disabling uses the same verified purge as logout/app lock.
 */
export function setWidgetMetricsEnabled(enabled: boolean): boolean {
  if (Platform.OS !== "ios") return !enabled;
  if (!enabled) return clearWidgetSnapshot();
  const st = getStorage();
  if (!st) return false;

  // Clear old account/snapshot values before publishing the opt-in marker.
  if (!removeAndVerifyKeys(st, WIDGET_ALL_KEYS)) {
    resetStorageAfterFailure();
    return false;
  }
  try {
    st.set(WIDGET_OPT_IN_KEY, 1);
    if (!optInValueIsEnabled(st.get(WIDGET_OPT_IN_KEY))) {
      throw new Error("Widget opt-in did not persist");
    }
    ExtensionStorage.reloadWidget();
    return true;
  } catch {
    // Best effort fail-closed rollback; the exact marker check means a
    // partial/invalid value still cannot opt the user in.
    try {
      st.remove(WIDGET_OPT_IN_KEY);
      ExtensionStorage.reloadWidget();
    } catch {
      // The false return tells Settings/account cleanup to retry and warn.
    }
    resetStorageAfterFailure();
    return false;
  }
}

/**
 * The pending-approvals count currently published, or null when there is none.
 *
 * Exists so a REFRESH that could not re-read the count — a background wake for
 * a non-admin, whose role cannot call GET /api/v1/approvals — can carry the
 * last true value forward instead of publishing a zero it never measured. Same
 * rule `useWidgetMirror` applies in the foreground with its `lastPending` ref;
 * a background writer has no React refs to remember it in, so it asks the
 * container.
 */
export function readPublishedWidgetPending(): number | null {
  if (Platform.OS !== "ios") return null;
  const st = getStorage();
  if (!st) return null;
  try {
    if (!optInValueIsEnabled(st.get(WIDGET_OPT_IN_KEY))) return null;
    // The ready marker is the transaction tombstone: a torn write leaves it
    // at 0 and the value below must not be trusted. `get` is typed as
    // `string | null` but the native bridge round-trips the Int we set, so
    // both forms are accepted rather than assuming one.
    if (!optInValueIsEnabled(st.get(WIDGET_READY_KEY))) return null;
    const raw: unknown = st.get("pw_widget_pending");
    const value =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim() !== ""
          ? Number(raw)
          : Number.NaN;
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.floor(value);
  } catch {
    resetStorageAfterFailure();
    return null;
  }
}

/**
 * Persist a crash-safe, short-lived snapshot and refresh WidgetKit.
 * No value is written unless explicit opt-in is currently present.
 */
export function writeWidgetSnapshot(input: WidgetSnapshotInput): boolean {
  if (Platform.OS !== "ios") return false;
  const st = getStorage();
  if (!st) return false;
  try {
    if (!optInValueIsEnabled(st.get(WIDGET_OPT_IN_KEY))) {
      // Upgrade cleanup: older builds wrote metrics without consent. The
      // missing exact marker is already non-renderable natively; remove those
      // legacy fields as soon as the dashboard next attempts a write.
      const removed = removeAndVerifyKeys(st, WIDGET_DATA_KEYS);
      ExtensionStorage.reloadWidget();
      if (!removed) resetStorageAfterFailure();
      return false;
    }

    const payload = buildWidgetPayload(input);
    const updatedAt = Math.floor(Date.now() / 1000);
    const expiresAt = Math.floor((Date.now() + WIDGET_SNAPSHOT_TTL_MS) / 1000);

    // READY=0 is the transaction tombstone. Native only reads the fields
    // after every write succeeds and READY flips to the exact value 1.
    st.set(WIDGET_READY_KEY, 0);
    st.set(WIDGET_SCHEMA_KEY, WIDGET_SCHEMA_VERSION);
    st.set("pw_widget_subs", payload.subs);
    st.set("pw_widget_open_rate", payload.openRate);
    st.set("pw_widget_sent30d", payload.sent30d);
    st.set("pw_widget_pending", payload.pending);
    // Each marker is set in the SAME transaction as its value, between the two
    // ready flips, so a reader can never pair a new value with an old marker.
    st.set("pw_widget_subs_known", payload.subsKnown ? 1 : 0);
    st.set("pw_widget_open_rate_known", payload.openRateKnown ? 1 : 0);
    st.set("pw_widget_sent30d_known", payload.sent30dKnown ? 1 : 0);
    st.set("pw_widget_workspace", payload.workspace);
    st.set("pw_widget_updated_at", updatedAt);
    st.set("pw_widget_expires_at", expiresAt);
    st.set(WIDGET_READY_KEY, 1);
    ExtensionStorage.reloadWidget();
    return true;
  } catch {
    // Fail closed after a torn write. If this write also fails, native's
    // schema/timestamp validation remains a second line of defence.
    try {
      st.set(WIDGET_READY_KEY, 0);
      ExtensionStorage.reloadWidget();
    } catch {
      // Report failure below; a later dashboard/cleanup attempt can retry.
    }
    resetStorageAfterFailure();
    return false;
  }
}
