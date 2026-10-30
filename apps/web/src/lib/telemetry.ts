// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Moosewave web telemetry — opt-in PostHog wrapper.
 *
 * Wiring is dormant until the operator sets `NEXT_PUBLIC_POSTHOG_KEY`
 * AND the cookie banner / Settings opt-in flag is satisfied. The
 * module is safe to import from server components (the actual
 * PostHog client only loads in the browser).
 *
 * --- PII discipline (HARD RULE) ---
 *
 * The following data must NEVER appear in event properties or user
 * traits:
 *   - subscriber email addresses, names, or any list-member PII
 *   - email body content (HTML, MJML, rendered text)
 *   - subject lines
 *   - free-form user-typed strings (campaign names, etc.)
 *   - error messages from the server
 *   - API keys, session tokens, OAuth tokens, signed URLs
 *
 * Allowed (structural):
 *   - event names + status enums
 *   - counts, durations, error codes
 *   - opaque IDs (tenant_id, campaign_id)
 *
 * The cookie-banner component (src/components/marketing/cookie-banner)
 * also calls `posthog.opt_in_capturing()` / `opt_out_capturing()`
 * directly via `window.posthog`, so EU consent flows continue to
 * work.
 */

import {
  type ConsentState,
  redactPath,
  shouldCapture,
  TELEMETRY_CONSENT_DEFAULT,
} from "@postwave/telemetry";

import {
  CONSENT_STORAGE_KEY,
  parseConsentRecord,
} from "@/lib/cookie-consent-record";

interface PostHogClient {
  init(key: string, options: PostHogInitOptions): void;
  capture(event: string, properties?: Record<string, unknown>): void;
  identify(distinctId: string, properties?: Record<string, unknown>): void;
  reset(): void;
  opt_in_capturing(): void;
  // posthog-js keeps its persistence store on opt-out unless told otherwise
  // (`opt_out_persistence_by_default` defaults to false). Withdrawal has to
  // remove what the grant stored, so the option is part of the contract here.
  opt_out_capturing(options?: { clear_persistence?: boolean }): void;
  has_opted_out_capturing(): boolean;
}

interface PostHogInitOptions {
  api_host: string;
  autocapture?: boolean;
  capture_pageview?: boolean;
  capture_exceptions?: boolean;
  disable_session_recording?: boolean;
  disable_surveys?: boolean;
  disable_surveys_automatic_display?: boolean;
  disable_external_dependency_loading?: boolean;
  respect_dnt?: boolean;
  persistence?: "localStorage+cookie" | "localStorage" | "cookie" | "memory";
  before_send?: (event: unknown) => unknown | null;
}

const LS_OPTOUT = "postwave.telemetry.optout.v1";
// Shared with the cookie banner: both read this same entry, and the byte cap
// and expiry must not be re-derived independently on each side.
const COOKIE_PREFS_KEY = CONSENT_STORAGE_KEY;

let phClient: PostHogClient | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;

function readEnv(): { key: string; host: string } | null {
  if (typeof process === "undefined") return null;
  const key = (process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "").trim();
  if (!key) return null;
  // EU Cloud is the default because we have published it as a commitment, not
  // as a preference: /legal/sub-processors declares PostHog's region as
  // "EU (eu.posthog.com)" and that register is part of the DPA per Terms §8,
  // and /legal/cookies tells visitors we use "PostHog (EU-hosted,
  // eu.posthog.com)". A US fallback here meant an unset env var quietly sent
  // EU visitors' analytics to US Cloud while both pages said otherwise.
  // Operators who genuinely run US Cloud must set the var AND amend those two
  // pages; posthog-host-matches-policy.test.ts fails until they agree.
  const host = (
    process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.posthog.com"
  ).trim();
  return { key, host };
}

/**
 * Resolve the user's analytics consent into the shared
 * @postwave/telemetry `ConsentState`.
 *
 * The audit found web defaulted opt-IN (captured unless the user had
 * affirmatively opted OUT), with no consent surface on the authenticated
 * dashboard — a GDPR liability. We now follow the package's uniform
 * opt-IN-by-affirmative-grant model: capture is `denied` UNTIL the cookie
 * banner persists `prefs.analytics === true` (an explicit accept/custom).
 * `unset`/missing prefs ⇒ denied (no capture), matching
 * `TELEMETRY_CONSENT_DEFAULT`.
 *
 * The dedicated Settings opt-out flag (`LS_OPTOUT`) still forces denial.
 */
