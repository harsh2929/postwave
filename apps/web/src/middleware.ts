// SPDX-License-Identifier: AGPL-3.0-only
//
// Composed middleware. Two responsibilities:
//
//   1. Auth gate for the dashboard (/app/...). Redirects unauthenticated
//      users to /. This is the original behaviour and must not regress.
//   2. Locale routing for public subscriber-facing pages (/forms/...,
//      /preferences/..., /landing/...). Detects the active locale from
//      ?lang=, NEXT_LOCALE cookie, or Accept-Language and rewrites to
//      /[locale]/<path>. The dashboard is intentionally NOT localized.
//
// The matcher below is the single source of truth for which paths the
// middleware runs against — keep dashboard and public matchers disjoint.
import { NextResponse, type NextRequest } from "next/server";
import createIntlMiddleware from "next-intl/middleware";

import { routing } from "@/i18n/routing";
import { isLocale } from "@/i18n/locales";
import { localizedPathForLangOverride } from "@/lib/i18n-paths";
import {
  PUBLIC_LOCALIZED_PREFIXES,
  isEmbeddablePublicPath,
  isPublicLocalizedPath,
} from "@/lib/public-localized-paths";
import { publicReleaseApproved } from "@/lib/public-release";
import { PATHNAME_HEADER } from "@/lib/safe-navigation";
import { ROOT_LAYOUT_SCRIPT_HASHES } from "@/lib/root-layout-scripts";
import { sentryDsnOrigin } from "../scripts/lib/sentry-dsn-origin.mjs";

const AUTH_COOKIE_NAMES = [
  "__session",
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
  "pw_session",
];

type AuthBypassEnvName =
  | "NEXT_PUBLIC_USE_MOCKS"
  | "POSTWAVE_AUTH_BYPASS"
  | "POSTWAVE_LOCAL_AUTH_BYPASS";

function enabledAuthBypassName(): AuthBypassEnvName | null {
  // Keep every lookup explicit. Next's edge compiler replaces statically named
  // process.env properties, but cannot populate a bracket-indexed env lookup
  // lookup in the middleware runtime. The old array/some implementation made
  // the documented local browser harness redirect to /login despite the flag.
  if (process.env.NEXT_PUBLIC_USE_MOCKS === "1") {
    return "NEXT_PUBLIC_USE_MOCKS";
  }
  if (process.env.POSTWAVE_AUTH_BYPASS === "1") {
    return "POSTWAVE_AUTH_BYPASS";
  }
  if (process.env.POSTWAVE_LOCAL_AUTH_BYPASS === "1") {
    return "POSTWAVE_LOCAL_AUTH_BYPASS";
  }
  return null;
}

// Refuse to load this module in production builds when any auth-bypass flag
// is set. The triple-trigger (mocks / auth-bypass / local-auth-bypass) is a
// dev-only convenience that must not be reachable in prod — one stray secret-
// manager copy is full tenant takeover. Failing at module load means the
// edge runtime refuses to serve and the deploy is loud, not silent.
if (process.env.NODE_ENV === "production") {
  const name = enabledAuthBypassName();
  if (name) {
    throw new Error(
      `[postwave/middleware] refusing to start: ${name}=1 is set in NODE_ENV=production. ` +
        `Auth-bypass flags are dev-only. Unset this variable before deploying.`,
    );
  }
}

function authBypassEnabled(): boolean {
  // In production we already threw above; checking again here is defense in
  // depth in case NODE_ENV is somehow unset at request time.
  if (process.env.NODE_ENV === "production") return false;
  return enabledAuthBypassName() !== null;
}

function hasSessionCookie(req: NextRequest): boolean {
  return AUTH_COOKIE_NAMES.some((name) =>
    Boolean(req.cookies.get(name)?.value),
  );
}

/**
 * Redirect on the browser-facing request origin, not the internal origin Next
 * reconstructed for the standalone server. Behind an ALB (and in the release
 * image locally) req.nextUrl and Host can say localhost while
 * X-Forwarded-Host carries the origin the browser used. Only build-pinned
 * public hosts (plus loopback for local verification) are accepted; strict
 * parsing prevents path/userinfo injection. Callers own the redirect path.
 */
