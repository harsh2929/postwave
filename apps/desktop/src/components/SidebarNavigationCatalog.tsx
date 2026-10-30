import { type ReactElement, type SVGProps } from "react";

import {
  routeMetaForSection,
  type PersistentDesktopSection,
} from "../lib/desktop-routes";
import { shortcutForSection } from "../lib/desktop-shortcuts";

export interface SidebarNavItem {
  id: PersistentDesktopSection;
  label: string;
  icon: (props: SVGProps<SVGSVGElement>) => ReactElement;
  shortcutId?: string;
}

/* Icons -------------------------------------------------------------- */

const iconProps: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

const IconHome = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" />
  </svg>
);
const IconUsers = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20c.5-3 3-5 6-5s5.5 2 6 5" />
    <circle cx="17" cy="9" r="2.5" />
    <path d="M21 19c-.3-2-1.6-3.4-3.5-4" />
  </svg>
);
const IconSend = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="m3 11 18-8-7 18-3-7z" />
    <path d="M11 13 21 3" />
  </svg>
);
const IconSequence = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <rect x="3" y="4" width="6" height="6" rx="1.5" />
    <rect x="15" y="4" width="6" height="6" rx="1.5" />
    <rect x="9" y="14" width="6" height="6" rx="1.5" />
    <path d="M9 7h6M6 10v2a2 2 0 0 0 2 2h1M18 10v2a2 2 0 0 1-2 2h-1" />
  </svg>
);
const IconForm = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M8 9h8M8 13h8M8 17h5" />
  </svg>
);
const IconTemplate = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M4 9h16M9 9v11" />
  </svg>
);
const IconChart = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M3 3v18h18" />
    <path d="M7 14l3-3 3 3 5-7" />
  </svg>
);
const IconSparkle = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M12 3l1.8 4.5L18 9l-4.2 1.5L12 15l-1.8-4.5L6 9l4.2-1.5z" />
    <path d="M19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7z" />
  </svg>
);
const IconMigrate = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M4 7h12" />
    <path d="m13 4 3 3-3 3" />
    <path d="M20 17H8" />
    <path d="m11 20-3-3 3-3" />
  </svg>
);
const IconCheck = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M9 12l2 2 4-4" />
    <circle cx="12" cy="12" r="9" />
  </svg>
);
const IconLog = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
    <path d="M8 10h8M8 14h8M8 18h5" />
  </svg>
);
const IconSettings = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);
/* ===== X1+X2+X3 surface icons ===== */
const IconTag = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" />
    <circle cx="7.5" cy="7.5" r="1.4" />
  </svg>
);
const IconList = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M8 6h12M8 12h12M8 18h12" />
    <circle cx="4" cy="6" r="1.2" />
    <circle cx="4" cy="12" r="1.2" />
    <circle cx="4" cy="18" r="1.2" />
  </svg>
);
const IconShield = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M12 3 4 6v6c0 4.5 3.4 8.4 8 9 4.6-.6 8-4.5 8-9V6z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);
const IconImage = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m4 18 5-5 4 4 3-3 4 4" />
  </svg>
);
const IconWebhook = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="18" r="2.5" />
    <circle cx="12" cy="6" r="2.5" />
    <path d="M9.7 7.4 6.6 13M14.3 7.4l3.1 5.6M8.5 18h7" />
  </svg>
);
const IconPlug = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M9 7V3" />
    <path d="M15 7V3" />
    <path d="M7 7h10v4a5 5 0 0 1-10 0z" />
    <path d="M12 16v5" />
  </svg>
);
const IconActivity = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M3 12h4l2-6 4 12 2-6h6" />
  </svg>
);
const IconClock = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
const IconArchive = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <path d="M10 12h4" />
  </svg>
);
const IconGift = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <rect x="3" y="8" width="18" height="4" rx="1" />
    <path d="M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8" />
    <path d="M12 8v13" />
    <path d="M12 8c-2 0-4-1-4-3a2 2 0 0 1 4 0c0 2-2 3-4 3M12 8c2 0 4-1 4-3a2 2 0 0 0-4 0c0 2 2 3 4 3" />
  </svg>
);
const IconPercent = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="m6 18 12-12" />
    <circle cx="7" cy="7" r="2" />
    <circle cx="17" cy="17" r="2" />
  </svg>
);
const IconGlobe = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </svg>
);
const IconBadgeCheck = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M12 2 9.5 4 6 4l-2 3-2 1 2 3-1 3 3 1 1 3 3-1 3 1 1-3 3-1-1-3 2-3-2-1-2-3-3.5 0z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);
// IconStar: reviews / ratings glyph.
const IconStar = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="m12 3 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.1l5.8-.8z" />
  </svg>
);
const IconGauge = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M4 13a8 8 0 0 1 16 0" />
    <path d="M12 13l4-3" />
    <circle cx="12" cy="13" r="1.2" />
    <path d="M5 19h14" />
  </svg>
);
const IconAgency = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <rect x="3" y="7" width="18" height="13" rx="2" />
    <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    <path d="M3 13h18" />
  </svg>
);
const IconRoute = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="5" r="2" />
    <path d="M8 19h6a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h6" />
  </svg>
);
const IconKey = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9" />
    <path d="M17 6l3 3" />
  </svg>
);
const IconShieldCheck = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);
const IconFunnel = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M3 5h18l-7 9v6l-4-2v-4z" />
  </svg>
);
const IconHeart = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M20.8 6.6a5.2 5.2 0 0 0-8.8-2.4 5.2 5.2 0 0 0-8.8 2.4c-1 4.7 4.5 8.4 8.8 12.4 4.3-4 9.7-7.7 8.8-12.4z" />
  </svg>
);
// IconAlert: shield-with-pulse for Privacy incidents. Subtly distinct
// from IconShield (no checkmark) and IconShieldCheck (different glyph),
// so the operator can tell at a glance which compliance surface is which.
const IconAlert = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M12 3 4 6v6c0 4.5 3.4 8.4 8 9 4.6-.6 8-4.5 8-9V6z" />
    <path d="M12 9v4" />
    <circle cx="12" cy="16" r="0.6" fill="currentColor" />
  </svg>
);

