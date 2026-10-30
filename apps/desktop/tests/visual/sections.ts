export interface PrimaryDesktopSection {
  id: string;
  label: string;
  heading: string;
}

/**
 * Every primary destination rendered by Sidebar, in visual order.
 *
 * The renderer gate compares this list with the actual sidebar before it
 * traverses the routes. Adding, removing, or renaming a production navigation
 * item therefore requires an intentional test update instead of silently
 * dropping that surface from production-readiness coverage.
 */
export const PRIMARY_DESKTOP_SECTIONS: readonly PrimaryDesktopSection[] = [
  { id: "dashboard", label: "Dashboard", heading: "Dashboard" },
  { id: "subscribers", label: "Subscribers", heading: "Subscribers" },
  { id: "tags", label: "Tags", heading: "Tags" },
  { id: "lists", label: "Lists", heading: "Lists" },
  { id: "segments", label: "Segments", heading: "Segments" },
  { id: "audienceSyncs", label: "Audience syncs", heading: "Audience syncs" },
  { id: "suppressions", label: "Suppressions", heading: "Suppressions" },
  { id: "campaigns", label: "Campaigns", heading: "Campaigns" },
  { id: "sequences", label: "Sequences", heading: "Sequences" },
  { id: "automations", label: "Automations", heading: "Automations" },
  { id: "forms", label: "Forms", heading: "Forms" },
  { id: "templates", label: "Templates", heading: "Templates" },
  { id: "assets", label: "Assets", heading: "Assets" },
  {
    id: "collections",
    label: "Collections",
    heading: "Reference collections",
  },
  { id: "webhooks", label: "Webhooks", heading: "Webhooks" },
  { id: "track", label: "Product events", heading: "Product events" },
  { id: "analytics", label: "Analytics", heading: "Analytics" },
  { id: "sendtime", label: "Send-time", heading: "Send-time intelligence" },
  { id: "archive", label: "Archive", heading: "Archive" },
  {
    id: "referrals",
    label: "Referrals",
    heading:
      "Understand your referral history. Qualify the loop before launch.",
  },
  {
    id: "affiliates",
    label: "Affiliates",
    heading: "Qualify the partner engine before money moves.",
  },
  {
    id: "discounts",
    label: "Discount history",
    heading: "Read the commercial record without inventing checkout truth.",
  },
  { id: "gifts", label: "Gift history", heading: "Gift subscriptions" },
  { id: "commerce", label: "Commerce", heading: "Commerce" },
  { id: "reviews", label: "Reviews", heading: "Reviews" },
  {
    id: "retentionOffers",
    label: "Retention history",
    heading: "See what the retention record can prove—and where it stops.",
  },
  {
    id: "deliverabilityHub",
    label: "Deliverability hub",
    heading: "Deliverability hub",
  },
  { id: "domains", label: "Custom domains", heading: "Custom domains" },
  { id: "dmarc", label: "DMARC reports", heading: "DMARC reports" },
  { id: "ai", label: "Moosewave AI", heading: "Moosewave AI" },
  { id: "aiChangelog", label: "AI Changelog", heading: "AI Changelog" },
  { id: "migrations", label: "Migrations", heading: "Migrations" },
  { id: "integrations", label: "Integrations", heading: "Integrations" },
  { id: "dataPlatform", label: "Data platform", heading: "Data platform" },
  { id: "approvals", label: "Approvals", heading: "Approvals" },
  { id: "audit", label: "Audit log", heading: "Audit log" },
  {
    id: "privacyIncidents",
    label: "Privacy incidents",
    heading: "Privacy incidents",
  },
  { id: "consent", label: "Consent", heading: "Consent receipts" },
  { id: "mcp", label: "MCP", heading: "MCP" },
  { id: "smsInbox", label: "SMS Inbox", heading: "SMS Inbox" },
  { id: "helpdesk", label: "Helpdesk", heading: "Helpdesk" },
  {
    id: "smsSuppressions",
    label: "SMS suppressions",
    heading: "SMS suppressions",
  },
  {
    id: "pushSuppressions",
    label: "Push suppressions",
    heading: "Push suppressions",
  },
  { id: "apiPlayground", label: "API Playground", heading: "API Playground" },
  {
    id: "webhookSimulator",
    label: "Webhook simulator",
    heading: "Webhook simulator",
  },
  { id: "sending", label: "Sending", heading: "Sending settings" },
  { id: "agency", label: "Agency", heading: "Agency" },
  { id: "inboundRoutes", label: "Inbound routes", heading: "Inbound routes" },
  { id: "scim", label: "SCIM", heading: "SCIM" },
  { id: "compliance", label: "Compliance", heading: "Compliance" },
  { id: "privacyPortal", label: "Privacy portal", heading: "Privacy portal" },
  { id: "auditSinks", label: "Audit sinks", heading: "Audit sinks" },
  { id: "auditAlerts", label: "Audit alerts", heading: "Audit alerts" },
  { id: "settings", label: "Settings", heading: "Settings" },
] as const;
