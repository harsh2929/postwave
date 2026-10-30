/**
 * lib/oauthStart.ts — the mobile half of the Google sign-in round-trip,
 * expressed as pure string grammar so it can be unit-tested in the node
 * vitest environment (no react-native / expo imports anywhere in this file).
 *
 * THE ROUND-TRIP, traced against the Go handlers rather than a doc:
 *
 *   1. The app mints a device-bound state nonce (lib/authLinkState) and opens
 *        GET {api}/api/v1/auth/oauth/google/start
 *            ?redirect_to=moosewave://auth/magic?state=<nonce>
 *      in an OS auth session. `sanitizeOAuthRedirect`
 *      (apps/api/internal/auth/oauth_handlers.go:512-552) accepts EXACTLY this
 *      shape: scheme `postwave`, host `auth`, path `/magic`, and a single
 *      `state` query parameter. Anything else is dropped to "" and the user is
 *      bounced to the web app instead of back to the phone — which is why the
 *      builder below is deliberately rigid.
 *
 *   2. Google returns to the server's own callback. `Callback` triages
 *      (oauth_handlers.go:256+): an IdP identity already linked to a Moosewave
 *      user issues a session and calls `bounceBack`, which — for our
 *      `moosewave://auth/magic` redirect — mints a one-time `magic_link` token
 *      and signs it with `authLinkBinding{Version:1, Flow:magic,
 *      Audience:mobile, State:<nonce>}` (oauth_handlers.go:556-604).
 *
 *   3. The OS hands `moosewave://auth/magic?token=…&v=1&flow=magic&aud=mobile
 *      &state=…&sig=…` back to the app, which parses it HERE and forwards the
 *      envelope to /(auth)/magic-return. That screen resolves the device state
 *      first (so no URL field can select an API origin) and POSTs
 *      /api/v1/auth/magic-link/consume, which is what actually gives the app
 *      its own session cookie — the browser's cookie is never the app's.
 *
 * NOT EVERY GOOGLE ACCOUNT CAN FINISH THIS. `Callback` only reaches step 2 for
 * an identity that is already linked (auth_idp_links). A verified Google email
 * that merely MATCHES a local account returns 409 `identity_link_required`
 * (oauth_handlers.go:369-374) and an unknown identity is bounced to the web
 * signup page — both of which terminate in the browser, not in the app. The
 * caller must therefore treat "the auth session closed without a callback" as
 * an ordinary outcome and say so in plain words, never as a crash.
 */
import {
  authLinkRouteParams,
  parseAuthLinkProof,
  safeAuthLinkState,
} from "./authLinkContract";

/** Google is the only provider the server enables (oauth_handlers.go:174). */
export type MobileOAuthProvider = "google";

/**
 * The one redirect target `sanitizeOAuthRedirect` admits. Also the value we
 * hand to the OS auth session so it knows which URL closes the browser.
 */
export const OAUTH_RETURN_URL = "moosewave://auth/magic";

/** A pathological URL must never reach `new URL` parsing or the browser. */
const MAX_OAUTH_URL_CHARS = 4096;

export interface OAuthStartInput {
  /** An ALREADY-VALIDATED origin (validateApiBaseUrl). Never a raw field. */
  baseUrl: string;
  provider: MobileOAuthProvider;
  /** Device-bound nonce from createPendingOAuthLinkState. */
  state: string;
}

/**
 * Builds the /start URL. Throws rather than returning a half-formed URL: every
 * caller is about to open a browser with it, and a silently-wrong redirect_to
 * strands the user on the web app with a session the phone cannot see.
 */
export function buildOAuthStartUrl(input: OAuthStartInput): string {
  if (input.provider !== "google") {
    throw new Error("Unsupported OAuth provider.");
  }
  const state = safeAuthLinkState(input.state);
  if (!state) throw new Error("OAuth state is invalid.");
  const origin = oauthOrigin(input.baseUrl);
  const url = new URL(
    `${origin}/api/v1/auth/oauth/${input.provider}/start`,
  );
  url.searchParams.set(
    "redirect_to",
    `${OAUTH_RETURN_URL}?state=${encodeURIComponent(state)}`,
  );
  const built = url.toString();
  if (built.length > MAX_OAUTH_URL_CHARS) {
    throw new Error("OAuth start URL is too long.");
  }
  return built;
}

/**
 * True when `candidate` is the callback we asked the OS to watch for. Used to
 * tell "the IdP came back" from "the user closed the sheet".
 */
export function isOAuthReturnUrl(candidate: string): boolean {
  return parseOAuthReturn(candidate) !== null;
}

/**
 * Translates the returned deep link into the route params /(auth)/magic-return
 * expects. Returns null for anything that is not a well-formed, mobile-audience
 * magic envelope on the exact `moosewave://auth/magic` path — an unsigned or
 * web-audience link must not be forwarded to a consumer that would spend the
 * device's one-time state on it.
 */
export function oauthReturnRouteParams(
  rawUrl: string,
): Record<string, string> | null {
  const parsed = parseOAuthReturn(rawUrl);
  if (!parsed) return null;
  const proof = parseAuthLinkProof(parsed.searchParams, "magic");
  if (!proof || proof.audience !== "mobile") return null;
  return authLinkRouteParams(proof);
}

function parseOAuthReturn(rawUrl: string): URL | null {
  if (typeof rawUrl !== "string" || !rawUrl || rawUrl.length > MAX_OAUTH_URL_CHARS) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "postwave:") return null;
  if (parsed.hostname.toLowerCase() !== "auth" || parsed.port) return null;
  if (parsed.username || parsed.password || parsed.hash) return null;
  if (parsed.pathname.replace(/\/+$/u, "") !== "/magic") return null;
  return parsed;
}

/**
 * The API origin, re-derived defensively. `validateApiBaseUrl` already ran at
 * the call site; this exists so a future caller cannot pass a path-carrying or
 * credential-carrying string straight into a browser open.
 */
function oauthOrigin(baseUrl: string): string {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/u, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("API URL is invalid.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("API URL is invalid.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("API URL is invalid.");
  }
  return trimmed;
}
