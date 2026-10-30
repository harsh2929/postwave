/**
 * subscriberTracking — per-subscriber open/click tracking preferences, the
 * "stop tracking me" request honored from a phone.
 *
 * Desktop's TrackingPrefsPanel distinguishes two layers, and this module
 * keeps them distinct because collapsing them misreports the law:
 *
 *  - the EXPLICIT opt-out (open_opt_out_at / click_opt_out_at) — subscriber
 *    evidence this workspace recorded and can also clear;
 *  - the EFFECTIVE state (effective_open_opt_out / effective_click_opt_out)
 *    — what send-time will actually do, which also honors Global Privacy
 *    Control. GPC comes from the subscriber's browser: the switch can record
 *    an ADDITIONAL explicit opt-out but can never override GPC, and the
 *    sentences below say so (mirroring desktop's effectiveHelp verbatim in
 *    intent).
 *
 * The PATCH body mirrors consent.TrackingPatchInput key for key; the write
 * is conditional on the strong quoted ETag the GET returned (tracking.go
 * rejects absent/weak/list If-Match), which the transport carries.
 *
 * Import-free so every rule runs in the node vitest suite.
 */

export interface TrackingPrefsState {
  subscriberId: string;
  /** Explicit subscriber evidence, ISO or null. */
  openOptOutAt: string | null;
  clickOptOutAt: string | null;
  /** What send-time will actually do (includes GPC). */
  effectiveOpenOptOut: boolean;
  effectiveClickOptOut: boolean;
  gpc: boolean;
  source: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The GET body (consent.TrackingPrefs). Null for junk — never a fake row. */
export function parseTrackingPrefs(payload: unknown): TrackingPrefsState | null {
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as Record<string, unknown>;
  const id = str(rec.subscriber_id);
  if (!id) return null;
  return {
    subscriberId: id,
    openOptOutAt: str(rec.open_opt_out_at) || null,
    clickOptOutAt: str(rec.click_opt_out_at) || null,
    effectiveOpenOptOut: rec.effective_open_opt_out === true,
    effectiveClickOptOut: rec.effective_click_opt_out === true,
    gpc: rec.gpc === true,
    source: str(rec.source),
  };
}

/**
 * The status sentence per dimension — desktop's effectiveHelp, phone-sized.
 * The words carry the layered truth; a switch position alone cannot.
 */
export function trackingDimensionSummary(
  channel: "Open" | "Click",
  explicitOptOut: boolean,
  effectiveOptOut: boolean,
  gpc: boolean,
): string {
  if (gpc && explicitOptOut) {
    return `${channel} tracking is off: the subscriber opted out AND their browser sends Global Privacy Control.`;
  }
  if (gpc && effectiveOptOut) {
    return `${channel} tracking is off by Global Privacy Control. Recording an explicit opt-out is allowed; overriding GPC is not.`;
  }
  if (explicitOptOut || effectiveOptOut) {
    return `${channel} tracking is off for this subscriber.`;
  }
  return `${channel} tracking is on for this subscriber.`;
}

/**
 * PATCH body for one dimension's explicit evidence — TrackingPatchInput,
 * key for key. Only the touched dimension is sent: an omitted key inherits,
 * and sending both would turn one recorded decision into two.
 */
export function buildTrackingPatchBody(
  dimension: "open" | "click",
  nextOptOut: boolean,
): Record<string, unknown> {
  return dimension === "open"
    ? { open_opt_out: nextOptOut }
    : { click_opt_out: nextOptOut };
}