function browserOriginRedirect(
  req: NextRequest,
  target: Pick<URL, "pathname" | "search" | "hash">,
): NextResponse {
  const configuredOrigins = new Map(
    [
      process.env.NEXT_PUBLIC_SITE_URL,
      process.env.NEXT_PUBLIC_APP_URL,
      process.env.NEXT_PUBLIC_DOCS_URL,
      process.env.NEXT_PUBLIC_FORMS_ORIGIN,
    ].flatMap((raw) => {
      if (!raw) return [];
      try {
        const parsed = new URL(raw);
        return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
          !parsed.username &&
          !parsed.password
          ? [[parsed.host, parsed.origin] as const]
          : [];
      } catch {
        return [];
      }
    }),
  );
  const isLoopbackHost = (host: string): boolean => {
    try {
      const hostname = new URL(`http://${host}`).hostname
        .replace(/^\[|\]$/gu, "")
        .toLowerCase();
      return (
        hostname === "localhost" ||
        hostname === "::1" ||
        /^127(?:\.\d{1,3}){3}$/u.test(hostname)
      );
    } catch {
      return false;
    }
  };
  const candidateHosts = [
    (req.headers.get("x-forwarded-host") ?? "").split(",", 1)[0]?.trim(),
    (req.headers.get("host") ?? "").trim(),
  ];
  const localUnconfiguredBuild =
    configuredOrigins.size === 0 && isLoopbackHost(req.nextUrl.host);
  const forwardedProto = (req.headers.get("x-forwarded-proto") ?? "")
    .split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  const protocol =
    forwardedProto === "https" || forwardedProto === "http"
      ? `${forwardedProto}:`
      : req.nextUrl.protocol;
  let origin = req.nextUrl.origin;
  for (const rawHost of candidateHosts) {
    const configuredOrigin = rawHost
      ? configuredOrigins.get(rawHost)
      : undefined;
    if (
      !rawHost ||
      /[\s/@\\]/u.test(rawHost) ||
      (!configuredOrigin &&
        !(localUnconfiguredBuild && isLoopbackHost(rawHost)) &&
        rawHost !== req.nextUrl.host)
    ) {
      continue;
    }
    if (configuredOrigin) {
      // The build contract pins deployed origins to HTTPS. Do not let a
      // spoofed forwarded-protocol header downgrade an external redirect.
      origin = configuredOrigin;
      break;
    }
    try {
      const parsed = new URL(`${protocol}//${rawHost}`);
      if (parsed.host === rawHost && !parsed.username && !parsed.password) {
        origin = parsed.origin;
        break;
      }
    } catch {
      // Try the next candidate, then retain Next's already-parsed origin.
    }
  }
  return NextResponse.redirect(
    new URL(`${target.pathname}${target.search}${target.hash}`, origin),
  );
}

const intlMiddleware = createIntlMiddleware(routing);

function configuredHttpsOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const value = new URL(raw);
    if (value.protocol !== "https:" || value.username || value.password) {
      return null;
    }
    return value.origin;
  } catch {
    return null;
  }
}

function isPublishedArchivePath(pathname: string): boolean {
  return /^(?:\/[a-z]{2})?\/archive(?:\/|$)/.test(pathname);
}

