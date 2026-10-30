/**
 * useDeliverabilityWidgetMirror — publish the workspace's sender health to the
 * home-screen widget, stamped with the moment the SERVER computed it
 * (DELIVERABILITY#64).
 *
 * THE ONE DESIGN DECISION WORTH THE COMMENT: `measuredAt` is the hub payload's
 * own `computed_at`, not `Date.now()` and not TanStack's `dataUpdatedAt`.
 *
 * The commerce mirror uses `dataUpdatedAt` because a store's analytics carry no
 * server-side measurement time. This payload does: the handler sets
 * `ComputedAt: d.now()` on every request (deliverability_hub/hub.go:201), and
 * `useDeliverabilityHub` is SNAPSHOT-BACKED — an offline device replays a
 * saved hub whose `computed_at` may be hours old. Stamping that with the
 * arrival time would publish a stale score to the home screen as if it had
 * just been taken, which is precisely what the widget's "as of" line exists to
 * prevent. Using the server's own timestamp means a cached screen publishes a
 * cached age, and the widget says so.
 *
 * An unparseable or absent `computed_at` publishes NOTHING rather than
 * inventing one. An absent measurement is not a zero.
 */
import { useEffect, useRef } from "react";

import type { HubLike } from "@/lib/deliverabilityHubView";
import { writeDeliverabilityWidgetSnapshot } from "@/lib/widgetDeliverability";
import {
  computedAtMs,
  buildDeliverabilityWidgetPayload,
  shouldPublishDeliverabilityWidget,
  type DeliverabilityWidgetPayload,
} from "@/lib/widgetDeliverabilitySnapshot";

export interface DeliverabilityWidgetMirrorInput {
  /** The hub currently on screen, or undefined while there is none. */
  hub: HubLike | undefined;
}

export function useDeliverabilityWidgetMirror({
  hub,
}: DeliverabilityWidgetMirrorInput): void {
  /**
   * The last record this hook actually got into the container. Only updated
   * after a write REPORTS success, so a device that has not opted in — or
   * whose App Group is momentarily unavailable — retries on the next change
   * instead of believing it already published.
   */
  const published = useRef<DeliverabilityWidgetPayload | null>(null);

  // Derived scalars only. `hub` is a fresh object identity on every successful
  // read, and depending on it would rewrite the App Group (and spend an iOS
  // WidgetKit reload) every time the screen refetched.
  const score = hub?.score;
  const grade = hub?.grade;
  const status = hub?.status;
  const autoThrottled = hub?.autoThrottled;
  const breaches = hub?.breaches.length;
  const sends7d = hub?.sends7d;
  const computedAt = hub?.computedAt;

  useEffect(() => {
    if (hub === undefined) return;
    const input = {
      score,
      grade,
      status,
      autoThrottled,
      breaches,
      sends7d,
      measuredAtMs: computedAtMs(computedAt),
    };
    // Null means the record could not be published honestly — a grade that did
    // not come from the scorer, a count that was never measured, or no idea
    // when the server computed any of it. Leave whatever is there; it carries
    // its own expiry.
    const next = buildDeliverabilityWidgetPayload(input);
    if (!next) return;
    if (!shouldPublishDeliverabilityWidget(published.current, next)) return;
    published.current = writeDeliverabilityWidgetSnapshot(input);
  }, [
    hub,
    score,
    grade,
    status,
    autoThrottled,
    breaches,
    sends7d,
    computedAt,
  ]);
}
