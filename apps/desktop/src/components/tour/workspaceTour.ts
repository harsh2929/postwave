import {
  capabilityForSection,
  DESKTOP_NAV_DOMAINS,
} from "../../lib/desktop-capabilities";
import {
  PERSISTENT_DESKTOP_SECTIONS,
  type PersistentDesktopSection,
} from "../../lib/desktop-routes";
import type { TourStep } from "./types";

interface WorkspaceTourCopy {
  title: string;
  body: string;
}

/**
 * The full-tour copy is deliberately written as a customer conversation, not
 * as generated documentation. Each stop answers two practical questions:
 * "why would I come here?" and "what can I do once I arrive?" Keeping this as
 * an exhaustive Record makes a newly added sidebar destination fail typecheck
 * until it has an honest introduction.
 */
export const WORKSPACE_TOUR_COPY = {
  dashboard: {
    title: "Your morning briefing",
    body: "Start here to see what changed while you were away. Performance, audience growth, recent campaigns, recommendations, and setup health are gathered into one useful snapshot.",
  },
  subscribers: {
    title: "Your audience, person by person",
    body: "Find anyone, inspect their history, edit their profile, or bring in a CSV. Search, filters, bulk actions, tags, lists, and natural-language segments keep even a large audience manageable.",
  },
  tags: {
    title: "Small labels, big leverage",
    body: "Tags capture intent, source, status, or any label your team relies on. Create and group tags here, then use them to drive segments, personalization, and sequence triggers.",
  },
  lists: {
    title: "The groups you choose",
    body: "Lists are deliberate, reusable collections of subscribers. Build one, add or remove members, and use it as the audience for a campaign, form, import, or sync.",
  },
  segments: {
    title: "Audiences that update themselves",
    body: "Segments turn rules into living audiences. Combine profile fields, engagement, tags, and behavior; preview the matches; then reuse the result without rebuilding the logic.",
  },
  audienceSyncs: {
    title: "Take audiences where they need to go",
    body: "Keep a Moosewave audience aligned with an external destination. Configure the destination, choose what should sync, run it, and inspect each delivery when a provider needs attention.",
  },
  suppressions: {
    title: "The people you must not email",
    body: "This is the final guardrail before an email leaves Moosewave. Review bounces, complaints, unsubscribes, and manual blocks; add an address or export the registry when needed.",
  },
  smsSuppressions: {
    title: "Respect every SMS opt-out",
    body: "Phone numbers that cannot receive messages live here, along with the reason and source. Search the registry, add a manual block, and verify that STOP requests were honored.",
  },
  pushSuppressions: {
    title: "Govern push authority before dispatch",
    body: "Exact admins can review privacy-safe device fingerprints and add or remove manual authority here. Customer push dispatch is held, the future APNs/FCM send path is suppression-gated, automatic provider feedback is unavailable, and Web remains registry-only.",
  },
  campaigns: {
    title: "One home for every broadcast",
    body: "Draft, review, test, schedule, send, and inspect campaigns here. Filters separate active work from sent history, while each campaign keeps its audience, content, approvals, and results together.",
  },
  sequences: {
    title: "Journeys that keep moving",
    body: "Build an ordered conversation instead of a one-off send. Add messages, waits, branches, and enrollment rules; then inspect who is active, paused, completed, or needs attention.",
  },
  automations: {
    title: "Turn behavior into timely action",
    body: "Automations listen for a useful signal and decide what happens next. Define triggers, conditions, and actions here, then inspect readiness and execution history before enabling a live workflow.",
  },
  forms: {
    title: "A clean front door for subscribers",
    body: "Create forms and landing pages that collect the right data from the start. Choose fields, consent language, destinations, styling, and publish settings, then review submissions in context.",
  },
  templates: {
    title: "Your best work, ready to reuse",
    body: "Browse the complete template library without loading thousands of cards at once. Search, filter, preview, favorite, and open a design; Moosewave renders the full email only when you ask for it.",
  },
  assets: {
    title: "A shared shelf for campaign media",
    body: "Upload and organize the images your team uses repeatedly. Search the library, inspect file details, copy a URL, or choose an asset while composing without hunting through local folders.",
  },
  collections: {
    title: "Structured content without a spreadsheet",
    body: "Collections hold reusable records such as products, locations, authors, or events. Define the fields, maintain the rows, and reference that data consistently across personalized content.",
  },
  webhooks: {
    title: "Events in, events out",
    body: "Webhooks connect Moosewave to systems that need an immediate signal. Manage inbound routes and outbound subscriptions, rotate secrets, inspect deliveries, and retry failures from one place.",
  },
  track: {
    title: "See what people do beyond the inbox",
    body: "Product Events captures meaningful actions from your site or app. Review incoming events, verify payloads, export data, and use trusted behavior to power segments and automations.",
  },
  analytics: {
    title: "Results you can actually investigate",
    body: "Move from headline performance to the detail behind it. Compare delivery, opens, clicks, conversions, and audience movement; adjust the date range or drill into the campaign that changed the trend.",
  },
  sendtime: {
    title: "Meet each audience at the right hour",
    body: "Send-time optimization turns engagement history into a recommended window. Choose an audience, inspect signal quality, compare candidate times, and use the recommendation when confidence is strong enough.",
  },
  archive: {
    title: "Give every issue a life after send",
    body: "Archive turns published campaigns into a browsable web collection. Review the catalog, refresh publication data, and manage the path to web pages, feeds, and search when publishing is enabled.",
  },
  referrals: {
    title: "Let loyal readers bring the next ones",
    body: "Referrals show who is sharing, who joined through them, and which milestones they reached. Use the history to understand program momentum while configuration remains safely review-gated.",
  },
  affiliates: {
    title: "Affiliate operations are release-held",
    body: "This status workspace explains the reviewed affiliate boundary without loading partner records or exposing commercial actions. Attribution, customer linkage, commissions, partner management, and payouts remain unavailable.",
  },
  discounts: {
    title: "Inspect sanitized discount history",
    body: "Discount History shows stored offer terms and aggregate recorded-use counters without exposing coupon codes or customer identity. Search by record label, benefit, currency, or scope and filter lifecycle state without editing commerce data.",
  },
  gifts: {
    title: "Every gifted subscription, accounted for",
    body: "Gift History follows purchases from giver to recipient and activation. Use search and status filters to answer support questions quickly while the source system remains authoritative.",
  },
  commerce: {
    title: "Connect messages to revenue",
    body: "Commerce brings stores, customers, products, and order signals into the same operating view. Connect a provider, inspect sync health, and use trusted purchase data in audiences and messaging.",
  },
  reviews: {
    title: "Turn customer voice into a growth signal",
    body: "Reviews collects rating and response activity tied to your customers and products. Inspect the feed, filter by sentiment or status, and follow up on the moments that deserve a human reply.",
  },
  retentionOffers: {
    title: "Inspect stored retention evidence",
    body: "Retention History shows bounded stored offer rows, stored win-back settings, and aggregate event counters. It does not identify customers or certify offer presentation, acceptance, coupon application, provider reconciliation, or automated delivery; those paths remain release-held.",
  },
  deliverabilityHub: {
    title: "Protect the route to the inbox",
    body: "This is the operational view of sending health. Check domain posture, provider signals, suppression pressure, and recommended fixes, then open the exact control behind an issue.",
  },
  domains: {
    title: "Prove who is sending",
    body: "Add and verify the domains behind your mail. Moosewave shows the SPF, DKIM, tracking, and return-path records to publish, then keeps checking them for drift.",
  },
  dmarc: {
    title: "Understand who sends as your brand",
    body: "DMARC Reports turns aggregate authentication reports into something readable. Inspect sources, alignment, pass rates, and policy impact before tightening enforcement with confidence.",
  },
  ai: {
    title: "A capable copilot with clear boundaries",
    body: "Moosewave AI helps shape campaign and sequence work using your approved context. Start a task, review every proposed change, and keep the final decision with the person responsible for the send.",
  },
  aiChangelog: {
    title: "See exactly what AI changed",
    body: "The AI Changelog records assisted edits and the context around them. Filter the history, inspect a change, and trace what was suggested, accepted, or rejected without relying on memory.",
  },
  migrations: {
    title: "Move platforms without losing the plot",
    body: "Migrations guides source connection, discovery, mapping, dry runs, and import history. Work through readiness checks first, then inspect each run and recover cleanly from provider errors.",
  },
  integrations: {
    title: "Your connection control room",
    body: "Connect the services Moosewave depends on and see whether each one is healthy. Browse available providers, configure credentials, review capabilities, reconnect, or disconnect with the impact made clear.",
  },
  dataPlatform: {
    title: "Keep warehouse data moving",
    body: "Data Platform is for durable syncs between Moosewave and your data stack. Configure sources and destinations, choose objects and cadence, then inspect checkpoints, freshness, and failed runs.",
  },
  approvals: {
    title: "The right eyes before the risky click",
    body: "Approvals gathers sends and sensitive changes waiting for review. Open the evidence, compare what changed, leave a reason, and approve or reject with a durable decision trail.",
  },
  audit: {
    title: "A trustworthy account of who did what",
    body: "Audit Log records important actions across people, API keys, and agents. Search, filter, save a view, inspect event details, or export evidence without altering the underlying record.",
  },
  privacyIncidents: {
    title: "A calm workflow for serious moments",
    body: "Privacy Incidents keeps investigation, impact, counsel review, and notification packets together. Move through the response stages deliberately and preserve the evidence behind every decision.",
  },
  consent: {
    title: "Consent you can prove",
    body: "Consent shows what a subscriber agreed to, when, and through which source. Search receipts, inspect channel and tracking preferences, and resolve questions with the original evidence in view.",
  },
  mcp: {
    title: "Let trusted tools work with Moosewave",
    body: "MCP connects assistants and developer tools to the workspace through explicit capabilities. Follow the setup recipe, verify registration, inspect available tools, and review call activity before enabling writes.",
  },
  smsInbox: {
    title: "Every SMS conversation in one queue",
    body: "Read inbound replies alongside the messages your team sent. Search by person or number, open the thread, respond where allowed, and keep opt-out context visible while you work.",
  },
  helpdesk: {
    title: "Review and triage recorded conversations",
    body: "Helpdesk keeps customer message records in one queue. Triage the queue, assign verified ownership, inspect recorded context, add private internal notes, and record status changes. Customer reply delivery and live channel handling remain release-held.",
  },
  apiPlayground: {
    title: "Learn the API by making a real request",
    body: "Choose an endpoint, review its parameters, add a safe request body, and run it against this workspace. The response, status, and generated example make integration work much easier to explain.",
  },
  webhookSimulator: {
    title: "Test the receiver before the real event",
    body: "Send a realistic, signed sample to an outbound webhook on demand. Pick the event, edit the payload, run the delivery, and inspect the exact response your integration returned.",
  },
  sending: {
    title: "The rules behind every send",
    body: "Sending Settings holds the defaults and safeguards shared by campaigns and automations. Review sender identity, limits, tracking, unsubscribe behavior, and provider posture before changing production delivery.",
  },
  agency: {
    title: "Operate several workspaces without confusion",
    body: "Agency gives teams a portfolio view of the accounts they support. Inspect workspace status, access, and ownership, then move into the right tenant without mixing customer context.",
  },
  inboundRoutes: {
    title: "Give incoming mail the right destination",
    body: "Inbound Routes decides how replies and forwarded messages enter Moosewave. Configure addresses and routing rules, inspect matches, and keep provider verification visible before going live.",
  },
  scim: {
    title: "Keep access aligned with your directory",
    body: "SCIM manages provisioning credentials and group-to-role mappings. Create or revoke a token, order mapping rules, and verify how directory users will land before connecting the identity provider.",
  },
  compliance: {
    title: "Know what is ready for regulated work",
    body: "Compliance brings policy controls and deployment evidence into one review surface. Check current posture, inspect gaps, and follow the named setup path instead of guessing whether a safeguard is active.",
  },
  privacyPortal: {
    title: "Handle privacy requests with a paper trail",
    body: "Privacy Portal tracks access, export, correction, and deletion requests from intake to completion. Search cases, verify identity, review deadlines, and record each action taken for the requester.",
  },
  auditSinks: {
    title: "Send audit evidence where your team watches",
    body: "Audit Sinks forwards selected security events to an external destination. Configure and test a sink, protect its credentials, monitor delivery health, and recover failed batches without losing the source record.",
  },
  auditAlerts: {
    title: "Turn important audit events into a signal",
    body: "Audit Alerts watches the event stream for conditions your team cares about. Define a rule, choose severity and destination, test it, and inspect firing history before relying on it operationally.",
  },
  settings: {
    title: "Make the workspace yours",
    body: "Settings covers connection, appearance, security, privacy, notifications, updates, shortcuts, sample data, and workspace policy. This full walkthrough stays here too, ready whenever a teammate wants the complete tour.",
  },
} as const satisfies Record<PersistentDesktopSection, WorkspaceTourCopy>;

