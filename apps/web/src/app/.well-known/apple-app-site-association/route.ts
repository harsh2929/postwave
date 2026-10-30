import { ENTITIES, CLI_DEVICE_APPROVE_PATH } from "@postwave/route-map";

export const dynamic = "force-dynamic";

/**
 * LIST-LEVEL destinations the mobile app resolves that are not `ENTITIES`.
 *
 * route-map's registry declares things that have an `<id>` and a detail screen
 * on every surface. Mobile ships forty screens that have neither, and
 * `routeForNavLink` (apps/mobile/src/lib/navDeepLinks.ts) resolves
 * `https://app.moosewave.com/app/<slug>` for all of them — a grammar that was
 * reachable only through the `moosewave://` scheme, because neither this file
 * nor the Android intent filter claimed a single one of those urls.
 *
 * THREE RULES DECIDED THIS LIST, and each one is why it is enumerated rather
 * than derived:
 *
 *  1. The mobile app must resolve `/app/<slug>` to a real screen. An AASA
 *     claim is a hijack; claiming a path the app cannot route is strictly
 *     worse than leaving it to Safari.
 *     (apps/mobile/src/lib/appLinkClaimParity.test.ts enforces this against
 *     the app's own route manifest — that guard, not this comment, is what
 *     keeps the list honest.)
 *  2. THIS app must serve a page there. A claim on a url the web dashboard
 *     does not render is dead weight: nobody can paste it.
 *  3. EXACT paths, never a prefix. These destinations have no detail route,
 *     and mobile's grammar REJECTS `/app/<slug>/<anything>` rather than
 *     truncating it — so a wildcard claim would hand iOS a url the app
 *     answers with "couldn't open that link".
 */
export const MOBILE_DESTINATION_LINK_PATHS = [
  "/app/agency",
  "/app/agent-routines",
  "/app/analytics",
  "/app/assets",
  "/app/audience-syncs",
  "/app/billing",
  "/app/compliance",
  "/app/deliverability",
  "/app/dmarc",
  "/app/notifications",
  "/app/omnichannel",
  "/app/referrals",
  "/app/reviews",
  "/app/settings",
  "/app/sms",
];

export const APP_LINK_PATHS = [
  "/auth",
  "/auth/magic",
  "/auth/reset",
  "/auth/oauth-return",
  "/magic-link",
  "/reset-password",
  // Device-authorization approval (QR / push "approve on a trusted device").
  // Exact path (no wildcard) — the shared route-map literal keeps this claim,
  // the mobile router, and the parser in lockstep.
  CLI_DEVICE_APPROVE_PATH,
  // Address verification. The email links here; without the claim iOS opens
  // Safari and the phone's Settings row keeps saying "Email verified: No".
  "/verify-email",
  // Entity paths — ONLY those the iOS app can actually open.
  //
  // An AASA claim is a HIJACK, not a hint: once the app is installed, iOS stops
  // opening Safari for a claimed path and hands it to the app instead. Claiming
  // a path the app cannot route turns a working web page into a dead end — the
  // app opens, `routeForEntityLink` resolves `mobilePath()` to null for an
  // entity with no mobile screen, and the user is left in an app that did
  // nothing while the page they wanted was one tap away in the browser.
  //
  // So the claim set is the registry filtered by `surfaces.mobile`, not the
  // whole registry. Affiliates and sequence templates are web-only today and
  // are deliberately left to Safari.
  //
  // TWO patterns per entity, not one. Apple's `*` matches any substring
  // INCLUDING the empty one, but the literal `/` before it still has to be
  // there: `/app/campaigns/*` claims `/app/campaigns/<id>` and does NOT claim
  // `/app/campaigns`. So the wildcard alone left every entity's LIST url —
  // the url a teammate actually pastes into Slack — unclaimed on iOS while
  // Android's `pathPrefix` claimed it, which is the two platforms disagreeing
  // about the sixteen paths they were supposed to share. Mobile routes the
  // bare list through `routeForNavLink` (apps/mobile/src/lib/navDeepLinks.ts),
  // so the exact claim lands on a real screen.
  ...Object.values(ENTITIES)
    .filter((entity) => entity.surfaces.mobile !== "none")
    .flatMap((entity) => [`/app/${entity.slug}`, `/app/${entity.slug}/*`]),
  ...MOBILE_DESTINATION_LINK_PATHS,
];

function json(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, {
    ...init,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600",
      ...(init.headers ?? {}),
    },
  });
}

export function GET() {
  const teamID = process.env.POSTWAVE_APPLE_TEAM_ID?.trim();
  const bundleID = process.env.POSTWAVE_IOS_BUNDLE_ID?.trim() || "com.moosewave.app";

  if (!teamID) {
    return json(
      {
        error: "POSTWAVE_APPLE_TEAM_ID is required to serve Apple universal links.",
      },
      { status: 503 },
    );
  }

  return json({
    applinks: {
      apps: [],
      details: [
        {
          appID: `${teamID}.${bundleID}`,
          paths: APP_LINK_PATHS,
          components: APP_LINK_PATHS.map((path) => ({ "/": path })),
        },
      ],
    },
    // Shared Web Credentials. iOS binds the app's saved-password domain from
    // THIS key, not from `applinks` — without it the app's
    // `webcredentials:app.moosewave.com` entitlement has no counterpart, so
    // AutoFill never offers (or saves) the workspace password and every
    // re-auth is typed by hand. Same appID, deliberately: one identity.
    webcredentials: {
      apps: [`${teamID}.${bundleID}`],
    },
  });
}
