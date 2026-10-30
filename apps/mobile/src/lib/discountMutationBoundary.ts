/**
 * Discount route boundary (COMMERCE#11 / MAP#24).
 *
 * WHAT THE SERVER MOUNTS TODAY
 * ----------------------------
 * `MountRoutes` (apps/api/internal/discounts/handlers.go) registers two reads
 * and nothing else. The discount surface is a sanitized, read-only historical
 * ARCHIVE:
 *
 *   GET /api/v1/discounts                            → the archive page
 *   GET /api/v1/discounts/{record_id}/redemptions    → its PII-free timeline
 *
 * Withheld: the live redeemability probe, the additive PATCH, the redemptions
 * CSV, the DELETE kill switch, coupon-pool inventory and coupon issuance. The
 * four constants below say so, and the guard test parses the Go source in BOTH
 * directions — a route that arrives fails the build until someone builds for
 * it, and a route that leaves takes its affordance with it.
 *
 * THE A1 RELEASE WAS REVERSED, AND THE REVERSAL IS THE CORRECT STATE
 * -----------------------------------------------------------------
 * On 2026-08-18 commit dec6c5786 ("open the discount mutation boundary (A1)")
 * mounted four more routes precisely BECAUSE mobile already carried four
 * capability flags. That was the tail wagging the dog, and it shipped a kill
 * switch that could never kill anything. Two facts settle it:
 *
 *  1. NO PROVIDER BRIDGE IS COMPOSED. `apps/api/main.go` builds
 *     `&discounts.Deps{Repo: discountsRepo}` with no `Bridge`, and
 *     `Repo.Delete` returns `ErrStripeBridgeUnavailable` the moment the bridge
 *     is nil (apps/api/internal/discounts/repo.go). A mounted DELETE in this
 *     deployment is a destructive control that answers "unavailable" to every
 *     caller — worse than an absent one, because it looks like a transient
 *     failure.
 *  2. THE ARCHIVE HAS NO REDEEMABLE CODE TO ADDRESS. `Repo.ListHistoricalRecords`
 *     does not select `code` at all, and `historicalDiscountRecord` serializes
 *     an opaque `id` plus a server-authored `label`. Every withheld route is
 *     `{code}`-addressed, so even remounting them would leave a client with no
 *     identifier to put in the path.
 *
 * Desktop (`apps/desktop/src/lib/api/monetization.ts`), web
 * (`apps/web/src/lib/discounts-api.ts`) and the TypeScript SDK
 * (`packages/sdk-ts/src/resources/discounts.ts`) have all been migrated to the
 * two-route archive. Mobile is the last client on the old shape, so this file
 * follows the server rather than asking the server to follow it.
 *
 * HOW THE CLIENT DEGRADES
 * -----------------------
 * Affordances backed by an unmounted route are OMITTED, not disabled — a
 * disabled button on a phone is a promise you cannot keep. But omission alone
 * is silence, and silence about a safety capability reads as "there is nothing
 * to say". So the two capabilities an operator will actively go looking for
 * carry an explicit notice instead: the live probe
 * (`DISCOUNT_LIVE_CHECK_UNAVAILABLE_NOTICE`) and the kill switch
 * (`DISCOUNT_KILL_SWITCH_UNAVAILABLE_NOTICE`).
 *
 * The constants are deliberately compile-time, mirroring the way the API states
 * its own boundaries (apps/api/internal/referrals/referrals.go
 * `OperationalRuntimeAvailable`, apps/api/internal/affiliates/availability.go),
 * and the way mobile already mirrors them (lib/sequenceCapabilities.ts).
 */

/**
 * GET /api/v1/discounts/{code}/check — the server-side `CheckRedeemable`
 * probe. NOT MOUNTED: the handler is retained as scaffolding, and the archive
 * exposes no code to probe with.
 */
export const DISCOUNT_LIVE_CHECK_MOUNTED = false;

/**
 * PATCH /api/v1/discounts/{code} — the additive-only "extend the expiry / raise
 * the cap" edit. NOT MOUNTED. The archive is read-only; the Go boundary test
 * fails if any non-GET route appears.
 */
export const DISCOUNT_PATCH_MOUNTED = false;

/**
 * GET /api/v1/discounts/{code}/redemptions.csv — the whole-set export.
 * NOT MOUNTED. The mounted timeline is the bounded, PII-free projection; a CSV
 * of subscriber emails is the thing that projection exists to withhold.
 */
export const DISCOUNT_REDEMPTIONS_CSV_MOUNTED = false;

