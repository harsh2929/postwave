import type { Section } from "./store";

export type DesktopNavDomain =
  | "home"
  | "audience"
  | "messaging"
  | "growth"
  | "connections"
  | "insights"
  | "ai"
  | "governance"
  | "settings";

export type DesktopCapabilityReadiness =
  | "operational"
  | "mixed"
  | "read-only"
  | "conditional"
  | "preview";

export type DesktopOfflineSupport =
  | "cached"
  | "retained-session"
  | "online-required";
export type DesktopEntryRole = "viewer" | "editor" | "admin";

export interface DesktopCapabilityMeta {
  id: string;
  domain: DesktopNavDomain;
  readiness: DesktopCapabilityReadiness;
  offline: DesktopOfflineSupport;
  entryRole?: DesktopEntryRole;
  auditScope?: "audit:read" | "audit:read_pii" | "audit:configure_sinks";
  limitation?: string;
  recoverySection?: Section;
}

export interface DesktopNavDomainMeta {
  id: DesktopNavDomain;
  label: string;
  description: string;
}

export const DESKTOP_NAV_DOMAINS: readonly DesktopNavDomainMeta[] = [
  { id: "home", label: "Home", description: "Overview and current work" },
  {
    id: "audience",
    label: "Audience",
    description: "People, groups and channel eligibility",
  },
  {
    id: "messaging",
    label: "Messaging",
    description: "Create, automate and reuse content",
  },
  {
    id: "growth",
    label: "Publishing & growth",
    description: "Publish, monetize and retain",
  },
  {
    id: "connections",
    label: "Data & connections",
    description: "Move data and connect systems",
  },
  {
    id: "insights",
    label: "Insights & delivery",
    description: "Measure and protect delivery",
  },
  { id: "ai", label: "AI", description: "Assisted work and model changes" },
  {
    id: "governance",
    label: "Operations & governance",
    description: "Review, investigate and govern",
  },
  {
    id: "settings",
    label: "Settings",
    description: "Workspace, account and desktop preferences",
  },
] as const;

function operational(
  id: string,
  domain: DesktopNavDomain,
  extra: Partial<DesktopCapabilityMeta> = {},
): DesktopCapabilityMeta {
  return {
    id,
    domain,
    readiness: "operational",
    offline: "online-required",
    ...extra,
  };
}

function cached(
  id: string,
  domain: DesktopNavDomain,
  extra: Partial<DesktopCapabilityMeta> = {},
): DesktopCapabilityMeta {
  return operational(id, domain, { offline: "cached", ...extra });
}

function limited(
  id: string,
  domain: DesktopNavDomain,
  readiness: Exclude<DesktopCapabilityReadiness, "operational">,
  limitation: string,
  extra: Partial<DesktopCapabilityMeta> = {},
): DesktopCapabilityMeta {
  return operational(id, domain, { readiness, limitation, ...extra });
}

export const DESKTOP_CAPABILITIES: Readonly<
  Record<Section, DesktopCapabilityMeta>
