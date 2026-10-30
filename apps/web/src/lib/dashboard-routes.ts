// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared dashboard route facts. UI shells map `icon` keys to concrete lucide
// components locally so this module stays plain data for Node tests.

import { NAV_ENTRIES } from "@postwave/nav";

export type DashboardCommandGroup = "go" | "settings";
export type DashboardRouteScope = "member" | "admin";

/**
 * Logical sidebar section, mirroring the shared @postwave/nav `NavGroup` so the
 * web sidebar can render the same Workspace / Growth / Deliverability / Account
 * headers the manifest already encodes (SHELL-012).
 */
export type DashboardNavGroup =
  | "workspace"
  | "growth"
  | "deliverability"
  | "account";

export type DashboardRouteIcon =
  | "arrowRightLeft"
  | "badgeCheck"
  | "building2"
  | "barChart3"
  | "clipboardCheck"
  | "clipboardList"
  | "creditCard"
  | "gavel"
  | "gitBranch"
  | "handshake"
  | "inbox"
  | "keyRound"
  | "layoutDashboard"
  | "layoutTemplate"
  | "mail"
  | "messageSquareText"
  | "mic"
  | "panelTop"
  | "plug"
  | "settings"
  | "shield"
  | "shieldBan"
  | "ticketPercent"
  | "userCog"
  | "users"
  | "webhook"
  | "workflow";

export interface DashboardRoute {
  label: string;
  href: `/app${string}`;
  icon: DashboardRouteIcon;
  sidebar?: boolean;
  commandGroup?: DashboardCommandGroup;
  keywords?: readonly string[];
  /** Sidebar section — sourced from the manifest, defaulted for web-only routes. */
  group?: DashboardNavGroup;
  /** Display-only keyboard hint (⌘1…) from the manifest; not bound on web. */
  kbd?: string;
  /** Coarse visibility boundary sourced from @postwave/nav. */
  scope?: DashboardRouteScope;
}

export interface DashboardCreateRoute {
  label: string;
  href: `/app${string}`;
  keywords?: readonly string[];
}

