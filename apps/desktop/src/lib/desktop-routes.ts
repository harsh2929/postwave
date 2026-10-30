import type { Section } from "./store";
import { NAV_ENTRIES, labelFor } from "@postwave/nav";

import {
  formatShortcutBinding,
  shortcutBindingFor,
  shortcutForSection,
} from "./desktop-shortcuts";

export type DesktopRouteCrumb =
  | "Workspace"
  | "Audience"
  | "Hygiene"
  | "Account";

export interface DesktopRouteMeta {
  title: string;
  crumb: DesktopRouteCrumb;
  /** Label used in dense navigation surfaces when it differs from title. */
  navLabel?: string;
  kbd?: string;
}

type DesktopRouteDetails = Pick<DesktopRouteMeta, "navLabel" | "kbd">;

function routeIn(crumb: DesktopRouteCrumb) {
  return (
    title: string,
    details: DesktopRouteDetails = {},
  ): DesktopRouteMeta => ({ title, crumb, ...details });
}

const workspaceRoute = routeIn("Workspace");
const audienceRoute = routeIn("Audience");
const hygieneRoute = routeIn("Hygiene");
const accountRoute = routeIn("Account");

const RAW_DESKTOP_ROUTE_META: Record<Section, DesktopRouteMeta> = {
  dashboard: workspaceRoute("Dashboard"),
  subscribers: workspaceRoute("Subscribers"),
  tags: workspaceRoute("Tags"),
  lists: workspaceRoute("Lists"),
  segments: audienceRoute("Segments"),
  suppressions: workspaceRoute("Suppressions"),
  smsSuppressions: accountRoute("SMS suppressions"),
  pushSuppressions: audienceRoute("Push suppressions"),
  deliverabilityHub: hygieneRoute("Deliverability hub"),
  privacyPortal: accountRoute("Privacy portal"),
  audienceSyncs: audienceRoute("Audience syncs"),
  campaigns: workspaceRoute("Campaigns"),
  sequences: workspaceRoute("Sequences"),
  automations: workspaceRoute("Automations"),
  forms: workspaceRoute("Forms"),
  templates: workspaceRoute("Templates"),
  assets: workspaceRoute("Assets"),
  collections: workspaceRoute("Collections"),
  webhooks: workspaceRoute("Webhooks"),
  outboundWebhooks: workspaceRoute("Outbound webhooks"),
  track: workspaceRoute("Product events"),
  analytics: workspaceRoute("Analytics"),
  sendtime: workspaceRoute("Send-time optimization", {
    navLabel: "Send-time",
  }),
  archive: workspaceRoute("Archive"),
  referrals: workspaceRoute("Referrals"),
  affiliates: workspaceRoute("Affiliates"),
  discounts: workspaceRoute("Discount history"),
  gifts: workspaceRoute("Gift history"),
  commerce: workspaceRoute("Commerce"),
  reviews: workspaceRoute("Reviews"),
  retentionOffers: workspaceRoute("Retention history"),
  // Internal scaffold only until real answer-engine drivers are wired.
  aeoSensor: workspaceRoute("AEO sensor"),
  domains: workspaceRoute("Custom domains"),
  dmarc: workspaceRoute("DMARC reports"),
  approvals: accountRoute("Approvals"),
  audit: accountRoute("Audit log"),
  consent: accountRoute("Consent receipts", { navLabel: "Consent" }),
  mcp: accountRoute("MCP"),
  smsInbox: accountRoute("SMS Inbox"),
  helpdesk: accountRoute("Helpdesk"),
  apiPlayground: accountRoute("API Playground"),
  webhookSimulator: accountRoute("Webhook simulator"),
  ai: workspaceRoute("Moosewave AI"),
  aiChangelog: workspaceRoute("AI Changelog"),
  migrations: workspaceRoute("Migrations"),
  integrations: workspaceRoute("Integrations"),
  dataPlatform: workspaceRoute("Data platform"),
  sending: accountRoute("Sending settings", { navLabel: "Sending" }),
  agency: accountRoute("Agency"),
  inboundRoutes: accountRoute("Inbound routes"),
  scim: accountRoute("SCIM"),
  hipaa: accountRoute("Compliance"),
  compliance: accountRoute("Compliance"),
  privacyIncidents: accountRoute("Privacy incidents"),
  auditSinks: accountRoute("Audit sinks"),
  auditAlerts: accountRoute("Audit alerts"),
  auditInvestigation: accountRoute("Audit investigation"),
  settings: accountRoute("Settings"),
};

