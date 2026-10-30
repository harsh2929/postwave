// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withSentryConfig } from "@sentry/nextjs";
import createNextIntlPlugin from "next-intl/plugin";

import {
  ensureIsolatedNextTsconfig,
  resolveNextDistDir,
  resolveNextDistDirName,
} from "./scripts/lib/next-dist-dir.mjs";
import { sentryDsnOrigin } from "./scripts/lib/sentry-dsn-origin.mjs";
import { outputFileTracingExcludes } from "./scripts/lib/output-file-tracing.mjs";

// Wire next-intl to the request config at src/i18n.ts. The plugin replaces
// `next-intl/server`'s loader to read messages on the server during SSR/RSC.
const withNextIntl = createNextIntlPlugin("./src/i18n.ts");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localQaMemoryMode =
  process.env.NODE_ENV !== "production" &&
  process.env.POSTWAVE_LOCAL_QA_MEMORY_MODE === "1";
const distDirName = resolveNextDistDirName(process.env.POSTWAVE_NEXT_DIST_DIR);
const distDir = resolveNextDistDir(
  __dirname,
  process.env.POSTWAVE_NEXT_DIST_DIR,
);
const tsconfigPath = ensureIsolatedNextTsconfig(
  __dirname,
  distDir,
  process.env.POSTWAVE_NEXT_DIST_DIR,
);

function configuredOrigin(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const uploadOrigin = configuredOrigin(
  process.env.NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN,
);

const browserConnectSources = [
  "'self'",
  configuredOrigin(process.env.NEXT_PUBLIC_POSTHOG_HOST),
  configuredOrigin(process.env.NEXT_PUBLIC_WEB_VITALS_ENDPOINT),
  sentryDsnOrigin(process.env.NEXT_PUBLIC_SENTRY_DSN_WEB),
  // Public form file uploads PUT directly to a presigned URL (SurveyForm ->
  // safePresignedUploadURL). Only the exact configured bucket origin is
  // reachable: an absent value fails closed instead of authorizing every S3
  // bucket as a browser exfiltration destination.
  uploadOrigin,
  "https://www.google.com",
  "https://www.recaptcha.net",
].filter(Boolean);

const browserImageSources = [
  "'self'",
  "data:",
  "blob:",
  configuredOrigin(process.env.NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL),
  "https://www.google.com",
  "https://www.gstatic.com",
  "https://www.recaptcha.net",
].filter(Boolean);

const developmentScriptDirectives =
  process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";

// Immutable pre-paint scripts rendered by RootLayout. Normal document
// requests receive a fresh nonce in middleware; these hashes keep a strict,
// fail-closed fallback for non-document tooling and make script drift visible.
const rootLayoutScriptHashes = [
  "'sha256-cepvyKym128tSq8q5LbN2S8TgsFXseJ4SmWfNTOz4f0='",
  "'sha256-C162/+MVy+gQQmdhMfgt0Rz+JNXOisA4BhBoWH5vbtQ='",
];

const enforcedCSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  `img-src ${browserImageSources.join(" ")}`,
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' ${rootLayoutScriptHashes.join(" ")}${developmentScriptDirectives} https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/ https://www.recaptcha.net/recaptcha/`,
  `connect-src ${browserConnectSources.join(" ")}`,
  "frame-src 'self' https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/ https://www.recaptcha.net/recaptcha/",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "report-uri /api/csp-report",
].join("; ");

// The script nonce of the cached long-tail docs (/docs/api/*, /docs/skills/*):
// one unpredictable value per build, inlined into middleware through `env`
// below. Their HTML outlives any one request, so the nonce has to as well; see
// CACHED_DOCS_SCRIPT_NONCE in src/middleware.ts for why it is still a boundary.
const cachedDocsScriptNonce = randomBytes(18).toString("base64");

// Document requests replace this fail-closed baseline with a fresh nonce
// policy in middleware. Mirroring it report-only means reports represent real
// violations instead of a deliberately weaker candidate policy.
const candidateCSP = enforcedCSP;

const globalSecurityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
  {
    key: "Content-Security-Policy",
    value: enforcedCSP,
  },
  { key: "Content-Security-Policy-Report-Only", value: candidateCSP },
];

const sensitiveCSP = enforcedCSP.replace(
  "frame-ancestors 'self'",
  "frame-ancestors 'none'",
);
const sensitiveCandidateCSP = candidateCSP.replace(
  "frame-ancestors 'self'",
  "frame-ancestors 'none'",
);

const noFrameHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  // Next applies the later route-specific value for duplicate header names.
  // Retain the complete global policy here; a frame-only value would silently
  // drop script/connect/object restrictions on the most sensitive routes.
  { key: "Content-Security-Policy", value: sensitiveCSP },
  {
    key: "Content-Security-Policy-Report-Only",
    value: sensitiveCandidateCSP,
  },
];