const RAW_DASHBOARD_ROUTES: readonly DashboardRoute[] = [
  {
    label: "Overview",
    href: "/app",
    icon: "layoutDashboard",
    sidebar: true,
    commandGroup: "go",
    keywords: ["home", "dashboard"],
  },
  {
    // Full notifications history/center (SHELL-017). Reached from the bell's
    // "View all" and ⌘K; not a sidebar entry (the bell is the primary surface).
    label: "Notification history",
    href: "/app/notifications",
    icon: "inbox",
    commandGroup: "go",
    keywords: ["notifications", "alerts", "history", "activity", "inbox"],
  },
  {
    label: "Subscribers",
    href: "/app/subscribers",
    icon: "users",
    sidebar: true,
    commandGroup: "go",
    keywords: ["contacts", "audience"],
  },
  {
    label: "Lists",
    href: "/app/lists",
    icon: "users",
    sidebar: true,
    commandGroup: "go",
    keywords: ["audience", "list", "opt-in"],
  },
  {
    label: "Tags",
    href: "/app/tags",
    icon: "badgeCheck",
    sidebar: true,
    commandGroup: "go",
    keywords: ["taxonomy", "labels", "subscriber tags", "groups"],
  },
  {
    label: "Campaigns",
    href: "/app/campaigns",
    icon: "mail",
    sidebar: true,
    commandGroup: "go",
    keywords: ["broadcast", "newsletter", "send"],
  },
  {
    label: "Analytics",
    href: "/app/analytics",
    icon: "barChart3",
    sidebar: true,
    commandGroup: "go",
    keywords: ["metrics", "stats", "insights"],
  },
  // Saved report definitions. Palette-only rather than sidebar: it is reached
  // from Analytics in normal use, and the sidebar set is a deliberate 21-item
  // budget. Listing it here is what keeps it off the orphan list.
  {
    label: "Reports",
    href: "/app/reports",
    icon: "clipboardList",
    commandGroup: "go",
    keywords: ["saved reports", "report definitions", "metric version"],
  },
  {
    label: "Migrations",
    href: "/app/migrations",
    icon: "arrowRightLeft",
    sidebar: true,
    commandGroup: "go",
    keywords: ["import", "mailchimp", "klaviyo"],
  },
  {
    label: "Pilot",
    href: "/app/pilot",
    icon: "clipboardCheck",
    sidebar: true,
    commandGroup: "go",
  },
  {
    label: "Compatibility",
    href: "/app/compatibility",
    icon: "badgeCheck",
    sidebar: true,
    commandGroup: "go",
  },
  {
    label: "SMS",
    href: "/app/sms",
    icon: "messageSquareText",
    sidebar: true,
    commandGroup: "go",
    keywords: [
      "text",
      "a2p",
      "consent",
      "suppression",
      "inbox",
      "campaign",
      "sender registration",
    ],
  },
  {
    label: "Inbox Reality",
    href: "/app/inbox-reality",
    icon: "inbox",
    sidebar: true,
    commandGroup: "go",
    keywords: ["deliverability", "spam"],
  },
  {
    label: "Predict placement",
    href: "/app/inbox-reality/predict",
    icon: "inbox",
    commandGroup: "go",
    keywords: [
      "pre-send",
      "presend",
      "forecast",
      "spam",
      "deliverability",
      "placement",
      "predictor",
    ],
  },
  {
    // Answer Engine Optimization sensor (desktop parity, analytics-1..10).
    // Palette-only: the sidebar has a deliberate budget, and operators reach
    // this from the archive / analytics context rather than the rail.
    label: "AEO Sensor",
    href: "/app/aeo",
    icon: "barChart3",
    commandGroup: "go",
    keywords: [
      "aeo",
      "answer engine",
      "chatgpt",
      "gemini",
      "perplexity",
      "citations",
      "brand mentions",
      "ai search",
    ],
  },
  {
    label: "Sequences",
    href: "/app/sequences",
    icon: "workflow",
    sidebar: true,
    commandGroup: "go",
    keywords: ["automation", "drip", "flow"],
  },
  {
    label: "Flows",
    href: "/app/flows",
    icon: "gitBranch",
    sidebar: true,
    commandGroup: "go",
    keywords: ["automation", "journey", "canvas"],
  },
  {
    label: "Forms",
    href: "/app/forms",
    icon: "clipboardList",
    sidebar: true,
    commandGroup: "go",
    keywords: ["signup", "popup", "embed"],
  },
  {
    label: "Landing Pages",
    href: "/app/landing-pages",
    icon: "panelTop",
    sidebar: true,
    commandGroup: "go",
    keywords: ["page", "site", "web", "lander"],
  },
  {
    label: "Templates",
    href: "/app/templates",
    icon: "layoutTemplate",
    sidebar: true,
    commandGroup: "go",
    keywords: ["email", "newsletter", "design", "gallery"],
  },
  {
    label: "Sequence Templates",
    href: "/app/sequence-templates",
    icon: "workflow",
    commandGroup: "go",
    keywords: ["voice", "drip", "series", "automation", "writing"],
  },
  {
    label: "Voice Profile",
    href: "/app/sequences/voice-profile",
    icon: "mic",
    commandGroup: "go",
    keywords: ["tone", "brand voice", "writing", "style", "sequences"],
  },
  {
    label: "Voice Labels",
    href: "/app/voice-labels",
    icon: "mic",
    commandGroup: "go",
    keywords: ["tone", "brand voice", "writing"],
  },
  {
    label: "Integrations",
    href: "/app/integrations",
    icon: "plug",
    commandGroup: "go",
    keywords: ["connect", "apps", "crm", "commerce", "webhook"],
  },
  {
    label: "Integration Catalog",
    href: "/app/integrations/catalog",
    icon: "plug",
    commandGroup: "go",
    keywords: [
      "browse",
      "directory",
      "marketplace",
      "native",
      "apps",
      "connectors",
    ],
  },
  {
    label: "Inbound Webhooks",
    href: "/app/inbound-webhooks",
    icon: "webhook",
    sidebar: true,
    commandGroup: "go",
    keywords: ["incoming", "ingest", "endpoint", "receive", "events"],
  },
  {
    label: "Billing",
    href: "/app/billing",
    icon: "creditCard",
    sidebar: true,
    commandGroup: "go",
    keywords: ["plan", "invoice", "subscription"],
  },
  {
    // Read-only roster and stored audit-portal branding projection. Lifecycle,
    // publishing, custom-host routing, and billing estimates are release-held.
    label: "Agency",
    href: "/app/agency",
    icon: "building2",
    sidebar: true,
    commandGroup: "go",
    keywords: ["child", "workspace", "reseller", "audit branding", "roster"],
  },
  {
    label: "Affiliates",
    href: "/app/affiliates",
    icon: "handshake",
    sidebar: true,
    commandGroup: "go",
    keywords: ["referral", "partner"],
  },
  {
    label: "Discount history",
    href: "/app/discounts",
    icon: "ticketPercent",
    sidebar: true,
    commandGroup: "go",
    keywords: ["history", "archive", "stored terms", "recorded uses"],
  },
  {
    label: "Commerce",
    href: "/app/commerce",
    icon: "creditCard",
    sidebar: true,
    commandGroup: "go",
    keywords: [
      "store",
      "shopify",
      "woocommerce",
      "stripe",
      "catalog",
      "orders",
      "recovery",
    ],
  },
  {
    label: "Approvals",
    href: "/app/approvals",
    icon: "gavel",
    sidebar: true,
    commandGroup: "go",
    keywords: ["review", "approve", "reject", "governance", "sign-off"],
  },
  {
    // The hub had twelve desktop endpoints and no web surface at all. The
    // score is deliberately withheld when `sample_qualified` is false — see
    // the page for why an unqualified "A" is the worst thing this screen
    // could render.
    label: "Deliverability",
    href: "/app/deliverability",
    icon: "shield",
    sidebar: true,
    commandGroup: "go",
    keywords: [
      "reputation",
      "score",
      "dns",
      "spf",
      "dkim",
      "dmarc",
      "blocklist",
      "bounce",
    ],
  },
  {
    // Eight /api/v1/verification/* paths were reached by desktop and nothing
    // on web. `balance: null` is rendered as an em-dash, never 0 — "no paid
    // provider" and "out of credits" are opposite situations.
    // Four /api/v1/predictive/* paths desktop reached and web did not. The
    // page keeps MODEL status and DATA sufficiency apart — one is a property
    // of the build, the other is something the operator can change.
    // Five /api/v1/translations/* paths. `updated_at` is Go's zero time on a
    // never-saved workspace and must not be formatted as a date.
    // Five /api/v1/track/* paths. The page states the measurement WINDOW
    // beside the count, because "0 events" over 30 days in UTC and "0 events"
    // over 7 days locally are different answers to a tracking-install question.
    // Four /api/v1/referrals/* paths, and web had no referrals surface at all.
    // Five /api/v1/privacy/portal* paths. The surface that answers "can we
    // evidence consent, and what have we been asked to erase?"
    // The server ships a finished `headline` sentence and a `methodology`
    // paragraph arguing the figure is a FLOOR, not an estimate. Both are
    // rendered verbatim.
    // Four /api/v1/ai-regression/* paths. The page compares the golden-example
    // count against min_examples_for_gate and says when the gate is inert.
    // Four /api/v1/deliverability/dmarc-* paths. Zero reports does not mean
    // zero mail, and the server's suggestion says so — rendered verbatim.
    // 31 destinations, every one runtime_status "partial" and four awaiting
    // live certification. The page states that rather than showing 31 Connect
    // buttons that imply production readiness.
    // Four /api/v1/assets* paths. Counts come from the server and describe the
    // whole library, not the current page.
    // Four /api/v1/audience-syncs* paths. The exclusion receipt is the point:
    // the compliance question is who was WITHHELD, not who was sent.
    // Mobile ships a routines screen; web had none. On a governance surface
    // "nothing is scheduled" must be known, not guessed.
    // Two /api/v1/bot-opens/* paths. Total is reported separately from the
    // two parts, so the unclassified remainder is shown rather than folded in.
    // The evidence trail behind every "they opted in". `has_more` and
    // `source_planes` are shown because incomplete evidence presented as
    // complete is the failure mode that matters here.
    // HIPAA reports `unsupported` with a legal note; the rest are
    // `in_progress`. Eight framework names in a tidy list would read as eight
    // compliance programmes, so the unsupported ones lead.
    // Three /api/v1/api-usage/* paths. The measured window and the
    // straight-line projection are separated: only one of them is money spent.
    // /providers returns `supported` AND `providers` — what this build can
    // talk to vs what this workspace configured. Conflating them tells someone
    // their data is under their own key when it is not.
    // Collection count comes from the server's `total`, not the page length.
    // pii-config + deduplication + identifier-transforms. Merging is
    // destructive and 0.95 renders as a tidy "95%" that reads like a quality
    // score, so the page says which direction is riskier.
    // The unit is part of the number: engagement classification counts
    // INTERACTION EVENTS while human-reach counts RECIPIENTS. Same word, two
    // different things, unless one of them says which.
    // Declared stages and occupied stages are different lists: a configured
    // stage with nobody in it is a fact, and deriving the list from the
    // distribution would silently delete every empty stage.
    // observed / accepted / rejected are NOT a partition: a signup observed
    // and not ruled on is its own case, and accepted+rejected as "the total"
    // hides it.
    // A 404 on the inbound endpoint is "never provisioned", not a failure.
    // Caught specifically; every other error still propagates.
    // the governed tool catalog, and quotas the server reports as
    // `authoritative: false`.
    // Enforcement status leads: a limit that does not bind is worse than none.
    // 57 providers: 9 loyalty + 48 lead sources. All partial except one
    // `delegated`, which is a different state rather than a lesser one.
    // First MIXED catalogue in the sweep: 15 supported, 11 partial, 2
    // unavailable. A blanket banner would be false, so status is per-option.
    // automatic_reactivation_active decides what "eligible now" implies:
    // off means nobody is acting on those addresses. Same number, opposite
    // call to action.
    // 0 custom rules + 6 defaults means scoring IS running. Showing "0 rules"
    // would say the opposite, so the page renders the EFFECTIVE weights.
    // "No outstanding subject access requests" is a claim with a legal
    // deadline behind it — the error branch refuses to make it.
    // A 0% complaint rate on zero sends is not a compliment — the page
    // distinguishes "unmeasured" from "flawless".
    // available / scan_enabled / scheduled_scans_available are three different
    // questions. "Off" is a setting; "not offered" is a limitation.
    // tips_suggested_amounts is in CENTS and is shown to READERS. Second
    // cents trap this sweep, and the one that would misprice a stranger.
    // "3 inactive keys" is not a fact without threshold_days. And score
    // snapshots across a model_version change are not one series.
    // capabilities are PER-PROVIDER: four ad platforms can diagnose a failed
    // sync and Meta cannot. Five identical logos would imply otherwise, and
    // the difference matters BEFORE you pick a destination, not during an
    // incident.
    // human/bot do NOT partition the total — unclassified is a third band —
    // and the sender table's window is 90 days against the summary's 30.
    // churn_threshold is a FRACTION (0.7); 12 profiles are scored while the
    // automation is off, so neither number means anything without the other.
    // quiet_hours_per_recipient is TRUE with bucket_count 0, and eligible_now
    // is a counterfactual while auto-suppress is off.
    // blocked-products joins to metrics BY KEY; the product_area join marks
    // 9 of 24 unavailable when only 6 are.
    // public_contract is a server-authored privacy guarantee; rendered
    // verbatim, never paraphrased.
    // every event has created_at AND recorded_at, 20 days apart here; plus
    // source_planes / snapshot_at / has_more qualify the whole response.
    // three empties with three different causes: no campaigns to analyse,
    // nothing ranked, and a regression that has NEVER run (not "run clean").
    // sample payloads are illustrations, and the 15 event types are what THIS
    // build emits — not a closed protocol list.
    // verdict carries complete:false, send-window says allow with enforcement
    // off, and expected_open 0 means no basis — none are what they look like.
    // validators return warnings on SUCCESS (social capture: valid, but no SMS
    // consent handoff), and completed_at is the only proof a sweep ran.
    // rewritten == original means no template; no_matches with evaluated:0
    // says nothing about the routes; verify-batch is billable and needs a key.
    // streams/token mints a live bearer credential; endpoint/rotate keeps the
    // inbound slug but immediately replaces its signing secret, revealed once.
    // retention_days is a DELETION deadline; zero DMARC reports alone proves
    // neither healthy delivery nor an absent DMARC publication.
    // BYOK provider, no key in this workspace. "not configured" and "provider
    // down" return the SAME error, so the page never names a remedy.
    label: "AI assist",
    href: "/app/ai-assist",
    icon: "mic",
    sidebar: true,
    commandGroup: "go",
    keywords: ["ai", "compose", "draft", "subject line", "nlq", "anomaly"],
  },
  {
    label: "Workspace operations",
    href: "/app/workspace-ops",
    icon: "settings",
    sidebar: true,
    commandGroup: "go",
    keywords: ["retention", "dmarc", "dns", "warmup", "blocks", "flags"],
  },
  {
    label: "Alerting and access",
    href: "/app/alerting-access",
    icon: "shield",
    sidebar: true,
    commandGroup: "go",
    keywords: ["pagerduty", "jira", "servicenow", "token", "rotate", "inbound"],
  },
  {
    label: "Data operations",
    href: "/app/data-operations",
    icon: "arrowRightLeft",
    sidebar: true,
    commandGroup: "go",
    keywords: ["utm", "rewrite", "route", "tag", "merge", "verify", "sink"],
  },
  {
    label: "Maintenance",
    href: "/app/maintenance",
    icon: "settings",
    sidebar: true,
    commandGroup: "go",
    keywords: ["run now", "sweep", "validate", "recompute", "job"],
  },
  {
    label: "Pre-flight",
    href: "/app/preflight",
    icon: "clipboardCheck",
    sidebar: true,
    commandGroup: "go",
    keywords: ["presend", "check", "accessibility", "subject line", "verdict"],
  },
  {
    label: "Developer reference",
    href: "/app/developer-reference",
    icon: "webhook",
    sidebar: true,
    commandGroup: "go",
    keywords: ["webhook", "event", "payload", "transform", "merge field"],
  },
  {
    label: "Webhook simulator",
    href: "/app/developer-reference/webhook-simulator",
    icon: "webhook",
    commandGroup: "go",
    keywords: ["webhook", "simulate", "test event", "payload", "signature"],
  },
  {
    label: "API playground",
    href: "/app/developer-reference/playground",
    icon: "webhook",
    commandGroup: "go",
    keywords: ["api", "request", "try it", "endpoint", "curl"],
  },
  {
    label: "Content quality",
    href: "/app/content-quality",
    icon: "clipboardCheck",
    sidebar: true,
    commandGroup: "go",
    keywords: ["subject line", "template", "leaderboard", "regression", "ai"],
  },
  {
    label: "Consent evidence",
    href: "/app/consent-evidence",
    icon: "gavel",
    sidebar: true,
    commandGroup: "go",
    keywords: ["consent", "ledger", "proof", "policy", "incident", "gdpr"],
  },
  {
    label: "Reviews",
    href: "/app/reviews",
    icon: "badgeCheck",
    sidebar: true,
    commandGroup: "go",
    keywords: ["review", "rating", "widget", "moderation", "testimonial"],
  },
  {
    label: "Reporting catalogue",
    href: "/app/reporting-catalogue",
    icon: "barChart3",
    sidebar: true,
    commandGroup: "go",
    keywords: ["metric", "registry", "reporting", "blocked", "coverage"],
  },
  {
    label: "Sending health",
    href: "/app/sending-health",
    icon: "badgeCheck",
    sidebar: true,
    commandGroup: "go",
    keywords: ["quiet hours", "reputation", "spam trap", "suppress", "timing"],
  },
  {
    label: "Win-back",
    href: "/app/retention",
    icon: "ticketPercent",
    sidebar: true,
    commandGroup: "go",
    keywords: ["churn", "winback", "retention", "offer", "risk"],
  },
  {
    label: "Replies",
    href: "/app/replies",
    icon: "messageSquareText",
    sidebar: true,
    commandGroup: "go",
    keywords: ["reply", "inbound", "responses", "senders", "human"],
  },
  {
    label: "Audience destinations",
    href: "/app/audience-destinations",
    icon: "arrowRightLeft",
    sidebar: true,
    commandGroup: "go",
    keywords: [
      "ads",
      "google ads",
      "meta",
      "tiktok",
      "holdout",
      "control group",
    ],
  },
  {
    label: "Credential hygiene",
    href: "/app/key-hygiene",
    icon: "keyRound",
    sidebar: true,
    commandGroup: "go",
    keywords: ["api key", "dormant", "inactive", "revoke", "score history"],
  },
  {
    label: "Archive settings",
    href: "/app/archive-settings",
    icon: "layoutTemplate",
    sidebar: true,
    commandGroup: "go",
    keywords: ["archive", "public", "tips", "tipping", "domain"],
  },
  {
    label: "Data controls",
    href: "/app/data-controls",
    icon: "shieldBan",
    sidebar: true,
    commandGroup: "go",
    keywords: ["pii", "scan", "transform", "import template", "privacy"],
  },
  {
    label: "Source quality",
    href: "/app/source-quality",
    icon: "badgeCheck",
    sidebar: true,
    commandGroup: "go",
    keywords: ["source", "quality", "acquisition", "gift", "paywall"],
  },
  {
    label: "Gift history",
    href: "/app/source-quality/gifts",
    icon: "badgeCheck",
    commandGroup: "go",
    keywords: ["gift", "redeemed", "paywall", "source quality"],
  },
  {
    label: "Requests and reports",
    href: "/app/compliance-requests",
    icon: "clipboardCheck",
    sidebar: true,
    commandGroup: "go",
    keywords: [
      "dsar",
      "sar",
      "subject access",
      "scheduled report",
      "brand voice",
    ],
  },
  {
    label: "Scoring and tags",
    href: "/app/scoring",
    icon: "clipboardList",
    sidebar: true,
    commandGroup: "go",
    keywords: ["score", "lead", "weight", "tag", "taxonomy", "utm"],
  },
  {
    label: "List hygiene",
    href: "/app/list-hygiene",
    icon: "shieldBan",
    sidebar: true,
    commandGroup: "go",
    keywords: ["sunset", "bounce", "spam trap", "frequency cap", "send window"],
  },
  {
    label: "Onsite growth",
    href: "/app/onsite-growth",
    icon: "layoutTemplate",
    sidebar: true,
    commandGroup: "go",
    keywords: [
      "popup",
      "onsite",
      "trigger",
      "targeting",
      "recommendation",
      "nbp",
    ],
  },
  {
    label: "Integration catalogue",
    href: "/app/integration-catalogue",
    icon: "plug",
    sidebar: true,
    commandGroup: "go",
    keywords: [
      "loyalty",
      "lead",
      "forms",
      "typeform",
      "ads",
      "cms",
      "connector",
    ],
  },
  {
    label: "Agent tools",
    href: "/app/agent-tools",
    icon: "workflow",
    sidebar: true,
    commandGroup: "go",
    keywords: ["mcp", "agent", "tools", "quota", "governance"],
  },
  {
    label: "Routing",
    href: "/app/routing",
    icon: "arrowRightLeft",
    sidebar: true,
    commandGroup: "go",
    keywords: ["inbound", "reply", "route", "webhook", "outbound", "events"],
  },
  {
    label: "Outbound webhooks",
    href: "/app/routing/outbound-webhooks",
    icon: "arrowRightLeft",
    commandGroup: "go",
    keywords: [
      "webhook",
      "outbound",
      "deliveries",
      "replay",
      "signing secret",
      "endpoint",
    ],
  },
  {
    label: "Signup protection",
    href: "/app/signup-protection",
    icon: "shieldBan",
    sidebar: true,
    commandGroup: "go",
    keywords: [
      "firewall",
      "spam",
      "signup",
      "preset",
      "segment",
      "maintenance",
    ],
  },
  {
    label: "Lifecycle",
    href: "/app/lifecycle",
    icon: "gitBranch",
    sidebar: true,
    commandGroup: "go",
    keywords: ["stage", "funnel", "lead", "mql", "growth", "source", "goals"],
  },
  {
    label: "Cohorts",
    href: "/app/cohorts",
    icon: "barChart3",
    sidebar: true,
    commandGroup: "go",
    keywords: [
      "cohort",
      "retention",
      "fatigue",
      "engagement",
      "classification",
    ],
  },
  {
    label: "Data hygiene",
    href: "/app/data-hygiene",
    icon: "badgeCheck",
    sidebar: true,
    commandGroup: "go",
    keywords: ["dedupe", "merge", "pii", "normalize", "identity"],
  },
  {
    label: "Content library",
    href: "/app/content-library",
    icon: "layoutTemplate",
    sidebar: true,
    commandGroup: "go",
    keywords: ["blocks", "collections", "reusable", "snippets"],
  },
  {
    // The schema layer for records that are not people.
    label: "Custom objects",
    href: "/app/custom-objects",
    icon: "clipboardList",
    sidebar: true,
    commandGroup: "go",
    keywords: ["orders", "bookings", "tickets", "schema", "objects"],
  },
  {
    label: "Encryption keys",
    href: "/app/encryption-keys",
    icon: "shieldBan",
    sidebar: true,
    commandGroup: "go",
    keywords: ["byok", "kms", "encryption", "cmk", "key management"],
  },
  {
    label: "API usage",
    href: "/app/api-usage",
    icon: "barChart3",
    sidebar: true,
    commandGroup: "go",
    keywords: ["api", "keys", "usage", "cost", "spend", "quota"],
  },
  {
    label: "Compliance",
    href: "/app/compliance",
    icon: "shield",
    sidebar: true,
    commandGroup: "go",
    keywords: ["hipaa", "soc2", "gdpr", "ccpa", "pci", "iso27001", "framework"],
  },
  {
    label: "Consent ledger",
    href: "/app/consent-ledger",
    icon: "clipboardCheck",
    sidebar: true,
    commandGroup: "go",
    keywords: ["consent", "receipt", "optin", "evidence", "audit", "gdpr"],
  },
  {
    label: "Machine opens",
    href: "/app/bot-opens",
    icon: "badgeCheck",
    sidebar: true,
    commandGroup: "go",
    keywords: ["bot", "mpp", "apple", "prefetch", "open rate", "signature"],
  },
  {
    label: "Agent routines",
    href: "/app/agent-routines",
    icon: "workflow",
    sidebar: true,
    commandGroup: "go",
    keywords: ["agent", "routine", "schedule", "automation", "cron"],
  },
  {
    label: "Audience syncs",
    href: "/app/audience-syncs",
    icon: "arrowRightLeft",
    sidebar: true,
    commandGroup: "go",
    keywords: ["ads", "meta", "google", "audience", "sync", "exclusion"],
  },
  {
    label: "Assets",
    href: "/app/assets",
    icon: "layoutTemplate",
    sidebar: true,
    commandGroup: "go",
    keywords: ["images", "files", "media", "library", "upload"],
  },
  {
    label: "Analytics destinations",
    href: "/app/analytics-destinations",
    icon: "plug",
    sidebar: true,
    commandGroup: "go",
    keywords: ["amplitude", "mixpanel", "segment", "cdp", "posthog", "ga4"],
  },
  {
    label: "DMARC",
    href: "/app/dmarc",
    icon: "shield",
    sidebar: true,
    commandGroup: "go",
    keywords: ["dmarc", "spf", "dkim", "alignment", "reports", "spoofing"],
  },
  {
    label: "AI quality",
    href: "/app/ai-quality",
    icon: "badgeCheck",
    sidebar: true,
    commandGroup: "go",
    keywords: ["regression", "golden", "gate", "quality", "ai"],
  },
  {
    // Exact-admin availability plus the mounted Helpdesk record-state queue.
    label: "Service suite & Helpdesk",
    href: "/app/service-suite",
    icon: "inbox",
    sidebar: true,
    commandGroup: "go",
    keywords: [
      "availability",
      "configuration",
      "release holds",
      "catalog",
      "helpdesk",
      "conversations",
      "tickets",
      "macros",
      "internal notes",
      "assignment",
    ],
  },
  {
    label: "Human reach",
    href: "/app/human-reach",
    icon: "badgeCheck",
    sidebar: true,
    commandGroup: "go",
    keywords: ["human", "reach", "engagement", "mpp", "machine", "classifier"],
  },
  {
    label: "Privacy portal",
    href: "/app/privacy-portal",
    icon: "shieldBan",
    sidebar: true,
    commandGroup: "go",
    keywords: ["gdpr", "ccpa", "dsar", "consent", "erasure", "gpc"],
  },
  {
    // Admin-only operational breach register. Legal determinations, delivery
    // proof, packet generation, and closure are explicit release holds.
    label: "Privacy incidents",
    href: "/app/privacy-incidents",
    icon: "shield",
    sidebar: true,
    commandGroup: "go",
    keywords: [
      "breach",
      "incident",
      "privacy",
      "response",
      "notification",
      "gdpr",
    ],
  },
  {
    label: "Shadow-PII findings",
    href: "/app/pii-findings",
    icon: "shieldBan",
    sidebar: true,
    commandGroup: "go",
    keywords: [
      "pii",
      "privacy",
      "undeclared data",
      "dpo",
      "findings",
      "scanner",
      "review queue",
    ],
  },
  {
    label: "Referrals",
    href: "/app/referrals",
    icon: "handshake",
    sidebar: true,
    commandGroup: "go",
    keywords: ["refer", "advocate", "leaderboard", "payout", "reward"],
  },
  {
    label: "Product events",
    href: "/app/track",
    icon: "barChart3",
    sidebar: true,
    commandGroup: "go",
    keywords: ["track", "events", "analytics", "script", "pixel"],
  },
  {
    label: "Translations",
    href: "/app/translations",
    icon: "mail",
    sidebar: true,
    commandGroup: "go",
    keywords: ["locale", "language", "i18n", "dictionary"],
  },
  {
    // Four /api/v1/omnichannel/* paths. The server reports
    // `runtime_status: "unavailable"`, and the page leads with that.
    label: "Omnichannel",
    href: "/app/omnichannel",
    icon: "workflow",
    sidebar: true,
    commandGroup: "go",
    keywords: ["multichannel", "sms", "push", "cross-channel"],
  },
  {
    label: "Predictive",
    href: "/app/predictive",
    icon: "barChart3",
    sidebar: true,
    commandGroup: "go",
    keywords: ["clv", "ltv", "rfm", "churn", "propensity", "score"],
  },
  {
    // Pure, non-persistent CDP operation lab. Palette-reachable and linked
    // directly from Data warehouse; bulk subscriber apply is intentionally not
    // exposed by this qualified preview surface.
    label: "CDP transform preview",
    href: "/app/cdp-transforms",
    icon: "gitBranch",
    commandGroup: "go",
    keywords: ["cdp", "transform", "preview", "properties", "dry run"],
  },
  {
    label: "Data warehouse",
    href: "/app/warehouse",
    icon: "arrowRightLeft",
    sidebar: true,
    commandGroup: "go",
    keywords: ["export", "sync", "snowflake", "bigquery", "redshift", "s3"],
  },
  {
    // Every network still reports `runtime_status: "foundation"`, and the page
    // says so rather than offering a setup that cannot run.
    label: "Social capture",
    href: "/app/social-capture",
    icon: "inbox",
    sidebar: true,
    commandGroup: "go",
    keywords: ["instagram", "facebook", "tiktok", "dm", "comment", "lead"],
  },
  {
    label: "Verification",
    href: "/app/verification",
    icon: "badgeCheck",
    sidebar: true,
    commandGroup: "go",
    keywords: [
      "verify",
      "email",
      "bounce",
      "validation",
      "zerobounce",
      "kickbox",
    ],
  },
  {
    label: "Suppressions",
    href: "/app/suppressions",
    icon: "shieldBan",
    sidebar: true,
    commandGroup: "go",
    keywords: [
      "bounce",
      "complaint",
      "blocklist",
      "deliverability",
      "unsubscribe",
    ],
  },
  {
    label: "Settings",
    href: "/app/settings",
    icon: "userCog",
    sidebar: true,
    commandGroup: "settings",
    keywords: ["preferences", "workspace"],
  },
  {
    label: "Sender Identity",
    href: "/app/settings/sender",
    icon: "badgeCheck",
    commandGroup: "settings",
    keywords: ["from", "domain", "dkim"],
  },
  {
    label: "Team Access",
    href: "/app/settings/team",
    icon: "users",
    commandGroup: "settings",
    keywords: ["members", "invite", "roles"],
  },
  {
    label: "API Keys",
    href: "/app/settings/api",
    icon: "keyRound",
    commandGroup: "settings",
    keywords: ["token", "developer"],
  },
  {
    label: "Security",
    href: "/app/settings/security",
    icon: "shield",
    commandGroup: "settings",
    keywords: ["password", "2fa", "sessions"],
  },
  // Remaining settings sub-routes so every tab is ⌘K-reachable (SETA-032).
  {
    label: "Notifications",
    href: "/app/settings/notifications",
    icon: "inbox",
    commandGroup: "settings",
    keywords: ["alerts", "email", "digest"],
  },
  {
    label: "Send-Time Optimization",
    href: "/app/settings/send-time",
    icon: "clipboardCheck",
    commandGroup: "settings",
    keywords: ["sto", "timing", "schedule", "engagement"],
  },
  {
    label: "Domain & DNS",
    href: "/app/settings/domain",
    icon: "panelTop",
    commandGroup: "settings",
    keywords: ["dns", "spf", "dkim", "dmarc", "cname"],
  },
  {
    label: "Custom Fields",
    href: "/app/settings/custom-fields",
    icon: "clipboardList",
    commandGroup: "settings",
    keywords: ["merge", "attributes", "properties", "traits"],
  },
  {
    label: "Topics",
    href: "/app/settings/topics",
    icon: "messageSquareText",
    commandGroup: "settings",
    keywords: ["preference center", "subscriptions", "opt-in"],
  },
  {
    label: "Webhooks",
    href: "/app/settings/webhooks",
    icon: "webhook",
    commandGroup: "settings",
    keywords: ["events", "outbound", "delivery", "hmac"],
  },
  {
    label: "Integrations",
    href: "/app/settings/integrations",
    icon: "plug",
    commandGroup: "settings",
    keywords: ["slack", "connect", "apps"],
  },
  {
    label: "Developer",
    href: "/app/settings/developer",
    icon: "keyRound",
    commandGroup: "settings",
    keywords: ["sample data", "sdk", "quickstart", "tools"],
  },
  {
    label: "Offline Sync",
    href: "/app/settings/offline",
    icon: "arrowRightLeft",
    commandGroup: "settings",
    keywords: ["queue", "outbox", "conflicts", "pending"],
  },
  {
    label: "Audit Log",
    href: "/app/settings/audit",
    icon: "shield",
    commandGroup: "settings",
    keywords: ["activity", "history", "trail", "compliance"],
  },
  {
    label: "Audit Streaming",
    href: "/app/settings/audit-sinks",
    icon: "shield",
    commandGroup: "settings",
    keywords: [
      "siem",
      "sink",
      "dead letter",
      "dlq",
      "replay",
      "recovery",
      "audit alert",
    ],
  },
  {
    label: "Data Region",
    href: "/app/settings/data-region",
    icon: "shield",
    commandGroup: "settings",
    keywords: ["residency", "gdpr", "compliance", "region"],
  },
  {
    label: "Privacy",
    href: "/app/settings/privacy",
    icon: "shield",
    commandGroup: "settings",
    keywords: ["gdpr", "ccpa", "retention", "export", "deletion", "dsar"],
  },
] as const;

