/**
 * lib/capabilityCoverage.ts — the SDK-anchored half of the honesty ledger.
 *
 * ── WHY THIS IS A SEPARATE FILE FROM desktopOnlyCapabilities.ts ────────────
 * That module holds copy that is RENDERED — the "not on this phone" rows a
 * user reads — so every sentence in it goes through the message catalogue and
 * the i18n guard enforces that. Nothing here is ever rendered. These are
 * verdicts an engineer reads in a guard failure, and routing engineering prose
 * through the translation catalogue would make translators responsible for
 * sentences no user will ever see.
 *
 * The two files answer different questions and are checked by different tests;
 * keeping them apart is what lets each be strict about the right thing.
 */
import type { MobileCoverage } from "@/lib/desktopOnlyCapabilities";

/**
 * ── THE THIRD ANCHOR: WHAT THE PLATFORM PUBLISHES ──────────────────────────
 *
 * The two tables above are anchored to UI: one to desktop's sidebar catalogue,
 * one to apps/web's dashboard directories. Both share a blind spot, and it is
 * structural rather than an oversight — a capability with NO screen on the
 * anchor surface can never produce a row, so it is invisible to the honesty
 * table by construction.
 *
 * `developer-marketplace` is the worked example. It has a full Go surface
 * (`developer_marketplace.go`: catalog, app CRUD, monitoring, and an admin
 * review queue with SEPARATE decision verbs for apps, listings and partner
 * profiles), a complete TypeScript SDK resource, and a paragraph of marketing
 * copy — and no human UI on web, desktop or mobile. Neither table above can
 * see it: there is no desktop sidebar section and no
 * `apps/web/src/app/(dashboard)/app/developer-marketplace` directory.
 *
 * So this table is anchored to `packages/sdk-ts/src/resources/` instead: one
 * row per resource the platform PUBLISHES, regardless of whether any surface
 * renders it. That is the honest denominator for "what can this product do,
 * and what does the phone do about each of them", and it is the only anchor
 * under which an API-only capability is representable at all.
 *
 * Its test fails when the SDK grows a resource with no verdict here — the same
 * ratchet as the other two, pointed at the contract rather than at a screen.
 */
