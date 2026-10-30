// SPDX-License-Identifier: AGPL-3.0-only
import type { DashboardNavGroup, DashboardRouteIcon } from "./dashboard-routes";
import {
  DASHBOARD_SHELL_NAV_ROUTES,
  dashboardShellRouteRequiresAdmin,
} from "./dashboard-shell-nav-routes";

/**
 * The web dashboard's primary sidebar nav, derived from the shared dashboard
 * route facts without React/icon imports so it can be unit-tested in Node.
 */

export interface DashboardNavItem {
  /** Canonical sidebar label shown to the user. */
  label: string;
  /** In-app route the entry links to. */
  href: string;
  /** Presentation-neutral icon key consumed by client shells. */
  icon: DashboardRouteIcon;
  /** Sidebar section the entry belongs to (SHELL-012). */
  group: DashboardNavGroup;
  /** Coarse manifest access boundary used by the persistent shell. */
  scope: "member" | "admin";
}

/** Display order of the sidebar sections + their user-facing headers. */
export const DASHBOARD_NAV_GROUP_ORDER: readonly DashboardNavGroup[] = [
  "workspace",
  "growth",
  "deliverability",
  "account",
];

export const DASHBOARD_NAV_GROUP_LABELS: Record<DashboardNavGroup, string> = {
  workspace: "Workspace",
  growth: "Growth",
  deliverability: "Deliverability",
  account: "Account",
};

export const DASHBOARD_NAV: readonly DashboardNavItem[] =
  DASHBOARD_SHELL_NAV_ROUTES.map(({ label, href, icon, group }) => ({
    label,
    href,
    icon,
    group: group ?? "workspace",
    scope: dashboardShellRouteRequiresAdmin(href) ? "admin" : "member",
  }));

/**
 * Second-level information architecture for the dashboard rail.
 *
 * The shared manifest intentionally keeps its group vocabulary coarse so it
 * can be reused by web, desktop, and mobile. At 77 web destinations those four
 * groups are too large to scan as flat lists, so web adds presentation-only
 * collections beneath them. Routes, labels, ordering, and access decisions
 * still come from DASHBOARD_NAV; these rules only decide which disclosure a
 * route appears beneath.
 */
export interface DashboardNavCollectionRule {
  key: string;
  label: string;
  group: DashboardNavGroup;
  hrefs: readonly string[];
}

export interface DashboardNavCollection {
  key: string;
  label: string;
  group: DashboardNavGroup;
  items: readonly DashboardNavItem[];
}