/**
 * The web dashboard route facts, with the canonical LABEL for every
 * manifest-modelled route sourced from @postwave/nav at runtime — so the
 * shared manifest is the actual source of truth, not merely a consistency
 * test oracle. A manifest label change now propagates into the web sidebar +
 * command palette automatically. Deliberate web-local label choices are kept
 * via MANIFEST_LABEL_OVERRIDES; web-only routes keep their literal labels.
 */
const MANIFEST_LABEL_BY_WEB_ROUTE = new Map<string, string>(
  NAV_ENTRIES.filter((e) => typeof e.routes.web === "string").map((e) => [
    e.routes.web as string,
    e.label,
  ]),
);

/** Routes where web deliberately keeps its own label instead of the manifest's. */
const MANIFEST_LABEL_OVERRIDES: Record<string, string> = {
  "/app": "Overview", // manifest canonical is "Dashboard"; web keeps "Overview"
  // Keep the active, sanitized inspection surface honest even when a consumer
  // still has an older @postwave/nav build in its dependency graph.
  "/app/discounts": "Discount history",
  // The manifest's canonical label is "Notifications" because that is what
  // mobile's tab is. On web the bell IS notifications and this route is its
  // history, so adopting the canonical label would give two different surfaces
  // the same name in the same product.
  "/app/notifications": "Notification history",
};

