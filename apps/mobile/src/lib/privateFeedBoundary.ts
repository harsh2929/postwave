/**
 * lib/privateFeedBoundary.ts — WHY the phone mints, rotates and revokes no
 * private podcast feed token, said in the platform's own words.
 *
 * THE ROUTES ARE LIVE. This is not a 503 and not a missing handler.
 * `apps/api/internal/podcast/podcast.go` MountAdminRoutes registers all three
 * token verbs unconditionally, and `routeauth/manifest.json` mounts them —
 * GET at `viewer`, POST and DELETE at `admin`. A request would work.
 *
 * THE HOLD IS THE PRODUCT'S OWN, AND IT IS CROSS-PLATFORM. Desktop built the
 * whole card (`components/archive/PodcastTokensCard.tsx`) and then refused to
 * render it: `ARCHIVE_PRIVATE_PODCAST_AVAILABLE = false`
 * (desktop/src/lib/archive-operational-availability.ts) routes the Private
 * feeds workspace to a review-gate panel instead. Shipping the same verbs on a
 * phone would not be parity with desktop — it would be mobile stepping over a
 * release qualification desktop is still waiting on, on the one surface where
 * the artefact is a long-lived bearer credential.
 *
 * THE FIRST CHECKLIST ITEM IS THE REASON THIS MATTERS. "Issued tokens must
 * never be recoverable after reveal" is not yet true of the server:
 * `AdminGetToken` returns the plaintext `token` and `feed_url` on every read
 * (podcast.go — "we surface it on read too; operators reconstruct lost URLs
 * via the GET"). Desktop's own card carries a comment claiming the opposite.
 * Until that is settled, a mobile screen that showed a feed token would be
 * putting a recoverable credential on a lock screen.
 *
 * WHAT THIS FILE DOES INSTEAD. It states the hold where an operator looking
 * for the control will actually look, in the same sentence desktop uses, so
 * the answer is "held, and here is why" rather than a missing control. It
 * imports nothing: the copy and the withhold rule are unit-tested in node, and
 * the component only renders what comes out of here.
 *
 * WHEN THE GATE OPENS. `privateFeedBoundary.test.ts` reads the desktop
 * constant and fails if this mirror disagrees, and fails again on the day the
 * flag flips — at which point mobile must either wire the verbs or write a new
 * and true reason. Neither can happen silently.
 */

/**
 * Mirrors `ARCHIVE_PRIVATE_PODCAST_AVAILABLE` in
 * apps/desktop/src/lib/archive-operational-availability.ts. The boundary test
 * reads that file and fails the build if the two disagree.
 */
export const PRIVATE_PODCAST_FEEDS_AVAILABLE = false;

/**
 * `ARCHIVE_PRIVATE_PODCAST_UNAVAILABLE_REASON`, verbatim. Rendered as-is —
 * paraphrasing a release boundary is how one platform ends up promising
 * something another platform is still holding.
 */
export const PRIVATE_PODCAST_UNAVAILABLE_REASON =
  "Private feeds are review-gated while one-time secret storage, tenant-scoped resolution, entitlement, media access, and revocation are release-qualified.";

/** Desktop's review-gate heading for this boundary, verbatim. */
export const PRIVATE_PODCAST_GATE_TITLE = "Private feed access is held back.";

/**
 * The three conditions desktop's `ReviewGatePanel` lists for this boundary,
 * verbatim (ArchivePageContent.tsx). The second one is why even revoke — the
 * on-the-go half — is not wired here: revocation is named in the hold.
 */
export const PRIVATE_PODCAST_RELEASE_CHECKLIST: readonly string[] =
  Object.freeze([
    "Issued tokens must never be recoverable after reveal.",
    "Revocation and expiry need complete audit evidence.",
    "Feed URLs must be protected from logs and referrers.",
  ]);

/** Desktop's closing assurance for this panel, verbatim. */
export const PRIVATE_PODCAST_NO_CHANGE_NOTE =
  "No reader content or credentials are changed from this workspace while the review gate is active.";

/**
 * The mobile-specific half: exactly which verbs are withheld, and the one fact
 * an operator most needs — that this is not a phone limitation.
 */
export const PRIVATE_PODCAST_MOBILE_NOTE =
  "No control on this phone mints, rotates, or revokes a subscriber feed token, and none reveals one. The same hold is in force on desktop.";

/**
 * The token routes this boundary covers, as `routeauth/manifest.json` mounts
 * them. Listed so the boundary test can prove the hold is a PRODUCT decision
 * and not a broken route — if one of these ever disappears, the reason above
 * stops being the true reason and this file has to say something else.
 */
export const PRIVATE_PODCAST_TOKEN_ROUTES: readonly {
  method: string;
  path: string;
  minimumRole: string;
}[] = Object.freeze([
  {
    method: "GET",
    path: "/api/v1/podcast/subscribers/{email}/token",
    minimumRole: "viewer",
  },
  {
    method: "POST",
    path: "/api/v1/podcast/subscribers/{email}/token",
    minimumRole: "admin",
  },
  {
    method: "DELETE",
    path: "/api/v1/podcast/subscribers/{email}/token",
    minimumRole: "admin",
  },
]);

/**
 * Whether the archive screen should offer the private-feed disclosure.
 *
 * WITHHELD BELOW ADMIN, deliberately. The two verbs a reader would come here
 * for (rotate, revoke) are `admin` in the manifest, so telling a viewer that a
 * control they could never press is held back is noise about someone else's
 * capability. Their honest answer is the absence of the row.
 *
 * WITHHELD WHEN THE GATE OPENS, equally deliberately. On that day the copy in
 * this file becomes false, and a disclosure that quietly kept rendering would
 * be the worst of the three outcomes. The boundary test goes red first.
 */
export function privateFeedGateVisible(input: { canAdmin: boolean }): boolean {
  return input.canAdmin && !PRIVATE_PODCAST_FEEDS_AVAILABLE;
}
