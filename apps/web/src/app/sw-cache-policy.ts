// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure service-worker cache policy helpers. Kept free of Serwist/SW globals so
// security-sensitive routing decisions can be unit-tested without evaluating
// generated public/sw.js.

// Strict allowlist: other `/api/public/*` paths may contain bearer tokens in
// the path and return subscriber PII. New public endpoints are network-only
// until they are deliberately reviewed and added here.
export const PUBLIC_ARCHIVE_API_RE = /^\/api\/public\/archive(?:\/|$)/;
export const AUTHED_API_RE = /^\/api\//;
export const HASHED_ASSET_RE =
  /\.(?:js|css|woff2?|ttf|otf|svg|png|jpg|jpeg|webp|gif|ico)$/;

const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "auth_token",
  "code",
  "key",
  "signature",
  "stream_token",
  "token",
]);

const AUTH_NAVIGATION_PREFIXES = [
  "/app",
  "/accept-invite",
  "/browser-auth",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/magic-link",
  "/verify-email",
  "/totp-challenge",
  "/cli/auth",
] as const;

const PUBLIC_PII_NAVIGATION_PREFIXES = ["/preferences"] as const;

function withoutLocalePrefix(pathname: string): string {
  return pathname.replace(/^\/[a-z]{2}(?=\/)/i, "");
}

function isSameOrigin(url: URL): boolean {
  const origin =
    typeof globalThis.location === "object" &&
    typeof globalThis.location?.origin === "string"
      ? globalThis.location.origin
      : "";
  return origin ? url.origin === origin : true;
}

function hasSensitiveSearch(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}

function hasAuthHeaders(request: Request): boolean {
  return (
    request.headers.has("authorization") ||
    request.headers.has("x-postwave-token") ||
    request.headers.has("x-api-key")
  );
}

export function isStaticAssetCacheCandidate(
  request: Request,
  url: URL,
): boolean {
  if (request.method !== "GET") return false;
  if (!isSameOrigin(url)) return false;
  if (hasSensitiveSearch(url)) return false;
  if (hasAuthHeaders(request)) return false;
  if (AUTHED_API_RE.test(url.pathname)) return false;
  // Next's content-hashed JS is already immutable in the browser HTTP cache.
  // Intercepting it a second time in Cache Storage makes Chrome's preload and
  // execution fetches cross different cache worlds, producing systematic
  // resource-mismatch warnings and wasted preload work. Leave chunks entirely
  // to the browser; the authenticated app is network-only and the offline
  // document does not depend on its client runtime.
  if (url.pathname.startsWith("/_next/static/chunks/")) return false;
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    HASHED_ASSET_RE.test(url.pathname)
  );
}

export function isPublicArchiveApiCacheCandidate(
  request: Request,
  url: URL,
): boolean {
  return (
    request.method === "GET" &&
    isSameOrigin(url) &&
    !hasSensitiveSearch(url) &&
    !hasAuthHeaders(request) &&
    PUBLIC_ARCHIVE_API_RE.test(url.pathname)
  );
}

export function isAuthenticatedApiRequest(request: Request, url: URL): boolean {
  if (!AUTHED_API_RE.test(url.pathname)) return false;
  if (request.method !== "GET") return true;
  return !PUBLIC_ARCHIVE_API_RE.test(url.pathname);
}

export function isAuthSensitiveNavigation(url: URL): boolean {
  if (
    AUTH_NAVIGATION_PREFIXES.some(
      (prefix) =>
        url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    )
  ) {
    return true;
  }
  const publicPath = withoutLocalePrefix(url.pathname);
  if (
    PUBLIC_PII_NAVIGATION_PREFIXES.some(
      (prefix) => publicPath === prefix || publicPath.startsWith(`${prefix}/`),
    )
  ) {
    return true;
  }
  return /^\/forms\/[^/]+\/confirm(?:\/|$)/.test(publicPath);
}

/**
 * True for any same-origin GET that must never be stored, regardless of how the
 * browser labelled it.
 *
 * `isAuthSensitiveNavigation` answers a question about a URL; this answers the
 * question the router table actually needs to ask. The distinction matters
 * because Next's App Router requests RSC payloads and <Link> prefetches with
 * `mode: "cors"` — a matcher gated on `request.mode === "navigate"` sees none
 * of them, so the rendered flight payload for an authenticated route slips past
 * a guard that reads, correctly, as if it covered that route.
 */
export function isAuthSensitiveRequest(request: Request, url: URL): boolean {
  if (request.method !== "GET") return true;
  if (!isSameOrigin(url)) return false;
  return (
    isAuthSensitiveNavigation(url) ||
    hasSensitiveSearch(url) ||
    hasAuthHeaders(request)
  );
}

export function shouldCacheNavigation(request: Request, url: URL): boolean {
  return (
    request.mode === "navigate" &&
    request.method === "GET" &&
    isSameOrigin(url) &&
    !isAuthSensitiveNavigation(url) &&
    !hasSensitiveSearch(url) &&
    !hasAuthHeaders(request)
  );
}

export function isCacheCandidate(request: Request, url: URL): boolean {
  return (
    isStaticAssetCacheCandidate(request, url) ||
    isPublicArchiveApiCacheCandidate(request, url) ||
    shouldCacheNavigation(request, url)
  );
}

/** True for a Server-Sent Events request (EventSource always asks for this). */
export function isEventStreamRequest(request: Request): boolean {
  return (request.headers.get("accept") ?? "")
    .toLowerCase()
    .includes("text/event-stream");
}

/**
 * True for a request the service worker must leave to the browser entirely:
 * no `respondWith`, so the browser fetches it exactly as it would with no
 * worker installed.
 *
 * The worker only earns its hop for requests it can answer from a cache, and
 * for page loads it can rescue with the offline page. Everything else — every
 * authenticated API call, the RSC payloads of `/app`, cross-origin requests —
 * used to fall through to a NetworkOnly route that re-issued the request from
 * the worker and piped the response back. A Server-Sent Events stream never
 * ends, so each open EventSource held one of those pipes for the life of the
 * tab, and the chunk downloads the worker issued behind them stalled for tens
 * of seconds. Streams are therefore always left alone, and so is anything the
 * worker would only have passed through.
 */
export function shouldBypassServiceWorker(request: Request, url: URL): boolean {
  if (isEventStreamRequest(request)) return true;
  // Page loads stay with the worker so a failed one can fall back to /offline.
  if (request.mode === "navigate" || request.destination === "document") {
    return false;
  }
  return !isCacheCandidate(request, url);
}