/* ===== full-surface wiring (2026-06-11) icons ===== */
// IconBolt: trigger/automation glyph — mirrors the CommandPalette's
// BoltIcon so "Automations" reads the same in both surfaces.
const IconBolt = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="M13 3 4 14h7l-1 7 9-11h-7z" />
  </svg>
);
// IconCart: commerce/storefront glyph for the revenue cluster.
const IconCart = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <circle cx="9" cy="20" r="1.4" />
    <circle cx="18" cy="20" r="1.4" />
    <path d="M3 4h2l2.5 12h11L21 8H6" />
  </svg>
);
// IconDatabase: cylinder glyph for the warehouse-facing Data platform.
const IconDatabase = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <ellipse cx="12" cy="5.5" rx="8" ry="2.5" />
    <path d="M4 5.5V12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V5.5" />
    <path d="M4 12v6.5C4 19.9 7.6 21 12 21s8-1.1 8-2.5V12" />
  </svg>
);
// IconCollection: stacked-layers glyph for workspace reference-data tables.
// These records are administrative data, not the live coupon or automation
// runtime.
const IconCollection = (p: SVGProps<SVGSVGElement>): ReactElement => (
  <svg {...iconProps} {...p}>
    <path d="m12 3 9 5-9 5-9-5z" />
    <path d="m3 13 9 5 9-5" />
    <path d="m3 17 9 5 9-5" />
  </svg>
);

function navItem(
  id: PersistentDesktopSection,
  icon: (props: SVGProps<SVGSVGElement>) => ReactElement,
): SidebarNavItem {
  const meta = routeMetaForSection(id);
  const shortcut = shortcutForSection(id);
  return {
    id,
    label: meta.navLabel ?? meta.title,
    icon,
    ...(shortcut ? { shortcutId: shortcut.id } : {}),
  };
}

