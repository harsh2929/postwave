/**
 * lib/mobileRoutesTools.ts — the TOOLS section of the More menu.
 *
 * Split from `mobileRoutesCore.ts` when that file crossed its 450-line ceiling
 * for the second time. Tools is where this app grows fastest — it is the
 * catch-all for operator surfaces that are neither audience nor sending, and it
 * had reached 20 of the 45 core rows on its own. Keeping it apart means a new
 * monitor screen stops pushing the audience and sending rows over a limit they
 * had nothing to do with.
 *
 * Same rules as its siblings: the role floor is the STRICTER of the handler's
 * scope guard and the routeauth manifest row, and a row without `minimumRole`
 * is deliberately viewer-readable.
 */
import type { MobileSecondaryRoute } from "@/lib/mobileRouteTypes";

export const TOOLS_MOBILE_ROUTES: readonly MobileSecondaryRoute[] = [
  {
    key: "webhooks",
    icon: "link",
    label: "Webhook health",
    hint: "Delivery failures, replay, re-enable an endpoint",
    route: "/(tabs)/webhooks",
    routeFile: "app/(tabs)/webhooks.tsx",
    moreSection: "Tools",
    minimumRole: "admin",
  },
  {
    key: "sms",
    icon: "send",
    label: "SMS inbox",
    hint: "Reply to people who texted your brand number",
    route: "/(tabs)/sms",
    routeFile: "app/(tabs)/sms/index.tsx",
    moreSection: "Tools",
    // GET /api/v1/sms/conversations — the inbox's only read — is
    // session_minimum_role admin (reviewed) in the generated policy manifest, so
    // without this floor a viewer saw "Reply to people who texted your brand
    // number" and reached an empty screen backed by a 403.
    minimumRole: "admin",
  },
  {
    key: "forms",
    icon: "check",
    label: "Forms",
    hint: "Signup forms, submissions, conversion",
    route: "/(tabs)/forms",
    routeFile: "app/(tabs)/forms/index.tsx",
    moreSection: "Tools",
  },
  {
    key: "analytics",
    icon: "log",
    label: "Analytics",
    hint: "Growth, top performers, deliverability, send fatigue",
    route: "/(tabs)/analytics",
    routeFile: "app/(tabs)/analytics.tsx",
    moreSection: "Tools",
    // Deliberately no `navKey`: @postwave/nav's analytics entry has
    // `mobile: null`, so claiming the key would fail nav.consistency's
    // routeFor(key, "mobile") === route assertion. Same shape as search/scan.
    // (notifications no longer belongs in that list — the manifest models it.)
    // Deliberately no `minimumRole`: every backing route is `read:reports`,
    // which viewers already hold.
  },
  {
    key: "search",
    icon: "search",
    label: "Search",
    hint: "Find subscribers, lists, suppressions",
    route: "/(tabs)/search",
    routeFile: "app/(tabs)/search.tsx",
    moreSection: "Tools",
  },
  {
    key: "notifications",
    navKey: "notifications",
    icon: "bell",
    label: "Notifications",
    hint: "Approvals, sends, and delivery alerts",
    route: "/(tabs)/notifications",
    routeFile: "app/(tabs)/notifications.tsx",
    moreSection: "Tools",
  },
  {
    key: "scan",
    icon: "link",
    label: "Scan QR code",
    hint: "Open a desktop code on your phone",
    route: "/(tabs)/scan",
    routeFile: "app/(tabs)/scan.tsx",
    moreSection: "Tools",
  },
  {
    key: "sequences",
    icon: "send",
    label: "Sequences",
    // Names the split the screen actually implements, which moved when
    // MOBILE_SEQUENCE_AUTHORING_AVAILABLE flipped to true (GATE#3): a draft's
    // existing steps ARE edited here now, and the hint that still said
    // otherwise was telling operators a shipped verb did not exist. What stays
    // on desktop is ADDING a step — there is no palette on the mobile canvas —
    // and every non-draft journey, which the server refuses to edit for any
    // client (409, sequences.go:892-895).
    hint: "Journey drafts — create, review, and edit a draft's steps",
    route: "/(tabs)/sequences",
    routeFile: "app/(tabs)/sequences/index.tsx",
    moreSection: "Tools",
    navKey: "sequences",
    entityKey: "sequence",
  },
  {
    key: "voice",
    icon: "mic",
    label: "Voice",
    // Build/Rebuild is offered to any signed-in user (voice.tsx:97 gates on
    // the online gate, not on a role), so a "just look at it" hint was wrong
    // in the other direction — it hid a verb that is actually available.
    hint: "Your workspace's learned brand voice — build or rebuild it",
    route: "/(tabs)/voice",
    routeFile: "app/(tabs)/voice.tsx",
    moreSection: "Tools",
  },
  {
    key: "integrations",
    icon: "link",
    label: "Integrations",
    hint: "View connected services",
    route: "/(tabs)/integrations",
    routeFile: "app/(tabs)/integrations.tsx",
    moreSection: "Tools",
    navKey: "integrations",
    // Every read this screen performs is admin-floored in the generated policy
    // manifest — GET /api/v1/integrations/connections and /{slug}/health are both
    // `session_minimum_role: admin`, `review_status: reviewed`. The Go mount sites
    // ask only for ScopeReadReports, so reading the handler alone suggests any
    // role may look; the manifest is the binding layer and it says otherwise.
    // Without this floor a viewer saw "View connected services", tapped it, and
    // got nothing but a 403.
    minimumRole: "admin",
  },
  {
    key: "inbound-webhooks",
    icon: "link",
    label: "Inbound webhooks",
    hint: "View receive endpoints",
    route: "/(tabs)/inbound-webhooks",
    routeFile: "app/(tabs)/inbound-webhooks.tsx",
    moreSection: "Tools",
    minimumRole: "admin",
  },
  {
    key: "migrations",
    icon: "log",
    label: "Migrations",
    hint: "Monitor provider import status",
    route: "/(tabs)/migrations",
    routeFile: "app/(tabs)/migrations.tsx",
    moreSection: "Tools",
    navKey: "migrations",
    minimumRole: "admin",
  },
  {
    key: "agent-routines",
    icon: "check",
    label: "Agent routines",
    hint: "Scheduled runs and their history",
    route: "/(tabs)/agent-routines",
    routeFile: "app/(tabs)/agent-routines.tsx",
    // Links this row to the manifest's `agentRoutines` entry. The row's own
    // `key` is hyphenated and the manifest key is camelCase, so without this
    // the reachability set could not match them and the manifest entry counted
    // as an orphan — a screen the app ships, routes to, and appears unable to
    // reach. Same fix, same reason, as `deliverabilityHub` in mobileRoutesCore.
    navKey: "agentRoutines",
    moreSection: "Tools",
  },
  {
    key: "product-events",
    icon: "log",
    label: "Product events",
    hint: "Which events are arriving, and which stopped",
    route: "/(tabs)/product-events",
    routeFile: "app/(tabs)/product-events.tsx",
    moreSection: "Tools",
  },
  {
    key: "flows",
    icon: "link",
    label: "Flows",
    hint: "Automation steps and parked reviews",
    route: "/(tabs)/flows",
    routeFile: "app/(tabs)/flows.tsx",
    moreSection: "Tools",
  },
  {
    key: "conversions",
    icon: "card",
    label: "Conversions",
    hint: "Attributed revenue by campaign",
    route: "/(tabs)/conversions",
    routeFile: "app/(tabs)/conversions.tsx",
    moreSection: "Tools",
  },
  {
    // ADMIN. The manifest CONTRADICTS ITSELF across this family — the list row
    // is admin/reviewed while /{id}/matches and /matches/{id}/runs are
    // viewer/fail_closed_default — but inbound_email/routes.go:80-89 applies
    // RequireScope(ScopeAdmin) to all eight routes. The handler wins.
    key: "inbound-routes",
    icon: "link",
    label: "Inbound routing",
    hint: "Did mail route, and did its actions run",
    route: "/(tabs)/inbound-routes",
    routeFile: "app/(tabs)/inbound-routes.tsx",
    moreSection: "Tools",
    minimumRole: "admin",
  },
  {
    // VIEWER, and both layers agree for once: flowabtests.go:321 uses
    // ScopeReadCampaigns (a read-only scope, so any session role clears it),
    // the mount at main.go:2632 is bare, and the manifest row is
    // viewer/REVIEWED. Writes are ScopeWriteCampaigns and are gated in-screen.
    key: "flow-ab-tests",
    icon: "log",
    label: "Flow A/B tests",
    hint: "Variant results and which arm is winning",
    route: "/(tabs)/flow-ab-tests",
    routeFile: "app/(tabs)/flow-ab-tests.tsx",
    moreSection: "Tools",
  },
  {
    // No floor DELIBERATELY, because the screen has two halves with two server
    // floors: GET /subject-analyzer/buckets is viewer, POST /subject-lab/score
    // and POST /subject-lab/variants are editor (subject_lab.go MountRoutes
    // mounts both under write:campaigns; routeauth/manifest.json records
    // session_minimum_role "editor" for both). Gating the ROUTE at editor would
    // hide viewer-readable data ("what has actually worked for your list") from
    // viewers; instead the screen renders an explicit "Writing and scoring need
    // editor access" card in place of the composer, which the route test pins.
    key: "subject-lab",
    icon: "check",
    label: "Subject Lab",
    hint: "Score a subject line against what has actually worked for your list",
    route: "/(tabs)/subject-lab",
    routeFile: "app/(tabs)/subject-lab.tsx",
    moreSection: "Tools",
  },
  {
    // Editor-floored end to end: POST /api/v1/voice/generate is the screen's
    // only call (aichat.go:113-114 write:campaigns; routeauth row editor,
    // reviewed). Left un-floored like subject-lab so a viewer is told the floor
    // in-screen (AiChatAccessNotice, pinned by the route test) rather than
    // meeting the generic access-denied.
    key: "ai-chat",
    navKey: "aiAssist",
    icon: "mic",
    label: "Moosewave AI",
    hint: "Ask for a draft, a subject line or a summary in a tone you pick",
    route: "/(tabs)/ai-chat",
    routeFile: "app/(tabs)/ai-chat.tsx",
    moreSection: "Tools",
  },
  {
    // Both reads are viewer (customobjects/handlers.go:61 types, :180 records),
    // so no minimumRole. No navKey: @postwave/nav has no entry for this concept.
    key: "custom-objects",
    icon: "log",
    label: "Custom objects",
    hint: "Look up a booking, order or business record",
    route: "/(tabs)/custom-objects",
    routeFile: "app/(tabs)/custom-objects.tsx",
    moreSection: "Tools",
  },
  {
    // Every tenant-bound service-suite route is exact-admin. Only the static
    // catalog is viewer-readable, and this screen is not a static catalog.
    key: "helpdesk",
    icon: "help",
    label: "Helpdesk",
    hint: "Inspect bounded support records and private internal notes",
    route: "/(tabs)/helpdesk",
    routeFile: "app/(tabs)/helpdesk/index.tsx",
    moreSection: "Tools",
    minimumRole: "admin",
  },
];