function strictContentSecurityPolicy(nonce: string, pathname: string): string {
  // RootLayout contains two deliberately tiny, immutable pre-paint scripts
  // (document language and dashboard theme). Static routes cannot read a
  // request nonce without forfeiting prerendering, so the strict dynamic
  // routes authorize those exact script bodies by SHA-256 as well as
  // authorizing Next's request-specific bootstrap with the nonce. Keep the
  // hashes covered by csp-security.test.ts so a script edit fails closed.
  const uploadOrigin = configuredHttpsOrigin(
    process.env.NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN,
  );
  const connectSources = [
    "'self'",
    configuredHttpsOrigin(process.env.NEXT_PUBLIC_POSTHOG_HOST),
    configuredHttpsOrigin(process.env.NEXT_PUBLIC_WEB_VITALS_ENDPOINT),
    sentryDsnOrigin(process.env.NEXT_PUBLIC_SENTRY_DSN_WEB),
    // Public form file uploads PUT directly to a presigned URL (SurveyForm ->
    // safePresignedUploadURL). Only the exact configured bucket origin is
    // reachable: an absent value fails closed instead of authorizing every S3
    // bucket as a browser exfiltration destination.
    uploadOrigin,
    "https://www.google.com",
    "https://www.recaptcha.net",
  ].filter((source): source is string => Boolean(source));
  const imageSources = [
    "'self'",
    "data:",
    "blob:",
    configuredHttpsOrigin(process.env.NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL),
    "https://www.google.com",
    "https://www.gstatic.com",
    "https://www.recaptcha.net",
    // Published archives intentionally render operator-supplied hero images
    // and tracking pixels. Template-library pages never receive this escape
    // hatch: they can fetch only the exact Moosewave asset origin above.
    isPublishedArchivePath(pathname) ? "https:" : null,
  ].filter((source): source is string => Boolean(source));

  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    // Hosted forms and landing pages exist to be iframed onto customer sites —
    // the dashboard's embed panel and public/embed.js both generate
    // `<iframe src="…/forms/<slug>">`. A blanket 'none' here (plus the
    // X-Frame-Options: DENY below) meant every generated snippet rendered a
    // blank box on the customer's page, failing console-only on a third-party
    // site where nobody would see it.
    //
    // This deliberately does NOT extend to the other public locale-routed
    // prefixes: /preferences and /gift render subscriber PII against a
    // capability token, and framing those is a click-harvesting vector.
    isEmbeddablePublicPath(pathname)
      ? "frame-ancestors *"
      : "frame-ancestors 'none'",
    `img-src ${imageSources.join(" ")}`,
    "font-src 'self' data:",
    // Next currently emits inline style attributes for framework and component
    // state. Script execution is the XSS boundary and is nonce-enforced below.
    "style-src 'self' 'unsafe-inline'",
    // Dev ONLY: `next dev` HMR / react-refresh / webpack chunk loading require
    // eval + inline scripts, which the strict nonce + strict-dynamic policy
    // blocks (breaking lazy imports). Production AND test keep the strict policy
    // below — csp-security.test.ts runs under NODE_ENV=test and asserts it.
    process.env.NODE_ENV === "development"
      ? "script-src 'self' 'unsafe-eval' 'unsafe-inline'"
      : `script-src 'self' 'nonce-${nonce}' ${ROOT_LAYOUT_SCRIPT_HASHES.join(" ")} 'strict-dynamic'`,
    `connect-src ${connectSources.join(" ")}`,
    "frame-src 'self' https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/ https://www.recaptcha.net/recaptcha/",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "report-uri /api/csp-report",
  ].join("; ");
}

/** The policy with its report-uri / report-to directives removed. */
function withoutReportEndpoint(policy: string): string {
  return policy
    .split(";")
    .map((directive) => directive.trim())
    .filter(
      (directive) =>
        directive && !/^report-(?:uri|to)(?:\s|$)/i.test(directive),
    )
    .join("; ");
}

function nextWithStrictCSP(
  req: NextRequest,
  existingResponse?: NextResponse,
): NextResponse {
  const nonce = crypto.randomUUID();
  const policy = strictContentSecurityPolicy(nonce, req.nextUrl.pathname);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  // Server components cannot read the request path. Without it the dashboard
  // layout's own auth redirects had to hardcode `?next=/app`, so a visitor
  // whose session expired on /app/campaigns/123 was returned to the dashboard
  // root after signing in and had to find their way back. Forward the path so
  // that redirect can preserve the destination the middleware already
  // preserves. Overwritten from req.headers, never trusted from the client.
  requestHeaders.set(
    PATHNAME_HEADER,
    req.nextUrl.pathname + req.nextUrl.search,
  );
  const requestOverride = NextResponse.next({
    request: { headers: requestHeaders },
  });
  const response = existingResponse ?? requestOverride;

  // next-intl may already have produced a rewrite response. Preserve that
  // response (and its locale cookie) while forwarding the same request-header
  // override that NextResponse.next() generated for the nonce carrier.
  if (existingResponse) {
    const overriddenRequestHeaders = new Set(
      (response.headers.get("x-middleware-override-headers") ?? "")
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
    );
    for (const name of (
      requestOverride.headers.get("x-middleware-override-headers") ?? ""
    ).split(",")) {
      const normalized = name.trim().toLowerCase();
      if (normalized) overriddenRequestHeaders.add(normalized);
    }
    for (const [name, value] of requestOverride.headers) {
      if (name.startsWith("x-middleware-request-")) {
        response.headers.set(name, value);
      }
    }
    // Do not replace next-intl's override list with the nonce response's list.
    // The corresponding x-middleware-request-x-next-intl-locale header can
    // remain present yet be ignored by Next when its name is missing here,
    // which produced English copy at explicit /es, /fr, … URLs.
    response.headers.set(
      "x-middleware-override-headers",
      [...overriddenRequestHeaders].join(","),
    );
  }
  response.headers.set("Content-Security-Policy", policy);
  // Route-level static headers also attach the public tightening candidate.
  // Replace it here: nonce-protected routes are already at the target policy,
  // and retaining the public candidate would report every legitimate nonced
  // Next bootstrap as a false-positive inline violation. It cannot simply be
  // deleted — middleware headers only override config headers, never remove
  // them — so it becomes the enforced policy WITHOUT its report endpoint:
  // an identical copy that still reported sent every real violation twice,
  // doubling /api/csp-report traffic on every dashboard page.
  response.headers.set(
    "Content-Security-Policy-Report-Only",
    withoutReportEndpoint(policy),
  );
  // X-Frame-Options has no "allow any origin" value, so an embeddable page can
  // only be made embeddable by omitting the header entirely. frame-ancestors
  // above is the governing control for those routes.
  if (!isEmbeddablePublicPath(req.nextUrl.pathname)) {
    response.headers.set("X-Frame-Options", "DENY");
  }
  if (!publicReleaseApproved()) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  return response;
}