export const SDK_RESOURCE_COVERAGE: Readonly<Record<string, MobileCoverage>> = {
  account: { kind: "route", mobileKey: "settings" },
  agency: { kind: "route", mobileKey: "agency" },
  "agent-mandates": { kind: "route", mobileKey: "agent-mandates" },
  // Generation is offered inside the composer surfaces that consume it, not as
  // a destination of its own.
  "ai-compose": { kind: "inside", hostKey: "campaigns" },
  analytics: { kind: "route", mobileKey: "analytics" },
  "api-keys": { kind: "route", mobileKey: "api-keys" },
  approvals: { kind: "route", mobileKey: "approvals" },
  archive: { kind: "route", mobileKey: "archive" },
  assets: { kind: "route", mobileKey: "assets" },
  // Shipped as AudienceDestinationsPanel inside the integrations hub. This
  // ENTRY existed before the panel did -- it claimed `inside` while the screen
  // never mentioned it -- so `every inside host actually mentions what it
  // hosts` now holds it to that. Reads are viewer-floored; pause/resume/
  // disconnect are admin. Create and `config` editing stay off the phone: see
  // lib/audienceDestinationRows.ts for why that seam falls there.
  "audience-destinations": { kind: "inside", hostKey: "integrations" },
  "audience-syncs": { kind: "route", mobileKey: "audience-syncs" },
  audiences: { kind: "route", mobileKey: "segments" },
  audit: { kind: "route", mobileKey: "audit" },
  "audit-sinks": { kind: "route", mobileKey: "audit-sinks" },
  // Pre-send authentication checks are part of the campaign review surface and
  // the deliverability hub; there is no separate "checks" destination anywhere.
  "auth-checks": { kind: "inside", hostKey: "deliverability" },
  automations: { kind: "route", mobileKey: "flows" },
  "campaign-assurance": { kind: "inside", hostKey: "campaigns" },
  "campaign-polls": { kind: "inside", hostKey: "campaigns" },
  "campaign-templates": { kind: "route", mobileKey: "templates" },
  campaigns: { kind: "route", mobileKey: "campaigns" },
  "campaigns-ab": { kind: "route", mobileKey: "flow-ab-tests" },
  "chat-integrations": { kind: "inside", hostKey: "integrations" },
  // HMAC signing keys for conversion ingest. Minting one reveals a secret
  // exactly once, which mobile has no hardened capture ceremony for.
  "conversion-ingest": { kind: "inside", hostKey: "conversions" },
  /**
   * The signing-key REGISTER, which is a different resource from the ingest
   * endpoint above and needs its own verdict.
   *
   * Mobile ships `IngestSecretsPanel` inside `ConversionsScreen`, and it
   * carries the stopping half only: it lists key metadata and revokes a leaked
   * key. It cannot MINT one, because issuing reveals the HMAC secret exactly
   * once and this platform has no hardened capture ceremony for that — the
   * same line `lib/stoppingHalfPolicy.ts` draws for every reveal-once
   * credential.
   */
  "conversion-ingest-secrets": { kind: "inside", hostKey: "conversions" },
  cost: { kind: "route", mobileKey: "billing" },
  "custom-domains": { kind: "route", mobileKey: "custom-domains" },
  /**
   * The partner/app-review programme. SDK-complete, marketing-documented, and
   * with no human UI on ANY surface — which is coherent for a developer API: a
   * partner integrates against it programmatically. Listing it as a mobile gap
   * would be false; leaving it out of the table entirely is how it stayed
   * invisible.
   */
  "developer-marketplace": {
    kind: "api_only",
    reason:
      "A partner-facing API. Apps are registered, validated and submitted for review programmatically through the SDK; the admin review queue has no client on web, desktop or mobile.",
  },
  discounts: { kind: "route", mobileKey: "discounts" },
  dmarc: { kind: "route", mobileKey: "dmarc" },
  // The transactional send API. Its OUTCOMES are on the deliverability triage
  // surface; sending a transactional message is a server's job, not a phone's.
  emails: { kind: "inside", hostKey: "deliverability" },
  events: { kind: "route", mobileKey: "product-events" },
  forms: { kind: "route", mobileKey: "forms" },
  "gift-subscriptions": { kind: "route", mobileKey: "gift-subscriptions" },
  // The v2 service-suite catalog explicitly holds inbound_email_bridge. The
  // Helpdesk mirror must not stand in for the separate inbound-email resource.
  "inbound-emails": { kind: "absent" },
  "inbound-routes": { kind: "route", mobileKey: "inbound-routes" },
  "inbound-webhooks": { kind: "route", mobileKey: "inbound-webhooks" },
  "inbox-reality": { kind: "inside", hostKey: "deliverability" },
  integrations: { kind: "route", mobileKey: "integrations" },
  "landing-pages": { kind: "route", mobileKey: "landing-pages" },
  "link-check": { kind: "inside", hostKey: "campaigns" },
  lists: { kind: "route", mobileKey: "lists" },
  migrations: { kind: "route", mobileKey: "migrations" },
  "mobile-push": { kind: "route", mobileKey: "notifications" },
  "native-integrations": { kind: "route", mobileKey: "integrations" },
  onboarding: { kind: "inside", hostKey: "settings" },
  preferences: { kind: "route", mobileKey: "subscribers" },
  referrals: { kind: "route", mobileKey: "referrals" },
  reputation: { kind: "route", mobileKey: "deliverability" },
  // NOT offered anywhere on mobile. This claimed `inside` -> `campaigns`, and
  // nothing there reaches it: no `client.safety` caller, no `/safety` path, and
  // no safety vocabulary in the campaigns screen or its components. The one SDK
  // method is `safety.check({subject, body_html, intended_audience_count})`,
  // which returns blocking findings BEFORE a send -- a pre-flight gate, so
  // claiming it while not shipping it is the worst direction to be wrong in.
  safety: {
    kind: "api_only",
    reason:
      "Pre-send content safety check (safety.check) has no mobile caller. It takes the full draft body and an audience count and returns blocking findings, so it belongs with composition rather than with the send button; mobile does not author campaign bodies, which is why it was never wired. Recorded as api_only rather than as coverage.",
  },
  // A sandbox tenant is created and driven by test harnesses, not by a person
  // on a phone.
  sandbox: {
    kind: "api_only",
    reason:
      "Sandbox tenants exist for automated testing. They are provisioned and torn down by test harnesses through the SDK; no surface renders them.",
  },
  scim: { kind: "route", mobileKey: "scim" },
  segments: { kind: "route", mobileKey: "segments" },
  sending: { kind: "route", mobileKey: "sending-settings" },
  "sending-settings": { kind: "route", mobileKey: "sending-settings" },
  "send-time": { kind: "route", mobileKey: "send-time" },
  sequences: { kind: "route", mobileKey: "sequences" },
  "slack-integrations": { kind: "inside", hostKey: "integrations" },
  sms: { kind: "route", mobileKey: "sms" },
  subscribers: { kind: "route", mobileKey: "subscribers" },
  suppressions: { kind: "route", mobileKey: "suppressions" },
  /**
   * Device-token suppressions, listed as `PushSuppressionsPanel` on the
   * suppressions screen rather than as a destination of their own. An operator
   * looking for "why is this person not getting notified" starts from the
   * suppression list, not from a push-specific route, so a separate tab would
   * split one question across two places.
   */
  "push-suppressions": { kind: "inside", hostKey: "suppressions" },
  tags: { kind: "route", mobileKey: "tags" },
  "template-preview": { kind: "inside", hostKey: "templates" },
  templates: { kind: "route", mobileKey: "templates" },
  topics: { kind: "inside", hostKey: "settings" },
  // The public event-ingest endpoint a customer's own site calls. There is
  // nothing for a person to operate.
  track: {
    kind: "api_only",
    reason:
      "The public tracking endpoint a customer's own website or server calls. It has no operator surface by design.",
  },
  "voice-drift": { kind: "inside", hostKey: "voice" },
  "voice-profile": { kind: "route", mobileKey: "voice" },
  webhooks: { kind: "route", mobileKey: "webhooks" },
};

