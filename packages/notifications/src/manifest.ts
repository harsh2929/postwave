/**
 * Canonical notification-category manifest. The single source of truth that
 * maps each server event (the webhook EventType, e.g. approval.requested,
 * campaign.sent, subscriber.bounced) to its user-facing notification:
 * category, title/body templates, deep-link target, default-enabled flag,
 * and per-channel eligibility.
 *
 * The 2026-06-21 ecosystem audit found push copy + routing were duplicated
 * mobile-only-by-convention:
 *
 *   - the server's titleForEvent/bodyForEvent switch lived in the retired
 *     public mobile relay rather than a current-user delivery channel,
 *   - mobile re-derived the route in apps/mobile/src/lib/deepLinks.ts,
 *   - desktop emitted only local OS notifications with no shared copy,
 *   - and the web PWA had no push handler at all.
 *
 * This manifest is the TypeScript client contract. The Go mobile-device sender
 * mirrors its bounded event/copy set in apps/api/internal/mobilepush; the
 * cross-language manifest test rejects event/default drift, and runtime code
 * rejects unsupported event names at registration and send time. The deep-link target reuses
 * @postwave/route-map entity keys so a notification reconstructs the same
 * entity on every supported client.
 */

import { type EntityKey } from "@postwave/route-map";

/**
 * Delivery channels a notification can reach. Mirrors the audit's
 * push/desktop/web split:
 *
 *   - `push`    — mobile push via Expo (apps/api/internal/mobilepush),
 *   - `desktop` — desktop native OS notification (Tauri show_native_notification),
 *   - `web`     — browser Web Push via the service worker (the PWA gap the
 *                 audit wants closed).
 */
export type Channel = "push" | "desktop" | "web";

export const CHANNELS: readonly Channel[] = ["push", "desktop", "web"];

/**
 * Coarse category used to group notifications for per-category preferences
 * (Apple-style "toggle a category off and it silences everywhere"). The
 * server's NotificationSettings should gate on this, not on raw event_type.
 */
export type NotificationCategory =
  | "security"
  | "approvals"
  | "campaigns"
  | "subscribers"
  | "automations"
  | "migrations"
  | "forms"
  // COMMERCE#3 — the outbound-webhook plumbing that carries a tenant's data to
  // their own systems. Its own category because "an integration stopped" is a
  // different decision from anything in the six above, and Android's per-channel
  // controls are the only place a person can silence one class without the rest.
  | "integrations"
  // COMMERCE#4 — money. Separate for the same reason, and because it is the one
  // category a workspace admin should essentially never turn off: an unnoticed
  // failed payment ends in a lapsed workspace.
  | "billing"
  // DELIVERABILITY#15 — sender health at the WORKSPACE level, which is a
  // different decision from `subscribers`. The per-subscriber bounce/complaint
  // events already live in `subscribers`, and they are far too granular to act
  // on: one address bouncing is bookkeeping. "The account score crossed the
  // degraded threshold" and "Moosewave has cut your send rate" are single,
  // account-scoped incidents an operator must respond to, and folding them in
  // with per-subscriber noise would mean the only way to silence the noise is
  // to silence the incident too.
  | "deliverability";

/**
 * Every category, in the order a preferences UI should list them: the ones that
 * block a person or a workspace first, the high-volume FYI ones last. Exported
 * so per-category UI and the Android channel registration derive their order
 * from one place instead of each re-listing it.
 */
export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  "security",
  "approvals",
  "billing",
  // Above `integrations` because an auto-throttle is already costing the
  // workspace delivered mail per hour, where a paused webhook costs a data
  // copy the tenant can backfill.
  "deliverability",
  "integrations",
  "campaigns",
  "subscribers",
  "automations",
  "migrations",
  "forms",
];