/**
 * DELETE /api/v1/discounts/{code} — the kill switch the audit asked for.
 * NOT MOUNTED, and it could not work if it were: this deployment composes
 * `discounts.Deps` without a `StripeBridge`, so `Repo.Delete` fails closed with
 * `ErrStripeBridgeUnavailable` before it touches a row.
 */
export const DISCOUNT_DELETE_MOUNTED = false;

/**
 * The routes `MountRoutes` actually registers, in registration order. The
 * guard test compares this list against the Go source verbatim.
 */
export const MOUNTED_DISCOUNT_ROUTES: readonly string[] = Object.freeze([
  "GET /api/v1/discounts",
  "GET /api/v1/discounts/{record_id}/redemptions",
]);

/**
 * True when SOME server route could take a leaked code out of circulation —
 * either DELETE, or a PATCH that can pull the expiry in. Neither is mounted, so
 * this is false. PATCH would not have sufficed even mounted: it is additive-only
 * by server rule (the cap cannot go below `times_redeemed`, the expiry cannot
 * move earlier), which is why this asks about DELETE specifically. Stated as a
 * function so the screen asks a question rather than reading a flag whose name
 * implies less.
 */
export function discountKillSwitchAvailable(): boolean {
  return DISCOUNT_DELETE_MOUNTED;
}

/**
 * What the drawer says in place of the live redeemability verdict.
 *
 * ABSENCE IS NOT ZERO: silence here would let the derived pill above read as a
 * server-confirmed verdict. The sentence names the fallback explicitly so a
 * support conversation ("the customer says it doesn't work") is not settled by
 * a twelve-hour-old offline snapshot without the reader knowing that is what
 * they are looking at.
 */
export const DISCOUNT_LIVE_CHECK_UNAVAILABLE_NOTICE = Object.freeze({
  headline: "No live re-check on this deployment",
  detail:
    "The status above is derived from the code list, which can be up to a refresh old. This workspace does not expose the server-side redeemability probe.",
  spoken:
    "The live redeemability check is not available on this deployment. The status shown is derived from the code list and may be out of date.",
});

/**
 * What the drawer says where the "Delete code" button would be.
 *
 * COMMERCE#11 and MAP#24 both asked for one thing: "this code is on Reddit,
 * disable it from my phone at 2am". The answer today is no, and an operator who
 * came to this screen for that reason has to be TOLD no — an empty row of
 * buttons would let them conclude they had missed a tap, or worse, that they
 * had already stopped it.
 *
 * It names where the capability actually lives, because no Moosewave surface has
 * it: the route is unmounted for every client, and the server could not honour
 * it anyway without a provider bridge. Withdrawing the coupon in the payment
 * provider is the only thing that stops a circulating code right now.
 */
export const DISCOUNT_KILL_SWITCH_UNAVAILABLE_NOTICE = Object.freeze({
  headline: "This code cannot be withdrawn from Moosewave",
  detail:
    "Deleting a discount is not available on this deployment — no Moosewave surface exposes it, and the server has no payment-provider connection to withdraw the coupon with. To stop a leaked code now, delete the coupon in Stripe.",
  spoken:
    "This code cannot be withdrawn from Moosewave. Deleting a discount is not available on this deployment. To stop a leaked code now, delete the coupon in Stripe.",
});

/**
 * The identity half of the boundary, and the half a flag cannot express.
 *
 * The one detail route that IS mounted moved from `{code}` to `{record_id}`
 * and now demands a canonical UUID: `canonicalArchiveUUID` rejects anything
 * else with a 400, and `TestListRedemptionsRejectsRedeemableCodePathValue`
 * pins that a redeemable code in that slot is refused rather than looked up.
 *
 * That matters on mobile specifically. The catalogue is VAULT-BACKED: a cold
 * offline launch replays whatever a PREVIOUS build of the app wrote to
 * SecureStore, and older builds stored rows carrying `code`. Feeding one of
 * those into the path is a guaranteed 400 that reads to the operator as "the
 * server is broken". Canonicalising here turns it into a question the caller
 * can answer honestly before a request is ever made.
 *
 * Mirrors `canonicalRecordId` in packages/sdk-ts/src/resources/discounts.ts and
 * `canonicalDiscountRecordId` in apps/web/src/lib/discounts-api.ts.
 */
const DISCOUNT_ARCHIVE_RECORD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The canonical, lowercase archive record ID, or null when `value` is not one.
 *
 * Null is the honest answer for a redeemable code, an empty string, or a
 * snapshot row from an older build — never a value the caller can put in a
 * `{record_id}` slot and hope.
 */
export function discountArchiveRecordId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!DISCOUNT_ARCHIVE_RECORD_ID.test(value)) return null;
  return value.toLowerCase();
}
