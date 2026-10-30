/**
 * Canonical navigation / information-architecture manifest. The single
 * source of truth for every primary nav entry across web, desktop, and
 * mobile.
 *
 * The 2026-06-21 ecosystem audit found three surfaces hand-roll three
 * divergent nav maps:
 *
 *   - web      apps/web/src/app/(dashboard)/layout.tsx  — `NAV` (15 entries)
 *   - desktop  apps/desktop/src/components/Sidebar.tsx  — WORKSPACE_ITEMS +
 *              ACCOUNT_ITEMS (50+ entries, grouped)
 *   - mobile   apps/mobile/app/(tabs)/_layout.tsx        — 5 visible bottom
 *              tabs (Home/People/Send/Approve/More) + many `href: null`
 *              screens
 *
 * The maps disagree on labels (web "Overview" vs desktop "Dashboard" vs
 * mobile "Home"; web "Subscribers" vs mobile tab "People"), and several
 * shipped pages are orphaned — reachable only by typing the URL. This
 * manifest reconciles them: one `canonicalLabel` per concept, one icon
 * key, one required scope, and the route per surface (or `null` where a
 * surface deliberately doesn't expose the entry). The `surfaces` array is
 * the authoritative "which surfaces show this in primary nav" list — a
 * surface can still own a *route* for an entry it doesn't surface in its
 * primary chrome (e.g. mobile keeps a Settings screen but reaches it via
 * the More sheet, not a bottom tab).
 *
 * Clients render from this manifest filtered by surface; icons stay
 * per-surface (each toolkit has its own icon set) but key off the shared
 * `iconKey` so the *concept* is consistent.
 */

/** The three product surfaces that render primary navigation. */
export type Surface = "web" | "desktop" | "mobile";

export const SURFACES: readonly Surface[] = ["web", "desktop", "mobile"];

/**
 * Coarse RBAC scope a nav entry requires. `member` = any authenticated
 * user; `admin` = workspace admin/owner-only chrome (settings, audit,
 * compliance, billing). The audit's concern is *consistency of exposure*,
 * not enforcement — enforcement still lives in each route guard — but
 * surfacing the scope here lets every client hide admin-only entries the
 * same way instead of each re-deciding.
 */
export type Scope = "member" | "admin";

/**
 * Logical grouping used to section the nav (desktop renders these as
 * WORKSPACE vs ACCOUNT headers; web/mobile may flatten). Kept small and
 * stable so the grouping doesn't drift per surface.
 */
export type NavGroup = "workspace" | "growth" | "deliverability" | "account";

export interface NavEntry {
  /**
   * Canonical, stable key. Doubles as the cross-surface identity for the
   * entry and the value clients persist for "last section". MUST be unique
   * across the manifest.
   */
  key: string;
  /**
   * The one canonical label. Replaces the per-surface drift (Overview /
   * Dashboard / Home → "Dashboard"; the Subscribers tab's "People" label →
   * "Subscribers"). Surfaces with extreme width limits (a 5-up mobile tab
   * bar) may abbreviate via `shortLabel`, but `label` is the name of record.
   */
  label: string;
  /**
   * Optional space-constrained label (e.g. the mobile bottom-tab bar, where
   * "Subscribers" is too wide). When absent, surfaces use `label`.
   */
  shortLabel?: string;
  /** Shared concept icon key. Each surface maps it to its own icon set. */
  iconKey: string;
  /** Coarse scope required to *see* the entry. */
  scope: Scope;
  /** Logical section the entry belongs to. */
  group: NavGroup;
  /**
   * Route per surface. A string is the surface's in-app path; `null` means
   * the surface does NOT expose this entry in its primary navigation (it may
   * still be reachable elsewhere). `surfaces` is derived from the non-null
   * routes — see `SURFACES_FOR` below — so the two can never disagree.
   */
  routes: Record<Surface, string | null>;
  /**
   * Optional keyboard shortcut hint (desktop ⌘+digit scheme, mirrored in the
   * command palette). Display-only; the actual binding lives in the client.
   */
  kbd?: string;
}

