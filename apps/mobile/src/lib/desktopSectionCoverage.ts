/**
 * lib/desktopSectionCoverage.ts — the desktop-anchored half of the honesty
 * ledger: every section apps/desktop's sidebar offers, and what mobile does
 * about it.
 *
 * Split out of `desktopOnlyCapabilities.ts`, which keeps the half a USER reads
 * (the "Not on this phone" block) and re-exports this table, so callers of the
 * old surface are unaffected.
 *
 * ── WHY THIS IS A TABLE AND NOT PROSE ──────────────────────────────────────
 * A hand-written "some things are desktop-only" sentence rots the moment a
 * capability ships on mobile, and rots in the WORST direction: it tells a user
 * a feature they are looking at does not exist. So the list is data, and
 * `desktopOnlyCapabilities.test.ts` reconciles it against BOTH ends:
 *
 *   1. Against apps/desktop's own sidebar catalogue, so a desktop section that
 *      is neither mapped to a mobile screen nor declared desktop-only fails
 *      the build. That is the guard MAP#73 actually asks for — it makes "the
 *      More menu implies coverage it does not have" a test failure rather than
 *      an audit finding.
 *   2. Against the mobile route manifest, so the day Affiliates ships on the
 *      phone, the row claiming it is missing fails the build and has to go.
 *
 * ── COVERAGE IS NOT ONLY A ROUTE ───────────────────────────────────────────
 * Several desktop sections exist on mobile as a PANEL inside another screen
 * rather than as their own destination — push suppressions live in the shared
 * Suppressions screen, consent receipts on the subscriber detail, send-time
 * optimisation in the campaign scheduler. Those are covered, and calling them
 * missing would be as wrong as staying silent. `MobileCoverage` records which
 * of the two shapes each one has, and the reason is written next to it.
 *
 * Import-free of react-native/expo by construction (its only import is a
 * type), so every rule above is unit-tested under node.
 */
import type { MobileCoverage } from "@/lib/mobileCoverage";

/**
 * The desktop Webhook Simulator contains two materially different verbs. The
 * phone ships the bounded, canned signed test; it does not ship arbitrary
 * payload authoring or the receiver-evidence inspector. Keeping those as two
 * entries prevents either half from being used to overclaim the other.
 */
export const OUTBOUND_WEBHOOK_DIAGNOSTIC_COVERAGE = {
  cannedSignedTest: { kind: "inside", hostKey: "settings" },
  customPayloadSimulator: { kind: "absent" },
} as const satisfies Readonly<Record<string, MobileCoverage>>;

/**
 * Every section in apps/desktop/src/components/SidebarNavigationCatalog.tsx,
 * and what mobile does about it. The test fails if desktop grows a section
 * that is missing here, so this table cannot silently fall behind.
 */
export const DESKTOP_SECTION_COVERAGE: Readonly<
  Record<string, MobileCoverage>
