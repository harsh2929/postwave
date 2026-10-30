// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Minimal synchronous route projection used by the persistent dashboard shell.
 *
 * The full command-palette catalogue also carries keywords, keyboard hints,
 * manifest reconciliation, and non-shell metadata. Importing that catalogue
 * here made every dashboard route pay for all of it before hydration. This
 * projection retains exactly the labels used for Recent destinations, the
 * sidebar presentation fields, and the Create menu.
 *
 * dashboard-shell-route-contract.test.ts pins this projection byte-for-byte to
 * the canonical dashboard-routes catalogue so an edit cannot silently drift.
 */
import type {
  DashboardCreateRoute,
  DashboardNavGroup,
  DashboardRouteIcon,
} from "./dashboard-routes";

export interface DashboardShellRoute {
  label: string;
  href: `/app${string}`;
  icon?: DashboardRouteIcon;
  group?: DashboardNavGroup;
  sidebar?: true;
}

export const DASHBOARD_SHELL_ROUTES = [
  {
    label: "Overview",
    href: "/app",
    icon: "layoutDashboard",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Notification history",
    href: "/app/notifications",
  },
  {
    label: "Subscribers",
    href: "/app/subscribers",
    icon: "users",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Lists",
    href: "/app/lists",
    icon: "users",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Tags",
    href: "/app/tags",
    icon: "badgeCheck",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Campaigns",
    href: "/app/campaigns",
    icon: "mail",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Analytics",
    href: "/app/analytics",
    icon: "barChart3",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Reports",
    href: "/app/reports",
  },
  {
    label: "Migrations",
    href: "/app/migrations",
    icon: "arrowRightLeft",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Pilot",
    href: "/app/pilot",
    icon: "clipboardCheck",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Compatibility",
    href: "/app/compatibility",
    icon: "badgeCheck",
    group: "deliverability",
    sidebar: true,
  },
  {
    label: "SMS",
    href: "/app/sms",
    icon: "messageSquareText",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Inbox Reality",
    href: "/app/inbox-reality",
    icon: "inbox",
    group: "deliverability",
    sidebar: true,
  },
  {
    label: "Predict placement",
    href: "/app/inbox-reality/predict",
  },
  {
    label: "AEO Sensor",
    href: "/app/aeo",
  },
  {
    label: "Sequences",
    href: "/app/sequences",
    icon: "workflow",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Flows",
    href: "/app/flows",
    icon: "gitBranch",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Forms",
    href: "/app/forms",
    icon: "clipboardList",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Landing Pages",
    href: "/app/landing-pages",
    icon: "panelTop",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Templates",
    href: "/app/templates",
    icon: "layoutTemplate",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Sequence Templates",
    href: "/app/sequence-templates",
  },
  {
    label: "Voice Profile",
    href: "/app/sequences/voice-profile",
  },
  {
    label: "Voice Labels",
    href: "/app/voice-labels",
  },
  {
    label: "Integrations",
    href: "/app/integrations",
  },
  {
    label: "Integration Catalog",
    href: "/app/integrations/catalog",
  },
  {
    label: "Inbound Webhooks",
    href: "/app/inbound-webhooks",
    icon: "webhook",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Billing",
    href: "/app/billing",
    icon: "creditCard",
    group: "account",
    sidebar: true,
  },
  {
    label: "Agency",
    href: "/app/agency",
    icon: "building2",
    group: "account",
    sidebar: true,
  },
  {
    label: "Affiliates",
    href: "/app/affiliates",
    icon: "handshake",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Discount history",
    href: "/app/discounts",
    icon: "ticketPercent",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Commerce",
    href: "/app/commerce",
    icon: "creditCard",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Approvals",
    href: "/app/approvals",
    icon: "gavel",
    group: "account",
    sidebar: true,
  },
  {
    label: "Deliverability",
    href: "/app/deliverability",
    icon: "shield",
    group: "deliverability",
    sidebar: true,
  },
  {
    label: "AI assist",
    href: "/app/ai-assist",
    icon: "mic",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Workspace operations",
    href: "/app/workspace-ops",
    icon: "settings",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Alerting and access",
    href: "/app/alerting-access",
    icon: "shield",
    group: "account",
    sidebar: true,
  },
  {
    label: "Data operations",
    href: "/app/data-operations",
    icon: "arrowRightLeft",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Maintenance",
    href: "/app/maintenance",
    icon: "settings",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Pre-flight",
    href: "/app/preflight",
    icon: "clipboardCheck",
    group: "deliverability",
    sidebar: true,
  },
  {
    label: "Developer reference",
    href: "/app/developer-reference",
    icon: "webhook",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Webhook simulator",
    href: "/app/developer-reference/webhook-simulator",
  },
  {
    label: "API playground",
    href: "/app/developer-reference/playground",
  },
  {
    label: "Content quality",
    href: "/app/content-quality",
    icon: "clipboardCheck",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Consent evidence",
    href: "/app/consent-evidence",
    icon: "gavel",
    group: "account",
    sidebar: true,
  },
  {
    label: "Reviews",
    href: "/app/reviews",
    icon: "badgeCheck",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Reporting catalogue",
    href: "/app/reporting-catalogue",
    icon: "barChart3",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Sending health",
    href: "/app/sending-health",
    icon: "badgeCheck",
    group: "deliverability",
    sidebar: true,
  },
  {
    label: "Win-back",
    href: "/app/retention",
    icon: "ticketPercent",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Replies",
    href: "/app/replies",
    icon: "messageSquareText",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Audience destinations",
    href: "/app/audience-destinations",
    icon: "arrowRightLeft",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Credential hygiene",
    href: "/app/key-hygiene",
    icon: "keyRound",
    group: "account",
    sidebar: true,
  },
  {
    label: "Archive",
    href: "/app/archive-settings",
    icon: "layoutTemplate",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Data controls",
    href: "/app/data-controls",
    icon: "shieldBan",
    group: "account",
    sidebar: true,
  },
  {
    label: "Source quality",
    href: "/app/source-quality",
    icon: "badgeCheck",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Gift history",
    href: "/app/source-quality/gifts",
  },
  {
    label: "Requests and reports",
    href: "/app/compliance-requests",
    icon: "clipboardCheck",
    group: "account",
    sidebar: true,
  },
  {
    label: "Scoring and tags",
    href: "/app/scoring",
    icon: "clipboardList",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "List hygiene",
    href: "/app/list-hygiene",
    icon: "shieldBan",
    group: "deliverability",
    sidebar: true,
  },
  {
    label: "Onsite growth",
    href: "/app/onsite-growth",
    icon: "layoutTemplate",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Integration catalogue",
    href: "/app/integration-catalogue",
    icon: "plug",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Agent tools",
    href: "/app/agent-tools",
    icon: "workflow",
    group: "account",
    sidebar: true,
  },
  {
    label: "Routing",
    href: "/app/routing",
    icon: "arrowRightLeft",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Outbound webhooks",
    href: "/app/routing/outbound-webhooks",
  },
  {
    label: "Signup protection",
    href: "/app/signup-protection",
    icon: "shieldBan",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Lifecycle",
    href: "/app/lifecycle",
    icon: "gitBranch",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Cohorts",
    href: "/app/cohorts",
    icon: "barChart3",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Data hygiene",
    href: "/app/data-hygiene",
    icon: "badgeCheck",
    group: "account",
    sidebar: true,
  },
  {
    label: "Content library",
    href: "/app/content-library",
    icon: "layoutTemplate",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Custom objects",
    href: "/app/custom-objects",
    icon: "clipboardList",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Encryption keys",
    href: "/app/encryption-keys",
    icon: "shieldBan",
    group: "account",
    sidebar: true,
  },
  {
    label: "API usage",
    href: "/app/api-usage",
    icon: "barChart3",
    group: "account",
    sidebar: true,
  },
  {
    label: "Compliance",
    href: "/app/compliance",
    icon: "shield",
    group: "account",
    sidebar: true,
  },
  {
    label: "Consent ledger",
    href: "/app/consent-ledger",
    icon: "clipboardCheck",
    group: "account",
    sidebar: true,
  },
  {
    label: "Machine opens",
    href: "/app/bot-opens",
    icon: "badgeCheck",
    group: "deliverability",
    sidebar: true,
  },
  {
    label: "Agent routines",
    href: "/app/agent-routines",
    icon: "workflow",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Audience syncs",
    href: "/app/audience-syncs",
    icon: "arrowRightLeft",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Assets",
    href: "/app/assets",
    icon: "layoutTemplate",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Analytics destinations",
    href: "/app/analytics-destinations",
    icon: "plug",
    group: "account",
    sidebar: true,
  },
  {
    label: "DMARC",
    href: "/app/dmarc",
    icon: "shield",
    group: "deliverability",
    sidebar: true,
  },
  {
    label: "AI quality",
    href: "/app/ai-quality",
    icon: "badgeCheck",
    group: "account",
    sidebar: true,
  },
  {
    label: "Service suite & Helpdesk",
    href: "/app/service-suite",
    icon: "inbox",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Human reach",
    href: "/app/human-reach",
    icon: "badgeCheck",
    group: "deliverability",
    sidebar: true,
  },
  {
    label: "Privacy portal",
    href: "/app/privacy-portal",
    icon: "shieldBan",
    group: "account",
    sidebar: true,
  },
  {
    label: "Privacy incidents",
    href: "/app/privacy-incidents",
    icon: "shield",
    group: "account",
    sidebar: true,
  },
  {
    label: "Shadow-PII findings",
    href: "/app/pii-findings",
    icon: "shieldBan",
    group: "account",
    sidebar: true,
  },
  {
    label: "Referrals",
    href: "/app/referrals",
    icon: "handshake",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Product events",
    href: "/app/track",
    icon: "barChart3",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Translations",
    href: "/app/translations",
    icon: "mail",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Omnichannel",
    href: "/app/omnichannel",
    icon: "workflow",
    group: "workspace",
    sidebar: true,
  },
  {
    label: "Predictive",
    href: "/app/predictive",
    icon: "barChart3",
    group: "growth",
    sidebar: true,
  },
  {
    label: "CDP transform preview",
    href: "/app/cdp-transforms",
  },
  {
    label: "Data warehouse",
    href: "/app/warehouse",
    icon: "arrowRightLeft",
    group: "account",
    sidebar: true,
  },
  {
    label: "Social capture",
    href: "/app/social-capture",
    icon: "inbox",
    group: "growth",
    sidebar: true,
  },
  {
    label: "Verification",
    href: "/app/verification",
    icon: "badgeCheck",
    group: "deliverability",
    sidebar: true,
  },
  {
    label: "Suppressions",
    href: "/app/suppressions",
    icon: "shieldBan",
    group: "deliverability",
    sidebar: true,
  },
  {
    label: "Settings",
    href: "/app/settings",
    icon: "userCog",
    group: "account",
    sidebar: true,
  },
  {
    label: "Sender Identity",
    href: "/app/settings/sender",
  },
  {
    label: "Team Access",
    href: "/app/settings/team",
  },
  {
    label: "API Keys",
    href: "/app/settings/api",
  },
  {
    label: "Security",
    href: "/app/settings/security",
  },
  {
    label: "Notifications",
    href: "/app/settings/notifications",
  },
  {
    label: "Send-Time Optimization",
    href: "/app/settings/send-time",
  },
  {
    label: "Domain & DNS",
    href: "/app/settings/domain",
  },
  {
    label: "Custom Fields",
    href: "/app/settings/custom-fields",
  },
  {
    label: "Topics",
    href: "/app/settings/topics",
  },
  {
    label: "Webhooks",
    href: "/app/settings/webhooks",
  },
  {
    label: "Integrations",
    href: "/app/settings/integrations",
  },
  {
    label: "Developer",
    href: "/app/settings/developer",
  },
  {
    label: "Offline Sync",
    href: "/app/settings/offline",
  },
  {
    label: "Audit log",
    href: "/app/settings/audit",
  },
  {
    label: "Audit Streaming",
    href: "/app/settings/audit-sinks",
  },
  {
    label: "Data Region",
    href: "/app/settings/data-region",
  },
  {
    label: "Privacy",
    href: "/app/settings/privacy",
  },
] as const satisfies readonly DashboardShellRoute[];