function readConsent(): ConsentState {
  if (typeof window === "undefined") return TELEMETRY_CONSENT_DEFAULT;
  try {
    // Explicit Settings opt-out always wins.
    if (window.localStorage.getItem(LS_OPTOUT) === "1") return "denied";
    const raw = window.localStorage.getItem(COOKIE_PREFS_KEY);
    if (!raw) return "unset"; // no decision yet ⇒ treated as denied
    // parseConsentRecord also enforces the 13-month re-consent window that
    // /legal/privacy §7 and the /legal/cookies register both publish. It was
    // written into the record and never read, so a grant made once was honoured
    // forever — capture has to stop when the window lapses, not just the
    // banner reappear.
    const { prefs, oversize } = parseConsentRecord(raw, new Date());
    if (oversize) {
      window.localStorage.removeItem(COOKIE_PREFS_KEY);
      return "denied";
    }
    return prefs?.analytics === true ? "granted" : "denied";
  } catch {
    // If browser storage is unavailable we cannot prove consent; fail closed.
    return "denied";
  }
}

/**
 * Whether capture is currently permitted — only an explicit `granted`
 * consent enables it (opt-IN model via @postwave/telemetry::shouldCapture).
 */
function captureAllowed(): boolean {
  return shouldCapture(readConsent());
}

/** Back-compat boolean for the public opt-out API. */
function readOptOut(): boolean {
  return !captureAllowed();
}

/**
 * Query keys that mark a URL as credential-bearing.
 *
 * The first seven mirror the set the service worker already refuses to cache
 * (src/app/sw-cache-policy.ts). The remainder are the signed email auth-link
 * contract from src/lib/auth-link.ts, which carries its whole proof in the
 * QUERY string — `/accept-invite?token=…`, `/magic-link?token=…&sig=…`,
 * `/reset-password?token=…&sig=…`. A path-only gate cannot see any of those,
 * because `redactPath("/magic-link")` returns its input unchanged.
 */
const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "auth_token",
  "code",
  "key",
  "signature",
  "stream_token",
  "token",
  // Signed auth-link contract (auth-link.ts) — a partially stripped link that
  // still carries the signature or its audience/flow binding is sensitive.
  "aud",
  "flow",
  "sig",
]);

/**
 * Whether a location is off-limits for capture. Exported for tests; production
 * callers go through `currentPathIsSensitive()`.
 *
 * Fails closed on both halves of the URL: the redaction table decides the path,
 * and any credential-shaped query key vetoes regardless of path. `search` is
 * accepted in either `?a=b` or `a=b` form so `window.location.search` can be
 * passed straight through.
 */
export function locationIsSensitive(pathname: string, search = ""): boolean {
  if (pathname !== "" && redactPath(pathname) !== pathname) return true;
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (!raw) return false;
  try {
    for (const key of new URLSearchParams(raw).keys()) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) return true;
    }
  } catch {
    // An unparseable query string is not provably safe.
    return true;
  }
  return false;
}

function currentPathIsSensitive(): boolean {
  if (typeof window === "undefined") return false;
  return locationIsSensitive(
    window.location?.pathname ?? "",
    window.location?.search ?? "",
  );
}