export const DASHBOARD_NAV_COLLECTION_RULES = [
  {
    key: "workspace-core",
    label: "Core workspace",
    group: "workspace",
    hrefs: [
      "/app",
      "/app/subscribers",
      "/app/lists",
      "/app/tags",
      "/app/campaigns",
      "/app/sequences",
      "/app/flows",
      "/app/analytics",
    ],
  },
  {
    key: "workspace-operations",
    label: "Operations",
    group: "workspace",
    hrefs: [
      "/app/migrations",
      "/app/pilot",
      "/app/sms",
      "/app/inbound-webhooks",
      "/app/workspace-ops",
      "/app/data-operations",
      "/app/maintenance",
      "/app/service-suite",
    ],
  },
  {
    key: "workspace-data-automation",
    label: "Data & automation",
    group: "workspace",
    hrefs: [
      "/app/developer-reference",
      "/app/reporting-catalogue",
      "/app/scoring",
      "/app/routing",
      "/app/lifecycle",
      "/app/cohorts",
      "/app/custom-objects",
      "/app/agent-routines",
      "/app/track",
      "/app/omnichannel",
    ],
  },
  {
    key: "growth-create",
    label: "Create",
    group: "growth",
    hrefs: [
      "/app/forms",
      "/app/landing-pages",
      "/app/templates",
      "/app/content-library",
      "/app/assets",
      "/app/translations",
    ],
  },
  {
    key: "growth-engage",
    label: "Engage",
    group: "growth",
    hrefs: [
      "/app/affiliates",
      "/app/discounts",
      "/app/commerce",
      "/app/reviews",
      "/app/retention",
      "/app/replies",
      "/app/onsite-growth",
      "/app/referrals",
      "/app/social-capture",
    ],
  },
  {
    key: "growth-optimize-connect",
    label: "Optimize & connect",
    group: "growth",
    hrefs: [
      "/app/ai-assist",
      "/app/content-quality",
      "/app/audience-destinations",
      "/app/archive-settings",
      "/app/source-quality",
      "/app/integration-catalogue",
      "/app/signup-protection",
      "/app/audience-syncs",
      "/app/predictive",
    ],
  },
  {
    key: "deliverability-monitor",
    label: "Monitor",
    group: "deliverability",
    hrefs: [
      "/app/compatibility",
      "/app/inbox-reality",
      "/app/deliverability",
      "/app/sending-health",
      "/app/human-reach",
    ],
  },
  {
    key: "deliverability-protect",
    label: "Protect",
    group: "deliverability",
    hrefs: [
      "/app/preflight",
      "/app/list-hygiene",
      "/app/bot-opens",
      "/app/dmarc",
      "/app/verification",
      "/app/suppressions",
    ],
  },
  {
    key: "account-workspace-management",
    label: "Workspace management",
    group: "account",
    hrefs: [
      "/app/billing",
      "/app/agency",
      "/app/approvals",
      "/app/alerting-access",
      "/app/agent-tools",
      "/app/api-usage",
      "/app/settings",
    ],
  },
  {
    key: "account-governance-privacy",
    label: "Governance & privacy",
    group: "account",
    hrefs: [
      "/app/consent-evidence",
      "/app/key-hygiene",
      "/app/data-controls",
      "/app/compliance-requests",
      "/app/data-hygiene",
      "/app/encryption-keys",
      "/app/compliance",
      "/app/consent-ledger",
      "/app/ai-quality",
      "/app/privacy-portal",
      "/app/privacy-incidents",
      "/app/pii-findings",
    ],
  },
  {
    key: "account-data-infrastructure",
    label: "Data infrastructure",
    group: "account",
    hrefs: ["/app/analytics-destinations", "/app/warehouse"],
  },
] as const satisfies readonly DashboardNavCollectionRule[];

/**
 * Partition a possibly-filtered nav list without ever orphaning a route. The
 * fallback collection is a safety net for a newly shipped destination; the
 * focused coverage test still asks authors to give it an intentional home.
 */
export function buildDashboardNavCollections(
  items: readonly DashboardNavItem[],
): DashboardNavCollection[] {
  const collections: DashboardNavCollection[] = [];
  const claimed = new Set<string>();

  for (const group of DASHBOARD_NAV_GROUP_ORDER) {
    const groupItems = items.filter((item) => item.group === group);
    for (const rule of DASHBOARD_NAV_COLLECTION_RULES.filter(
      (candidate) => candidate.group === group,
    )) {
      const hrefs = new Set<string>(rule.hrefs);
      const collectionItems = groupItems.filter(
        (item) => hrefs.has(item.href) && !claimed.has(item.href),
      );
      if (collectionItems.length === 0) continue;
      collectionItems.forEach((item) => claimed.add(item.href));
      collections.push({
        key: rule.key,
        label: rule.label,
        group,
        items: collectionItems,
      });
    }

    const unclaimed = groupItems.filter((item) => !claimed.has(item.href));
    if (unclaimed.length > 0) {
      unclaimed.forEach((item) => claimed.add(item.href));
      collections.push({
        key: `${group}-more`,
        label: `More ${DASHBOARD_NAV_GROUP_LABELS[group].toLowerCase()}`,
        group,
        items: unclaimed,
      });
    }
  }

  return collections;
}

export const DASHBOARD_NAV_COLLECTIONS: readonly DashboardNavCollection[] =
  buildDashboardNavCollections(DASHBOARD_NAV);