/**
 * Lightweight projection of @postwave/nav's admin-scoped web destinations.
 *
 * The persistent shell deliberately does not import the full cross-platform
 * manifest into every dashboard chunk. This small list is therefore the
 * runtime access projection; the focused contract test compares it with the
 * manifest so it cannot silently drift when either side changes.
 */
export const DASHBOARD_SHELL_ADMIN_ROUTE_HREFS = [
  "/app/workspace-ops",
  "/app/alerting-access",
  "/app/data-operations",
  "/app/maintenance",
  "/app/consent-evidence",
  "/app/key-hygiene",
  "/app/data-controls",
  "/app/compliance-requests",
  "/app/list-hygiene",
  "/app/agent-tools",
  "/app/routing",
  "/app/signup-protection",
  "/app/data-hygiene",
  "/app/custom-objects",
  "/app/encryption-keys",
  "/app/api-usage",
  "/app/compliance",
  "/app/consent-ledger",
  "/app/agent-routines",
  "/app/audience-syncs",
  "/app/analytics-destinations",
  "/app/ai-quality",
  "/app/service-suite",
  "/app/privacy-portal",
  "/app/privacy-incidents",
  "/app/pii-findings",
  "/app/warehouse",
  "/app/agency",
  "/app/billing",
  "/app/settings/audit",
  "/app/commerce",
  "/app/inbound-webhooks",
] as const;