/**
 * Capabilities with a DESKTOP client and no mobile one, which neither the
 * sidebar table nor the SDK table can represent: they are not sidebar sections
 * and they have no SDK resource, so they would otherwise be silently implied as
 * covered.
 *
 * Both were named by the audit's completeness pass and both are correctly
 * desk-shaped — the point of recording them is that "mobile doesn't do this"
 * should be a written verdict rather than an absence nobody noticed.
 */
export const DESKTOP_CLIENT_ONLY_CAPABILITIES: readonly {
  key: string;
  reason: string;
}[] = [
  {
    key: "translations",
    reason:
      "Multilingual sends: settings, a dictionary with CSV import/export, and a preview. Authoring a translation dictionary is keyboard work, and mobile does not compose campaigns, so there is nothing here a phone would finish.",
  },
  {
    key: "a11y-check",
    reason:
      "The email-accessibility linter (POST /api/v1/a11y/check). It belongs beside campaign composition, which is a desk surface — mobile reviews and approves campaigns rather than editing their markup.",
  },
];

/**
 * ── THE FOURTH ANCHOR: CAPABILITIES THAT ARE CARDS, NOT SECTIONS ───────────
 *
 * Three anchors still cannot see everything, and the reason is the same shape
 * as the two blind spots already fixed above it.
 *
 *   DESKTOP_SECTION_COVERAGE is keyed on desktop's sidebar catalogue.
 *   WEB_SECTION_COVERAGE is keyed on apps/web route directories.
 *   SDK_RESOURCE_COVERAGE is keyed on published SDK resources.
 *
 * A capability that renders as a CARD inside somebody else's page, and has no
 * SDK resource, is invisible to all three. It has no sidebar entry, no route
 * directory of its own, and nothing in packages/sdk-ts.
 *
 * An adversarial sweep found two, both with full server surfaces:
 *
 *   RSS feed sources — `/api/v1/feed-sources` list/create/update/delete plus
 *     poll-now and run history (`feed_ingest/handlers.go`), rendered by
 *     `FeedSourcesSection` on desktop's Campaigns page.
 *   Control groups — holdout cohorts and lift reporting over
 *     `/api/v1/control-groups`, rendered by `ControlGroupsCard` on the same
 *     page.
 *
 * Both are genuinely absent from mobile. Recording them is the point: "mobile
 * does not do this" should be a written verdict, and until now there was
 * nowhere it could be written.
 */