export async function init(): Promise<void> {
  if (typeof window === "undefined") return;
  // PostHog can emit an opt-in event during initialization and automatically
  // attaches $current_url/$pathname. Never initialize it on a bearer/PII path.
  if (currentPathIsSensitive()) return;
  if (initialized || initPromise) {
    if (initPromise) await initPromise;
    return;
  }
  const env = readEnv();
  if (!env) {
    initialized = true;
    return;
  }
  // ePrivacy Art. 5(3) — PRIOR consent, for STORAGE.
  //
  // Capture was already gated below, but `posthog.init()` writes its
  // persistence store (a `ph_*_posthog` cookie plus a localStorage entry) as
  // part of initialising, and posthog-js retains that store when opted out.
  // So the old order — init, then decide — stored information on the
  // visitor's device before they answered the banner. Art. 5(3) regulates the
  // storing itself, and analytics identity is not "strictly necessary" for a
  // service the visitor asked for, so there is no carve-out to rely on.
  //
  // Deliberately NOT latching `initialized`: this path is the common one (a
  // visitor's first page load precedes their decision), and latching would
  // make the module permanently inert for everyone who ever loaded a page
  // before accepting. The cookie banner calls back into `init()` on grant.
  if (!captureAllowed()) return;
  initPromise = (async () => {
    try {
      const mod = (await import("posthog-js")) as { default: PostHogClient };
      mod.default.init(env.key, {
        api_host: env.host,
        // Marketing site CAN benefit from autocapture (form fills,
        // CTA clicks); we leave it off here to stay aligned with
        // the rest of the surface and to keep PII surface minimal.
        // Operators can flip it on per-project from PostHog UI.
        autocapture: false,
        // We send pageviews ourselves via a router observer so the
        // event payload is consistent across SPA + MPA navigation.
        capture_pageview: false,
        capture_exceptions: false,
        disable_session_recording: true,
        disable_surveys: true,
        disable_surveys_automatic_display: true,
        disable_external_dependency_loading: true,
        respect_dnt: true,
        persistence: "localStorage+cookie",
        // This is the final outbound boundary after an SPA navigation. Even if
        // a future SDK feature or direct call creates an event, automatic URL
        // properties cannot leave a credential/PII-bearing route.
        before_send: (event) => (currentPathIsSensitive() ? null : event),
      });
      // Opt-IN model: capture only when consent is explicitly `granted`.
      // Reaching here already implies a grant (the Art. 5(3) gate above), but
      // consent can lapse between that check and this line — the 13-month
      // window can expire mid-await — so it is re-read rather than assumed.
      if (captureAllowed()) {
        mod.default.opt_in_capturing();
      } else {
        mod.default.opt_out_capturing({ clear_persistence: true });
      }
      // Expose for the existing cookie-banner component which already
      // pokes window.posthog.opt_in_capturing/opt_out_capturing
      // directly.
      (window as unknown as { posthog?: PostHogClient }).posthog = mod.default;
      phClient = mod.default;
    } catch (err) {
      console.warn("[postwave-telemetry] init failed:", err);
    } finally {
      initialized = true;
    }
  })();
  await initPromise;
}

export function isEnabled(): boolean {
  return phClient !== null && captureAllowed();
}

export function getOptOut(): boolean {
  return readOptOut();
}

export function setOptOut(optOut: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (optOut) window.localStorage.setItem(LS_OPTOUT, "1");
    else window.localStorage.removeItem(LS_OPTOUT);
  } catch {
    /* ignore */
  }
  if (phClient) {
    // Withdrawal must remove the store the grant created, not merely stop
    // sending from it — otherwise information keeps sitting on the visitor's
    // device with no lawful basis behind it.
    if (optOut) phClient.opt_out_capturing({ clear_persistence: true });
    else phClient.opt_in_capturing();
  } else if (!optOut) {
    // Consent granted before PostHog was ever loaded — the normal order now
    // that initialisation waits for consent. Load it here so the grant takes
    // effect in this session rather than on the next navigation.
    void init();
  }
}

export function track(event: string, props?: Record<string, unknown>): void {
  // Every capture receives PostHog's automatic $current_url/$pathname fields,
  // so custom-property redaction alone cannot protect capability routes.
  if (currentPathIsSensitive()) return;
  if (!isEnabled() || !phClient) return;
  try {
    phClient.capture(event, props);
  } catch (err) {
    console.warn("[postwave-telemetry] capture failed:", err);
  }
}

export function identify(
  userId: string,
  props?: Record<string, unknown>,
): void {
  if (currentPathIsSensitive()) return;
  if (!isEnabled() || !phClient) return;
  try {
    phClient.identify(userId, props);
  } catch (err) {
    console.warn("[postwave-telemetry] identify failed:", err);
  }
}

export function reset(): void {
  if (!phClient) return;
  try {
    phClient.reset();
  } catch {
    /* ignore */
  }
}
