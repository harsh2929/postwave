# Moosewave audit portal

This is the customer-facing, read-only audit viewer. It has a deliberately
narrow capability boundary: customers can browse their tenant audit feed, but
cannot export, unmask PII, edit retention, or call dashboard APIs.

## Credential flow

1. A tenant admin calls `POST /api/v1/audit/portal/sessions`.
2. The returned URL is `/portal/audit#bootstrap=<signed JWT>`. Fragments are
   never transmitted in HTTP requests.
3. `main.tsx` synchronously removes the fragment and every non-theme query
   parameter before React or application network I/O starts.
4. The SPA posts the bootstrap to `/api/v1/audit/portal/exchange`. The API
   atomically consumes it and returns a distinct `Secure`, `HttpOnly`,
   `SameSite=None`, `Partitioned`, `Path=/` cookie. Only token digests are
   stored.
5. Only `/api/v1/audit/portal/branding` and
   `/api/v1/audit/portal/events` accept that cookie. Authorization headers are
   rejected on those routes.

The bootstrap is one-use; session expiry and revocation are checked against
PostgreSQL on every read under forced tenant RLS.

## Build and verify

```sh
pnpm --filter postwave-audit-portal test
pnpm --filter postwave-audit-portal build
```

Production builds omit source maps. The Go API can serve `dist/` through
`POSTWAVE_PORTAL_SPA_DIR`. The standalone Docker image serves only the portal
shell/assets and proxies only its three public API routes.

Standalone runtime configuration:

- `POSTWAVE_API_ORIGIN`: exact internal HTTP(S) API origin, required.
- `POSTWAVE_PORTAL_FRAME_ANCESTORS`: `'none'`, `'self'`, or exact HTTPS
  origins separated by spaces. Wildcards and paths are rejected at startup, and
  so is an explicitly empty value — leave the variable unset to get `'none'`.
  (An empty value would render `frame-ancestors` with no source list, which
  browsers drop as a parse error; nothing else here forbids framing.)

The API additionally requires `POSTWAVE_PORTAL_ORIGIN`, an independent
`POSTWAVE_PORTAL_JWT_SECRET` of at least 32 bytes, and an existing
`POSTWAVE_PORTAL_SPA_DIR` in production.