export interface DesktopCardCapability {
  /** The desktop component that renders it — the anchor a guard can check. */
  readonly component: string;
  readonly capability: string;
  readonly coverage: MobileCoverage;
}

export const DESKTOP_CARD_CAPABILITIES: readonly DesktopCardCapability[] = [
  {
    component: "FeedSourcesSection",
    capability: "RSS feed sources (feed-to-campaign ingestion)",
    coverage: {
      kind: "absent",
      // Configuring a feed URL, its cadence and its content mapping is setup
      // work done once, at a keyboard. The thing a phone WOULD want — "did
      // last night's poll fail?" — is already carried by the automation
      // failure notification, so the phone is not blind to the outcome.
    },
  },
  {
    component: "ControlGroupsCard",
    capability: "Control groups (holdout cohorts and lift reporting)",
    coverage: {
      kind: "absent",
      // Defining a holdout is an experiment-design act with a long tail: get
      // the cohort wrong and the lift number is wrong for the life of the
      // experiment. Reading a lift report on a phone would be reasonable; it
      // is the authoring that is not, and the two ship together on desktop.
    },
  },
];

/**
 * ── SERVER-COMPLETE, NO CLIENT ANYWHERE ────────────────────────────────────
 *
 * The four anchors above answer "does MOBILE cover this, and if not, was that a
 * decision?". They cannot express a fifth situation that adversarial sweeps
 * keep finding: a capability whose SERVER is complete and which has no client
 * on ANY surface — not mobile, not web, not desktop, not the SDK.
 *
 * That is not a mobile gap and it is not an `api_only` decision either. An
 * `api_only` capability is deliberately programmatic (a partner API, a tracking
 * endpoint). These are capabilities somebody built the back half of and stopped.
 * Calling them `absent` on mobile would file a product-wide gap as a phone
 * problem, which is how it stays invisible.
 *
 * Recorded here so the honest answer to "is this platform complete?" can
 * include them. Each is verified by the four-check method — path literal, SDK
 * method, BASE-const template, and screen inventory — because a path-literal
 * grep alone has produced three wrong conclusions in this repository.
 */
export interface ServerOnlyCapability {
  readonly capability: string;
  /** Where the routes are mounted, for anyone re-checking the claim. */
  readonly source: string;
  /** Why no client exists, as far as the code says. */
  readonly note: string;
}

export const SERVER_ONLY_CAPABILITIES: readonly ServerOnlyCapability[] = [
  {
    capability: "Service Suite ticketing (tickets, views, channels, macro CRUD, spam assessments, support report)",
    source: "apps/api/internal/service_suite/service_suite.go",
    note:
      "The CONVERSATIONS half of this module is fully client-side on mobile and desktop; the TICKET half is not. 16 mounted route-methods have no caller anywhere. " +
      "NOT BUILDABLE AS A CLIENT SLICE, and this is the decisive fact rather than a preference: the ONLY producer of `support_tickets` is `POST /api/v1/service-suite/tickets` itself (repo.go CreateTicket, reachable solely from the handler at service_suite.go). Nothing else in apps/api or services/ writes that table. " +
      "So a ticket list on any surface would be empty by construction for every workspace that has not driven the raw API — and shipping a permanently-empty screen is worse than shipping none, because it asserts a feature exists. " +
      "The Klaviyo gap-alleviation plan's KLV-10 entry agrees: it ships the routes and names 'workspace UI' as remaining work. Whether ticketing launches is a product decision, and it needs a producer before it needs a client.",
  },
  {
    capability: "Idempotency key inspector",
    source: "apps/api/internal/idempotency/inspector.go",
    note:
      "Admin routes that list and inspect stored idempotency keys. The server even hands clients a replay URL that nothing follows. Operator-debugging surface with a real audience (someone diagnosing a duplicated request) and no UI on any platform.",
  },
];