/**
 * The manifest. Order is the canonical display order (top-to-bottom within
 * a surface). Routes intentionally reuse the existing per-surface URL shapes
 * so adopting this manifest is a swap, not a re-route:
 *
 *   - web/desktop dashboard routes are `/app/<slug>` (desktop renders the
 *     same web dashboard); desktop's section ids map onto these paths.
 *   - mobile routes are Expo-router group paths `/(tabs)/<screen>`.
 *
 * Where a surface lacks a screen we set `null` rather than inventing one;
 * the audit's fix for orphaned pages is to *add* the entry to the surfaces
 * that should have it (e.g. Analytics, which is shipped on web but was
 * missing from web's own sidebar), which is a route-string change here.
 */
export const NAV_ENTRIES: readonly NavEntry[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    shortLabel: "Home",
    iconKey: "dashboard",
    scope: "member",
    group: "workspace",
    routes: { web: "/app", desktop: "/app", mobile: "/(tabs)/dashboard" },
    kbd: "⌘1",
  },
  {
    key: "subscribers",
    label: "Subscribers",
    shortLabel: "People",
    iconKey: "users",
    scope: "member",
    group: "workspace",
    routes: {
      web: "/app/subscribers",
      desktop: "/app/subscribers",
      mobile: "/(tabs)/subscribers",
    },
    kbd: "⌘2",
  },
  {
    key: "lists",
    label: "Lists",
    iconKey: "users",
    scope: "member",
    group: "workspace",
    routes: { web: "/app/lists", desktop: "/app/lists", mobile: null },
  },
  {
    key: "tags",
    label: "Tags",
    iconKey: "badgeCheck",
    scope: "member",
    group: "workspace",
    routes: { web: "/app/tags", desktop: "/app/tags", mobile: null },
  },
  {
    key: "campaigns",
    label: "Campaigns",
    shortLabel: "Send",
    iconKey: "mail",
    scope: "member",
    group: "workspace",
    routes: {
      web: "/app/campaigns",
      desktop: "/app/campaigns",
      mobile: "/(tabs)/campaigns",
    },
    kbd: "⌘3",
  },
  {
    key: "sequences",
    label: "Sequences",
    iconKey: "workflow",
    scope: "member",
    group: "workspace",
    routes: {
      web: "/app/sequences",
      desktop: "/app/sequences",
      mobile: "/(tabs)/sequences",
    },
    kbd: "⌘4",
  },
  {
    key: "forms",
    label: "Forms",
    iconKey: "form",
    scope: "member",
    group: "growth",
    routes: { web: "/app/forms", desktop: "/app/forms", mobile: null },
    kbd: "⌘5",
  },
  {
    key: "templates",
    label: "Templates",
    iconKey: "template",
    scope: "member",
    group: "growth",
    routes: { web: "/app/templates", desktop: "/app/templates", mobile: null },
    kbd: "⌘6",
  },
  {
    key: "analytics",
    label: "Analytics",
    iconKey: "chart",
    scope: "member",
    group: "workspace",
    // Shipped on web (apps/web/.../app/analytics) but the audit found it was
    // ORPHANED — absent from web's own sidebar. The manifest puts it back.
    routes: {
      web: "/app/analytics",
      desktop: "/app/analytics",
      mobile: null,
    },
    kbd: "⌘7",
  },
  {
    key: "approvals",
    label: "Approvals",
    shortLabel: "Approve",
    iconKey: "check",
    scope: "member",
    group: "account",
    // Standalone approvals inbox. The web app ships it at /app/approvals
    // (apps/web/src/app/(dashboard)/app/approvals) — NOT under /settings,
    // which never existed. Desktop + mobile already use /approvals too.
    routes: {
      web: "/app/approvals",
      desktop: "/app/approvals",
      mobile: "/(tabs)/approvals",
    },
    kbd: "⌘8",
  },
  {
    key: "sms",
    label: "SMS",
    iconKey: "message",
    scope: "member",
    group: "workspace",
    // The old value `/app/sms` is not a desktop section at all, so it hit the
    // router's unknown-destination branch. `sms-inbox` parses, which is exactly
    // why it is the WRONG fix: web's /app/sms is the SMS programme console
    // (campaigns, compliance, sender profiles, credits) and desktop's SMS Inbox
    // is a two-way conversation view. Desktop ships no programme console, so
    // `null` is the honest answer — a parseable pointer to a different feature
    // is worse than none, because nothing downstream can tell it is wrong.
    routes: { web: "/app/sms", desktop: null, mobile: null },
  },
  {
    key: "aiAssist",
    label: "AI assist",
    iconKey: "message",
    scope: "member",
    group: "growth",
    routes: { web: "/app/ai-assist", desktop: null, mobile: "/(tabs)/ai-chat" },
  },
  {
    key: "workspaceOps",
    label: "Workspace operations",
    iconKey: "settings",
    scope: "admin",
    group: "workspace",
    routes: { web: "/app/workspace-ops", desktop: null, mobile: null },
  },
  {
    key: "alertingAccess",
    label: "Alerting and access",
    iconKey: "bell",
    scope: "admin",
    group: "account",
    routes: { web: "/app/alerting-access", desktop: null, mobile: null },
  },
  {
    key: "dataOperations",
    label: "Data operations",
    iconKey: "migrate",
    scope: "admin",
    group: "workspace",
    routes: { web: "/app/data-operations", desktop: null, mobile: null },
  },
  {
    key: "maintenance",
    label: "Maintenance",
    iconKey: "settings",
    scope: "admin",
    group: "workspace",
    routes: { web: "/app/maintenance", desktop: null, mobile: null },
  },
  {
    key: "preflight",
    label: "Pre-flight",
    iconKey: "check",
    scope: "member",
    group: "deliverability",
    routes: { web: "/app/preflight", desktop: null, mobile: null },
  },
  {
    key: "developerReference",
    label: "Developer reference",
    iconKey: "plug",
    scope: "member",
    group: "workspace",
    routes: { web: "/app/developer-reference", desktop: null, mobile: null },
  },
  {
    key: "contentQuality",
    label: "Content quality",
    iconKey: "template",
    scope: "member",
    group: "growth",
    routes: { web: "/app/content-quality", desktop: null, mobile: null },
  },
  {
    key: "consentEvidence",
    label: "Consent evidence",
    iconKey: "shield",
    scope: "admin",
    group: "account",
    routes: { web: "/app/consent-evidence", desktop: null, mobile: null },
  },
  {
    key: "reviews",
    label: "Reviews",
    iconKey: "check",
    scope: "member",
    group: "growth",
    routes: { web: "/app/reviews", desktop: "/app/reviews", mobile: null },
  },
  {
    key: "reportingCatalogue",
    label: "Reporting catalogue",
    iconKey: "chart",
    scope: "member",
    group: "workspace",
    routes: { web: "/app/reporting-catalogue", desktop: null, mobile: null },
  },
  {
    key: "sendingHealth",
    label: "Sending health",
    iconKey: "check",
    scope: "member",
    group: "deliverability",
    routes: { web: "/app/sending-health", desktop: null, mobile: null },
  },
  {
    key: "winback",
    label: "Win-back",
    iconKey: "tag",
    scope: "member",
    group: "growth",
    routes: { web: "/app/retention", desktop: null, mobile: null },
  },
  {
    key: "replies",
    label: "Replies",
    iconKey: "message",
    scope: "member",
    group: "growth",
    routes: { web: "/app/replies", desktop: null, mobile: null },
  },
  {
    key: "audienceDestinations",
    label: "Audience destinations",
    iconKey: "plug",
    scope: "member",
    group: "growth",
    routes: { web: "/app/audience-destinations", desktop: null, mobile: null },
  },
  {
    key: "keyHygiene",
    label: "Credential hygiene",
    iconKey: "shield",
    scope: "admin",
    group: "account",
    routes: { web: "/app/key-hygiene", desktop: null, mobile: null },
  },
  {
    key: "archive",
    label: "Archive",
    iconKey: "template",
    scope: "member",
    group: "growth",
    routes: {
      web: "/app/archive-settings",
      desktop: "/app/archive",
      mobile: null,
    },
  },
  {
    key: "dataControls",
    label: "Data controls",
    iconKey: "shield",
    scope: "admin",
    group: "account",
    routes: { web: "/app/data-controls", desktop: null, mobile: null },
  },
  {
    key: "sourceQuality",
    label: "Source quality",
    iconKey: "chart",
    scope: "member",
    group: "growth",
    routes: { web: "/app/source-quality", desktop: null, mobile: null },
  },
  {
    key: "complianceRequests",
    label: "Requests and reports",
    iconKey: "check",
    scope: "admin",
    group: "account",
    routes: { web: "/app/compliance-requests", desktop: null, mobile: null },
  },
  {
    key: "scoringTaxonomy",
    label: "Scoring and tags",
    iconKey: "tag",
    scope: "member",
    group: "workspace",
    routes: { web: "/app/scoring", desktop: null, mobile: null },
  },
  {
    key: "listHygiene",
    label: "List hygiene",
    iconKey: "shield",
    scope: "admin",
    group: "deliverability",
    routes: { web: "/app/list-hygiene", desktop: null, mobile: null },
  },
  {
    key: "onsiteGrowth",
    label: "Onsite growth",
    iconKey: "form",
    scope: "member",
    group: "growth",
    routes: { web: "/app/onsite-growth", desktop: null, mobile: null },
  },
  {
    key: "integrationCatalogue",
    label: "Integration catalogue",
    iconKey: "plug",
    scope: "member",
    group: "growth",
    routes: { web: "/app/integration-catalogue", desktop: null, mobile: null },
  },
  {
    key: "agentTools",
    label: "Agent tools",
    iconKey: "workflow",
    scope: "admin",
    group: "account",
    routes: { web: "/app/agent-tools", desktop: null, mobile: null },
  },
  {
    key: "routing",
    label: "Routing",
    iconKey: "plug",
    scope: "admin",
    group: "workspace",
    routes: { web: "/app/routing", desktop: null, mobile: null },
  },
  {
    key: "signupProtection",
    label: "Signup protection",
    iconKey: "shield",
    scope: "admin",
    group: "growth",
    routes: { web: "/app/signup-protection", desktop: null, mobile: null },
  },
  {
    key: "lifecycle",
    label: "Lifecycle",
    iconKey: "workflow",
    scope: "member",
    group: "workspace",
    routes: { web: "/app/lifecycle", desktop: null, mobile: null },
  },
  {
    key: "cohorts",
    label: "Cohorts",
    iconKey: "chart",
    scope: "member",
    group: "workspace",
    routes: { web: "/app/cohorts", desktop: null, mobile: null },
  },
  {
    key: "dataHygiene",
    label: "Data hygiene",
    iconKey: "check",
    scope: "admin",
    group: "account",
    routes: { web: "/app/data-hygiene", desktop: null, mobile: null },
  },
  {
    key: "contentLibrary",
    label: "Content library",
    iconKey: "template",
    scope: "member",
    group: "growth",
    routes: { web: "/app/content-library", desktop: null, mobile: null },
  },
  {
    key: "customObjects",
    label: "Custom objects",
    iconKey: "log",
    scope: "admin",
    group: "workspace",
    routes: { web: "/app/custom-objects", desktop: null, mobile: null },
  },
  {
    key: "encryptionKeys",
    label: "Encryption keys",
    iconKey: "shield",
    scope: "admin",
    group: "account",
    routes: { web: "/app/encryption-keys", desktop: null, mobile: null },
  },
  {
    key: "apiUsage",
    label: "API usage",
    iconKey: "chart",
    scope: "admin",
    group: "account",
    routes: { web: "/app/api-usage", desktop: null, mobile: null },
  },
  {
    key: "compliancePrograms",
    label: "Compliance",
    iconKey: "shield",
    scope: "admin",
    group: "account",
    routes: { web: "/app/compliance", desktop: null, mobile: null },
  },
  {
    key: "consentLedger",
    label: "Consent ledger",
    iconKey: "log",
    scope: "admin",
    group: "account",
    routes: { web: "/app/consent-ledger", desktop: null, mobile: null },
  },
  {
    key: "botOpens",
    label: "Machine opens",
    iconKey: "check",
    scope: "member",
    group: "deliverability",
    routes: { web: "/app/bot-opens", desktop: null, mobile: null },
  },
  {
    key: "agentRoutines",
    label: "Agent routines",
    iconKey: "workflow",
    scope: "admin",
    group: "workspace",
    routes: {
      web: "/app/agent-routines",
      desktop: null,
      mobile: "/(tabs)/agent-routines",
    },
  },
  {
    key: "audienceSyncs",
    label: "Audience syncs",
    iconKey: "plug",
    scope: "admin",
    group: "growth",
    routes: {
      web: "/app/audience-syncs",
      desktop: "/app/audience-syncs",
      mobile: null,
    },
  },
  {
    key: "assets",
    label: "Assets",
    iconKey: "template",
    scope: "member",
    group: "growth",
    routes: { web: "/app/assets", desktop: "/app/assets", mobile: null },
  },
  {
    key: "analyticsDestinations",
    label: "Analytics destinations",
    iconKey: "plug",
    scope: "admin",
    group: "account",
    routes: { web: "/app/analytics-destinations", desktop: null, mobile: null },
  },
  {
    key: "dmarc",
    label: "DMARC",
    iconKey: "shield",
    scope: "member",
    group: "deliverability",
    routes: {
      web: "/app/dmarc",
      desktop: "/app/dmarc",
      mobile: "/(tabs)/dmarc",
    },
  },
  {
    key: "aiQuality",
    label: "AI quality",
    iconKey: "check",
    scope: "admin",
    group: "account",
    routes: { web: "/app/ai-quality", desktop: null, mobile: null },
  },
  {
    key: "serviceSuite",
    label: "Service suite & Helpdesk",
    iconKey: "inbox",
    scope: "admin",
    group: "workspace",
    routes: { web: "/app/service-suite", desktop: null, mobile: null },
  },
  {
    key: "humanReach",
    label: "Human reach",
    iconKey: "check",
    scope: "member",
    group: "deliverability",
    routes: { web: "/app/human-reach", desktop: null, mobile: null },
  },
  {
    key: "privacyPortal",
    label: "Privacy portal",
    iconKey: "shield",
    scope: "admin",
    group: "account",
    routes: {
      web: "/app/privacy-portal",
      desktop: "/app/privacy-portal",
      mobile: null,
    },
  },
  {
    key: "privacyIncidents",
    label: "Privacy incidents",
    iconKey: "shield",
    scope: "admin",
    group: "account",
    routes: {
      web: "/app/privacy-incidents",
      desktop: "/app/privacy-incidents",
      mobile: null,
    },
  },
  {
    key: "piiFindings",
    label: "Shadow-PII findings",
    iconKey: "shield",
    scope: "admin",
    group: "account",
    routes: {
      web: "/app/pii-findings",
      desktop: null,
      mobile: "/(tabs)/pii-findings",
    },
  },
  {
    key: "referrals",
    label: "Referrals",
    iconKey: "handshake",
    scope: "member",
    group: "growth",
    routes: { web: "/app/referrals", desktop: null, mobile: null },
  },
  {
    // Five /api/v1/track/* paths desktop reached and web did not.
    key: "track",
    label: "Product events",
    iconKey: "chart",
    scope: "member",
    group: "workspace",
    routes: { web: "/app/track", desktop: "/app/track", mobile: null },
  },
  {
    key: "translations",
    label: "Translations",
    iconKey: "mail",
    scope: "member",
    group: "growth",
    routes: { web: "/app/translations", desktop: null, mobile: null },
  },
  {
    // The server reports runtime_status "unavailable"; the page says so.
    key: "omnichannel",
    label: "Omnichannel",
    iconKey: "workflow",
    scope: "member",
    group: "workspace",
    routes: { web: "/app/omnichannel", desktop: null, mobile: null },
  },
  {
    // Four /api/v1/predictive/* paths desktop reached and web did not.
    key: "predictive",
    label: "Predictive",
    iconKey: "chart",
    scope: "member",
    group: "growth",
    routes: { web: "/app/predictive", desktop: null, mobile: null },
  },
  {
    // Eight /api/v1/warehouse/* paths desktop reached and web did not.
    key: "warehouse",
    label: "Data warehouse",
    iconKey: "plug",
    scope: "admin",
    group: "account",
    routes: { web: "/app/warehouse", desktop: null, mobile: null },
  },
  {
    // Seven /api/v1/social-capture/* paths. Every network still reports
    // `runtime_status: "foundation"` — built, not live.
    key: "socialCapture",
    label: "Social capture",
    iconKey: "inbox",
    scope: "member",
    group: "growth",
    routes: { web: "/app/social-capture", desktop: null, mobile: null },
  },
  {
    // Desktop reached the verification endpoints with no web counterpart.
    // `desktop` is null for the same reason as deliverabilityHub: desktop
    // surfaces this inside its hub rather than at a route of its own.
    key: "verification",
    label: "Verification",
    iconKey: "check",
    scope: "member",
    group: "deliverability",
    routes: { web: "/app/verification", desktop: null, mobile: null },
  },
  {
    // DISTINCT from inboxReality. Both speak about sending reputation, but
    // they read different endpoints: Inbox Reality is built on
    // /reputation/history + /dmarc/*, while the hub is /deliverability/hub and
    // its sub-resources (dns-health, blocklist-hits, webhook-errors,
    // bounce-class-breakdown) — five paths web reached nowhere before
    // 2026-08-21. The hub is also the only one of the two that receives
    // `sample_qualified`, which is what lets it refuse to present an
    // unearned grade.
    key: "deliverabilityHub",
    label: "Deliverability",
    iconKey: "shield",
    scope: "member",
    group: "deliverability",
    // Desktop's Deliverability Hub IS this entry. Both surfaces read the same
    // six endpoints — /api/v1/deliverability/hub plus dns-health,
    // blocklist-hits, webhook-errors, bounce-class-breakdown and
    // repair-override — so the screens are the same feature at different
    // depths, not two features sharing a word.
    //
    // This route previously belonged to `inboxReality`, which was the wrong way
    // round: web's inbox-reality reads a DISJOINT family (reputation,
    // auth-checks, dmarc/reports, predict) that desktop surfaces at its own
    // `dmarc` section. See the note on inboxReality below.
    routes: {
      web: "/app/deliverability",
      desktop: "/app/deliverability-hub",
      mobile: "/(tabs)/deliverability",
    },
  },
  {
    key: "inboxReality",
    label: "Inbox Reality",
    iconKey: "inbox",
    scope: "member",
    group: "deliverability",
    // Desktop has no inbox-reality screen, and the Deliverability Hub is NOT
    // it: this entry's endpoints (reputation, auth-checks, dmarc/reports,
    // predict) do not overlap the hub's at all. Desktop's nearest equivalent
    // is its separate `dmarc` section, which the `dmarc` entry routes.
    //
    // Pointing this at /app/deliverability-hub advertised a desktop screen
    // that answers a different question, and held the route hostage from the
    // entry that genuinely owns it.
    routes: {
      web: "/app/inbox-reality",
      desktop: null,
      mobile: null,
    },
  },
  {
    key: "migrations",
    label: "Migrations",
    iconKey: "migrate",
    scope: "member",
    group: "workspace",
    routes: {
      web: "/app/migrations",
      desktop: "/app/migrations",
      mobile: "/(tabs)/migrations",
    },
  },
  {
    key: "integrations",
    label: "Integrations",
    iconKey: "plug",
    scope: "member",
    group: "workspace",
    routes: {
      web: "/app/integrations",
      desktop: "/app/integrations",
      mobile: "/(tabs)/integrations",
    },
  },
  {
    // Shipped on desktop (pages/Agency.tsx) and mobile ((tabs)/agency.tsx)
    // long before the web dashboard had it, so the manifest listed neither and
    // the capability was invisible to every cross-surface check. Web gained it
    // on 2026-08-21; modelling it here is what makes the three agree.
    key: "agency",
    label: "Agency",
    iconKey: "users",
    scope: "admin",
    group: "account",
    routes: {
      web: "/app/agency",
      desktop: "/app/agency",
      mobile: "/(tabs)/agency",
    },
  },
  {
    key: "affiliates",
    label: "Affiliates",
    iconKey: "handshake",
    scope: "member",
    group: "growth",
    routes: {
      web: "/app/affiliates",
      desktop: "/app/affiliates",
      mobile: null,
    },
  },
  {
    key: "billing",
    label: "Billing",
    iconKey: "billing",
    scope: "admin",
    group: "account",
    // `mobile` was null while apps/mobile shipped app/(tabs)/billing.tsx,
    // registered it in (tabs)/_layout.tsx and listed it in the More sheet as
    // "Plan & usage" — so the file that calls itself authoritative was simply
    // wrong about a shipped screen. Reconciled the same way `audit` and
    // `settings` already are: a non-null mobile route means the surface OWNS
    // the screen (mobile reaches account-group entries through the More sheet,
    // not a bottom tab — see the header note on primary chrome).
    // Desktop ships no dedicated billing section — plan state and the payment
    // method live under Settings (see notification-navigation.ts's category
    // fallback, which already says so). `null` is the honest value; the old
    // "/app/billing" failed to parse.
    routes: {
      web: "/app/billing",
      desktop: null,
      mobile: "/(tabs)/billing",
    },
  },
  {
    key: "audit",
    label: "Audit log",
    iconKey: "log",
    scope: "admin",
    group: "account",
    // Web intentionally nests governance tools under Settings; this is the
    // shipped, palette-reachable audit page, not a missing top-level route.
    routes: {
      web: "/app/settings/audit",
      desktop: "/app/audit",
      mobile: "/(tabs)/audit",
    },
    kbd: "⌘9",
  },
  {
    key: "settings",
    label: "Settings",
    iconKey: "settings",
    scope: "member",
    group: "account",
    routes: {
      web: "/app/settings",
      desktop: "/app/settings",
      mobile: "/(tabs)/settings",
    },
  },
  {
    key: "flows",
    label: "Flows",
    iconKey: "workflow",
    scope: "member",
    group: "workspace",
    // Desktop's automation section is `automations`; mobile reaches Flows from
    // the More sheet rather than the 5-slot tab bar.
    //
    // packages/route-map marks `flow.surfaces.desktop = "none"`. That is not a
    // contradiction and it is not redundant: route-map answers "can you
    // deep-link to ONE flow record here?" (no — desktop has no /flows/:id) and
    // this manifest answers "where does the Flows nav concept land?" (the
    // automations section). Recorded in NAV_ROUTE_MAP_DIVERGENCE_ACK so the
    // two contracts are cross-checked instead of merely coexisting.
    routes: { web: "/app/flows", desktop: "/app/automations", mobile: null },
  },
  {
    key: "suppressions",
    label: "Suppressions",
    iconKey: "shield",
    scope: "member",
    group: "deliverability",
    routes: {
      web: "/app/suppressions",
      desktop: "/app/suppressions",
      mobile: null,
    },
  },
  {
    key: "landingPages",
    label: "Landing Pages",
    iconKey: "page",
    scope: "member",
    group: "growth",
    // No desktop section exists for landing pages today.
    routes: { web: "/app/landing-pages", desktop: null, mobile: null },
  },
  {
    key: "discounts",
    label: "Discount history",
    iconKey: "tag",
    scope: "member",
    group: "growth",
    // Both web and desktop expose the same inspection-only, sanitized history
    // boundary. Neither route exposes coupon codes, customer identity, provider
    // writes, coupon-pool inventory, or redemption export.
    routes: {
      web: "/app/discounts",
      desktop: "/app/discounts",
      mobile: null,
    },
  },
  {
    // All three clients ship a commerce workspace. Store enumeration and the
    // administrative verbs are owner/admin scoped on the API, so advertising
    // this destination to ordinary members only leads to a known 403 state.
    key: "commerce",
    label: "Commerce",
    iconKey: "billing",
    scope: "admin",
    group: "growth",
    routes: {
      web: "/app/commerce",
      desktop: "/app/commerce",
      mobile: "/(tabs)/commerce",
    },
  },
  {
    key: "inboundWebhooks",
    label: "Inbound Webhooks",
    iconKey: "plug",
    scope: "admin",
    group: "workspace",
    // Desktop's `webhooks` section is the OUTBOUND catalog — a different
    // resource, not a slug variant of this one.
    routes: { web: "/app/inbound-webhooks", desktop: null, mobile: null },
  },
  {
    key: "sequenceTemplates",
    label: "Sequence Templates",
    iconKey: "template",
    scope: "member",
    group: "growth",
    routes: { web: "/app/sequence-templates", desktop: null, mobile: null },
  },
  {
    key: "notifications",
    label: "Notifications",
    iconKey: "bell",
    scope: "member",
    group: "account",
    routes: {
      web: "/app/notifications",
      desktop: null,
      mobile: "/(tabs)/notifications",
    },
  },
] as const;

