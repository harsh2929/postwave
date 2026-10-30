/**
 * dashboard-notifier — fire native (Tauri) / web notifications for
 * milestone crossings and newly-detected anomalies. Refined Dashboard PR 3.
 *
 * Anomaly dedupe uses `sessionStorage` (anomaly ids are stable, so the
 * user sees each one at most once per session). Milestone dedupe uses a
 * persistent `localStorage` high-water mark: it is seeded silently on
 * first observation and we only notify for milestones crossed AFTER
 * that — without persistence, every app launch re-fired a notification
 * for every historical milestone (7 notifications for a 12k-subscriber
 * tenant, every start).
 *
 * Every new event is first admitted to the encrypted Notification Center;
 * the shared topic/quiet-hour/foreground policy then decides whether an OS
 * projection is appropriate. Failed OS delivery remains retryable and never
 * advances dedupe/high-water state. The "OS blizzard" anti-pattern of one
 * toast per stat update is exactly what kills notification permission consent.
 */

import { type DashboardAnomalyRow } from "./api-client";
import {
  ingestNotification,
  notificationDeliveryDecision,
  recordNotificationDelivery,
  type DesktopNotificationTopic,
} from "./notification-center";
import { tauriApi } from "./tauri";

const SS_NOTIFIED_ANOM = "pw.dashboard.notified.anomalies";
const LS_MILESTONE_HIGH_WATER = "pw.dashboard.milestone.highwater";
const MILESTONE_KEY_VERSION = "v3";
const inFlightDeliveries = new Set<string>();

type DashboardDeliveryResult =
  | "delivered"
  | "suppressed"
  | "failed"
  | "in-flight";

/** Keep tenant/workspace/anomaly identifiers out of plaintext web storage. */
function opaqueLocalIdentity(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + index), 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

async function deliverDashboardNotification(input: {
  topic: Extract<
    DesktopNotificationTopic,
    "dashboard.anomaly" | "dashboard.milestone"
  >;
  title: string;
  body: string;
  eventIdentity: string;
  occurredAt: string;
}): Promise<DashboardDeliveryResult> {
  const center = await ingestNotification({ ...input, deepLink: null });
  // Do not consume a new event before identity-scoped encrypted history is
  // available. A later dashboard refresh can retry safely.
  if (!center.id) return "failed";
  const decision = notificationDeliveryDecision({
    topic: input.topic,
    appVisible:
      typeof document !== "undefined" && document.visibilityState === "visible",
    appFocused:
      typeof document !== "undefined" &&
      typeof document.hasFocus === "function" &&
      document.hasFocus(),
  });
  if (!decision.deliver) {
    recordNotificationDelivery(center.id, decision.reason);
    return "suppressed";
  }
  const deliveryKey = `${input.topic}:${input.eventIdentity}`;
  if (inFlightDeliveries.has(deliveryKey)) return "in-flight";
  inFlightDeliveries.add(deliveryKey);
  try {
    await tauriApi.showNotification({
      title: input.title,
      body: input.body,
      activationId: center.id,
    });
    recordNotificationDelivery(center.id, "delivered");
    return "delivered";
  } catch {
    recordNotificationDelivery(center.id, "failed");
    return "failed";
  } finally {
    inFlightDeliveries.delete(deliveryKey);
  }
}

function readSet(key: string): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    const normalized = arr
      .map(String)
      .filter((value) => /^[0-9a-f]{16}$/u.test(value));
    if (normalized.length !== arr.length) {
      window.sessionStorage.setItem(key, JSON.stringify(normalized));
    }
    return new Set(normalized);
  } catch {
    return new Set();
  }
}

function writeSet(key: string, s: Set<string>): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}

/**
 * Notify the user about any anomaly ids they haven't seen yet this
 * session. Returns the count of notifications fired so callers can
 * telemetry it.
 */
export async function notifyNewAnomalies(
  anomalies: readonly DashboardAnomalyRow[],
): Promise<number> {
  if (anomalies.length === 0) return 0;
  const seen = readSet(SS_NOTIFIED_ANOM);
  let fired = 0;
  for (const a of anomalies) {
    const eventIdentity = `${a.tenantId}:${a.id}`;
    const dedupeIdentity = opaqueLocalIdentity(eventIdentity);
    if (seen.has(dedupeIdentity)) continue;
    const result = await deliverDashboardNotification({
      topic: "dashboard.anomaly",
      title: "Dashboard anomaly detected",
      body: "A workspace metric needs attention. Open Moosewave to investigate.",
      eventIdentity,
      occurredAt: a.detectedAt || new Date().toISOString(),
    });
    if (result === "delivered" || result === "suppressed") {
      seen.add(dedupeIdentity);
      if (result === "delivered") fired += 1;
    }
  }
  writeSet(SS_NOTIFIED_ANOM, seen);
  return fired;
}

/**
 * The milestone high-water mark is scoped to the opaque signed-in identity.
 * This prevents both cross-workspace behavior and raw user/workspace labels
 * from entering plaintext storage. Ownership-ambiguous older keys are purged
 * and the current total is silently re-seeded; their values are never adopted.
 */
function milestoneKey(identityScope?: string | null): string {
  return identityScope
    ? `${LS_MILESTONE_HIGH_WATER}.${MILESTONE_KEY_VERSION}.${opaqueLocalIdentity(identityScope)}`
    : LS_MILESTONE_HIGH_WATER;
}

function readHighWaterMark(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function writeHighWaterMark(key: string, n: number): void {
  try {
    window.localStorage.setItem(key, String(n));
  } catch {
    /* ignore */
  }
}

function purgeAmbiguousMilestoneKeys(currentKey: string): void {
  try {
    const prefix = `${LS_MILESTONE_HIGH_WATER}.`;
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(prefix) && key !== currentKey) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    /* best-effort privacy cleanup */
  }
}

/**
 * Notify the user when their subscriber count crosses one of the
 * milestone rungs (100, 250, 500, 1k, …).
 *
 * Dedupe is an identity-scoped persistent high-water mark in localStorage:
 *   • First observation seeds the mark silently — no notifications for
 *     milestones the tenant crossed before we started watching.
 *   • Afterwards we only notify for rungs in (mark, currentTotal], then
 *     raise the mark. The mark never lowers, so dipping below a rung
 *     and re-crossing it doesn't re-notify.
 */
export async function notifyMilestoneCrossings(
  currentTotal: number,
  identityScope?: string | null,
): Promise<number> {
  const ladder = [
    100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000,
    250_000, 500_000, 1_000_000,
  ];
  const key = milestoneKey(identityScope);
  purgeAmbiguousMilestoneKeys(key);
  const mark = readHighWaterMark(key);
  if (mark === null) {
    // First run: remember where we started, notify nothing.
    writeHighWaterMark(key, currentTotal);
    return 0;
  }
  if (currentTotal <= mark) return 0;
  let fired = 0;
  let processedThrough = mark;
  let completed = true;
  for (const m of ladder) {
    if (currentTotal < m) break;
    if (m <= mark) continue;
    const result = await deliverDashboardNotification({
      topic: "dashboard.milestone",
      title: "Audience milestone reached",
      body: "Open Moosewave to review your workspace growth.",
      eventIdentity: `${identityScope?.trim() || "default"}:${m}`,
      occurredAt: new Date().toISOString(),
    });
    if (result === "failed" || result === "in-flight") {
      completed = false;
      break;
    }
    processedThrough = m;
    if (result === "delivered") fired += 1;
  }
  writeHighWaterMark(key, completed ? currentTotal : processedThrough);
  return fired;
}
