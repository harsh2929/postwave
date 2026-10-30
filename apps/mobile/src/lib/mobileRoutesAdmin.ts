/**
 * lib/mobileRoutesAdmin.ts — the ADMIN and GOVERNANCE secondary routes:
 * the Enterprise and Account sections.
 *
 * Sibling of `mobileRoutesCore.ts`; see that file's header for why the table is
 * split this way. Most rows here carry a `minimumRole`, and the reason is worth
 * stating once: Moosewave authorises an authenticated request TWICE — the
 * per-route scope guard in the package's MountRoutes, and routeauth.Middleware
 * (wired as `authorizeRoute` for the whole authenticated group at main.go:2247)
 * which evaluates routeauth/manifest.json with a strict rank comparison.
 *
 * The effective floor is the STRICTER of the two, and either can bind:
 *   warehouse-runs   handler ScopeReadReports (any role) + manifest admin
 *                    (family:admin, REVIEWED)            => admin
 *   retention-offers main composition wraps all three reads with
 *                    RequireExactTenantAdmin                   => admin
 *
 * A manifest row marked `fail_closed_default` is auto-generated and unchecked;
 * a `reviewed` row is authoritative. Read both layers before setting a floor.
 */
import type { MobileSecondaryRoute } from "@/lib/mobileRouteTypes";

