/**
 * lib/deepLinks.ts — the URL grammars that can open this app.
 *
 * Three of them live here: auth links (magic / reset / verify / oauth-return),
 * entity + destination links (`moosewave://campaign/<id>`,
 * `https://app.moosewave.com/app/audit`), and the CLI device-approval link. The
 * fourth — where a tapped PUSH NOTIFICATION lands — moved to
 * `lib/notificationRoutes.ts`, which has to track the shared
 * @postwave/notifications manifest and was competing for space in this file
 * with URL parsing it has nothing to do with. It is re-exported below because
 * `routeForNotification` is imported from `@/lib/deepLinks` across the app and
 * the split is an implementation detail, not a migration.
 *
 * Defensive parsing throughout: malformed input (a mail client re-encoding a
 * URL, a server-side bug, a mid-flight schema change) MUST NOT crash the app.
 * Every parser returns null and the caller falls through to its default.
 */
import type { Href } from "expo-router";
import {
  mobilePath,
  parseDeepLink,
  parseDeviceApproveLink,
  parseUniversalLink,
} from "@postwave/route-map";

import {
  authLinkRouteParams,
  parseAuthLinkProof,
  type AuthLinkFlow,
} from "./authLinkContract";
import { PUBLIC_APP_BASE_URL } from "./config";
import { routeForNavLink } from "./navDeepLinks";
import { utf8ByteLength } from "./utf8";

export { routeForNotification } from "./notificationRoutes";

const MAX_AUTH_DEEP_LINK_URL_BYTES = 8 * 1024;
/** `IssueToken` mints a compact opaque token; anything longer is not ours. */
const MAX_VERIFY_EMAIL_TOKEN_CHARS = 512;

/**
 * routeForAuthLink translates an auth deep link into the in-app route.
 *
 * Recognised URLs:
 *
 *   - `moosewave://auth/magic?<signed-v1-envelope>` → magic return
 *   - `https://app.moosewave.com/magic-link?<signed-v1-envelope>` → same
 *   - `https://app.moosewave.com/auth?<signed-v1-envelope>` → flow-selected return
 *   - `moosewave://auth/reset?<signed-v1-envelope>` → reset confirmation
 *   - `https://app.moosewave.com/reset-password?<signed-v1-envelope>` → same
 *   - `moosewave://auth/oauth-return?…` → /(auth)/sign-in
 *   - `https://app.moosewave.com/verify-email?token=…` → verification
 *   - `moosewave://auth/verify?token=…` → same
 *
 * Anything else returns null so the caller falls through to its
 * default behaviour. We never throw — malformed URLs are common in
 * the wild (mail clients re-encode them).
 */
export function routeForAuthLink(rawUrl: string): Href | null {
  if (!rawUrl) return null;
  if (utf8ByteLength(rawUrl) > MAX_AUTH_DEEP_LINK_URL_BYTES) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password || parsed.hash) return null;
  if (parsed.protocol === "postwave:") {
    if (parsed.hostname.toLowerCase() !== "auth" || parsed.port) return null;
  } else if (
    parsed.protocol !== "https:" ||
    !isTrustedUniversalLinkHost(parsed.hostname)
  ) {
    return null;
  }
  const pathKind = authPathKind(parsed);
  if (pathKind === "oauth-return") {
    // NOT the callback the Google flow uses. sanitizeOAuthRedirect
    // (auth/oauth_handlers.go:512-552) admits exactly `moosewave://auth/magic`,
    // and bounceBack mints a mobile-audience magic envelope for it — which is
    // what hooks/useGoogleSignIn requests and the `magic` branch below
    // consumes. A link on THIS path carries no envelope this device holds
    // state for, so it lands on the sign-in choices instead of a consumer.
    return "/(auth)/sign-in";
  }
  if (pathKind === "verify") {
    // Address verification carries a BARE token, not the signed v1 envelope
    // the magic/reset flows use — `sendVerification` builds the link with
    // buildAuthPublicLink(publicBaseURL, "/verify-email", plain). So there is
    // no proof to parse; the screen posts the token and the server is the only
    // authority on whether it is valid.
    const token = parsed.searchParams.get("token") ?? "";
    if (!token || token.length > MAX_VERIFY_EMAIL_TOKEN_CHARS) return null;
    return {
      pathname: "/(auth)/verify-email",
      params: { token },
    } as unknown as Href;
  }
  if (!pathKind) return null;

  // Bare /auth delegates flow selection to the signed v1 envelope; named
  // paths additionally require the signed flow to match the path.
  const proof = parseAuthLinkProof(
    parsed.searchParams,
    pathKind === "contract" ? undefined : pathKind,
  );
  if (!proof) return null;
  const params = {
    ...authLinkRouteParams(proof),
    ...(proof.audience === "web" ? { browser_fallback: "1" } : {}),
  };
  return proof.flow === "magic"
    ? { pathname: "/(auth)/magic-return", params }
    : ({
        pathname: "/(auth)/reset-confirm",
        params,
      } as unknown as Href);
}

