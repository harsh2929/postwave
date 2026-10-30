/**
 * api/landingPages.ts — transport for hosted landing pages and their leads.
 *
 * Every route below was read off the chi mount in
 * `apps/api/internal/server/analytics_realtime_routes.go:66-74` and then
 * cross-checked against the handler it points at, not against openapi.json:
 *
 *   GET /api/v1/landing-pages             read:campaigns → []LandingPage (BARE ARRAY)
 *   GET /api/v1/landing-pages/{id}        read:campaigns → LandingPage
 *   GET /api/v1/landing-pages/{id}/leads  read:campaigns → {items:[Conversion]}
 *   GET /api/v1/landing-pages/{id}/leads.csv  read:campaigns → text/csv attachment
 *
 * THE GATE IS A SCOPE, NOT A ROLE — and that distinction decides the screen.
 * The four reads are mounted behind `apikeys.RequireScope(ScopeReadCampaigns)`.
 * On the session-cookie path `RequireScope` only escalates to an owner/admin
 * role check when a required scope is NOT in `readOnlyScopes`
 * (apikeys/middleware.go:342), and `read:campaigns` IS in that allowlist
 * (middleware.go:334). So every authenticated dashboard user — viewer included
 * — may read landing pages and their leads, and the mobile route needs no role
 * floor. The three WRITES (POST / PATCH / DELETE) are mounted behind
 * `ScopeAdmin`, which is not in the allowlist, so they are owner/admin only.
 *
 * THE WRITES (desktop-parity pass) — all three mounted behind `ScopeAdmin`
 * (analytics_realtime_routes.go:75-77 — owner/admin only on a session), all
 * ONLINE-ONLY (none is on the offline-queue allowlist; each changes what the
 * public internet is served):
 *   - PATCH  {status} — publish / unpublish / restore (lib/landingLifecycle
 *     carries the verb table read off desktop's statusAction);
 *   - POST   {slug, name} — desktop's exact create body; the block editor
 *     stays desk-side, this births the draft shell;
 *   - DELETE — a SOFT archive: `UPDATE … SET status='archived'`
 *     (landingpages.go:343-352). Leads survive; restore-to-draft exists.
 *
 * STILL NOT HERE, ON PURPOSE:
 *   - PATCHing `blocks` / `seo` / `tracking`: whole-JSON-document authoring,
 *     a block-editor job.
 *   - GET /{id}: `Repo.Get` selects the IDENTICAL column list as `Repo.List`
 *     (landingpages.go:125-130 vs 157-161), so a detail request would return
 *     exactly the row the list already handed the screen. It is exported here
 *     as `landingPagePath` for a future deep link, and deliberately not called.
 *   - /{id}/leads.csv: that route answers `Content-Disposition: attachment`.
 *     This app has no file-share sheet (no expo-sharing / expo-file-system
 *     dependency), so there is no honest way to complete a CSV export on the
 *     phone; the screen says so in words instead of offering a dead button.
 *
 * Parsing lives in lib/landingPages so it is unit-testable in the node vitest
 * environment; this module is only URLs and envelopes.
 */
import {
  parseLandingPage,
  parseLandingPageList,
  parseLeadList,
  type MobileLandingPage,
  type MobileLead,
} from "@/lib/landingPages";

import { checkedApiResult, rawRequest } from "./request";

export const LANDING_PAGES_PATH = "/api/v1/landing-pages";

export function landingPagePath(id: string): string {
  return `${LANDING_PAGES_PATH}/${encodeURIComponent(id)}`;
}

export function landingLeadsPath(id: string): string {
  return `${landingPagePath(id)}/leads`;
}

/**
 * The list. `Deps.List` writes the slice directly, so the body is a bare JSON
 * array and the SDK's `request()` hands it back verbatim — `parseLandingPageList`
 * is what absorbs that (and an `{items}` envelope, should the route ever be
 * normalised).
 */
export async function fetchLandingPages(): Promise<MobileLandingPage[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", LANDING_PAGES_PATH),
  );
  return parseLandingPageList(res.data);
}

/**
 * One page. Unused by the list screen (see the header) and kept for a deep
 * link that arrives without the list in cache.
 */
export async function fetchLandingPage(
  id: string,
): Promise<MobileLandingPage | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", landingPagePath(id)),
  );
  return parseLandingPage(res.data);
}

/**
 * The leads captured by one page: `growth_surface_events` rows with
 * `event_type = 'conversion'`, newest first, capped at 5000 with no cursor
 * (`Repo.ListConversions`). An unknown id is NOT a 404 here — the repo simply
 * matches no rows — so an empty list means "no conversions recorded", which is
 * exactly what the screen renders it as.
 */
export async function fetchLandingLeads(id: string): Promise<MobileLead[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", landingLeadsPath(id)),
  );
  return parseLeadList(res.data);
}

/** PATCH {status} — the publish/unpublish/restore verb. ADMIN, online-only. */
export async function updateLandingPageStatus(
  id: string,
  status: "draft" | "published",
): Promise<MobileLandingPage | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("PATCH", landingPagePath(id), { status }),
  );
  return parseLandingPage(res.data);
}

/** POST {slug, name} — desktop's exact create body. Pages are born drafts. */
export async function createLandingPage(input: {
  name: string;
  slug: string;
}): Promise<MobileLandingPage | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("POST", LANDING_PAGES_PATH, {
      name: input.name.trim(),
      slug: input.slug.trim(),
    }),
  );
  return parseLandingPage(res.data);
}

/** DELETE — the SOFT archive (status='archived'; leads kept, restorable). */
export async function archiveLandingPage(id: string): Promise<void> {
  await checkedApiResult(
    rawRequest<{ ok?: boolean }>("DELETE", landingPagePath(id)),
  );
}