const WORKSPACE_ITEMS: SidebarNavItem[] = [
  navItem("dashboard", IconHome),
  // Audience cluster
  navItem("subscribers", IconUsers),
  navItem("tags", IconTag),
  navItem("lists", IconList),
  // Segments: dynamic predicate-backed audiences (GAP-LS-003). Sits
  // next to Lists under the Audience cluster so the IA matches every
  // 2026 competitor (HubSpot / Klaviyo / Iterable / Braze) where Lists
  // and Segments are sibling concepts, not the same surface.
  navItem("segments", IconFunnel),
  navItem("audienceSyncs", IconRoute),
  navItem("suppressions", IconShield),
  // Compose cluster
  navItem("campaigns", IconSend),
  navItem("sequences", IconSequence),
  // Automations: warehouse-native triggers + omnichannel orchestration
  // (#28–30). Sits right after Sequences in the create/engage cluster —
  // both surfaces are "things that send on the tenant's behalf".
  navItem("automations", IconBolt),
  navItem("forms", IconForm),
  navItem("templates", IconTemplate),
  navItem("assets", IconImage),
  // Collections: workspace reference-data tables. They remain beside Assets
  // for content administration, but are not a personalization/automation
  // runtime and are distinct from deployable coupon pools.
  navItem("collections", IconCollection),
  // Ingestion / events cluster
  /* P2 fix (audit 2026-06-02): the two "Inbound webhooks" + "Outbound
   * webhooks" entries both routed to the same <WebhooksHome /> which
   * already has its own Inbound / Outbound tab pair. Three nav
   * destinations for two surfaces is one too many — merged into a
   * single "Webhooks" entry; the in-page tab pair handles direction. */
  navItem("webhooks", IconWebhook),
  navItem("track", IconActivity),
  // Insight cluster
  navItem("analytics", IconChart),
  navItem("sendtime", IconClock),
  // Distribution cluster
  navItem("archive", IconArchive),
  navItem("referrals", IconHeart),
  // Affiliates: partner/commission program (#51). Directly after
  // Referrals — both are grow-by-advocacy surfaces.
  navItem("affiliates", IconUsers),
  // Monetization cluster
  navItem("discounts", IconPercent),
  navItem("gifts", IconGift),
  // Commerce: storefront/integration revenue surface (#32–33). Sits
  // with Discounts / Gift subs in the monetization cluster.
  navItem("commerce", IconCart),
  navItem("reviews", IconStar),
  navItem("retentionOffers", IconHeart),
  // Deliverability ops
  navItem("deliverabilityHub", IconGauge),
  navItem("domains", IconGlobe),
  navItem("dmarc", IconBadgeCheck),
  // Agent / integration
  navItem("ai", IconSparkle),
  navItem("aiChangelog", IconSparkle),
  // No kbd chip: ⌘M is macOS Minimize (intercepted by the native menu
  // before the webview), so Migrations is palette/sidebar-only — see
  // LETTER_SECTIONS in store.ts. Don't advertise a shortcut that no-ops.
  navItem("migrations", IconMigrate),
  navItem("integrations", IconPlug),
  // Data platform: warehouse syncs / CDP plumbing (#34–36). Lives next
  // to Migrations — both are "move data in and out" operator surfaces.
  navItem("dataPlatform", IconDatabase),
];

const ACCOUNT_ITEMS: SidebarNavItem[] = [
  navItem("approvals", IconCheck),
  navItem("audit", IconLog),
  // Privacy incidents: breach-response workflow (state machine + counsel
  // sign-off + per-audience packets). Sits next to Audit log because the
  // two surfaces share a forensic/compliance audience.
  navItem("privacyIncidents", IconAlert),
  // Consent: per-tenant consent receipts + per-subscriber tracking
  // prefs (open/click opt-outs). Sits between Audit log and MCP because
  // it's the compliance auditor's other primary surface.
  navItem("consent", IconShield),
  // MCP: agent connection guide + per-call telemetry. Operator-grade
  // observability for whatever the customer's Claude Code / Cursor /
  // Continue / Zed integrations are doing against this tenant.
  navItem("mcp", IconKey),
  // SMS inbox: two-way conversational view of inbound + outbound SMS.
  // Sits in Account because it's operator-grade (read every reply
  // across the tenant), not editor-grade.
  navItem("smsInbox", IconRoute),
  navItem("helpdesk", IconRoute),
  // SMS + Push suppression registries (Wave 2/3 — GAP-LS-014 / 015).
  // Sit next to SMS Inbox in the Account cluster because all three
  // are compliance/operator surfaces, not editor surfaces.
  navItem("smsSuppressions", IconShield),
  navItem("pushSuppressions", IconShield),
  // API Playground: in-app explorer for the Moosewave OpenAPI spec.
  // Developer-facing; sits in Account next to MCP since both are
  // about how external integrators talk to Moosewave.
  navItem("apiPlayground", IconKey),
  // Webhook simulator: fire HMAC-signed event payloads at a configured
  // outbound webhook to test integrators' handlers. Saves a day of
  // back-and-forth per integrator.
  navItem("webhookSimulator", IconFunnel),
  navItem("sending", IconGauge),
  navItem("agency", IconAgency),
  navItem("inboundRoutes", IconRoute),
  navItem("scim", IconKey),
  navItem("compliance", IconShieldCheck),
  navItem("privacyPortal", IconShield),
  navItem("auditSinks", IconFunnel),
  navItem("auditAlerts", IconAlert),
  navItem("settings", IconSettings),
];

export const ALL_NAV_ITEMS = [...WORKSPACE_ITEMS, ...ACCOUNT_ITEMS] as const;