/** Manifest group + kbd hint keyed by the entry's web route. */
const MANIFEST_GROUP_BY_WEB_ROUTE = new Map<string, DashboardNavGroup>(
  NAV_ENTRIES.filter((e) => typeof e.routes.web === "string").map((e) => [
    e.routes.web as string,
    e.group,
  ]),
);
const MANIFEST_KBD_BY_WEB_ROUTE = new Map<string, string>(
  NAV_ENTRIES.filter(
    (e) => typeof e.routes.web === "string" && typeof e.kbd === "string",
  ).map((e) => [e.routes.web as string, e.kbd as string]),
);
const MANIFEST_SCOPE_BY_WEB_ROUTE = new Map<string, DashboardRouteScope>(
  NAV_ENTRIES.filter((e) => typeof e.routes.web === "string").map((e) => [
    e.routes.web as string,
    e.scope,
  ]),
);

/**
 * A nested page the manifest does not model (e.g. /app/routing/outbound-webhooks)
 * takes its nearest modelled ancestor's scope. Otherwise it would default to
 * "member", and because {@link dashboardRouteScopeForHref} prefers the most
 * specific route, listing an admin section's child would quietly downgrade
 * that deep link below its parent.
 */
function inheritedManifestScope(href: string): DashboardRouteScope | undefined {
  for (
    let at = href.lastIndexOf("/");
    at > "/app".length;
    at = href.lastIndexOf("/", at - 1)
  ) {
    const scope = MANIFEST_SCOPE_BY_WEB_ROUTE.get(href.slice(0, at));
    if (scope !== undefined) return scope;
  }
  return undefined;
}

