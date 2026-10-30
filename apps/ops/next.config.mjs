// SPDX-License-Identifier: AGPL-3.0-only
//
// The ops console is a single server-rendered page. No rewrites, no images,
// no experiments — the board is fetched server-side per request and rendered
// as plain HTML.

// Deliberately no Cache-Control here (apps/web/next.config.mjs does the same):
// a header list bound to `/:path*` also lands on `/_next/static/*`, and Next
// does not carve those out. `no-store` there would forbid even a conditional
// revalidation of content-hashed, immutable chunks, so the console would
// re-download its whole bundle on every load. Freshness is already guaranteed
// where it matters — every page is `force-dynamic` (Next serves those
// no-store) and every route handler sets `cache-control: no-store` itself.
const securityHeaders = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=()" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
