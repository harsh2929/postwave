/**
 * lib/mobileRoutesCore.ts — the DAILY-WORK secondary routes: Audience,
 * Tools, Sending and Content.
 *
 * Split from `mobileRouteTable.ts` when that file crossed its 450-line ceiling
 * for the second time. The seam is the one the table itself already uses: these
 * are the surfaces somebody opens to do the job, while the admin/governance
 * rows in `mobileRoutesAdmin.ts` are opened to configure or audit it. The two
 * sets grow independently — a sprint of campaign work adds rows here and none
 * there — so keeping them apart stops either from pushing the other over a
 * ceiling.
 */
import type { MobileSecondaryRoute } from "@/lib/mobileRouteTypes";
import { TOOLS_MOBILE_ROUTES } from "@/lib/mobileRoutesTools";

export const CORE_MOBILE_ROUTES: readonly MobileSecondaryRoute[] = [
  ...TOOLS_MOBILE_ROUTES,
  {
    key: "tags",
    icon: "users",
    label: "Tags",
    hint: "Browse targeting tags",
    route: "/(tabs)/tags",
    routeFile: "app/(tabs)/tags.tsx",
    moreSection: "Audience",
  },
  {
    key: "lists",
    icon: "users",
    label: "Lists",
    hint: "Browse static + dynamic segments",
    route: "/(tabs)/lists",
    routeFile: "app/(tabs)/lists/index.tsx",
    moreSection: "Audience",
  },
  {
    key: "suppressions",
    icon: "check",
    label: "Suppressions",
    hint: "Review bounces, complaints, manual",
    route: "/(tabs)/suppressions",
    routeFile: "app/(tabs)/suppressions/index.tsx",
    moreSection: "Audience",
  },
  {
    key: "sms-suppressions",
    icon: "check",
    label: "SMS opt-outs",
    hint: "Manual and authority-backed SMS holds",
    route: "/(tabs)/sms/suppressions",
    routeFile: "app/(tabs)/sms/suppressions.tsx",
    moreSection: "Audience",
    // The roster contains customer phone numbers. All three server operations
    // use RequireExactTenantAdmin; do not advertise even the collection route
    // to viewers or mobile API-key mode (whose exact scopes are unavailable).
    minimumRole: "admin",
  },
  {
    key: "sms-broadcasts",
    icon: "check",
    label: "SMS broadcasts",
    // Draft CRUD is live server-side; dispatch stays behind
    // sms_broadcast_dispatch_release_held, and the screen says so itself.
    hint: "Draft, edit, and track SMS broadcasts; dispatch is release-held",
    route: "/(tabs)/sms/broadcasts",
    routeFile: "app/(tabs)/sms/broadcasts.tsx",
    moreSection: "Sending",
    minimumRole: "admin",
  },
  {
    key: "reviews",
    icon: "check",
    label: "Reviews",
    hint: "Moderate incoming reviews — approve, reject, reply",
    route: "/(tabs)/reviews",
    routeFile: "app/(tabs)/reviews.tsx",
    moreSection: "Content",
    // NO minimumRole, deliberately. The row previously declared `editor`,
    // which matched NEITHER side of the contract: `GET /api/v1/reviews` is
    // `read:reports` (viewer) and approve / reject / reply are admin. So it
    // locked a viewer out of a queue the server would have served, and because
    // over-gating never errors, nothing ever surfaced it.
    //
    // The screen was already built for exactly this: its header says a viewer
    // "sees the queue and is told plainly that deciding needs admin", and
    // `canAccessMinimumRole("admin", …)` gates the three verbs in place. The
    // row was contradicting its own screen.
    //
    // Not machine-checked: the manifest row for GET /api/v1/reviews is
    // `fail_closed_default`, and nav.consistency deliberately skips unreviewed
    // rows rather than assert against a generated guess. The justification here
    // is the Go mount's scope plus the screen's own design.
  },
  {
    key: "deliverability",
    icon: "check",
    label: "Deliverability",
    hint: "Sender score, breaches, auto-throttle state",
    route: "/(tabs)/deliverability",
    routeFile: "app/(tabs)/deliverability.tsx",
    // The manifest calls this concept `deliverabilityHub`, not `deliverability`
    // -- the key here is the More-row's own id. Without the link the row was
    // invisible to nav.consistency's reachability set, so the manifest entry
    // counted as an orphan even though this row navigates to exactly the route
    // the manifest names for mobile.
    navKey: "deliverabilityHub",
    moreSection: "Sending",
    minimumRole: "admin",
  },
  {
    key: "segments",
    icon: "users",
    label: "Segments",
    hint: "Dynamic audience rules and their live counts",
    route: "/(tabs)/segments",
    routeFile: "app/(tabs)/segments/index.tsx",
    moreSection: "Audience",
  },
  {
    key: "sending-settings",
    icon: "send",
    label: "Sending settings",
    hint: "Throttles, warm-up, defaults",
    route: "/(tabs)/sending-settings",
    routeFile: "app/(tabs)/sending-settings.tsx",
    moreSection: "Sending",
    minimumRole: "admin",
  },
  {
    key: "custom-domains",
    icon: "link",
    label: "Custom domains",
    hint: "DKIM + sending domains",
    route: "/(tabs)/custom-domains",
    routeFile: "app/(tabs)/custom-domains.tsx",
    moreSection: "Sending",
    minimumRole: "admin",
  },
  {
    key: "dmarc",
    icon: "log",
    // MUST MATCH @postwave/nav's label for this key. The More menu renders
    // `labelFor()` from that package (lib/mobileRouteManifest.ts), so a
    // different string here is not a second opinion — it is a name no user
    // ever sees, which is how a test came to assert "DMARC reports" against a
    // menu that says "DMARC".
    label: "DMARC",
    hint: "Review authentication failures",
    route: "/(tabs)/dmarc",
    routeFile: "app/(tabs)/dmarc.tsx",
    // Links this row to the manifest's `dmarc` entry, which gained a mobile
    // route during the 2026-08-22 web sweep. The screen and the row both
    // already existed; only the manifest link was missing, which made the
    // entry read as an orphan.
    navKey: "dmarc",
    moreSection: "Sending",
  },
  {
    key: "archive",
    icon: "log",
    label: "Archive",
    hint: "Review published issues",
    route: "/(tabs)/archive",
    routeFile: "app/(tabs)/archive.tsx",
    moreSection: "Content",
  },
  {
    key: "discounts",
    icon: "check",
    label: "Discounts",
    hint: "Monitor promo codes + redemptions",
    route: "/(tabs)/discounts",
    routeFile: "app/(tabs)/discounts.tsx",
    moreSection: "Content",
  },
  {
    key: "templates",
    icon: "send",
    label: "Templates",
    hint: "Start a campaign from an approved design",
    route: "/(tabs)/templates",
    routeFile: "app/(tabs)/templates.tsx",
    moreSection: "Content",
  },
  {
    // ROLE FLOORS BELOW ARE THE STRICTER OF TWO ENFORCED LAYERS.
    // Moosewave authorises an authenticated request twice: the per-route scope
    // guard in the package's MountRoutes, AND routeauth.Middleware, wired as
    // `authorizeRoute` for the whole authenticated group (main.go:2247), which
    // evaluates apps/api/internal/routeauth/manifest.json with a strict rank
    // comparison (routeauth/middleware.go roleAllows). Either can be the
    // binding one:
    //   warehouse-runs  — handler says ScopeReadReports (read-only, any role),
    //                     manifest says admin (family:admin, REVIEWED) => admin
    //   retention-offers— manifest says viewer (safe-default, UNREVIEWED),
    //                     handler mount wraps ScopeAdmin (main.go:2943) => admin
    // A manifest row marked `fail_closed_default` is auto-generated and nobody
    // has checked it; a `reviewed` row is enforced and authoritative.
    key: "audience-syncs",
    icon: "link",
    label: "Audience syncs",
    hint: "Reverse-ETL health and what failed",
    route: "/(tabs)/audience-syncs",
    routeFile: "app/(tabs)/audience-syncs.tsx",
    moreSection: "Audience",
  },
  {
    key: "assets",
    icon: "image",
    label: "Assets",
    hint: "Workspace image library",
    route: "/(tabs)/assets",
    routeFile: "app/(tabs)/assets.tsx",
    moreSection: "Content",
  },
  {
    key: "landing-pages",
    icon: "link",
    label: "Landing pages",
    hint: "Published pages and their leads",
    route: "/(tabs)/landing-pages",
    routeFile: "app/(tabs)/landing-pages.tsx",
    moreSection: "Content",
  },
  {
    key: "subscriber-imports",
    icon: "users",
    label: "Imports",
    hint: "Import jobs, progress and confirmation",
    route: "/(tabs)/subscriber-imports",
    routeFile: "app/(tabs)/subscriber-imports.tsx",
    moreSection: "Audience",
  },
  {
    // VIEWER on purpose. The two reads are RequireScope(ScopeReadReports)
    // (subscriber_dedupe.go:34-39), a read-only scope, and the manifest rows
    // are viewer/REVIEWED — so a viewer gets the full monitor. The MERGE is
    // owner|admin (manifest admin + routeauth enforcing it independently) and
    // is gated INSIDE the screen; gating the route would hide a readable
    // queue for no reason.
    key: "subscriber-duplicates",
    icon: "users",
    label: "Duplicates",
    hint: "Candidate duplicate pairs and the merge review",
    route: "/(tabs)/subscriber-duplicates",
    routeFile: "app/(tabs)/subscriber-duplicates.tsx",
    moreSection: "Audience",
  },
  {
    key: "lookalike",
    icon: "users",
    label: "Lookalike audiences",
    hint: "Model quality, size and age",
    route: "/(tabs)/lookalike",
    routeFile: "app/(tabs)/lookalike.tsx",
    moreSection: "Audience",
  },
  {
    key: "gift-subscriptions",
    icon: "card",
    label: "Gift history",
    hint: "Sanitized lifecycle history and recorded outcomes",
    route: "/(tabs)/gift-subscriptions",
    routeFile: "app/(tabs)/gift-subscriptions.tsx",
    moreSection: "Content",
  },
  {
    key: "collections",
    icon: "log",
    label: "Collections",
    hint: "Reference lookup tables, their size and last change",
    route: "/(tabs)/collections",
    routeFile: "app/(tabs)/collections.tsx",
    moreSection: "Content",
  },
  {
    // Both backing reads are viewer at BOTH enforcement points, so the row
    // carries no floor; mobile owning the share sheet is what makes referrals
    // a natural phone surface rather than a port of a desktop table.
    key: "referrals",
    icon: "users",
    label: "Referrals",
    hint: "Programme tiers, conversion funnel, top referrers",
    route: "/(tabs)/referrals",
    routeFile: "app/(tabs)/referrals.tsx",
    moreSection: "Audience",
  },
  {
    // No floor DELIBERATELY: GET /api/v1/frequency-caps is viewer at both
    // layers, so "what is throttling my sends" is readable by everyone; the
    // admin-only PATCH toggle is gated inside the screen. Same shape as the
    // discounts row, which also fronts an admin mutation without a route floor.
    key: "frequency-caps",
    icon: "send",
    label: "Frequency caps",
    hint: "See what is throttling sends, switch a cap off",
    route: "/(tabs)/frequency-caps",
    routeFile: "app/(tabs)/frequency-caps.tsx",
    moreSection: "Sending",
  },
  {
    // ADMIN, and MEASURED rather than read off the manifest: every send-time
    // read is mounted behind RequireScope(ScopeReadReports, ScopeAdmin), and
    // ScopeAdmin sits OUTSIDE readOnlyScopes — so on the session path
    // sessionRoleAllowsScopes demands owner|admin and everyone else gets a 403
    // insufficient_role. Pinned by send_time_opt/rbac_session_test.go.
    key: "send-time",
    icon: "log",
    label: "Send time",
    hint: "When your audience actually reads — the week as a heatmap",
    route: "/(tabs)/send-time",
    routeFile: "app/(tabs)/send-time.tsx",
    moreSection: "Sending",
    minimumRole: "admin",
  },
  {
    // No floor: the omnichannel reads sit behind a lone
    // RequireScope(ScopeReadCampaigns), which IS in readOnlyScopes, so the
    // session-role branch never runs — and the manifest agrees (viewer).
    // Pinned by omnichannel/rbac_test.go.
    key: "omnichannel",
    icon: "send",
    label: "Omnichannel",
    hint: "Cross-channel definitions and the paths they declare",
    route: "/(tabs)/omnichannel",
    routeFile: "app/(tabs)/omnichannel.tsx",
    moreSection: "Sending",
  },
];