/**
 * Section for web-only sidebar routes the shared manifest does not (yet) model.
 * Keeps the sidebar fully grouped without inventing manifest entries; documented
 * per route so a future manifest addition is a conscious swap.
 */
const WEB_ONLY_GROUP: Record<string, DashboardNavGroup> = {
  "/app/pilot": "workspace",
  "/app/compatibility": "deliverability",
};

export const DASHBOARD_ROUTES: readonly DashboardRoute[] =
  RAW_DASHBOARD_ROUTES.map((route) => {
    const canonical = MANIFEST_LABEL_BY_WEB_ROUTE.get(route.href);
    const label =
      canonical === undefined
        ? route.label
        : (MANIFEST_LABEL_OVERRIDES[route.href] ?? canonical);
    const group =
      MANIFEST_GROUP_BY_WEB_ROUTE.get(route.href) ??
      WEB_ONLY_GROUP[route.href] ??
      "workspace";
    const kbd = MANIFEST_KBD_BY_WEB_ROUTE.get(route.href);
    const scope =
      MANIFEST_SCOPE_BY_WEB_ROUTE.get(route.href) ??
      inheritedManifestScope(route.href) ??
      "member";
    return { ...route, label, group, scope, ...(kbd ? { kbd } : {}) };
  });

export const DASHBOARD_NAV_ROUTES = DASHBOARD_ROUTES.filter(
  (route) => route.sidebar,
);