/**
 * The long-tail docs pages — one per API operation and per skill — render on
 * first request and are then served from Next's cache for a day
 * (`force-static` + `revalidate`; the image deliberately bakes none of them).
 * A per-request nonce cannot work there: the nonce of whichever request filled
 * the cache is written into the cached HTML, every later response carries a
 * fresh one in its header, and the browser blocks every script on the page —
 * 98 violations per load on staging, and a page that never hydrated.
 */
const CACHED_DOCS_PATH = /^\/docs\/(?:api|skills)\/[^/]+\/?$/;

/**
 * The script nonce of those pages: one value per build, not per request.
 * next.config.mjs generates it at build time and inlines it here, so every
 * request the build serves — on every task, before and after a restart — names
 * the same nonce, and every copy of a page the build rendered carries it. A new
 * build starts with an empty cache (the image bakes none of these pages and the
 * cache volume is per task). The fallback keeps a bundle without the value
 * (vitest) self-consistent for the life of the process.
 *
 * Why not hashes: each page inlines its own RSC payload as dozens of
 * `self.__next_f.push(…)` scripts whose bodies are the page content, and
 * middleware runs before the render that produces them, so no hash list can
 * authorize them. Why a nonce anyone can read off the page is still a boundary:
 * the HTML is identical for every visitor (no request input reaches it), and
 * markup that reaches a live page through a DOM sink never runs an inserted
 * <script> — what it can run is an inline event handler, a `javascript:` URL
 * or eval, which this policy blocks and 'unsafe-inline' allowed.
 */
const CACHED_DOCS_SCRIPT_NONCE = (() => {
  const built = process.env.POSTWAVE_CACHED_DOCS_SCRIPT_NONCE;
  return built && /^[A-Za-z0-9+/_-]{22,}={0,2}$/.test(built)
    ? built
    : crypto.randomUUID();
})();

/**
 * A configured https URL as a path-restricted CSP source. `prefix` keeps
 * everything under the URL's path (a client that appends its own paths, like
 * PostHog's `/e/` and `/flags/`); otherwise only that exact path matches. An
 * origin-only source would be far wider than the endpoint: staging posts web
 * vitals to https://api.<domain>/api/internal/web-vitals, and that origin is
 * the whole API, which accepts the visitor's session cookie.
 */
function configuredHttpsSource(
  raw: string | undefined,
  { prefix }: { prefix: boolean },
): string | null {
  const origin = configuredHttpsOrigin(raw);
  if (!origin || !raw) return null;
  const { pathname } = new URL(raw);
  // `;` and `,` are legal in a URL path but end a CSP directive or policy.
  if (/[;,\s]/.test(pathname)) return null;
  if (!prefix) return `${origin}${pathname}`;
  return `${origin}${pathname.endsWith("/") ? pathname : `${pathname}/`}`;
}

/**
 * The policy for those cached pages: the strict policy's script boundary with
 * the build's nonce in place of a per-request one. Nothing in it comes from the
 * request.
 *
 * - connect-src: the page's own origin is 'self'. The server cannot name it —
 *   behind the load balancer the request URL carries the container's bind
 *   address (https://0.0.0.0:3000), which, written into this directive,
 *   blocked the navigation index (/api/docs/nav), every client-side docs
 *   navigation and its prefetches. The configured telemetry endpoints follow,
 *   each by its path rather than its origin: web vitals is posted to the API
 *   host, which accepts the visitor's session cookie.
 * - form-action 'none', frame-src 'none', frame-ancestors 'none', base-uri
 *   'none'; and Cross-Origin-Opener-Policy: same-origin on the response, which
 *   no other page sets, so a window these pages open onto /app (or an /app
 *   window that opens them) lands in a separate browsing context group.
 */