export interface NotificationDef {
  /** The server event type. Matches webhooks.EventType / AllEvents. */
  event: string;
  /** Grouping for per-category preferences. */
  category: NotificationCategory;
  /**
   * Title template. `{field}` placeholders are filled from the context
   * passed to notificationForEvent; unknown/missing fields fall back to the
   * generic title (templates here are deliberately context-light so an
   * empty context still renders a sensible string).
   */
  titleTemplate: string;
  /** Body template. Same placeholder rules as `titleTemplate`. */
  bodyTemplate: string;
  /**
   * The entity this notification deep-links to, by @postwave/route-map
   * EntityKey, or `null` when there is no single entity target (the client
   * should open the relevant list/home instead). The concrete id comes from
   * the event context at render time.
   */
  deepLinkEntity: EntityKey | null;
  /**
   * Whether the category is ON by default for a new user. High-signal,
   * decision-required events (approvals) default on; high-volume / FYI
   * events default off so the user opts in.
   */
  defaultEnabled: boolean;
  /** Channels eligible to deliver this notification. */
  channels: readonly Channel[];
}

const ALL_CHANNELS: readonly Channel[] = CHANNELS;

/**
 * The manifest, keyed by event type. Covers the bounded event set understood
 * by the dedicated mobile-device sender plus the rest of webhooks.AllEvents that are notification-
 * worthy. Events in AllEvents that are pure machine-to-machine integrations
 * (the digest rollups, per-recipient open/click firehoses, merge/delete data
 * ops) are intentionally NOT user notifications and are omitted — a webhook
 * subscriber still receives them; they just don't surface as a ping.
 */