> = {
  dashboard: cached("dashboard", "home"),
  subscribers: cached("audience.subscribers", "audience"),
  tags: operational("audience.tags", "audience"),
  lists: operational("audience.lists", "audience"),
  segments: operational("audience.segments", "audience"),
  suppressions: cached("audience.email-suppressions", "audience"),
  smsSuppressions: limited(
    "audience.sms-suppressions",
    "audience",
    "mixed",
    "The exact-admin suppression registry and stored SMS policy records are available. Hosted carrier callbacks, dispatch, scheduling, automatic replies, and A2P registration remain release-held.",
    { entryRole: "admin" },
  ),
  pushSuppressions: limited(
    "audience.push-suppressions",
    "audience",
    "mixed",
    "The exact-admin push suppression registry is operational. Customer dispatch is not enabled; the APNs/FCM send gate is code-enforced before future enablement. Automatic provider feedback remains unavailable, and Web is registry-only.",
    { entryRole: "admin" },
  ),
  deliverabilityHub: operational("delivery.hub", "insights"),
  privacyPortal: operational("governance.privacy-portal", "governance"),
  audienceSyncs: limited(
    "audience.syncs",
    "audience",
    "mixed",
    "Webhook sync is operational; ad-platform foundations require provider readiness.",
    { recoverySection: "integrations" },
  ),
  campaigns: operational("messaging.campaigns", "messaging"),
  sequences: operational("messaging.sequences", "messaging"),
  automations: limited(
    "messaging.automations",
    "messaging",
    "mixed",
    "Definition and inspection tools are available; live warehouse-trigger and omnichannel execution remain unavailable until this deployment passes its durable-runtime readiness gates.",
    { recoverySection: "integrations" },
  ),
  forms: limited(
    "messaging.forms",
    "messaging",
    "mixed",
    "Core form definition, sharing, and reporting are available; canonical field editing, social capture activation, onsite experiments, and live variant delivery remain limited or staged.",
  ),
  templates: limited(
    "messaging.templates",
    "messaging",
    "mixed",
    "Catalog browsing and governed authoring are available; imported references still lack a review/promotion workflow, template edits lack concurrency preconditions, and saved blocks expose only the first server page.",
  ),
  assets: operational("messaging.assets", "messaging"),
  collections: limited(
    "messaging.collections",
    "messaging",
    "mixed",
    "Reference-data administration is available, but these rows are not connected to personalization, automation execution, or deployable coupon pools.",
  ),
  webhooks: operational("connections.webhooks", "connections", {
    entryRole: "admin",
    recoverySection: "settings",
  }),
  outboundWebhooks: operational("connections.webhooks", "connections", {
    entryRole: "admin",
    recoverySection: "settings",
  }),
  track: operational("connections.product-events", "connections"),
  analytics: operational("insights.analytics", "insights"),
  sendtime: limited(
    "delivery.send-time",
    "insights",
    "mixed",
    "Scoped audience analysis and subscriber inspection are available; campaign activation remains locked until durable scheduling and recovery are release-qualified.",
  ),
  archive: limited(
    "growth.archive",
    "growth",
    "mixed",
    "Authenticated issue inspection and admin safety-unpublishing are available. New publication, catalog edits, pinning, public delivery, comments, tips, paywalls, recommendations, and private feeds remain review-gated until their routing, tenant isolation, privacy, and secret-handling evidence is complete.",
    { entryRole: "viewer", recoverySection: "settings" },
  ),
  referrals: limited(
    "growth.referrals",
    "growth",
    "read-only",
    "Authenticated historical program, conversion-report, and leaderboard inspection is available. Program changes, subscriber links, live attribution, public installation, and reward-queue reads or actions remain review-gated until their runtime, privacy, expiry, snapshot, and fulfillment evidence is complete.",
    { entryRole: "viewer", recoverySection: "settings" },
  ),
  affiliates: limited(
    "growth.affiliates",
    "growth",
    "read-only",
    "Release-qualification guidance only. Platform-global partner records, public enrollment, attribution accrual, commission administration, and settlement remain hidden until platform-operator authority and the complete commercial, privacy, ledger, and payout evidence chain are approved.",
    { entryRole: "admin" },
  ),
  discounts: limited(
    "growth.discounts",
    "growth",
    "read-only",
    "Historical local-record inspection only. Provider-backed authoring, mutation, live validation, redemption, personally identified export, and checkout verification are unavailable.",
    { entryRole: "viewer" },
  ),
  gifts: limited(
    "growth.gift-subscriptions",
    "growth",
    "read-only",
    "Historical reporting only; purchase, claim and cancellation are unavailable.",
    { recoverySection: "integrations" },
  ),
  commerce: limited(
    "growth.commerce",
    "growth",
    "mixed",
    "Availability varies by connected provider; foundations are labelled in the catalog.",
    { recoverySection: "integrations" },
  ),
  reviews: limited(
    "growth.reviews",
    "growth",
    "mixed",
    "Authenticated review inspection, explicit moderation, public replies, and active-widget installation review are available. Review featuring, widget authoring or lifecycle changes, unbounded history, and anonymous/provider authenticity guarantees remain release-gated.",
    { recoverySection: "integrations" },
  ),
  retentionOffers: limited(
    "growth.retention-offers",
    "growth",
    "read-only",
    "Current stored offer rows and aggregate funnel counters only; authoring, delivery proof, and automated win-backs are unavailable.",
    { entryRole: "admin" },
  ),
  aeoSensor: limited(
    "ai.aeo-sensor",
    "ai",
    "preview",
    "Internal scaffold; no production answer-engine driver is attached.",
  ),
  domains: operational("delivery.domains", "insights"),
  dmarc: limited(
    "delivery.dmarc",
    "insights",
    "read-only",
    "Bounded aggregate-report evidence only. Ingestion readiness, current-RFC routing authorization, and policy-changing workflows remain release-gated until independently verified.",
  ),
  approvals: limited(
    "governance.approvals",
    "governance",
    "mixed",
    "Bounded queue inspection and response-verified rejection are available; approval execution, immutable review bundles, and durable downstream follow-up receipts remain release-held.",
    { entryRole: "admin" },
  ),
  audit: operational("governance.audit", "governance", {
    auditScope: "audit:read",
    recoverySection: "settings",
  }),
  consent: limited(
    "governance.consent",
    "governance",
    "read-only",
    "Admin-only inspection of bounded receipt/proof and consent-event windows. This surface does not prove complete cross-channel history, append-only integrity, retention, legal hold, certified export, or current delivery eligibility.",
    { entryRole: "admin", recoverySection: "settings" },
  ),
  mcp: limited(
    "connections.mcp",
    "connections",
    "read-only",
    "Admin-only inspection of a server-bundled candidate catalogue and best-effort API-key telemetry. Production client provisioning, public-artifact parity, transport governance, complete audit history, authoritative quota enforcement, and export remain release-held.",
    { entryRole: "admin", recoverySection: "settings" },
  ),
  smsInbox: operational("governance.sms-inbox", "governance"),
  helpdesk: limited(
    "governance.helpdesk",
    "governance",
    "mixed",
    "Admin-only stored-record inspection and versioned status or assignment changes are available. Internal notes are stored records with delivery not applicable; channel, Customer Hub, Customer Agent, provider runtime, and complete privacy lifecycle remain release-held.",
    {
      offline: "retained-session",
      entryRole: "viewer",
      recoverySection: "integrations",
    },
  ),
  apiPlayground: limited(
    "connections.api-playground",
    "connections",
    "mixed",
    "The authenticated OpenAPI catalog is complete. Live execution is limited to an explicit reviewed set of same-authority JSON operations; held, public-capability, special-auth, streaming, binary, download, deprecated, and unreviewed routes remain reference-only.",
    { entryRole: "viewer", recoverySection: "settings" },
  ),
  webhookSimulator: limited(
    "connections.webhook-simulator",
    "connections",
    "mixed",
    "Admin-only live signed diagnostics are available with durable fire receipts and explicit ambiguity reconciliation. They are not sandboxed, queued, automatically retried, or represented as production delivery-log evidence.",
    {
      entryRole: "admin",
      recoverySection: "settings",
    },
  ),
  ai: operational("ai.workspace", "ai"),
  aiChangelog: operational("ai.changelog", "ai"),
  migrations: operational("connections.migrations", "connections"),
  integrations: limited(
    "connections.integrations",
    "connections",
    "mixed",
    "The catalog includes verified, partial, delegated and planned connectors; each is labelled before setup.",
  ),
  dataPlatform: limited(
    "connections.data-platform",
    "connections",
    "conditional",
    "Warehouse and reverse-ETL jobs require a configured provider.",
    { recoverySection: "integrations" },
  ),
  sending: operational("settings.sending", "settings", {
    entryRole: "admin",
    recoverySection: "settings",
  }),
  agency: limited(
    "governance.agency",
    "governance",
    "conditional",
    "Workspace admins can inspect the bounded agency roster and saved audit-portal branding record. Provisioning, unlink, billing, invoice, and branding changes remain release-held.",
    { entryRole: "admin", recoverySection: "settings" },
  ),
  inboundRoutes: operational("connections.inbound-routes", "connections"),
  scim: operational("governance.scim", "governance", {
    entryRole: "admin",
    recoverySection: "settings",
  }),
  hipaa: operational("governance.compliance", "governance"),
  compliance: operational("governance.compliance", "governance"),
  privacyIncidents: limited(
    "governance.privacy-incidents",
    "governance",
    "mixed",
    "Admin-only preliminary incident records and non-terminal workflow updates are available. Counsel approval, verified notification delivery, packet generation or download, and incident closure remain release-held.",
    { entryRole: "admin" },
  ),
  auditSinks: operational("governance.audit-sinks", "governance", {
    auditScope: "audit:read",
    recoverySection: "settings",
  }),
  auditAlerts: operational("governance.audit-alerts", "governance", {
    auditScope: "audit:read",
    recoverySection: "settings",
  }),
  auditInvestigation: operational(
    "governance.audit-investigation",
    "governance",
    { auditScope: "audit:read_pii", recoverySection: "audit" },
  ),
  settings: operational("settings.workspace", "settings"),
};

export function capabilityForSection(section: Section): DesktopCapabilityMeta {
  return DESKTOP_CAPABILITIES[section];
}

export function capabilityReadinessLabel(
  readiness: DesktopCapabilityReadiness,
): string | null {
  switch (readiness) {
    case "mixed":
      return "Mixed readiness";
    case "read-only":
      return "Read only";
    case "conditional":
      return "Setup required";
    case "preview":
      return "Preview";
    case "operational":
    default:
      return null;
  }
}