const noFrameSources = [
  "/app/:path*",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/magic-link",
  "/verify-email",
  "/totp-challenge",
  "/accept-invite",
  "/browser-auth/:path*",
  "/cli/auth",
];

// Serwist plugin. Loaded lazily so the config still parses when the
// optional dep is not yet installed (CI/dev container without the lock).
// In production builds Serwist emits /sw.js from src/app/sw.ts.
let withSerwist = (cfg) => cfg;
try {
  const mod = await import("@serwist/next");
  withSerwist = mod.default({
    swSrc: "src/app/sw.ts",
    swDest: "public/sw.js",
    // PwaRegistrar (root layout) is the one registration path. Serwist's
    // automatic registration ran on every page as an unawaited
    // window.serwist.register(), which reads `registration.waiting`: in a
    // browser that blocks service workers the registration is undefined and
    // every page threw "Cannot read properties of undefined (reading
    // 'waiting')". PwaRegistrar handles a refused registration quietly.
    register: false,
    cacheOnNavigation: true,
    reloadOnOnline: false,
    disable: process.env.NODE_ENV === "development",
    // Precache the rendered offline document. Serwist's fallback plugin only
    // calls matchPrecache(); naming a fallback does not add it to the manifest.
    // additionalPrecacheEntries also supplies Serwist's internal size metadata,
    // unlike injecting an entry from a manifest transform.
    // Serwist keys precache entries on url+revision and skips re-download when
    // the revision is unchanged. A hardcoded literal therefore froze /offline
    // at whatever the very first service-worker install fetched: the document
    // references the build's hashed CSS by filename, those files are replaced
    // every deploy, and the cached copy kept pointing at CSS that no longer
    // exists. Derive it from the build so each deploy re-fetches the document
    // alongside the assets it names.
    additionalPrecacheEntries: [
      {
        url: "/offline",
        // One variable, not a chain of CI-vendor guesses: the deploy pipeline
        // sets POSTWAVE_BUILD_ID, and a local build falls back to the clock so
        // the entry still changes between builds.
        revision: process.env.POSTWAVE_BUILD_ID || `offline-${Date.now()}`,
      },
    ],
    // The default InjectManifest behaviour precaches every emitted route chunk.
    // With thousands of static docs/marketing routes that turns first install
    // into a background download of the whole application and competes with
    // the initial page on constrained connections. The offline fallback is
    // server-rendered, so precache only its shared styles; visited JS/assets
    // are populated by the bounded runtime cache instead.
    exclude: [({ asset }) => !asset.name.startsWith("static/css/")],
  });
} catch (error) {
  // The fallback here is a git-tracked public/sw.js — a generated artifact that
  // is also committed, which guarantees it is stale relative to the build that
  // would have replaced it. Its precache manifest pins exact CSS hashes, so
  // shipping it means shipping a service worker that precaches files this build
  // did not emit. In development that is a tolerable convenience; in a release
  // build it is a silent correctness failure, so fail loudly instead.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[postwave/web] @serwist/next failed to load during a production build. " +
        "Refusing to fall back to the committed public/sw.js, which pins stale " +
        "asset hashes and would strand clients on a previous build's shell. " +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // dev only — legacy public/sw.js still serves.
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Long local QA sessions visit many otherwise unrelated route graphs.
  // Release inactive entries promptly instead of retaining a large warm set.
  ...(localQaMemoryMode
    ? { onDemandEntries: { maxInactiveAge: 10_000, pagesBufferLength: 1 } }
    : {}),
  // Defaults to .next. Audits may point this at a guarded temporary child so
  // concurrent verification cannot erase or mix another build's artifacts.
  distDir: distDirName,
  // Keep metadata in <head> for every user agent. Next's default streaming
  // mode appends metadata after </head> on dynamic routes, which makes valid
  // descriptions invisible to HTML-limited clients and standards auditors.
  // Metadata is small enough that waiting for it is the safer public contract.
  htmlLimitedBots: /.*/,
  // Emit only the traced production server and runtime dependencies. The
  // release image copies this tree instead of the monorepo/build workspace.
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // What the release image must not carry, anchored so Next's substring
  // matcher cannot drop runtime files (see the module).
  outputFileTracingExcludes,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  // Substituted into src/middleware.ts where it reads process.env. Not a
  // secret, and not handled as one: it is written onto every script of every
  // cached docs page, and `env` also travels verbatim in the serialised config
  // (required-server-files.json, server chunks) the way every entry here does.
  env: { POSTWAVE_CACHED_DOCS_SCRIPT_NONCE: cachedDocsScriptNonce },
  // The release image is read-only; pages rendered at request time (the
  // on-demand docs, ISR revalidations) are cached on the writable .next/cache
  // volume instead of inside .next/server. See the module.
  cacheHandler: path.join(__dirname, "incremental-cache-handler.mjs"),
  // The app prerenders more than two thousand docs/marketing routes. BuildKit
  // commonly exposes many host CPUs but a much smaller memory limit, so Next's
  // default one-worker-per-core fan-out can be OOM-killed during multi-arch CI.
  experimental: {
    cpus: 2,
    // Defense in depth for external framework chunks. Per-request nonces are
    // the primary authorization boundary for executable script.
    sri: { algorithm: "sha384" },
  },
  transpilePackages: ["@postwave/schema"],
  serverExternalPackages: ["mjml"],
  typedRoutes: true,
  typescript: {
    ignoreBuildErrors: false,
    tsconfigPath,
  },
  eslint: { ignoreDuringBuilds: false },
  // No `images` block on purpose. next/image is used in zero components — the
  // 14 raw <img> tags in src each carry an explicit no-img-element suppression,
  // and preview-image.tsx documents why the loader is deliberately bypassed for
  // operator-supplied hero images. An empty remotePatterns allowlist alongside
  // that reads like a capability awaiting configuration; it is inert. Sizing is
  // solved at the CDN. If next/image is ever adopted, add the allowlist AND
  // `sharp` to the Dockerfile runtime stage in the same change.
  //
  // Keep Next's route-aware client chunking. A former minChunks=60 cache group
  // reduced repository-wide duplicate bytes, but it also attached a 186 KiB
  // union of unrelated controls to the root layout. That made every visitor
  // pay for modules used on other routes. The route-graph budget is the user
  // contract; optional dashboard controls now have explicit lazy boundaries,
  // so framework chunking can retain them with the routes that invoke them.
  webpack: (config, { dev }) => {
    if (dev && localQaMemoryMode && config.cache?.type === "filesystem") {
      // Let deserialized cache buffers release oversized backing allocations.
      config.cache = { ...config.cache, allowCollectingMemory: true };
    }
    // The OpenAPI spec contains regex strings with textual lone-surrogate
    // escapes (for example `\\uD800`). Webpack's JSON and raw-string
    // serializers can turn that text into an actual lone surrogate in a
    // generated JSON.parse payload. Encode the source as base64 first so its
    // bytes cannot be reinterpreted while the server bundle is minified.
    config.module.rules.push({
      test: /openapi\.json$/,
      resourceQuery: /base64/,
      type: "javascript/auto",
      use: [path.join(__dirname, "scripts/openapi-base64-loader.cjs")],
    });
    // Package release notes are bundled as text (lib/docs/package-changelogs):
    // the standalone image has no packages/ tree to read them from at request
    // time. Vite's built-in ?raw gives vitest the same import.
    config.module.rules.push({
      test: /\.md$/,
      resourceQuery: /raw/,
      type: "asset/source",
    });

    return config;
  },
  // The bare /docs URL is owned by the marketing route group's docs hub
  // (`(marketing)/docs/page.tsx`) — a landing page with its own search and
  // canonical for https://moosewave.com/docs. No redirect: forwarding /docs to
  // /docs/getting-started shadowed that hub and left it unreachable dead code
  // with a self-referential canonical (MKTN-014). /docs/getting-started remains
  // a real route under the (docs) group.
  async redirects() {
    return [];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: globalSecurityHeaders,
      },
      ...noFrameSources.map((source) => ({
        source,
        headers: noFrameHeaders,
      })),
      {
        // Service worker must never be cached at the edge — a stale
        // /sw.js means users get stuck on an old shell forever.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
        ],
      },
      {
        // Next's metadata-convention modules (sitemap.ts / robots.ts) return
        // MetadataRoute objects, not Responses, so they have no header hook of
        // their own. Without an entry here they inherit no caching directive at
        // all and are re-rendered per request — for sitemap.ts that means
        // rebuilding the full route list on every crawler hit.
        source: "/:path(sitemap.xml|robots.txt)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, stale-while-revalidate=86400",
          },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, must-revalidate",
          },
          { key: "Content-Type", value: "application/manifest+json" },
        ],
      },
    ];
  },
};

// Sentry build-time options. Source maps upload runs only when
// SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT are set in the CI env;
// missing creds make this a no-op so local `pnpm build` stays unbroken.
const sentryWebpackPluginOptions = {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
  },
  // Skip source-map upload when there's no auth token (dev / local).
  // The plugin already no-ops in that case but being explicit avoids
  // a benign warning in the build log.
  //
  // `deleteSourcemapsAfterUpload` replaces v8's top-level `hideSourceMaps`
  // (removed in @sentry/nextjs v9): after maps are uploaded to Sentry for
  // server-side symbolication they are deleted from the build output so
  // browsers can't auto-download them from the public CDN. Audit finding
  // (frontend PII): shipped source maps reveal full source code including
  // comments that reference internal endpoint structure.
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
    deleteSourcemapsAfterUpload: true,
  },
};

export default withSentryConfig(
  withSerwist(withNextIntl(nextConfig)),
  sentryWebpackPluginOptions,
);