/** Canonical sidebar order grouped exactly as the customer sees it. */
export const FULL_WORKSPACE_TOUR_SECTIONS: PersistentDesktopSection[] =
  DESKTOP_NAV_DOMAINS.flatMap((domain) =>
    PERSISTENT_DESKTOP_SECTIONS.filter(
      (section) => capabilityForSection(section).domain === domain.id,
    ),
  );

export const FULL_WORKSPACE_TOUR_STEPS: TourStep[] = [
  {
    id: "workspace-welcome",
    title: "The complete Moosewave walkthrough",
    body: "We’ll visit every workspace destination in sidebar order and explain the controls worth knowing. Nothing will be created, sent, approved, or changed while you look around.",
    targetSelector: null,
    navigateTo: "dashboard",
    hideBack: true,
  },
  ...FULL_WORKSPACE_TOUR_SECTIONS.map((section): TourStep => {
    const copy = WORKSPACE_TOUR_COPY[section];
    return {
      id: `workspace-${section}`,
      title: copy.title,
      body: copy.body,
      targetSelector: `nav-${section}`,
      navigateTo: section,
      placement: "right",
    };
  }),
  {
    id: "workspace-done",
    title: "You know where everything lives",
    body: "That was the whole workspace: every destination, its purpose, and the controls you’ll reach for most often. Replay the full walkthrough from Settings at any time, or use Help for a shorter refresher.",
    targetSelector: null,
    navigateTo: "dashboard",
    isFinal: true,
  },
];