/**
 * routeForEntityLink translates an entity deep link
 * (`moosewave://campaign/<id>`, `moosewave://subscriber/<id>`,
 * `moosewave://sequence/<id>`, …) or universal link
 * (`https://app.moosewave.com/app/campaigns/<id>`, …) into the matching
 * in-app route.
 *
 * Parsing + the entity→route mapping live in @postwave/route-map (the
 * single source of truth shared with web/desktop) — we do NOT re-implement
 * link parsing here. parseDeepLink / parseUniversalLink return null for
 * anything that isn't a recognised entity link (including auth links like
 * `moosewave://auth/magic?<signed-v1-envelope>`), so this is safe as a fallback
 * after routeForAuthLink without stealing auth links.
 *
 * When route-map declines, a SECOND grammar runs: mobile destination links
 * (`moosewave://dmarc`, `https://app.moosewave.com/app/audit`), resolved against
 * the mobile route manifest in lib/navDeepLinks. route-map's ENTITIES declares
 * four things, all of which imply an `<id>` and a detail screen on every
 * surface; mobile ships 40 screens that have neither, and links naming them
 * used to resolve to nothing at all.
 *
 * Returns null when the URL is neither, so the caller falls through to its
 * default behaviour.
 */
export function routeForEntityLink(rawUrl: string): Href | null {
  if (!rawUrl) return null;
  if (utf8ByteLength(rawUrl) > MAX_AUTH_DEEP_LINK_URL_BYTES) return null;
  const ref = parseDeepLink(rawUrl) ?? parseUniversalLink(rawUrl);
  if (!ref) {
    // Not one of route-map's four ENTITIES — but mobile ships 40 more screens,
    // and `moosewave://dmarc` / `https://app.moosewave.com/app/audit` are exactly
    // the links a teammate pastes. Resolved against the mobile route manifest
    // (lib/navDeepLinks), so a link can only ever name a screen that exists.
    // Runs LAST so it can never steal an entity or auth link.
    const navRoute = routeForNavLink(rawUrl);
    return navRoute ? (navRoute as unknown as Href) : null;
  }
  const path = mobilePath(ref.entity, ref.id);
  if (!path) return null;
  // Detail screens are `/(tabs)/<slug>/<id>`; entities without a detail
  // screen resolve to the list route `/(tabs)/<slug>`. Build the typed Href
  // accordingly so back-navigation lands on a real screen.
  if (path.endsWith(`/${ref.id}`)) {
    const pathname = path.slice(0, -(ref.id.length + 1)) + "/[id]";
    return { pathname, params: { id: ref.id } } as unknown as Href;
  }
  return path as unknown as Href;
}

/**
 * routeForDeviceApproveLink translates the CLI device-grant approval universal
 * link (`https://app.moosewave.com/cli/auth?user_code=XXXX-XXXX` — the QR that
 * `postwave login --device` renders) into the in-app approval screen.
 *
 * Host/path/code validation + normalisation live in @postwave/route-map (the
 * SAME parser the web AASA claim and the QR-scan path use), so the device-
 * approve link grammar can't drift across surfaces. Returns null for anything
 * that isn't a well-formed approval link, so the caller falls through.
 *
 * NOTE: this is intentionally routed with entity-link (navigate-if-authed /
 * defer-until-signed-in) semantics, NOT auth-link "route regardless" — you
 * approve a NEW device from one you are ALREADY signed in on, so a logged-out
 * approval link must wait for sign-in rather than hit the approve screen (whose
 * `approveDevice` call needs a session) and fail.
 */