/**
 * The desktop route metadata, with the canonical `title` of every
 * manifest-modelled section sourced from @postwave/nav at runtime — so the
 * shared manifest is the actual source of truth, not merely a test oracle. A
 * label change in the manifest propagates into desktop's crumbs, sidebar, and
 * command palette automatically; sections the manifest does not model keep
 * their desktop-local title.
 *
 * A section adopts the canonical title only when the manifest ROUTES that key
 * to this desktop section. Keying on the id alone can otherwise make a
 * name-collision silently retitle an unrelated surface; `referrals` remains the
 * current declared example.
 */
export const DESKTOP_ROUTE_META: Record<Section, DesktopRouteMeta> =
  Object.fromEntries(
    (Object.entries(RAW_DESKTOP_ROUTE_META) as [Section, DesktopRouteMeta][]).map(
      ([section, meta]) => {
        const canonical = manifestClaimsDesktopSection(section)
          ? labelFor(section)
          : undefined;
        return [
          section,
          canonical && canonical !== meta.title
            ? { ...meta, title: canonical }
            : meta,
        ];
      },
    ),
  ) as Record<Section, DesktopRouteMeta>;

/**
 * Does the shared manifest point this key at THIS desktop section?
 *
 * `routes.desktop` is `/app/<slug>`; desktop's Section id is the slug. A key
 * whose desktop route is null, or points somewhere else, has not claimed this
 * screen and must not rename it.
 */
function manifestClaimsDesktopSection(section: Section): boolean {
  const entry = NAV_ENTRIES.find((e) => e.key === section);
  return entry?.routes.desktop === `/app/${section}`;
}

export const ALL_DESKTOP_SECTIONS = Object.keys(
  DESKTOP_ROUTE_META,
) as Section[];

/**
 * The customer-visible, persistent desktop destinations in their canonical
 * navigation order. Keep this registry as the source for route-contract
 * tests: aliases (`outboundWebhooks`, `hipaa`), the contextual investigation
 * surface, and the internal AEO scaffold are deliberately not persistent
 * top-level destinations.
 */
export type PersistentDesktopSection = Exclude<
  Section,
  "aeoSensor" | "outboundWebhooks" | "hipaa" | "auditInvestigation"
>;

export const PERSISTENT_DESKTOP_SECTIONS = [
  "dashboard",
  "subscribers",
  "tags",
  "lists",
  "segments",
  "audienceSyncs",
  "suppressions",
  "campaigns",
  "sequences",
  "automations",
  "forms",
  "templates",
  "assets",
  "collections",
  "webhooks",
  "track",
  "analytics",
  "sendtime",
  "archive",
  "referrals",
  "affiliates",
  "discounts",
  "gifts",
  "commerce",
  "reviews",
  "retentionOffers",
  "deliverabilityHub",
  "domains",
  "dmarc",
  "ai",
  "aiChangelog",
  "migrations",
  "integrations",
  "dataPlatform",
  "approvals",
  "audit",
  "privacyIncidents",
  "consent",
  "mcp",
  "smsInbox",
  "helpdesk",
  "smsSuppressions",
  "pushSuppressions",
  "apiPlayground",
  "webhookSimulator",
  "sending",
  "agency",
  "inboundRoutes",
  "scim",
  "compliance",
  "privacyPortal",
  "auditSinks",
  "auditAlerts",
  "settings",
] as const satisfies readonly PersistentDesktopSection[];

export function routeMetaForSection(section: Section): DesktopRouteMeta {
  const meta = DESKTOP_ROUTE_META[section];
  const shortcut = shortcutForSection(section);
  if (!shortcut) return meta;
  return {
    ...meta,
    kbd: formatShortcutBinding(shortcutBindingFor(shortcut)),
  };
}

export function routeCommandLabel(section: Section): string {
  const meta = routeMetaForSection(section);
  return meta.navLabel ?? meta.title;
}

export interface CommandPaletteNavTarget {
  section: Section;
  label: string;
  kbd?: string;
}

export const COMMAND_PALETTE_NAV_TARGETS: CommandPaletteNavTarget[] =
  PERSISTENT_DESKTOP_SECTIONS.map((section) => {
    const meta = routeMetaForSection(section);
    return {
      section,
      label: meta.navLabel ?? meta.title,
      ...(meta.kbd ? { kbd: meta.kbd } : {}),
    };
  });
