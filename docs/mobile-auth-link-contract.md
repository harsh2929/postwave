# Native and browser auth-link contract

Magic-link sign-in and password reset use one signed, versioned contract. This
document is the implementation reference for the API, web app, mobile app, and
desktop app.

## Version 1 envelope

Every emailed magic/reset URL carries:

| Query field | Meaning |
| --- | --- |
| token | One-time API credential |
| v=1 | Contract version |
| flow=magic or reset | Purpose; must match the URL path and consume endpoint |
| aud=mobile or web | Intended consumer (`mobile` denotes a possession-bound native app) |
| state | Required only for native audience; device nonce |
| sig | Base64url HMAC-SHA256 over version, flow, audience, state and token |

The consume body uses the equivalent names link_version, link_flow,
link_audience, state, and link_signature. The API verifies the proof before it
consumes the token. Changing a mobile link to browser audience, changing its
flow/state, or moving a signature to another token fails closed.

Start requests from current clients always send link_version=1 and an explicit
audience. For rolling upgrades only, a start request with neither field is
normalized to browser v1, while a historical request containing only state is
normalized to mobile v1. Emitted and consumed links are always strict v1.

## Native origin binding

Before requesting email, a native app creates local pending state. Mobile also
binds its user-selected API origin into that record:

1. validates the user-selected API URL;
2. writes version, flow, audience, state, email, baseUrl, and expiry to
   device-only SecureStore;
3. asks that API to echo the state in a signed link.

On return, the app validates the link shape, then resolves pending state, then
constructs an API client using only the locally stored baseUrl. It never reads
base_url from an email URL; links containing that legacy parameter are
rejected. This permits any locally selected self-hosted HTTPS API without
allowing a link sender to redirect a credential.

Mobile magic state expires after five minutes and reset state after one hour.
Desktop uses a bounded native state for both email flows (and the existing
OAuth return); an unsolicited mismatch does not erase a still-valid request.
Logout/account switching clears mobile state, while native records are
single-use and expired/corrupt records are purged.

## Installed-app and browser behavior

- Native audience: an installed app consumes only after local state
  verification. If the HTTPS link lands in a desktop browser, the page offers
  a `moosewave://auth/*` handoff that preserves every signed field. Otherwise
  it asks the user to open the requesting device or request a browser link; it
  never bypasses possession state.
- Web audience: the web app consumes normally. If Android intercepts the URL,
  the native app shows a “Continue in browser” action. It opens
  /browser-auth/magic or /browser-auth/reset, paths intentionally excluded from
  AASA and Android intent filters, so no app/browser loop is possible.

App-link ownership is exact for /auth, /auth/magic, /auth/reset,
/auth/oauth-return, /magic-link, and /reset-password. Wildcard auth paths were
removed. The live validator exercises query-only bare-path fixtures and
asserts that /browser-auth paths and nested auth paths remain unclaimed.

## Evidence

Focused coverage lives in:

- apps/api/internal/auth/magiclink_test.go
- apps/api/internal/auth/password_reset_test.go
- apps/mobile/src/lib/magicLinkState.test.ts
- apps/mobile/src/lib/deepLinks.test.ts
- apps/mobile/src/api/auth.test.ts
- apps/web/src/__tests__/auth-link.test.ts
- apps/web/src/__tests__/mobile-app-links.test.ts
- apps/desktop/src/__tests__/lib/auth.test.ts
- apps/desktop/src/__tests__/lib/auth-flow-state.test.ts
- apps/mobile/scripts/app-link-fixtures.mjs
