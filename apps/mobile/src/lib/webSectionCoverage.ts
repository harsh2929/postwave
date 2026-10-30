/**
 * lib/webSectionCoverage.ts — the web-anchored half of the honesty ledger.
 *
 * ── THE SECOND ANCHOR (GUARD#2) ────────────────────────────────────────────
 * The desktop table in `desktopSectionCoverage.ts` reconciles against
 * apps/desktop's sidebar. That made a whole class of capability structurally
 * invisible: anything WEB ships that desktop does not. The table could be
 * complete, its test green, and mobile still silently behind on a surface
 * nobody was comparing against.
 *
 * So coverage is anchored twice. `WEB_SECTION_COVERAGE` records a verdict for every
 * directory under apps/web/src/app/(dashboard)/app, and its test fails when web
 * grows a section with no verdict here — the same ratchet the desktop table has,
 * pointed at the other surface.
 *
 * `inside` is used honestly rather than as an escape hatch: each one names the
 * mobile screen that actually hosts the capability.
 *
 * ── WHY THE KEYS BELOW INCLUDE NESTED PATHS ────────────────────────────────
 * This table originally enumerated only the TOP-LEVEL directories under
 * apps/web/src/app/(dashboard)/app. That anchoring had the same structural
 * blindness the table exists to prevent, one level down: `settings/team`,
 * `settings/custom-fields` and `subscribers/paid-members` are whole
 * capabilities, and each was silently absorbed by its parent's row. A verdict
 * of `settings: route` said nothing about whether mobile can administer a
 * team, and nothing ever asked.
 *
 * An adversarial sweep found five capabilities hiding this way — three here,
 * plus two that render as CARDS on a desktop page rather than as sidebar
 * sections (see DESKTOP_CARD_CAPABILITIES in lib/capabilityCoverage).
 *
 * So the guard now walks ONE LEVEL into every section, and a nested route
 * directory needs its own verdict. One level is deliberate rather than
 * arbitrary: below that the directories are `[id]` params and view fragments
 * of a capability already covered, not capabilities of their own.
 *
 * Import-free of react-native/expo by construction (its only import is a
 * type), so every rule above is unit-tested under node.
 */
import type { MobileCoverage } from "@/lib/mobileCoverage";

