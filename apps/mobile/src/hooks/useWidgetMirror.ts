/**
 * useWidgetMirror — publish the headline metrics to the home-screen widget's
 * App Group container, and no more often than they actually change.
 *
 * The effect this replaces depended on `stats.data` — a fresh object on every
 * 30-second poll even when every value was byte-identical — so it performed
 * nine ExtensionStorage writes plus an `ExtensionStorage.reloadWidget()` every
 * half minute for as long as the dashboard was open. iOS budgets WidgetKit
 * reload requests; spending that budget on identical data makes a reload
 * unavailable at the moment something genuinely changes.
 *
 * So the payload is derived with the pure `buildWidgetPayload` first, compared
 * against the last one written, and an unchanged payload is a no-op.
 *
 * TWO THINGS THAT MAKE THAT DEDUPE SAFE, both of which it is silently wrong
 * without:
 *
 *  - THE SNAPSHOT HAS AN EXPIRY. `writeWidgetSnapshot` stamps
 *    `pw_widget_expires_at` at now + WIDGET_SNAPSHOT_TTL_MS, and the native
 *    side refuses to render a snapshot past it. Deduping on VALUE alone
 *    therefore lets the widget go blank on any workspace whose numbers are
 *    stable for fifteen minutes — a quiet night is exactly when nothing
 *    changes. A heartbeat re-stamps the snapshot before it lapses, whether or
 *    not the figures moved, and it is independent of polling (which is itself
 *    suspended while the dashboard tab is unfocused).
 *  - A FAILED WRITE IS NOT A WRITE. `writeWidgetSnapshot` returns false when
 *    the user has not opted into widget metrics, and when the App Group is
 *    momentarily unavailable. Recording the fingerprint regardless meant that
 *    opting in from Settings and returning to an unchanged dashboard left the
 *    widget empty until some number happened to move. The fingerprint is only
 *    remembered after a write that reported success.
 *
 * Nothing is invented on the way out: a null open rate stays null instead of
 * being coerced to 0 at the call site, and as of DASHBOARD#72 the App Group
 * contract carries that null the whole way — `buildWidgetPayload` publishes an
 * absence marker beside each figure, so the widget and Siri can tell a genuine
 * 0% open rate from a field the stats payload never returned. See the note in
 * lib/widgetPayload.ts.
 */
import { useEffect, useRef, useState } from "react";

import { EVENTS } from "@postwave/telemetry";

import {
  pickCampaignsSent30d,
  pickOpenRate,
  pickSubscribersTotal,
  type DashboardStats,
} from "@/hooks/useDashboard";
import { track } from "@/lib/telemetry";
import {
  WIDGET_SNAPSHOT_FRESH_MS,
  buildWidgetPayload,
  writeWidgetSnapshot,
} from "@/lib/widgetData";

/**
 * Re-stamp at a third of the FRESHNESS window — not the disclosure TTL.
 *
 * The two used to be the same fifteen minutes so it did not matter which one
 * this divided; they are now fifteen minutes and twelve hours (see
 * lib/widgetData.ts). Dividing the TTL would heartbeat every four hours and
 * let the widget advertise "3h ago" while the Dashboard tab is open and the
 * real numbers are seconds old. Freshness is what this interval defends.
 */
export const WIDGET_REFRESH_MS = Math.floor(WIDGET_SNAPSHOT_FRESH_MS / 3);

export interface WidgetMirrorInput {
  stats: DashboardStats | undefined;
  workspaceName: string | undefined;
  /**
   * Pending approvals count, or NULL when it is genuinely unknown — the
   * approvals query is gated, offline, or still in flight.
   *
   * This used to be a plain `number` fed by a hook that returned
   * `data?.length ?? 0`, so a device with cached stats and an unresolved
   * approvals query published "To approve: 0" to the home screen: a
   * governance surface asserting there is nothing to do when it simply did
   * not know. Null is now carried all the way here, and the effect below
   * holds the last value it actually published rather than inventing one.
   */
  pending: number | null;
}

export function useWidgetMirror({
  stats,
  workspaceName,
  pending,
}: WidgetMirrorInput): void {
  const written = useRef<{ fingerprint: string; at: number } | null>(null);
  /**
   * The last pending count actually published. An unknown count reuses it, so
   * the widget keeps showing the last thing that was TRUE instead of a fresh
   * zero. Until anything has been published the whole snapshot write is
   * deferred — the widget's own `pw_widget_expires_at` already handles
   * "we could not refresh", and an empty widget is a smaller lie than a
   * wrong one.
   */
  const lastPending = useRef<number | null>(null);
  const subscribers = pickSubscribersTotal(stats);
  const openRate = pickOpenRate(stats);
  const sent30d = pickCampaignsSent30d(stats);
  const hasStats = Boolean(stats);

  // Bare counter rather than a clock: it exists only to re-run the effect
  // below, and a timestamp in the dep array would re-run it every tick.
  const [heartbeat, setHeartbeat] = useState(0);
  useEffect(() => {
    if (!hasStats) return;
    const timer = setInterval(
      () => setHeartbeat((n) => n + 1),
      WIDGET_REFRESH_MS,
    );
    return () => clearInterval(timer);
  }, [hasStats]);

  useEffect(() => {
    if (!hasStats) return;
    const publishablePending = pending ?? lastPending.current;
    // Nothing true has ever been known about the approvals queue. Publishing
    // now would mean publishing a zero we did not measure.
    if (publishablePending === null) return;
    const input = {
      subscribers,
      openRate: openRate === null ? null : openRate * 100,
      sent30d,
      pending: publishablePending,
      workspace: workspaceName || "Moosewave",
    };
    const fingerprint = JSON.stringify(buildWidgetPayload(input));
    const last = written.current;
    const stillFresh =
      last !== null &&
      last.fingerprint === fingerprint &&
      Date.now() - last.at < WIDGET_REFRESH_MS;
    if (stillFresh) return;

    if (writeWidgetSnapshot(input)) {
      written.current = { fingerprint, at: Date.now() };
      lastPending.current = publishablePending;
      trackWidgetState("published");
    } else {
      written.current = null;
      // NATIVE#56: a false return is either "not opted in" or a failed/torn
      // App Group write, and both look identical from the home screen — an
      // empty tile. Without this the cluster's only health signal was a user
      // complaint. Outcome enum only; the figures stay on the device.
      trackWidgetState("write_refused");
    }
    // Derived scalars only — `stats.data` itself is a new object identity on
    // every successful poll and would defeat the whole point.
  }, [
    heartbeat,
    hasStats,
    subscribers,
    openRate,
    sent30d,
    pending,
    workspaceName,
  ]);
}

/**
 * One structural line per publish attempt: `kind` names the OS surface and
 * `outcome` is a bounded enum. Deliberately NOT emitted from lib/widgetData —
 * that module is import-free of expo-secure-store on purpose so its node
 * vitest suite can load it, and lib/telemetry pulls SecureStore in.
 */
function trackWidgetState(outcome: "published" | "write_refused"): void {
  track(EVENTS.MOBILE_WIDGET_STATE, { kind: "widget", outcome });
}