export const DASHBOARD_COMMAND_ROUTES = DASHBOARD_ROUTES.filter(
  (route) => route.commandGroup !== undefined,
);

export const DASHBOARD_COMMAND_GO_ROUTES = DASHBOARD_ROUTES.filter(
  (route) => route.commandGroup === "go",
);

export const DASHBOARD_COMMAND_SETTINGS_ROUTES = DASHBOARD_ROUTES.filter(
  (route) => route.commandGroup === "settings",
);

/** Most-specific route visibility for recent/deep-link projections. */
export function dashboardRouteScopeForHref(href: string): DashboardRouteScope {
  return (
    DASHBOARD_ROUTES.filter(
      (route) => href === route.href || href.startsWith(`${route.href}/`),
    ).sort((left, right) => right.href.length - left.href.length)[0]?.scope ??
    "member"
  );
}

export { DASHBOARD_CREATE_ROUTES } from "./dashboard-shell-routes";

// Action commands for the ⌘K palette (SETA-054). These deep-link to the page
// that performs the action rather than firing a side effect from the palette,
// so an accidental Enter never exports data or loads samples. The target pages
// own the actual action (and any ?param auto-open handlers).
export const DASHBOARD_ACTION_ROUTES: readonly DashboardCreateRoute[] = [
  {
    label: "Export audit log (CSV)",
    href: "/app/settings/audit",
    keywords: ["download", "csv", "audit", "log", "export"],
  },
  {
    label: "Recover audit delivery",
    href: "/app/settings/audit-sinks",
    keywords: ["audit", "sink", "dlq", "replay", "circuit", "test"],
  },
  {
    label: "Sync offline changes",
    href: "/app/settings/offline",
    keywords: ["offline", "sync", "pending", "queue"],
  },
  {
    label: "Manage sample data",
    href: "/app/settings/developer",
    keywords: ["sample", "demo", "seed", "test data", "developer"],
  },
  {
    label: "Export workspace data",
    href: "/app/settings/privacy",
    keywords: ["export", "gdpr", "download", "data", "backup"],
  },
] as const;