export const ADMIN_MOBILE_ROUTES: readonly MobileSecondaryRoute[] = [
  {
    key: "diagnostics",
    icon: "help",
    label: "Diagnostics",
    hint: "Build, push token, stream and offline-queue state for support",
    route: "/(tabs)/diagnostics",
    routeFile: "app/(tabs)/diagnostics.tsx",
    moreSection: "Account",
  },
  {
    key: "api-keys",
    icon: "link",
    label: "API keys",
    hint: "See what can reach this workspace, revoke a leak",
    route: "/(tabs)/api-keys",
    routeFile: "app/(tabs)/api-keys.tsx",
    moreSection: "Account",
    minimumRole: "admin",
  },
  {
    key: "agent-mandates",
    icon: "check",
    label: "Agent mandates",
    hint: "What your agents may do — and end it",
    route: "/(tabs)/agent-mandates",
    routeFile: "app/(tabs)/agent-mandates.tsx",
    moreSection: "Account",
    // NO minimumRole. `GET /api/v1/agent-mandates` floors at viewer, and that
    // is right: knowing what an agent is permitted to do is governance
    // transparency, and the people most likely to notice an agent misbehaving
    // are not always admins. Only DELETE is admin, and the screen gates the
    // revoke action in place. Caught by the read-floor equality assertion in
    // nav.consistency.test.ts, which rejected the admin row this shipped with.
  },
  {
    key: "agency",
    icon: "users",
    label: "Agency",
    hint: "Child roster + audit branding",
    route: "/(tabs)/agency",
    routeFile: "app/(tabs)/agency.tsx",
    navKey: "agency",
    moreSection: "Enterprise",
    minimumRole: "admin",
  },
  {
    key: "scim",
    icon: "settings",
    label: "SCIM",
    hint: "View tokens + role mappings",
    route: "/(tabs)/scim",
    routeFile: "app/(tabs)/scim.tsx",
    moreSection: "Enterprise",
    minimumRole: "admin",
  },
  {
    key: "warehouse-runs",
    icon: "log",
    label: "Warehouse syncs",
    hint: "Nightly sync runs and row errors",
    route: "/(tabs)/warehouse-runs",
    routeFile: "app/(tabs)/warehouse-runs.tsx",
    moreSection: "Enterprise",
    minimumRole: "admin",
  },
  {
    key: "retention-offers",
    icon: "card",
    label: "Retention offers",
    hint: "Stored rows, settings and aggregate counters",
    route: "/(tabs)/retention-offers",
    routeFile: "app/(tabs)/retention-offers.tsx",
    moreSection: "Enterprise",
    minimumRole: "admin",
  },
  {
    key: "privacy-incidents",
    icon: "bell",
    label: "Breach incidents",
    hint: "Open breaches, their clock and state",
    route: "/(tabs)/privacy-incidents",
    routeFile: "app/(tabs)/privacy-incidents.tsx",
    moreSection: "Enterprise",
    minimumRole: "admin",
  },
  {
    key: "pii-findings",
    icon: "check",
    label: "Shadow-PII findings",
    hint: "Review undeclared personal-data detections without exposing values",
    route: "/(tabs)/pii-findings",
    routeFile: "app/(tabs)/pii-findings.tsx",
    navKey: "piiFindings",
    moreSection: "Enterprise",
    minimumRole: "admin",
  },
  {
    // ADMIN, and the reason is not obvious: two of this screen's reads
    // (/{id}/analytics, /{id}/orders) are ScopeReadReports and clear any
    // session, but BOTH need an integration id, and the only route that can
    // enumerate integrations — GET /api/v1/commerce/integrations — is mounted
    // behind ScopeAdmin (commerce/handlers.go:138). ScopeAdmin is not in
    // readOnlyScopes (apikeys/middleware.go:332-337), so for a session it
    // degenerates into owner|admin. A viewer would reach a screen that can
    // only ever render a 403.
    key: "commerce",
    icon: "card",
    label: "Stores",
    hint: "Store sync health and recent orders",
    route: "/(tabs)/commerce",
    routeFile: "app/(tabs)/commerce.tsx",
    // The shared nav manifest now models the commerce workspace on all three
    // clients. Bind this existing More row to that canonical destination so
    // it is reachable by navigation rather than only by a deep link.
    navKey: "commerce",
    moreSection: "Enterprise",
    minimumRole: "admin",
  },
  {
    // No role floor, matching the `audit` row below, because the server gates
    // this on a SCOPE rather than a role: audit_alerts.go:113 mounts the List
    // route behind `apikeys.RequireScope(apikeys.ScopeAuditRead)` and there is
    // no requireAdmin in the handler. The screen therefore checks the audit
    // scope (hasAuditReadScope) exactly as app/(tabs)/audit.tsx does.
    //
    // Read the HANDLER, not routeauth/manifest.json, when deciding a floor.
    // That manifest carries auto-generated rows — `"policy_source":
    // "safe-default:read"` with `"review_status": "fail_closed_default"` means
    // nobody has read the handler for that entry. GET /api/v1/approvals is
    // listed there as viewer while approvals/handlers.go:226 calls
    // requireAdmin, which admits owner|admin only.
    key: "audit-alerts",
    icon: "bell",
    label: "Audit alerts",
    hint: "Rules that watch the audit log",
    route: "/(tabs)/audit-alerts",
    routeFile: "app/(tabs)/audit-alerts.tsx",
    moreSection: "Enterprise",
  },
  {
    key: "audit-sinks",
    icon: "log",
    label: "Audit sinks",
    hint: "Monitor streaming health + DLQ",
    route: "/(tabs)/audit-sinks",
    routeFile: "app/(tabs)/audit-sinks.tsx",
    moreSection: "Enterprise",
    minimumRole: "admin",
  },
  {
    key: "billing",
    icon: "card",
    label: "Plan & usage",
    hint: "Your tier and metered usage",
    route: "/(tabs)/billing",
    routeFile: "app/(tabs)/billing.tsx",
    moreSection: "Account",
    // Claims the @postwave/nav key now that the manifest declares billing on
    // mobile (packages/nav/src/manifest.ts). Without it, navForSurface("mobile")
    // yields an entry no mobile row reaches and nav.consistency's no-orphans
    // assertion fails.
    //
    // KNOWN, ACCEPTED SIDE EFFECT: MOBILE_SECONDARY_ROUTES rewrites a navKey'd
    // row's label to the canonical one, so the More sheet now reads "Billing"
    // rather than "Plan & usage". That is the manifest working as intended —
    // one name per surface-spanning concept — and it matches web and desktop.
    navKey: "billing",
    // NO role floor: Billing is viewer-reachable, matching the server.
    //
    // This row used to carry `minimumRole: "admin"` as a fail-safe, because the
    // screen's headline card (GET /api/v1/billing/plan-summary) was effectively
    // admin-only — routeauth's generated manifest row said admin and binds
    // independently of the mount site, which had always guarded it with
    // readReports like its siblings.
    //
    // That admin row was an ARTEFACT, not a decision, and it has now been
    // CORRECTED AT THE SOURCE: plan-summary carried no x-required-scopes and so
    // fell through to the `family:admin` fallback, while
    // /billing/{state,usage,invoices} all declared read:reports. The spec now
    // declares it, and the regenerated manifest row reads viewer /
    // openapi.x-required-scopes.
    //
    // The loosening exposed nothing new: /api/v1/limits/usage already served
    // the same quota rows from the same SQL at viewer.
    //
    // COUPLED CHANGE — do not remove one without the other: POST
    // /api/v1/billing/portal is STILL admin, so app/(tabs)/billing.tsx hides
    // the "Manage plan & payment" button below admin. Dropping this floor
    // without that gate would hand a viewer a button that can only 403.
  },
  {
    key: "settings",
    icon: "settings",
    label: "Settings",
    hint: "API connection, theme, push",
    route: "/(tabs)/settings",
    routeFile: "app/(tabs)/settings.tsx",
    moreSection: "Account",
    navKey: "settings",
  },
  {
    key: "audit",
    icon: "log",
    label: "Audit log",
    hint: "Recent workspace events",
    route: "/(tabs)/audit",
    routeFile: "app/(tabs)/audit.tsx",
    moreSection: "Account",
    navKey: "audit",
  },
  {
    // ADMIN, and the two layers DISAGREE: every /api/v1/mcp/* route is
    // RequireScope(ScopeAdmin) (server/identity_api.go:111-120) => owner|admin,
    // while the manifest says viewer with policy_source=safe-default:read and
    // review_status=fail_closed_default — unreviewed, and wrong in the
    // permissive direction. The stricter layer binds.
    key: "agent-activity",
    icon: "log",
    label: "Agent activity",
    hint: "Advisory API-key recorder observations",
    route: "/(tabs)/agent-activity",
    routeFile: "app/(tabs)/agent-activity.tsx",
    moreSection: "Enterprise",
    minimumRole: "admin",
  },
  {
    // ADMIN on both layers: the mount site wraps the group in
    // RequireScope(ScopeAdmin) (server/tenant_governance.go:98,125-128) and
    // ScopeAdmin is outside readOnlyScopes, so the session path is owner|admin;
    // the routeauth manifest independently says admin/REVIEWED.
    key: "compliance",
    icon: "check",
    label: "Compliance",
    hint: "Attestations, renewals and what has lapsed",
    route: "/(tabs)/compliance",
    routeFile: "app/(tabs)/compliance.tsx",
    moreSection: "Enterprise",
    minimumRole: "admin",
  },
  {
    // ADMIN, and the manifest would have told you viewer. Its row for
    // GET /api/v1/archive/comments is policy_source=safe-default:read with
    // review_status=fail_closed_default — auto-generated, unchecked. The
    // handler mounts BARE (archive_comments.go:190-195, no per-route scope),
    // so the binding guard is at the mount site: main.go:2993 wraps the whole
    // group in RequireScope(ScopeAdmin), which for a session is owner|admin.
    key: "archive-comments",
    icon: "check",
    label: "Comment moderation",
    hint: "Reader comments that are already public",
    route: "/(tabs)/archive-comments",
    routeFile: "app/(tabs)/archive-comments.tsx",
    moreSection: "Enterprise",
    minimumRole: "admin",
  },
];