function cachedDocsContentSecurityPolicy(): string {
  const connectSources = [
    "'self'",
    configuredHttpsSource(process.env.NEXT_PUBLIC_POSTHOG_HOST, {
      prefix: true,
    }),
    configuredHttpsSource(process.env.NEXT_PUBLIC_WEB_VITALS_ENDPOINT, {
      prefix: false,
    }),
    sentryDsnOrigin(process.env.NEXT_PUBLIC_SENTRY_DSN_WEB),
  ].filter((source): source is string => Boolean(source));
  const imageSources = [
    "'self'",
    "data:",
    "blob:",
    configuredHttpsOrigin(process.env.NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL),
  ].filter((source): source is string => Boolean(source));
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    `img-src ${imageSources.join(" ")}`,
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    process.env.NODE_ENV === "development"
      ? "script-src 'self' 'unsafe-eval' 'unsafe-inline'"
      : `script-src 'self' 'nonce-${CACHED_DOCS_SCRIPT_NONCE}' ${ROOT_LAYOUT_SCRIPT_HASHES.join(" ")} 'strict-dynamic'`,
    `connect-src ${connectSources.join(" ")}`,
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "report-uri /api/csp-report",
  ].join("; ");
}

/**
 * Every request for a cached docs page — the document, and the RSC and
 * prefetch requests of a client-side navigation — hands the build's nonce to
 * the render. Whichever of them fills the cache, Next writes that nonce onto
 * its scripts, so the cached HTML satisfies this policy on every later hit.
 */
function nextWithCachedDocsCSP(req: NextRequest): NextResponse {
  const policy = cachedDocsContentSecurityPolicy();
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", CACHED_DOCS_SCRIPT_NONCE);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  // Neutralise the static tightening candidate (see nextWithStrictCSP).
  response.headers.set(
    "Content-Security-Policy-Report-Only",
    withoutReportEndpoint(policy),
  );
  response.headers.set("X-Frame-Options", "DENY");
  // Severs the opener relationship with every page that does not share this
  // value — i.e. the whole dashboard — in both directions.
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  if (!publicReleaseApproved()) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  return response;
}

function isDocumentRequest(req: NextRequest): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (req.headers.get("sec-fetch-dest") === "document") return true;
  return (req.headers.get("accept") ?? "").includes("text/html");
}

const STRICT_AUTH_PATHS = new Set([
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/accept-invite",
  "/magic-link",
  "/verify-email",
  "/totp-challenge",
  "/cli/auth",
]);

function isLocalePrefixedPublicPath(pathname: string): boolean {
  // e.g. /es/forms/foo  →  segments ["", "es", "forms", ...]
  const segments = pathname.split("/");
  if (segments.length < 3) return false;
  const maybeLocale = segments[1];
  const maybePrefix = `/${segments[2]}`;
  return (
    isLocale(maybeLocale) &&
    PUBLIC_LOCALIZED_PREFIXES.some((prefix) => prefix === maybePrefix)
  );
}

/**
 * One-segment paths the app itself requests on whatever host a page is
 * served from, so the forms host must not read them as a form slug.
 *
 * The service worker is registered on hosted form pages too, and its install
 * precaches /offline (next.config.mjs additionalPrecacheEntries). On
 * forms.<domain> that was redirected to /forms/offline, which asked the API
 * for a form named "offline" (GET /api/public/forms/offline → 404). The
 * failed precache aborted the install, so every hosted form load retried it.
 */