const DASHBOARD_SHELL_ADMIN_ROUTE_SET = new Set<string>(
  DASHBOARD_SHELL_ADMIN_ROUTE_HREFS,
);

export function dashboardShellRouteRequiresAdmin(href: string): boolean {
  return DASHBOARD_SHELL_ADMIN_ROUTE_SET.has(href);
}

export const DASHBOARD_SHELL_NAV_ROUTES = DASHBOARD_SHELL_ROUTES.filter(
  (
    route,
  ): route is (typeof DASHBOARD_SHELL_ROUTES)[number] & {
    icon: DashboardRouteIcon;
    group: DashboardNavGroup;
    sidebar: true;
  } => "sidebar" in route && route.sidebar === true,
);

export const DASHBOARD_CREATE_ROUTES = [
  {
    label: "New campaign",
    href: "/app/campaigns?create=1",
    keywords: ["compose", "send", "broadcast"],
  },
  {
    label: "New sequence",
    href: "/app/sequences/new",
    keywords: ["automation", "drip"],
  },
  {
    label: "New form",
    href: "/app/forms/new",
    keywords: ["signup", "popup"],
  },
  {
    label: "New landing page",
    href: "/app/landing-pages?new=1",
    keywords: ["lander", "page", "hosted", "site"],
  },
  {
    label: "New template",
    href: "/app/templates/new",
    keywords: ["email", "design"],
  },
  {
    label: "New segment",
    href: "/app/subscribers/segments/new",
    keywords: ["audience", "filter", "group"],
  },
  {
    label: "Suppress an address",
    href: "/app/suppressions?add=1",
    keywords: ["suppress", "block", "bounce", "complaint", "unsubscribe"],
  },
  {
    label: "Add webhook",
    href: "/app/settings/webhooks?create=1",
    keywords: ["webhook", "event", "endpoint", "outbound"],
  },
  {
    label: "Add topic",
    href: "/app/settings/topics?create=1",
    keywords: ["topic", "preference", "subscription"],
  },
] as const satisfies readonly DashboardCreateRoute[];