> = {
  // ── Workspace: audience ──────────────────────────────────────────────────
  dashboard: { kind: "route", mobileKey: "dashboard" },
  subscribers: { kind: "route", mobileKey: "subscribers" },
  tags: { kind: "route", mobileKey: "tags" },
  lists: { kind: "route", mobileKey: "lists" },
  segments: { kind: "route", mobileKey: "segments" },
  audienceSyncs: { kind: "route", mobileKey: "audience-syncs" },
  suppressions: { kind: "route", mobileKey: "suppressions" },
  // ── Workspace: compose ───────────────────────────────────────────────────
  campaigns: { kind: "route", mobileKey: "campaigns" },
  sequences: { kind: "route", mobileKey: "sequences" },
  automations: { kind: "route", mobileKey: "flows" },
  forms: { kind: "route", mobileKey: "forms" },
  templates: { kind: "route", mobileKey: "templates" },
  assets: { kind: "route", mobileKey: "assets" },
  collections: { kind: "route", mobileKey: "collections" },
  // ── Workspace: ingestion + insight ───────────────────────────────────────
  webhooks: { kind: "route", mobileKey: "webhooks" },
  track: { kind: "route", mobileKey: "product-events" },
  analytics: { kind: "route", mobileKey: "analytics" },
  // Send-time optimisation is a decision you make WHILE scheduling, and that
  // is where mobile puts it (components/campaigns/BestTimeScheduleCard, plus
  // the per-person answer on the subscriber detail). A standalone read-only
  // copy of the same model would be a screen with no verb on it.
  sendtime: { kind: "inside", hostKey: "campaigns" },
  // ── Workspace: distribution + monetisation ───────────────────────────────
  archive: { kind: "route", mobileKey: "archive" },
  referrals: { kind: "route", mobileKey: "referrals" },
  affiliates: { kind: "absent" },
  discounts: { kind: "route", mobileKey: "discounts" },
  gifts: { kind: "route", mobileKey: "gift-subscriptions" },
  commerce: { kind: "route", mobileKey: "commerce" },
  reviews: { kind: "route", mobileKey: "reviews" },
  retentionOffers: { kind: "route", mobileKey: "retention-offers" },
  // ── Workspace: deliverability ────────────────────────────────────────────
  deliverabilityHub: { kind: "route", mobileKey: "deliverability" },
  domains: { kind: "route", mobileKey: "custom-domains" },
  dmarc: { kind: "route", mobileKey: "dmarc" },
  // ── Workspace: agent + data platform ─────────────────────────────────────
  ai: { kind: "route", mobileKey: "voice" },
  aiChangelog: { kind: "absent" },
  migrations: { kind: "route", mobileKey: "migrations" },
  integrations: { kind: "route", mobileKey: "integrations" },
  dataPlatform: { kind: "route", mobileKey: "warehouse-runs" },
  // ── Account: governance ──────────────────────────────────────────────────
  approvals: { kind: "route", mobileKey: "approvals" },
  audit: { kind: "route", mobileKey: "audit" },
  privacyIncidents: { kind: "route", mobileKey: "privacy-incidents" },
  // The consent RECEIPT is a per-person artefact, so mobile renders it where
  // the person is (components/subscriber/sections/PortableReceiptCard) rather
  // than as a workspace-wide list nobody opens on a phone.
  consent: { kind: "inside", hostKey: "subscribers" },
  mcp: { kind: "route", mobileKey: "agent-activity" },
  smsInbox: { kind: "route", mobileKey: "sms" },
  helpdesk: { kind: "route", mobileKey: "helpdesk" },
  smsSuppressions: { kind: "route", mobileKey: "sms-suppressions" },
  // Tenant-customer APNs/FCM/Web authority lives inside the shared suppression
  // screen; Deliverability carries only a registry rollup. It is unrelated to
  // this operator app's Expo device and remains a release-held delivery path.
  pushSuppressions: { kind: "inside", hostKey: "suppressions" },
  apiPlayground: { kind: "absent" },
  // The desktop section is the CUSTOM-payload simulator: arbitrary event data,
  // prepared request evidence and the receiver response. That capability is not
  // on mobile. The separate `cannedSignedTest` verdict above records the real
  // phone verb at POST /outbound-webhooks/{id}/test without inflating it into
  // parity with desktop's live diagnostic.
  webhookSimulator: OUTBOUND_WEBHOOK_DIAGNOSTIC_COVERAGE.customPayloadSimulator,
  sending: { kind: "route", mobileKey: "sending-settings" },
  agency: { kind: "route", mobileKey: "agency" },
  inboundRoutes: { kind: "route", mobileKey: "inbound-routes" },
  scim: { kind: "route", mobileKey: "scim" },
  compliance: { kind: "route", mobileKey: "compliance" },
  // Export/erasure requests are an account-settings act, and mobile keeps them
  // in Settings › Privacy (components/settings/PrivacyRequestsSection) behind
  // the same `privacy_requests` capability the desktop portal uses.
  privacyPortal: { kind: "inside", hostKey: "settings" },
  auditSinks: { kind: "route", mobileKey: "audit-sinks" },
  auditAlerts: { kind: "route", mobileKey: "audit-alerts" },
  settings: { kind: "route", mobileKey: "settings" },
};