const HOST_AGNOSTIC_ROOT_PATHS: ReadonlySet<string> = new Set(["/offline"]);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const host = req.headers.get("host") ?? "";

  // Backward-compatible hosted-form short links. Older snippets and emails
  // used forms.moosewave.com/<slug>; the canonical app route is /forms/<slug>.
  // App-shell paths requested on every host are not slugs: see
  // HOST_AGNOSTIC_ROOT_PATHS.
  if (
    host.startsWith("forms.") &&
    pathname !== "/" &&
    !HOST_AGNOSTIC_ROOT_PATHS.has(pathname) &&
    pathname.split("/").filter(Boolean).length === 1 &&
    !pathname.includes(".")
  ) {
    const url = req.nextUrl.clone();
    url.pathname = `/forms${pathname}`;
    return browserOriginRedirect(req, url);
  }

  // ---- Dashboard auth gate. ---------------------------------------------
  // Runs before any locale logic so the dashboard never accidentally inherits
  // a locale prefix. Redirects unauthenticated visitors to the new /login
  // page (which lives outside the locale segment for stable email-deeplink
  // semantics) and forwards the original path via ?next=.
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    if (authBypassEnabled() || hasSessionCookie(req)) {
      return nextWithStrictCSP(req);
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    // Server-side `next` validation (audit finding: middleware wrote
    // the raw request path into ?next= with no sanitization, relying
    // entirely on the client-side safeNextPath gate). Enforce here:
    // only dashboard paths (/app or /app/*) round-trip through ?next=.
    // Anything else collapses to /app so a forged URL like
    // /app/../evil can't end up as a redirect target.
    const rawNext = req.nextUrl.pathname + req.nextUrl.search;
    const safeNext =
      rawNext === "/app" ||
      rawNext.startsWith("/app/") ||
      rawNext.startsWith("/app?")
        ? rawNext
        : "/app";
    url.searchParams.set("next", safeNext);
    return browserOriginRedirect(req, url);
  }

  // ---- Locale routing for public subscriber pages. ----------------------
  // Hand off to next-intl for any path under /forms, /preferences, /landing
  // (or already-prefixed /<locale>/forms, etc.). next-intl handles cookie +
  // Accept-Language detection out of the box; we layer ?lang= on top so a
  // newsletter footer link like /preferences/<token>?lang=es works without
  // requiring the publisher to know the locale-prefix routing scheme.
  if (isPublicLocalizedPath(pathname) || isLocalePrefixedPublicPath(pathname)) {
    const langOverride = req.nextUrl.searchParams.get("lang");
    if (isLocale(langOverride)) {
      const targetPath = localizedPathForLangOverride(pathname, langOverride);
      let response: NextResponse;
      if (targetPath !== pathname) {
        const url = req.nextUrl.clone();
        url.pathname = targetPath;
        response = browserOriginRedirect(req, url);
      } else {
        response = intlMiddleware(req);
      }
      response.cookies.set("NEXT_LOCALE", langOverride, {
        path: "/",
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 365,
      });
      return nextWithStrictCSP(req, response);
    }
    return nextWithStrictCSP(req, intlMiddleware(req));
  }

  // Authentication and credential-recovery pages are explicitly forced to
  // dynamic rendering by their small route layouts. Supplying the nonce in
  // the request CSP lets Next attach it to framework/hydration scripts, so
  // these sensitive pages get the same strict script boundary as /app.
  if (STRICT_AUTH_PATHS.has(pathname)) {
    return nextWithStrictCSP(req);
  }

  // The cached long-tail docs, whose HTML outlives any one request, carry the
  // build's nonce on every request that can render them: RSC and prefetch
  // included, since any of those may be the one that fills the cache.
  if (CACHED_DOCS_PATH.test(pathname)) {
    return nextWithCachedDocsCSP(req);
  }

  // Every other HTML document gets a request-specific nonce. RSC/prefetch, API
  // and static-asset requests remain untouched; they neither contain
  // executable inline script nor need to forfeit their cacheability.
  if (isDocumentRequest(req)) {
    return nextWithStrictCSP(req);
  }

  return NextResponse.next();
}

export const config = {
  // The final catch-all is required for nonce-protected marketing/docs
  // documents. isDocumentRequest keeps RSC, API and asset traffic out of the
  // nonce path even when a public filename happens to match the middleware.
  matcher: [
    "/",
    "/app",
    "/app/:path*",
    "/forms",
    "/forms/:path*",
    "/preferences",
    "/preferences/:path*",
    "/gift",
    "/gift/:path*",
    "/landing",
    "/landing/:path*",
    "/archive",
    "/archive/:path*",
    "/:slug",
    "/cli/auth",
    // Locale-prefixed variants. Without these, an in-app link to
    // /es/forms/foo wouldn't trigger the middleware and would 404.
    "/(en|es|fr|de|pt|ja)/:path*",
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|manifest.webmanifest|sw.js|icons/).*)",
  ],
};