export const NOTIFICATIONS: Record<string, NotificationDef> = {
  /**
   * A low-volume account-security alert. The body intentionally contains no
   * IP address, cookie, device code or verifier: lock-screen copy is public to
   * anyone holding the phone. The opaque session id is supplied separately as
   * the exact single-session revoke target.
   */
  "auth.new_device_sign_in": {
    event: "auth.new_device_sign_in",
    category: "security",
    titleTemplate: "New sign-in to your Moosewave account",
    bodyTemplate:
      "A new device signed in. Review active sessions if this wasn't you.",
    deepLinkEntity: null,
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
  "approval.escalated": {
    event: "approval.escalated",
    category: "approvals",
    titleTemplate: "Approval overdue",
    bodyTemplate: "A request has passed its escalation window and still needs a decision.",
    // Same destination as the request: approval has no detail screen, so
    // route-map's mobilePath lands on the queue.
    deepLinkEntity: "approval",
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
  "approval.requested": {
    event: "approval.requested",
    category: "approvals",
    titleTemplate: "Approval needed",
    bodyTemplate: "A pending request is waiting for your decision.",
    // approval is a route-map EntityKey; mobile lands on the approvals queue
    // (approval has no detail screen) — route-map's mobilePath handles that.
    deepLinkEntity: "approval",
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
  "campaign.sent": {
    event: "campaign.sent",
    category: "campaigns",
    titleTemplate: "Campaign sent",
    bodyTemplate: "{campaignName} finished sending.",
    deepLinkEntity: "campaign",
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
  "campaign.opened": {
    event: "campaign.opened",
    category: "campaigns",
    titleTemplate: "Campaign opened",
    bodyTemplate: "A recipient opened {campaignName}.",
    deepLinkEntity: "campaign",
    // High volume — opt-in only.
    defaultEnabled: false,
    channels: ALL_CHANNELS,
  },
  "campaign.clicked": {
    event: "campaign.clicked",
    category: "campaigns",
    titleTemplate: "Link clicked",
    bodyTemplate: "A recipient clicked a link in {campaignName}.",
    deepLinkEntity: "campaign",
    defaultEnabled: false,
    channels: ALL_CHANNELS,
  },
  "subscriber.created": {
    event: "subscriber.created",
    category: "subscribers",
    titleTemplate: "New subscriber",
    bodyTemplate: "A new subscriber joined.",
    deepLinkEntity: "subscriber",
    defaultEnabled: false,
    channels: ALL_CHANNELS,
  },
  "subscriber.confirmed": {
    event: "subscriber.confirmed",
    category: "subscribers",
    titleTemplate: "Subscriber confirmed",
    bodyTemplate: "A subscriber confirmed their email.",
    deepLinkEntity: "subscriber",
    defaultEnabled: false,
    channels: ALL_CHANNELS,
  },
  "subscriber.unsubscribed": {
    event: "subscriber.unsubscribed",
    category: "subscribers",
    titleTemplate: "Subscriber unsubscribed",
    bodyTemplate: "A subscriber opted out.",
    deepLinkEntity: "subscriber",
    defaultEnabled: false,
    channels: ALL_CHANNELS,
  },
  "subscriber.bounced": {
    event: "subscriber.bounced",
    category: "subscribers",
    titleTemplate: "Subscriber bounced",
    bodyTemplate: "A message bounced for a subscriber.",
    deepLinkEntity: "subscriber",
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
  "subscriber.complained": {
    event: "subscriber.complained",
    category: "subscribers",
    titleTemplate: "Spam complaint received",
    bodyTemplate: "A recipient marked an email as spam.",
    deepLinkEntity: "subscriber",
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
  "automation.completed": {
    event: "automation.completed",
    category: "automations",
    titleTemplate: "Automation completed",
    bodyTemplate: "An automation run finished.",
    // sequence is the route-map entity behind an automation/sequence run.
    deepLinkEntity: "sequence",
    defaultEnabled: false,
    channels: ALL_CHANNELS,
  },
  "automation.failed": {
    event: "automation.failed",
    category: "automations",
    titleTemplate: "Automation failed",
    bodyTemplate: "An automation run failed and needs attention.",
    deepLinkEntity: "sequence",
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
  "sequence.generated": {
    event: "sequence.generated",
    category: "automations",
    titleTemplate: "Sequence ready",
    bodyTemplate: "A generated sequence is ready to review.",
    deepLinkEntity: "sequence",
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
  /**
   * AUTOMATION#41 — automation HEALTH, which is not the same thing as
   * automation FAILURE.
   *
   * `automation.failed` covers a run that died: there is an error, a stack, a
   * terminal state someone can find. This covers the opposite and much quieter
   * condition — nothing errored, nothing is moving. The stuck scanner
   * (services/voice/internal/stuckworker) has always detected it and has always
   * emitted a `sequence.participants.stuck` fanout row for it; nothing ever
   * turned that into a notification a person receives.
   *
   * Deliberately shares the `automations` category and the `sequence` entity
   * with the two events above: the decision a person makes about all three is
   * "do I care about journeys right now", and one Android channel for the set
   * is better than a channel nobody can tell apart from its neighbour.
   *
   * Default ON, like the other "something needs attention" events. It is
   * inherently low volume — the scanner sweeps daily, and the emitter dedupes
   * to at most one notification per sequence per day.
   */
  "sequence.participants.stuck": {
    event: "sequence.participants.stuck",
    category: "automations",
    titleTemplate: "Participants stuck",
    bodyTemplate:
      "People have been waiting in a sequence longer than its stuck threshold.",
    deepLinkEntity: "sequence",
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
  "migration.completed": {
    event: "migration.completed",
    category: "migrations",
    titleTemplate: "Migration complete",
    bodyTemplate: "Your migration finished importing.",
    // Migration has no route-map entity (it's an auth/credential hand-off,
    // not a list entity) — clients open the migrations home.
    deepLinkEntity: null,
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
  "migration.failed": {
    event: "migration.failed",
    category: "migrations",
    titleTemplate: "Migration failed",
    bodyTemplate: "Your migration ran into a problem.",
    deepLinkEntity: null,
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
  "form.submitted": {
    event: "form.submitted",
    category: "forms",
    titleTemplate: "Form submitted",
    bodyTemplate: "Someone submitted a form.",
    // Forms aren't a route-map entity; mobile sends these to the dashboard.
    deepLinkEntity: null,
    defaultEnabled: false,
    channels: ALL_CHANNELS,
  },
  "form.confirmed": {
    event: "form.confirmed",
    category: "forms",
    titleTemplate: "Form confirmed",
    bodyTemplate: "A form submission was confirmed.",
    deepLinkEntity: null,
    defaultEnabled: false,
    channels: ALL_CHANNELS,
  },
  /**
   * COMMERCE#3. The server has detected and acted on this for a long time —
   * `AutoDisableThreshold` consecutive failures pauses the endpoint and an
   * outbox worker emails the owner — but there was no manifest entry, so no
   * client could ever be told. Queued deliveries stop until a human re-enables
   * it, which makes this exactly the "you need to know now" class.
   *
   * Default ON, like every other "something is broken" event
   * (automation.failed, migration.failed). `deepLinkEntity: null` because
   * webhooks are not a route-map entity and mobile ships no
   * `/(tabs)/webhooks/[id]` — the list IS the destination.
   *
   * NEVER add the receiver URL to this copy. Path/query components of a
   * webhook destination can be capabilities; the email notifier omits them for
   * the same reason and a push payload is even less private than an inbox.
   */
  "webhook.auto_disabled": {
    event: "webhook.auto_disabled",
    category: "integrations",
    titleTemplate: "Webhook paused",
    bodyTemplate:
      "An outbound webhook was paused after repeated delivery failures.",
    deepLinkEntity: null,
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
  /**
   * COMMERCE#4. A failed charge already sets `billing_state.dunning`, writes a
   * `billing.payment.failed` audit row and sends a dunning email. A workspace
   * whose owner does not read that email lapses silently.
   *
   * The copy deliberately says only what the existing dunning email says — the
   * charge did not go through, update the payment method. It does NOT restate
   * the email's conditional "sending will be paused", because a push is not the
   * place to make a commitment about what happens next.
   */
  /**
   * GOVERNANCE#48. A sink's breaker opens after FailureThresholdToOpen
   * consecutive delivery failures, at which point audit events stop reaching
   * the customer's SIEM and start piling into audit_sink_dlq. Everything
   * needed to notice was already returned by GET /api/v1/audit-sinks —
   * circuit_state, consecutive_failures — and it was discovered only if
   * somebody happened to open the screen. For a compliance pipeline, "we
   * stopped shipping your audit trail an hour ago" is the notification.
   *
   * Shares the `integrations` category with webhook.auto_disabled: both are
   * "an outbound delivery destination stopped accepting our data", which is
   * the decision a person makes about them, and one Android channel for the
   * pair is better than two channels nobody can tell apart.
   */
  "auditsink.circuit_opened": {
    event: "auditsink.circuit_opened",
    category: "integrations",
    titleTemplate: "Audit sink stopped",
    bodyTemplate:
      "An audit sink stopped accepting events. New audit records are being held.",
    deepLinkEntity: null,
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
  /**
   * DELIVERABILITY#15 — the account deliverability score crossed BELOW the
   * degraded threshold.
   *
   * The hub worker has computed this hourly for a long time and already fires a
   * `list_health.degraded` OUTBOUND WEBHOOK on the same down-crossing, so the
   * detection, the directional edge and the "don't re-fire while it stays low"
   * rule are all settled behaviour. What was missing is that a webhook only
   * reaches a tenant who built an integration to receive one; nobody on the
   * team was ever told.
   *
   * Down-crossing only, which is what makes this notifiable at all: the
   * condition persists for hours or days, and an alert per recompute would be
   * an hourly ping about a fact the operator already knows.
   *
   * `deepLinkEntity: null` — account health is not an entity. The hub screen is
   * the destination, and it is where the breach list and its fix CTAs live.
   */
  "deliverability.degraded": {
    event: "deliverability.degraded",
    category: "deliverability",
    titleTemplate: "Deliverability degraded",
    bodyTemplate:
      "This workspace's deliverability score dropped below the healthy threshold.",
    deepLinkEntity: null,
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
  /**
   * DELIVERABILITY#15 — Moosewave has ALREADY cut this workspace's send rate.
   *
   * The reputation-repair worker halves `max_sends_per_hour` after the score
   * stays under AutoThrottleScoreThreshold for a full sustain window. Until now
   * the only way to discover that was to open the hub screen and read
   * `auto_throttled`, which meant the common case was learning it from a
   * customer asking why the campaign is crawling.
   *
   * This is the one deliverability event that reports an ACTION taken against
   * the workspace rather than a measurement of it, and it is exactly one push
   * per incident — the worker refuses to apply a second throttle while an
   * uncleared override row exists.
   */
  "deliverability.auto_throttled": {
    event: "deliverability.auto_throttled",
    category: "deliverability",
    titleTemplate: "Sending auto-throttled",
    bodyTemplate:
      "Moosewave reduced this workspace's send rate to protect sender reputation.",
    deepLinkEntity: null,
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
  /**
   * Campaign assurance — the gate that can categorically REFUSE a send.
   *
   * `assurance.run.blocked` and `assurance.run.completed` have been outbound
   * webhook topics since P4.3 (outbound_webhooks.go `AllowedEvents`), so the
   * event could already reach a stranger's HTTP endpoint. It could not reach
   * the operator. Nothing assurance-related existed in this manifest at all,
   * which meant `allowedDeviceEvents` could never carry it either — so the one
   * system in the platform that stops a send outright had no way to tell a
   * person it had done so, on any channel.
   *
   * That is the missing half of the whole assurance surface. Mobile can now
   * render a run and start one (a run takes ~20 minutes), and there was no
   * answer to "how do I learn it finished, or that tonight's send was blocked,
   * without holding the app open?".
   *
   * BOTH DEFAULT ON, for the two established reasons:
   *   blocked   — the "something is broken / refusing" class, like
   *               automation.failed and webhook.auto_disabled. Edge-triggered,
   *               so "on" costs at most one notification per blocked send, and
   *               a send silently not going out is the expensive state.
   *   completed — the "long job you started has finished" class, like
   *               migration.completed. A person who kicked off a 20-minute run
   *               from a phone and walked away is exactly who this is for.
   *
   * There is deliberately NO "passed" event, mirroring the webhook topics: a
   * run that finished without complete evidence is `incomplete`, never green,
   * and a separate success event would invite readers to treat it as one. The
   * decision travels inside the completed payload.
   */
  "assurance.run.blocked": {
    event: "assurance.run.blocked",
    category: "campaigns",
    titleTemplate: "Send blocked by assurance",
    bodyTemplate: "{campaignName} was refused by the assurance gate.",
    deepLinkEntity: "campaign",
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
  "assurance.run.completed": {
    event: "assurance.run.completed",
    category: "campaigns",
    titleTemplate: "Assurance run finished",
    bodyTemplate: "The assurance run for {campaignName} has a verdict.",
    deepLinkEntity: "campaign",
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
  "billing.payment_failed": {
    event: "billing.payment_failed",
    category: "billing",
    titleTemplate: "Payment failed",
    bodyTemplate:
      "Your latest payment didn't go through. Update your payment method.",
    deepLinkEntity: null,
    defaultEnabled: true,
    channels: ALL_CHANNELS,
  },
};

/** Generic fallback used for unknown / unmapped events. Mirrors the server's
 *  default arm of titleForEvent/bodyForEvent. */
export const DEFAULT_NOTIFICATION = {
  title: "Moosewave update",
  body: "Open Moosewave for details.",
} as const;

export type NotificationEvent = keyof typeof NOTIFICATIONS;

export const NOTIFICATION_EVENTS = Object.keys(NOTIFICATIONS);