export const WEB_SECTION_COVERAGE: Readonly<Record<string, MobileCoverage>> = {
  affiliates: { kind: "absent" },
  // Web grew these four as top-level sections on 2026-08-30; every one already
  // had a mobile surface, so the verdicts simply say where.
  lists: { kind: "route", mobileKey: "lists" },
  // The PII findings review queue lives on the Compliance screen (built with
  // the 2026-08 parity pass), not as its own destination.
  "pii-findings": { kind: "inside", hostKey: "compliance" },
  "privacy-incidents": { kind: "route", mobileKey: "privacy-incidents" },
  tags: { kind: "route", mobileKey: "tags" },
  // Both shipped on web on 2026-08-22 and both already had a mobile screen, so
  // the verdict is `route` rather than `absent`: app/(tabs)/agency.tsx and
  // app/(tabs)/deliverability.tsx exist and the nav manifest points at them.
  agency: { kind: "route", mobileKey: "agency" },
  // mobileKey is the mobile ROW id, not the nav-manifest key: the manifest
  // calls the concept `deliverabilityHub` while the More row is `deliverability`.
  deliverability: { kind: "route", mobileKey: "deliverability" },
  // `inside` used honestly, not as an escape hatch: mobile reaches
  // /api/v1/verification/jobs through useVerificationJobs, rendered by
  // VerificationJobsPanel, which app/(tabs)/deliverability.tsx mounts. Web gave
  // the capability its own page; mobile hosts it in the deliverability screen.
  verification: { kind: "inside", hostKey: "deliverability" },
  analytics: { kind: "route", mobileKey: "analytics" },
  approvals: { kind: "route", mobileKey: "approvals" },
  billing: { kind: "route", mobileKey: "billing" },
  campaigns: { kind: "route", mobileKey: "campaigns" },
  // All three clients ship this workspace; mobile's admin-gated Stores route
  // is the operational, phone-sized view of the same commerce integrations.
  commerce: { kind: "route", mobileKey: "commerce" },
  // A compatibility matrix is reference material for someone choosing a plan or
  // debugging an integration at a desk; it carries no verb at all.
  compatibility: { kind: "absent" },
  discounts: { kind: "route", mobileKey: "discounts" },
  flows: { kind: "route", mobileKey: "flows" },
  /**
   * Web's flow CONFIGURATION page is a single `TriggerDelayPanel` behind a tab
   * shell. Mobile ships no equivalent, and this records that as a genuine gap
   * rather than letting the absence pass unnoticed.
   *
   * `absent`, not `inside`: nothing on the phone hosts it. Naming a host that
   * does not offer the capability is the failure mode this table exists to
   * prevent — the register's own test holds every `inside` claim to a screen
   * that actually mentions what it hosts.
   */
  "flows/configuration": { kind: "absent" },
  forms: { kind: "route", mobileKey: "forms" },
  "inbound-webhooks": { kind: "route", mobileKey: "inbound-webhooks" },
  // The pre-send predictor is on the campaign review surface, and the running
  // placement tests are on Deliverability, where the rest of the in-flight
  // resources live (InboxRealityTestsPanel).
  "inbox-reality": { kind: "inside", hostKey: "deliverability" },
  integrations: { kind: "route", mobileKey: "integrations" },
  "landing-pages": { kind: "route", mobileKey: "landing-pages" },
  migrations: { kind: "route", mobileKey: "migrations" },
  notifications: { kind: "route", mobileKey: "notifications" },
  // A first-customer pilot console: internal, time-boxed, and not something an
  // operator drives from a phone.
  pilot: { kind: "absent" },
  // Saved/scheduled report AUTHORING. Mobile surfaces the results these produce
  // (analytics, dashboard) but not the builder, which is desk work.
  reports: { kind: "absent" },
  sequences: { kind: "route", mobileKey: "sequences" },
  // Authoring a reusable sequence template is composition, and mobile does not
  // author sequences at all — see sequenceCapabilities.
  "sequence-templates": { kind: "absent" },
  settings: { kind: "route", mobileKey: "settings" },
  // ── settings/* ───────────────────────────────────────────────────────────
  "settings/api": { kind: "route", mobileKey: "api-keys" },
  "settings/audit": { kind: "route", mobileKey: "audit" },
  "settings/audit-sinks": { kind: "route", mobileKey: "audit-sinks" },
  // Tenant custom-field DEFINITIONS: create, edit, delete, plus the per-tenant
  // validator mode. Mobile renders field VALUES on a subscriber and cannot
  // administer the schema behind them — editing a definition retypes data
  // across an entire audience, which is not a phone act.
  "settings/custom-fields": { kind: "absent" },
  "settings/data-region": { kind: "inside", hostKey: "settings" },
  "settings/developer": { kind: "absent" },
  "settings/domain": { kind: "route", mobileKey: "custom-domains" },
  "settings/integrations": { kind: "route", mobileKey: "integrations" },
  "settings/notifications": { kind: "route", mobileKey: "notifications" },
  "settings/offline": { kind: "inside", hostKey: "settings" },
  "settings/privacy": { kind: "route", mobileKey: "compliance" },
  "settings/security": { kind: "inside", hostKey: "settings" },
  "settings/send-time": { kind: "route", mobileKey: "send-time" },
  "settings/sender": { kind: "route", mobileKey: "sending-settings" },
  // Desktop's section is the role × scope matrix (RolesSection). Mobile reads
  // it in Settings (WorkspaceRolesSection, GET /roles); re-permissioning a
  // role, inviting and role changes stay on the web — deliberate desk acts.
  "settings/team": { kind: "inside", hostKey: "settings" },
  "settings/topics": { kind: "inside", hostKey: "settings" },
  "settings/webhooks": { kind: "route", mobileKey: "webhooks" },
  // Web also exposes the canonical outbound-webhook workspace under Routing;
  // mobile's Webhooks route owns the same signed delivery controls.
  "routing/outbound-webhooks": { kind: "route", mobileKey: "webhooks" },
  sms: { kind: "route", mobileKey: "sms" },
  subscribers: { kind: "route", mobileKey: "subscribers" },
  // ── sub-views of a capability already covered above ─────────────────────
  // Each is a route in its own right, so each needs a verdict; none is a
  // separate capability. `inside` names the mobile screen that hosts the
  // parent, and `absent` marks an authoring step mobile deliberately lacks.
  "billing/upgrade": { kind: "inside", hostKey: "billing" },
  // Coupon-pool inventory. The discount boundary is a read-only archive on
  // every client — `MountRoutes` registers two GETs — so pool inventory and
  // coupon issuance are absent from mobile because they are absent from the
  // API, not because mobile skipped them. See lib/discountMutationBoundary.
  "discounts/coupon-pools": { kind: "absent" },
  "forms/new": { kind: "inside", hostKey: "forms" },
  "inbox-reality/campaigns": { kind: "inside", hostKey: "deliverability" },
  "inbox-reality/predict": { kind: "inside", hostKey: "campaigns" },
  "integrations/catalog": { kind: "route", mobileKey: "integrations" },
  "migrations/new": { kind: "inside", hostKey: "migrations" },
  // The OAuth return leg of a migration connect. It is a browser redirect
  // target, not a destination anybody navigates to.
  "migrations/oauth": { kind: "absent" },
  // Composition steps. Mobile creates sequences but does not author a
  // reusable TEMPLATE, and does not compose an email body at all.
  "sequence-templates/new": { kind: "absent" },
  "sequences/new": { kind: "inside", hostKey: "sequences" },
  "sequences/voice-profile": { kind: "route", mobileKey: "voice" },
  "templates/new": { kind: "absent" },
  // ── subscribers/* ────────────────────────────────────────────────────────
  "subscribers/duplicates": {
    kind: "route",
    mobileKey: "subscriber-duplicates",
  },
  "subscribers/import": { kind: "route", mobileKey: "subscriber-imports" },
  // Granting and revoking a paid membership moves money and entitlements. It
  // is a support act performed against a named person, and the desk surface
  // carries the search and the audit context that make it safe.
  "subscribers/paid-members": { kind: "absent" },
  "subscribers/segments": { kind: "route", mobileKey: "segments" },
  // The nested web page is the sanitized gift lifecycle archive; mobile
  // exposes that evidence in its Gift subscriptions route.
  "source-quality/gifts": {
    kind: "route",
    mobileKey: "gift-subscriptions",
  },
  suppressions: { kind: "route", mobileKey: "suppressions" },
  templates: { kind: "route", mobileKey: "templates" },
  // Voice LABELS are the taxonomy behind the brand-voice model; mobile ships the
  // voice screen that consumes them, not the label editor.
  "voice-labels": { kind: "inside", hostKey: "voice" },
  // ── The 2026-08-22 web sweep ─────────────────────────────────────────────
  // Fifty-two sections shipped on web in one pass, each closing a path desktop
  // reached and web did not. Every verdict below was decided by resolving the
  // page's API module to its `/api/v1/...` paths and grepping apps/mobile for
  // the same ones, then walking mobile's import graph from app/(tabs)/*.tsx to
  // confirm the code that answers is actually MOUNTED by a screen. A hook with
  // no renderer is not coverage, and three modules that looked like coverage
  // failed exactly that test.
  //
  // Most of these are operator surfaces, and `absent` is the honest verdict for
  // an operator surface on a field app rather than an admission of a gap.

  // Mobile ships the routine list at app/(tabs)/agent-routines.tsx, reading the
  // same /api/v1/agent-routines through api/agentRoutines.ts.
  "agent-routines": { kind: "route", mobileKey: "agent-routines" },
  // The MCP tool catalogue and the per-tool daily QUOTAS. api/mcpActivity.ts
  // declines both by name: a quota's blast radius is every agent in the
  // workspace, and setting one wrong stops production traffic.
  "agent-tools": { kind: "absent" },
  // The Answer Engine Optimization sensor: tracked prompts, competitors and
  // probe runs over /api/v1/aeo/*. Mobile reads no /aeo path; it is a research
  // console somebody works at a desk, and nothing on the phone hosts it.
  aeo: { kind: "absent" },
  // Web gave the assistant conversation its own page under ai-assist. Mobile
  // ships the same conversation as a destination of its own: app/(tabs)/
  // ai-chat.tsx, the host the parent `ai-assist` verdict already names.
  "ai-assist/chat": { kind: "route", mobileKey: "ai-chat" },
  // Live API execution against the workspace contract. Mobile deliberately
  // lacks it — the same `absent` the desktop `apiPlayground` row records in
  // desktopSectionCoverage, for the same reason: composing and running
  // arbitrary authenticated requests is keyboard work.
  "developer-reference/playground": { kind: "absent" },
  // The CUSTOM-payload simulator: pick a destination, review one real signed
  // request, inspect its durable outcome. Mobile ships only the bounded canned
  // signed test (POST /outbound-webhooks/{id}/test, inside Settings), which
  // OUTBOUND_WEBHOOK_DIAGNOSTIC_COVERAGE keeps as a separate verdict precisely
  // so it cannot be used to overclaim this one.
  "developer-reference/webhook-simulator": { kind: "absent" },
  // A BYOK console for the six LLM-backed endpoints. Mobile consumes three of
  // them in place (Ask Analytics, the anomaly brief, voice drift) and the other
  // three are body composition, which mobile does not do at all — so there is
  // no one screen this folds into.
  "ai-assist": { kind: "inside", hostKey: "ai-chat" },
  // The AI regression gate's thresholds and golden-example floor, on the phone
  // as components/voice/AiRegressionCard.tsx, mounted by app/(tabs)/voice.tsx.
  "ai-quality": { kind: "inside", hostKey: "voice" },
  // Six POSTs that mint or rotate live credentials — a stream bearer token shown
  // once, the inbound endpoint address, incident-alert secrets. Irreversible
  // acts that want a keyboard and a confirmation step.
  "alerting-access": { kind: "absent" },
  // A 31-provider connector catalogue, every entry `partial`. Reference material
  // plus an OAuth ceremony; mobile reads no /analytics-integrations path.
  "analytics-destinations": { kind: "inside", hostKey: "integrations" },
  // Per-key spend and a 30-day extrapolation, folded into Plan & usage as the
  // "API usage & cost" section (components/billing/ApiUsageSection, P2.54).
  "api-usage": { kind: "inside", hostKey: "billing" },
  // Editing the archive's slug, custom domain and reader TIP AMOUNTS. Mobile
  // reads /admin/archive/tenant-settings only to build links (lib/archiveLinks)
  // and cannot write any of it — mispricing a stranger's payment is desk work.
  "archive-settings": { kind: "absent" },
  // app/(tabs)/assets.tsx, over the same /api/v1/assets paths.
  assets: { kind: "route", mobileKey: "assets" },
  // hooks/useAudienceDestinations.ts renders the provider list and its per-
  // provider diagnostics capability inside app/(tabs)/integrations.tsx.
  "audience-destinations": { kind: "inside", hostKey: "integrations" },
  // app/(tabs)/audience-syncs.tsx, including the exclusion receipt.
  "audience-syncs": { kind: "route", mobileKey: "audience-syncs" },
  // The machine/human open split against 18 detection signatures. Mobile reads
  // no /bot-opens path; analytics answers the neighbouring question from the
  // human-engaged-reach report, which is a different measurement.
  "bot-opens": { kind: "absent" },
  // components/analytics/RetentionSection.tsx and FatigueSection.tsx, both
  // mounted by app/(tabs)/analytics.tsx, over /analytics/cohorts and /fatigue.
  cohorts: { kind: "inside", hostKey: "analytics" },
  // app/(tabs)/compliance.tsx, over /compliance/programs — including the HIPAA
  // `unsupported` refusal, which lib/complianceFrameworks renders as a refusal.
  compliance: { kind: "route", mobileKey: "compliance" },
  // The statutory half is on the phone: components/compliance/SarQueueBanner
  // reads /sar/requests inside app/(tabs)/compliance.tsx, where a missed clock
  // is visible. Scheduled reports and brand voice live on their own screens.
  "compliance-requests": { kind: "inside", hostKey: "compliance" },
  // Privacy incidents and push suppressions are both on the phone; the consent
  // EVENT ledger is not. app/(tabs)/privacy-incidents.tsx is the screen that
  // carries the evidence a phone is plausibly used to check.
  "consent-evidence": { kind: "inside", hostKey: "privacy-incidents" },
  // The same fold the desktop `consent` row makes, for the same reason: a
  // receipt is a per-person artefact, so components/subscriber/sections/
  // PortableReceiptCard renders it on the subscriber detail.
  "consent-ledger": { kind: "inside", hostKey: "subscribers" },
  // The collections half is app/(tabs)/collections.tsx. Saved BLOCKS are an
  // email-composition primitive, and mobile does not compose bodies.
  "content-library": { kind: "route", mobileKey: "collections" },
  // Subject-line patterns are the headline, and components/voice/
  // SubjectEvidencePanel.tsx renders them inside app/(tabs)/subject-lab.tsx.
  "content-quality": { kind: "inside", hostKey: "subject-lab" },
  // The schema layer for records that are not people. Mobile cannot administer
  // it for the same reason it cannot administer settings/custom-fields:
  // changing a definition retypes data across everything that uses it.
  "custom-objects": { kind: "absent" },
  // PII scan configuration, profile-transform rules and import templates —
  // rules that rewrite stored data workspace-wide before anybody sees it.
  "data-controls": { kind: "absent" },
  // The merge-confidence threshold decides when two records become one person
  // and one stops existing separately. Mobile shows identifier transforms
  // READ-ONLY in Settings (PlatformConfigSection) and can change nothing here.
  "data-hygiene": { kind: "absent" },
  // Six POSTs including tag rename and merge, which rewrite every subscriber
  // carrying the tag. Destructive operator actions needing a confirmation step.
  "data-operations": { kind: "absent" },
  // Webhook event samples, transform operations, merge-field and feed-source
  // schemas. Reference material for somebody building a consumer at a desk.
  "developer-reference": { kind: "absent" },
  // app/(tabs)/dmarc.tsx, over the same /deliverability/dmarc-* paths, and it
  // renders the server's "silence is not proof" suggestions verbatim.
  dmarc: { kind: "route", mobileKey: "dmarc" },
  // Customer-managed key material. Mobile reads no /byok path, and the screen's
  // central risk — reading `supported` as `configured` — is the kind of mistake
  // a small screen makes easier, not harder.
  "encryption-keys": { kind: "absent" },
  // components/analytics/ReachSection.tsx renders the floor and the server's own
  // methodology paragraph inside app/(tabs)/analytics.tsx (lib/humanEngagedReach).
  "human-reach": { kind: "inside", hostKey: "analytics" },
  // Loyalty and lead-source provider catalogues, 57 entries, all `partial` bar
  // one. Mobile's integrations screen hosts destinations, not these catalogues.
  "integration-catalogue": { kind: "absent" },
  // Dormant-key revocation against a 90-day threshold, plus exclusions and score
  // history. app/(tabs)/api-keys.tsx lists and revokes keys but reads no
  // /inactive-keys path, so the hygiene judgement itself is not on the phone.
  "key-hygiene": { kind: "absent" },
  // The declared stage vocabulary versus the occupied one. Mobile reads no
  // /lifecycle path; goals on the dashboard answer a different question.
  lifecycle: { kind: "inside", hostKey: "analytics" },
  // Sending windows, spam-trap hits and the reputation response all render on
  // app/(tabs)/deliverability.tsx, and frequency caps have their own screen.
  // Sunset policies and soft-bounce recovery are automation authoring it lacks.
  "list-hygiene": { kind: "inside", hostKey: "deliverability" },
  // Nine POST run-now jobs and config validators. Firing a workspace-wide job
  // is the archetypal keyboard-and-confirmation act.
  maintenance: { kind: "absent" },
  // app/(tabs)/omnichannel.tsx, over the same /omnichannel paths, and it leads
  // on the server's `runtime_status: "unavailable"` the same way web does.
  omnichannel: { kind: "route", mobileKey: "omnichannel" },
  // Popup capabilities and product recommendations — an on-site surface
  // configured where the site is. Mobile reads no /onsite-growth or /nbp path.
  "onsite-growth": { kind: "absent" },
  // components/analytics/PredictiveReadinessSection.tsx renders the model status
  // and the data-sufficiency verdict inside app/(tabs)/analytics.tsx.
  predictive: { kind: "inside", hostKey: "analytics" },
  // The pre-send checks are on the campaign, which is where you are when you
  // need them: CampaignChecklistCard, CampaignLinkCheckCard and
  // InboxRealityBanner all mount on app/(tabs)/campaigns/[id].tsx.
  preflight: { kind: "inside", hostKey: "campaigns" },
  // The same fold the desktop `privacyPortal` row makes: lib/privacyPosture
  // renders it in Settings, behind the same `privacy_requests` capability.
  "privacy-portal": { kind: "inside", hostKey: "settings" },
  // app/(tabs)/referrals.tsx, over /referrals/* and /referral-programs.
  referrals: { kind: "route", mobileKey: "referrals" },
  // Reply-intelligence analytics over two different windows. Mobile reads no
  // /replies path; the SMS inbox and helpdesk are conversations, not this.
  replies: { kind: "inside", hostKey: "analytics" },
  // Which metrics exist and which are blocked by product entitlement. A
  // capability reference with no verb on it.
  "reporting-catalogue": { kind: "absent" },
  // app/(tabs)/retention-offers.tsx, over /retention-offers and its funnel,
  // including the win-back automation switch this page is shaped around.
  retention: { kind: "route", mobileKey: "retention-offers" },
  // app/(tabs)/reviews.tsx ships the moderation queue — publish, reject, reply.
  // The widget designer the web page also catalogues is a layout tool, and that
  // screen's docstring excludes it deliberately.
  reviews: { kind: "route", mobileKey: "reviews" },
  // Mail in is app/(tabs)/inbound-routes.tsx; events out are app/(tabs)/
  // webhooks.tsx. Mobile splits into two screens what web joins into one page.
  routing: { kind: "route", mobileKey: "inbound-routes" },
  // Web's routing section is a shell whose only child IS inbound-routes, so the
  // nested path resolves to the same mobile destination as its parent rather
  // than to a second screen.
  "routing/inbound-routes": { kind: "route", mobileKey: "inbound-routes" },
  // Identifier transforms — the CDP rules that normalise an incoming id before
  // it is matched to a person. On mobile they are a sheet on Settings
  // (PlatformConfigSection -> IdentifierTransformsSheet), not a destination:
  // the rules are workspace configuration an operator sets once, and reading
  // them belongs beside the other platform switches rather than in the tab bar.
  "cdp-transforms": { kind: "inside", hostKey: "settings" },
  // The effective lead-scoring weights and the tag taxonomy behind them. Mobile
  // applies tag suggestions on a subscriber but reads no /scoring/rules path,
  // so it cannot see or author the rule set.
  scoring: { kind: "absent" },
  // The kill switch, sending status, sender reputation and spam-trap hits all
  // render on app/(tabs)/deliverability.tsx; SMS quiet hours sit with SMS.
  "sending-health": { kind: "inside", hostKey: "deliverability" },
  // The web Service suite is customer-hub configuration and availability.
  // Mobile Helpdesk is a bounded conversation-record view, not that surface.
  "service-suite": { kind: "absent" },
  // Attack mode is the verb, and components/deliverability/
  // ReputationResponseCard.tsx puts it on app/(tabs)/deliverability.tsx (with a
  // read-only echo in Settings). Firewall stats and preset segments are not here.
  "signup-protection": { kind: "inside", hostKey: "deliverability" },
  // Every network reports `runtime_status: "foundation"` — built, not live —
  // and connecting one is an OAuth ceremony. Mobile reads no /social-capture path.
  "social-capture": { kind: "absent" },
  // Per-acquisition-source engagement, bounce and complaint rates. Mobile shows
  // growth sources per LIST (ListGrowthSourcesCard) from a different endpoint;
  // the workspace-wide quality read is not on the phone.
  "source-quality": { kind: "absent" },
  // app/(tabs)/product-events.tsx, over /track/* — the same mapping the desktop
  // `track` row makes, and it prints the window the counts were measured over.
  track: { kind: "route", mobileKey: "product-events" },
  // Translation settings, the terminology dictionary and the LLM preview are
  // a sheet on the campaign detail (CampaignTranslationsCard -> Translation
  // settings, admin-only). CSV dictionary import/export stays desktop — that
  // half is typing work; the settings half no longer is.
  translations: { kind: "inside", hostKey: "campaigns" },
  // app/(tabs)/warehouse-runs.tsx, over /warehouse/* — connections, providers
  // and the run verdict (lib/warehouseVerdict).
  warehouse: { kind: "route", mobileKey: "warehouse-runs" },
  // Feature flags, export retention, email blocks, DNS health, warm-up plans.
  // Mobile echoes flags read-only in Settings and DNS/warm-up on Deliverability,
  // but the operator page itself is a workspace-configuration surface.
  "workspace-ops": { kind: "absent" },
};