export function routeForDeviceApproveLink(rawUrl: string): Href | null {
  if (!rawUrl) return null;
  if (utf8ByteLength(rawUrl) > MAX_AUTH_DEEP_LINK_URL_BYTES) return null;
  const ref = parseDeviceApproveLink(rawUrl, [
    new URL(PUBLIC_APP_BASE_URL).host,
  ]);
  if (!ref) return null;
  return {
    pathname: "/(tabs)/cli-approve",
    params: { user_code: ref.userCode },
  } as unknown as Href;
}

/**
 * planDeepLinkNavigation decides what the root layout should do with an
 * incoming deep link given the current auth state. Three outcomes:
 *
 *   - `navigate`: route there now. Auth links (magic-link / reset /
 *     oauth-return) ALWAYS take this path — they are how the user
 *     authenticates, so they must never wait on auth. Entity links also
 *     take this path once the user is authenticated.
 *
 *   - `defer`: an entity link (moosewave://campaign/<id>, …) arrived while
 *     the user is logged OUT. Pushing it now would bounce off the auth gate
 *     to sign-in and silently lose the target. Instead the caller remembers
 *     the target and navigates to it AFTER a successful sign-in.
 *
 *   - `ignore`: the URL is neither a recognised auth link nor entity link
 *     (or is empty); the caller does nothing and the default screen shows.
 *
 * Pulling the gating into a pure function keeps the "defer entity links
 * until authed" rule unit-testable without rendering the layout.
 */
export type DeepLinkPlan =
  | { kind: "navigate"; target: Href }
  | { kind: "defer"; target: Href }
  | { kind: "ignore" };

export function planDeepLinkNavigation(
  rawUrl: string | null | undefined,
  opts: { isAuthed: boolean },
): DeepLinkPlan {
  if (!rawUrl) return { kind: "ignore" };
  // Auth links take priority and route immediately regardless of auth —
  // they ARE the sign-in flow. parseDeepLink (inside routeForEntityLink)
  // rejects auth links, so the two branches never collide.
  const authTarget = routeForAuthLink(rawUrl);
  if (authTarget) return { kind: "navigate", target: authTarget };
  // Device-approval links (/cli/auth) require a session, so they follow the
  // same navigate-if-authed / defer-until-signed-in rule as entity links —
  // never the auth-link "route regardless" rule. The /cli/auth path is
  // disjoint from both auth (/auth*, /magic-link, …) and entity
  // (/app/<slug>/<id>) paths, so ordering here can't steal another link type.
  const deviceApproveTarget = routeForDeviceApproveLink(rawUrl);
  if (deviceApproveTarget) {
    return opts.isAuthed
      ? { kind: "navigate", target: deviceApproveTarget }
      : { kind: "defer", target: deviceApproveTarget };
  }
  const entityTarget = routeForEntityLink(rawUrl);
  if (!entityTarget) return { kind: "ignore" };
  // Entity link for a logged-out user: remember it, route after auth.
  return opts.isAuthed
    ? { kind: "navigate", target: entityTarget }
    : { kind: "defer", target: entityTarget };
}

function isTrustedUniversalLinkHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "app.moosewave.com" ||
    h === "moosewave.com" ||
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "[::1]"
  );
}

function authPathKind(
  parsed: URL,
): AuthLinkFlow | "contract" | "oauth-return" | "verify" | null {
  // Exact paths only: association files intentionally avoid auth wildcards,
  // and the in-app parser must not widen that boundary with slash folding.
  const path = parsed.pathname || "/";
  if (parsed.protocol === "postwave:") {
    if (path === "/magic") return "magic";
    if (path === "/reset") return "reset";
    if (path === "/oauth-return") return "oauth-return";
    if (path === "/verify") return "verify";
    if (path === "/") return "contract";
    return null;
  }
  if (path === "/magic-link" || path === "/auth/magic") return "magic";
  if (path === "/reset-password" || path === "/auth/reset") return "reset";
  if (path === "/auth/oauth-return") return "oauth-return";
  // Must stay byte-identical to the AASA claim in
  // apps/web/src/app/.well-known/apple-app-site-association/route.ts and to
  // the Android intentFilter in app.json — a path iOS hands over but this
  // parser rejects is a link that opens the app and then does nothing.
  if (path === "/verify-email") return "verify";
  if (path === "/auth") return "contract";
  return null;
}
