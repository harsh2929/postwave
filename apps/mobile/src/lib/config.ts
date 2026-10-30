import { httpHostAllowed } from "./httpHostPolicy";

export const DEFAULT_API_BASE_URL = normalizeApiBaseUrl(
  process.env.EXPO_PUBLIC_API_URL || "https://api.moosewave.com",
);

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export const BUILD_PROFILE = (
  process.env.EXPO_PUBLIC_BUILD_PROFILE || "development"
).toLowerCase();

export const IS_PRODUCTION_BUILD = BUILD_PROFILE === "production";

/** Public web-app origin used for browser-facing archive/share links. */
export const PUBLIC_APP_BASE_URL =
  normalizeExternalAppUrl(
    process.env.EXPO_PUBLIC_APP_URL || "https://app.moosewave.com",
  )?.replace(/\/$/, "") ?? "https://app.moosewave.com";

export const LEGAL_URLS = {
  privacy: normalizePublicHttpsUrl(
    process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL,
    "https://moosewave.com/legal/privacy",
  ),
  terms: normalizePublicHttpsUrl(
    process.env.EXPO_PUBLIC_TERMS_URL,
    "https://moosewave.com/legal/terms",
  ),
  support: normalizePublicHttpsUrl(
    process.env.EXPO_PUBLIC_SUPPORT_URL,
    "https://docs.moosewave.com",
  ),
  accountDeletion: normalizePublicHttpsUrl(
    process.env.EXPO_PUBLIC_ACCOUNT_DELETION_URL ||
      "https://moosewave.com/legal/account-deletion",
    "https://moosewave.com/legal/account-deletion",
  ),
} as const;

/**
 * Public source repository. Mirrors the desktop About block
 * (apps/desktop/src/pages/Settings.tsx), which is the established product
 * claim; both clients must not drift on where the source lives.
 */
export const SOURCE_URL = normalizePublicHttpsUrl(
  process.env.EXPO_PUBLIC_SOURCE_URL,
  "https://github.com/postwave/postwave",
);

/**
 * Privacy contact. A bare address rather than a URL, because it is opened as a
 * `mailto:` — `normalizePublicHttpsUrl` deliberately rejects every non-https
 * scheme, so this one cannot live in LEGAL_URLS. Validated against a
 * conservative address shape so a mistyped env var can never be interpolated
 * into a `mailto:` URI unescaped.
 */
export const PRIVACY_CONTACT_EMAIL = normalizeContactEmail(
  process.env.EXPO_PUBLIC_PRIVACY_CONTACT_EMAIL,
  "privacy@moosewave.com",
);

export function normalizeContactEmail(
  input: string | null | undefined,
  fallback: string,
): string {
  const raw = (input ?? "").trim();
  if (!raw || CONTROL_RE.test(raw)) return fallback;
  // Deliberately strict: no spaces, no quoting, no comments, exactly one "@",
  // and a dotted domain. Anything else falls back rather than being escaped.
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(raw)
    ? raw
    : fallback;
}

export type ApiBaseUrlValidation =
  | { ok: true; url: string }
  | { ok: false; message: string };

export function normalizeApiBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, "");
}

export function normalizePublicHttpsUrl(
  input: string | null | undefined,
  fallback: string,
): string {
  const raw = (input || fallback).trim();
  if (!raw || CONTROL_RE.test(raw)) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) {
      return fallback;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return fallback;
  }
}

export function normalizeExternalAppUrl(
  input: string | null | undefined,
): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  if (CONTROL_RE.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && !isDevelopmentHttpUrl(url)) return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function validateApiBaseUrl(
  input: string,
  buildProfile = BUILD_PROFILE,
): ApiBaseUrlValidation {
  const url = normalizeApiBaseUrl(input);
  if (!url) {
    return { ok: false, message: "API URL is required." };
  }
  if (CONTROL_RE.test(url)) {
    return { ok: false, message: "API URL must be a valid http(s) URL." };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: "API URL must be a valid http(s) URL." };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      message: "API URL must start with http:// or https://.",
    };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      message: "API URL must not include credentials.",
    };
  }

  if (parsed.search || parsed.hash) {
    return {
      ok: false,
      message: "API URL must not include a query string or fragment.",
    };
  }

  if (
    parsed.protocol === "http:" &&
    !isSdkLocalHttpHost(parsed.hostname, buildProfile)
  ) {
    return {
      ok: false,
      message: "HTTP is only supported for localhost development APIs.",
    };
  }

  if (buildProfile === "production" && isLocalHost(parsed.hostname)) {
    return {
      ok: false,
      message: "Production builds cannot connect to local API hosts.",
    };
  }

  return { ok: true, url };
}

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h.endsWith(".local")
  );
}

/** Hosts this build may reach over plain `http://` — see lib/httpHostPolicy. */
function isSdkLocalHttpHost(
  hostname: string,
  buildProfile: string = BUILD_PROFILE,
): boolean {
  // Delegates to lib/httpHostPolicy so this rule has ONE definition. It was
  // previously restated here, in api/url.ts and in the SDK; the copies drifted
  // and the app accepted an address it then refused to build a request for.
  return httpHostAllowed(hostname, buildProfile);
}

/**
 * Whether THIS build may reach a private-network host over plain http.
 *
 * Exported for the SDK client wiring (api/sdkClient.ts), which must pass the
 * matching opt-in flag so the two policies cannot drift. Production is
 * https-only, no exceptions.
 */
// Allow-list: see lib/httpHostPolicy. An unset profile falls back to
// "development" above, so a deny-list here failed OPEN for a build that
// never said what it was.
export const HTTP_PRIVATE_NETWORK_ALLOWED = BUILD_PROFILE === "development";

function isDevelopmentHttpUrl(url: URL): boolean {
  if (url.protocol !== "http:") return false;
  return BUILD_PROFILE === "development" && isLocalHost(url.hostname);
}