/**
 * Shipped screens that DELIBERATELY have no primary-navigation entry, with the
 * reason. Anything not listed here and not reachable from the manifest (or, on
 * mobile, from the More sheet) is an orphan: reachable only by typing the URL,
 * invisible to nav, search and the command palette.
 *
 * `scripts/check-nav-manifest-destinations.mjs` fails when a screen is missing
 * from both, AND when an entry here stops being an orphan — a stale excuse
 * hides the next real one behind it.
 */
export const NAV_ORPHAN_ACK: Record<string, string> = {
  "mobile:access-denied":
    "Guard-only denial target. SecondaryRouteGuard replaces a forbidden screen with this hidden route so sensitive content unmounts; it is intentionally never offered as a destination.",
  "mobile:cli-approve":
    "Device-approval landing for the CLI grant. Reached from Settings \u2192 Device approvals, and by scanning the QR or following the universal link \u2014 but never from the tab bar or the More sheet, because an approval screen with no pending request is a dead end.",
  "mobile:more":
    "The More sheet itself. It IS the navigation for mobile's secondary routes, so it cannot be one of its own destinations.",
};

/**
 * Web routes this manifest does not model, and why.
 *
 * Three entries used to live in NAV_ORPHAN_ACK claiming that /app/pilot,
 * /app/compatibility and /app/voice-labels were unreachable. All three were
 * false \u2014 the first two are sidebar items and the third is in the \u2318K palette.
 * They read as plausible because the guard scanned mobile's own route tables
 * but never web's, so it could only see the filesystem and had to be TOLD what
 * was reachable. It reads apps/web/src/lib/dashboard-routes.ts now, which is
 * why the excuses are gone rather than corrected: nothing needed excusing.
 */
export const NAV_WEB_UNMODELLED: Record<string, string> = {
  "/app/pilot":
    "Pilot-cohort console. In the sidebar for cohort tenants, but scoped to a programme rather than a product capability, so it has no counterpart on any other surface to keep a canonical label for.",
  "/app/compatibility":
    "Engine/API compatibility report \u2014 a release-engineering surface. Web-only by design.",
};

/**
 * Places where this manifest and packages/route-map differ on purpose.
 *
 * The two contracts answer different questions \u2014 route-map: "can you deep-link
 * to ONE record of this entity on this surface?", this manifest: "where does
 * this nav CONCEPT land?" \u2014 so a divergence is expected. It is recorded
 * because two shared contracts that quietly disagree are indistinguishable
 * from one of them being wrong, and both are gated in the same CI job.
 */
export const NAV_ROUTE_MAP_DIVERGENCE_ACK: Record<string, string> = {
  "flows:desktop":
    'route-map has flow.surfaces.desktop = "none" (no /flows/:id detail route); this manifest points the Flows concept at desktop\'s automations section, which is the same concept without per-record deep links.',
};

export type NavKey = (typeof NAV_ENTRIES)[number]["key"];
