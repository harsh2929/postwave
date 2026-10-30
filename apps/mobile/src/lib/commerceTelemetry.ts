/**
 * lib/commerceTelemetry.ts — the one emitter for the commerce/connector
 * cluster's ACTIONS.
 *
 * COMMERCE#58: billing, integrations, discounts, inbound + outbound webhooks
 * and the QR scanner all shipped as fully interactive screens whose only
 * telemetry was the shared `mobile.tab_viewed` the tab layout emits. So it was
 * possible to know that people OPEN the webhooks screen and impossible to know
 * whether anyone has ever replayed a delivery from a phone — which is the
 * whole premise of putting those screens on a phone.
 *
 * One canonical event with a bounded `kind`, rather than one event per screen:
 * these are the same question asked of six surfaces, and a name per screen is
 * how @postwave/telemetry's taxonomy rotted the first time.
 *
 * PII discipline. `kind` is a slug from ACTION_KINDS below — never an endpoint
 * URL, a connector's account name, a discount code, or a scanned payload.
 * `outcome` is a closed enum. lib/telemetry's allowlist would drop anything
 * else, silently in production; keeping the surface this narrow means nothing
 * ever reaches that drop.
 */
import { EVENTS } from "@postwave/telemetry";

import { track } from "./telemetry";

/**
 * Every action this cluster reports. Adding a screen means adding a slug here,
 * which is the review point — not a free-form string at a call site.
 */
export const COMMERCE_ACTION_KINDS = [
  "billing_portal",
  "integration_manage",
  // Enable / disable / rotate-secret / delete on either webhook half. One slug
  // rather than four: the question is "does anyone administer a webhook from a
  // phone", and splitting it four ways answers none of them at this volume.
  "webhook_manage",
  "webhook_test",
  "scan_code",
] as const;
// Deliberately no `discount_manage`: app/(tabs)/discounts.tsx is read-only —
// it has no onPress and no mutation — so its screen view (mobile.tab_viewed,
// emitted by useScreenViewed) already IS the whole story for that surface. A
// slug with no call site is a taxonomy that looks wired and is not.

export type CommerceActionKind = (typeof COMMERCE_ACTION_KINDS)[number];

/**
 * `refused` is distinct from `failure` on purpose: it means the CLIENT
 * declined to proceed (an unsafe redirect, an offline write, a role that
 * cannot act), which is a product signal, while `failure` is the server or the
 * network saying no.
 */
export type CommerceActionOutcome =
  | "success"
  | "failure"
  | "refused"
  | "unrecognized";

export function trackCommerceAction(
  kind: CommerceActionKind,
  outcome: CommerceActionOutcome,
): void {
  track(EVENTS.MOBILE_COMMERCE_ACTION, { kind, outcome });
}
