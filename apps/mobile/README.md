# Moosewave Mobile

React Native app for the Moosewave platform. Ships on iOS + Android via EAS.

**Stack** — Expo / React Native, Expo Router, NativeWind, TanStack Query,
Zustand, and `@postwave/sdk` (workspace). Exact checked-in versions, native
identifiers, and EAS distribution semantics are generated from the manifests
in [runtime-config.generated.md](./runtime-config.generated.md); CI rejects drift.

## Layout

```
apps/mobile/
├── app/                       Expo Router file-based routes
│   ├── _layout.tsx            Root: hydrate auth, providers, splash, deep links
│   ├── index.tsx              "/"  → redirect to (auth) or (tabs)
│   ├── (auth)/
│   │   ├── _layout.tsx        Logged-out group
│   │   ├── sign-in.tsx        Email + password (primary)
│   │   ├── sign-up.tsx        Email + password + workspace name + slug
│   │   ├── forgot-password.tsx  Request reset link
│   │   ├── totp.tsx           Per-session MFA challenge
│   │   ├── magic-return.tsx   Signed v1 magic-link completion
│   │   ├── reset-confirm.tsx  Signed v1 password-reset completion
│   │   └── login.tsx          Legacy API-key paste (still supported)
│   └── (tabs)/
│       ├── _layout.tsx        Bottom tabs (logged-in)
│       ├── dashboard.tsx
│       ├── subscribers.tsx
│       ├── subscribers/[id].tsx
│       ├── campaigns.tsx
│       ├── campaigns/[id].tsx
│       ├── campaigns/[id]/ab-results.tsx
│       ├── approvals.tsx
│       ├── voice.tsx
│       ├── sequences/index.tsx
│       ├── sequences/[id].tsx
│       ├── more.tsx           Secondary ops/admin route index
│       ├── lists.tsx / tags.tsx / suppressions.tsx
│       ├── integrations.tsx / inbound-webhooks.tsx / custom-domains.tsx
│       ├── sending-settings.tsx / dmarc.tsx / audit.tsx / archive.tsx
│       ├── discounts.tsx / migrations.tsx / scim.tsx / audit-sinks.tsx
│       ├── agency.tsx / scan.tsx
│       └── settings.tsx       Account, security, privacy, webhooks, voice labels
└── src/
    ├── api/client.ts          Compatibility facade over domain API modules
    ├── api/sdkClient.ts       Memoised PostwaveClient factory
    ├── api/request.ts         Shared AIApiResult/rawRequest envelope helpers
    ├── api/eventBus.ts        Realtime stream-token + SSE connector
    ├── api/inlineAI.ts        Send-time, inbox prediction, streaming AI helpers
    ├── api/mobileParity.ts    Onboarding + Mailchimp parity readers
    ├── api/abTests.ts         A/B create/results wrappers
    ├── api/sequences.ts       Voice sequence wrappers
    ├── api/settings.ts        Settings + outbound webhook wrappers
    ├── api/ops.ts             Migration/SCIM/audit-sink/agency readers
    ├── api/voiceLabels.ts     Voice-label CRUD wrappers
    ├── api/nativeClient.ts    Native-client headers for CSRF/origin gates
    ├── api/auth.ts            Email-auth surface (login/signup/magic/totp/oauth)
    ├── store/auth.ts          Zustand + expo-secure-store (api_key + session modes)
    ├── lib/queryClient.ts     TanStack defaults
    ├── lib/push.ts            Expo notifications → dedicated device API
    ├── lib/deepLinks.ts       Notification + auth-link → in-app route
    ├── components/            Card, Chip, Pill, EmptyState, StatCard, TabBarIcon
    └── hooks/                 useSubscribers, useDashboard, …
```

## Auth modes

The app supports two coexisting authentication modes. Both populate the
same Zustand store so route guards / sign-out are uniform.

### 1. Email + password (recommended)

Backed by the Phase 11 backend (`apps/api/internal/auth/handlers.go`).
Path:

1. User signs up at `/(auth)/sign-up` (or signs in at `/(auth)/sign-in`).
2. Backend sets a `pw_session` cookie. RN's stock fetch + native cookie
   jar (NSURLSession on iOS, OkHttp on Android) round-trips the cookie
   on every subsequent call to the same origin.
3. We call `/api/v1/auth/me` to snapshot the user profile (email, role,
   tenant, workspace name) into SecureStore.
4. The `/(auth)/totp` gate calls `/totp/challenge` to flip
   `mfa_satisfied` on the session — short-circuits for non-MFA users.
5. Magic-link and reset flows store a random, origin-bound pending state
   before requesting email. The API returns a signed v1 link envelope
   (`v`, `flow`, `aud`, `state`, `sig`); the native return screen verifies
   local state before constructing a client for that stored origin. A link can
   never select an API URL.
6. Browser-audience links intercepted by Android show an explicit “Continue
   in browser” action to `/browser-auth/*`, which is intentionally excluded
   from iOS/Android app-link ownership.

### 2. API key (legacy / power users)

The original mobile auth flow. Reach it from the "I have an API key"
link at the bottom of `/(auth)/sign-in`, which routes to
`/(auth)/login`. The user pastes:

- API base URL (e.g. `https://api.moosewave.com` or self-hosted)
- Tenant slug
- Long-lived API key (`pw_live_…`)

The triple is written to `expo-secure-store` and the SDK sends
`Authorization: Bearer pw_…` on every request.

### Sign-out

`useAuthStore.signOut()` clears both modes:

- For session mode: best-effort `POST /api/v1/auth/logout` to revoke
  the server-side record, then wipes SecureStore.
- For API-key mode: just wipes SecureStore.

## Local dev

```bash
# from repo root
pnpm install

# copy env template, edit if needed
cp apps/mobile/.env.example apps/mobile/.env

# start Metro + open the dev menu
pnpm --filter @postwave/mobile start

# open in iOS simulator (macOS only)
pnpm --filter @postwave/mobile ios

# open in Android emulator (Android Studio AVD must be running)
pnpm --filter @postwave/mobile android
```

### Simulator and emulator

The checked-in development EAS profile uses loopback. It is directly usable by
the iOS simulator. For an Android emulator or USB-connected Android device,
reverse the ports before launch so the app's `localhost` reaches the host:

```bash
adb reverse tcp:8080 tcp:8080
adb reverse tcp:3000 tcp:3000
```

Do not substitute `10.0.2.2` or a LAN-IP HTTP URL: the same fail-closed URL
policy used by the SDK intentionally permits plain HTTP only on loopback.

### Physical-device development

A phone cannot normally reach the host's `localhost`. Give both services an
organization-approved HTTPS tunnel or a LAN hostname whose certificate chain
is trusted by the device, then put the origins (without paths) in the local,
uncommitted `.env`:

```dotenv
EXPO_PUBLIC_API_URL=https://api-mobile-dev.example.test
EXPO_PUBLIC_APP_URL=https://app-mobile-dev.example.test
EXPO_PUBLIC_BUILD_PROFILE=development
```

Before starting Metro, verify both URLs from the device browser, verify the API
certificate without bypassing a warning, and confirm the API's CORS/origin
allowlist includes the app origin. Never place API keys, session tokens, or
customer identifiers in a tunnel URL. Production and preview profiles remain
pinned to the approved Moosewave HTTPS origins.

`EXPO_PUBLIC_APP_URL` is the browser-facing web origin used for public
archive links shared from mobile. It defaults to `https://app.moosewave.com`;
self-hosted deployments should set it to their web-app origin.

## Type checking

```bash
pnpm --filter @postwave/mobile typecheck
```

Strict mode + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
are all on; the CI gate trips on any type error.

## Deterministic workspace build

`pnpm --filter @postwave/mobile build` creates clean iOS and Android Hermes
exports under `.expo/verification-export`, requires external source maps, and
enforces checked-in per-platform bundle, asset, and font-count budgets. This is
a source-artifact verification target, not a signed IPA/AAB or an OTA update.
Root `pnpm build` includes it through Turbo, so a green workspace build cannot
silently omit mobile.

## Push notifications

Mobile push uses a dedicated current-user device API; it is not implemented as
a tenant webhook or a public notification relay:

1. The phone asks the OS for notification permission and an Expo push token.
2. A signed-in human session posts the token, platform, enabled event types,
   and a random installation key to `POST /api/v1/mobile/push/devices`. API
   keys cannot register a person's device.
3. The API stores only token/key digests plus an envelope-encrypted token. It
   never places the token in a URL or returns it from a list/status response.
4. Server-owned notification templates send only an event type and opaque
   entity ID to Expo. The durable delivery ledger applies an idempotency key,
   bounded retries, and receipt reconciliation; terminal
   `DeviceNotRegistered` responses revoke the exact installation.
5. Sign-out revokes the installation before local credentials are cleared. If
   the origin is temporarily unavailable, a bounded SecureStore journal keeps
   the possession-only revocation request for a later retry, including across
   account or server-origin changes.

The current application composition delivers actionable
`approval.requested` notifications to eligible users. The shared notification
catalog and device event allowlist cover additional event types, but an entry
in those catalogs is not a claim that its server-side producer is enabled for
this release.

### Android push: Firebase Cloud Messaging

On Android, `expo-notifications` gets the device token from Firebase Cloud
Messaging (FCM). A build without Firebase config still compiles, but
`getExpoPushTokenAsync` then fails on every device: the Settings switch turns
itself back off, launch-time registration does nothing, and approval pushes
never arrive. iOS uses APNs and needs none of this.

One-time setup:

1. In the Firebase console, add an Android app with the package name
   `com.moosewave.app` and download its `google-services.json`. Do not commit
   it.
2. Upload that file to EAS as a **file** environment variable named
   `GOOGLE_SERVICES_JSON`, in both the `production` and `preview`
   environments (expo.dev → the project → Environment variables). On the
   worker its value is the file's path. `app.config.js` passes that path to
   `android.googleServicesFile`, which makes prebuild apply the
   google-services Gradle plugin.
3. Give Expo's push service the FCM V1 service-account key:
   `pnpm dlx eas-cli credentials` → Android → Push Notifications (FCM V1) →
   upload the service-account key JSON from Firebase (Project settings →
   Service accounts). Without it, devices register tokens that Expo cannot
   deliver to.

The EAS pre-install hook (`scripts/validate-production-env.mjs`) fails an
Android production or preview build when `GOOGLE_SERVICES_JSON` is unset, is
not a JSON file, or has no client for `com.moosewave.app`. The GitHub runner
and local builds skip that check because they never see the EAS file variable,
so a local or native-smoke prebuild builds without FCM rather than failing.

## Building for the stores (EAS)

You'll need:

- An Expo account (https://expo.dev/signup)
- The EAS CLI (`pnpm dlx eas-cli` works; or `npm i -g eas-cli`)
- An Apple Developer Program membership (iOS, $99/yr)
- A Google Play Developer account (Android, $25 one-time)

### One-time account setup

```bash
# 1. Sign in to Expo
pnpm dlx eas-cli login

# 2. Configure credentials. EAS walks you through Apple cert + provisioning
#    profile generation and Android keystore creation. Pick "Let EAS handle
#    credentials" unless you have prior reasons to BYO.
cd apps/mobile
pnpm dlx eas-cli credentials
```

Provision the Expo project once under the organization account, then store its
owner slug as `EXPO_OWNER` and canonical project UUID as
`EXPO_PUBLIC_EAS_PROJECT_ID` in the protected `mobile-production` GitHub
environment and the EAS production environment. `app.config.js` injects both
values into the resolved Expo configuration. Do not run `eas init` during a
tagged build or rely on a developer-local edit to `app.json`; the release
preflight fails closed when either binding is absent or malformed.

### Build profiles

`eas.json` declares three profiles. Pick the one that matches the audience:

| Profile       | Distribution | iOS output        | Android output | Use when                                       |
| ------------- | ------------ | ----------------- | -------------- | ---------------------------------------------- |
| `development` | internal     | simulator build   | APK            | Simulator/emulator development                 |
| `preview`     | internal     | ad-hoc signed IPA | APK            | Registered-device QA and managed sideloading   |
| `production`  | store        | App Store IPA     | Play AAB       | TestFlight/closed-track certification, rollout |

### Build commands

```bash
# Internal preview build (recommend running both platforms in parallel)
pnpm dlx eas-cli build --profile preview --platform ios
pnpm dlx eas-cli build --profile preview --platform android

# Store-ready build
pnpm dlx eas-cli build --profile production --platform ios
pnpm dlx eas-cli build --profile production --platform android
```

EAS queues the build on its cloud workers. You can watch the log live
or come back to the dashboard at expo.dev/accounts/<your-org>/projects/postwave/builds.

### Submission

```bash
# Once the production build completes, submit it
pnpm dlx eas-cli submit --profile production --platform ios
pnpm dlx eas-cli submit --profile production --platform android
```

For iOS this uploads the IPA to App Store Connect for processing and
TestFlight certification; it does not submit an App Review release by itself.
For Android it uploads the AAB to the Play Console internal track by default;
promote only after smoke testing the exact build ID.

## App Store Connect (iOS) checklist

Before submitting:

- [ ] Apple Developer Program membership active
- [ ] App ID registered: `com.moosewave.app` (developer.apple.com → Certificates → Identifiers)
- [ ] Push capability enabled on the App ID
- [ ] App Store Connect record created: My Apps → New App
- [ ] Its numeric Apple ID (App Information) set as `EXPO_PUBLIC_IOS_APP_STORE_ID`
      in the EAS `production` environment and as a variable in the
      `mobile-production` GitHub environment. The iOS production preflight
      fails until it is set (see "CI")
- [ ] Bundle ID matches: `com.moosewave.app`
- [ ] App-Specific password generated for `eas submit` (appleid.apple.com → Sign-In and Security)
- [ ] Provide App Store Connect account IDs to `eas submit` or CI secrets:
  - `appleId` (the email)
  - `ascAppId` (numeric, from ASC → App Information)
  - `appleTeamId` (10-character, from developer.apple.com → Membership)
- [ ] Privacy questionnaire answered (no encryption beyond standard HTTPS, no IDFA)
- [ ] App Privacy answers transcribed row by row from each `data_types` row's
      `apple` object in `docs/compliance-2026-09/store-data-disclosure.json`
      (no data used for tracking). Select exactly these types, and remove any
      earlier answer that says photos or camera images are not collected:
  - Contact Info → Email Address (linked, not tracking; App Functionality)
  - Identifiers → User ID (linked, not tracking; App Functionality)
  - Identifiers → Device ID (linked, not tracking; App Functionality)
  - Usage Data → Product Interaction (not linked, not tracking; Analytics)
  - Diagnostics → Crash Data (not linked, not tracking; App Functionality, Analytics)
  - Diagnostics → Performance Data (not linked, not tracking; App Functionality, Analytics)
  - User Content → Photos or Videos (linked, not tracking; App Functionality)
- [ ] Account deletion is visible in Settings and the external deletion URL is live:
      `https://moosewave.com/legal/account-deletion`
- [ ] Privacy Policy and Terms are linked inside the app on auth screens and Settings
- [ ] Required iPhone and 13-inch iPad screenshots uploaded (iPad support enabled 2026-07-27; portrait, full screen)
- [ ] App description + keywords + support URL filled in
- [ ] Privacy policy URL points to the live page

## Google Play Console (Android) checklist

Before submitting:

- [ ] Play Developer account active
- [ ] App created in the Play Console: All apps → Create app
- [ ] Package name matches: `com.moosewave.app`
- [ ] Closed-testing internal track configured (or open testing if preferred)
- [ ] Service account created in GCP IAM, granted access in Play Console
      (Setup → API access)
- [ ] Service account .json key downloaded and supplied to `eas submit` or CI
      secrets for the Play Developer API upload step
- [ ] Firebase Android app registered for `com.moosewave.app`, and its
      `google-services.json` uploaded as the EAS file variable
      `GOOGLE_SERVICES_JSON` in the production and preview environments (see
      "Android push: Firebase Cloud Messaging")
- [ ] FCM V1 service-account key uploaded with `eas credentials` (Android →
      Push Notifications)
- [ ] Device pass on a Play build: enable push in Settings, relaunch, and
      receive an actionable approval push
- [ ] Data safety answers transcribed row by row from each `data_types` row's
      `play` object in `docs/compliance-2026-09/store-data-disclosure.json`
      (nothing shared, data encrypted in transit). Declare exactly these types,
      and remove any earlier answer that says photos or camera images are not
      collected. Mark data deletion as supported in-app and on the web:
  - Personal info → Email address (collected, not shared, required, not ephemeral; Account management, App functionality)
  - Personal info → User IDs (collected, not shared, required, not ephemeral; Account management, App functionality)
  - Device or other IDs → Device or other IDs (collected, not shared, required, not ephemeral; App functionality)
  - App activity → App interactions (collected, not shared, optional, not ephemeral; Analytics)
  - App info and performance → Crash logs (collected, not shared, optional, not ephemeral; Analytics, App functionality)
  - App info and performance → Diagnostics (collected, not shared, optional, not ephemeral; Analytics, App functionality)
  - Photos and videos → Photos (collected, not shared, optional, not ephemeral; App functionality)
- [ ] Content rating completed
- [ ] Target API level meets Play's current minimum for the submission window
      (verify from the generated `.aab` / Play Console pre-check before upload)
- [ ] Privacy policy URL set in the Play Console listing
- [ ] Account deletion URL set in Play Console:
      `https://moosewave.com/legal/account-deletion`
- [ ] Screenshots + feature graphic uploaded

## Deep links

Configured in `app.json`:

- iOS Universal Links: `applinks:app.moosewave.com` (exact auth paths carry a
  signed v1 envelope and open the app directly)
- Android App Links: same hostname, autoVerify=true (requires the
  `.well-known/assetlinks.json` to be served by the marketing site)
- Custom scheme: `moosewave://` for everywhere a Universal Link can't
  reach

The router handler lives in `app/_layout.tsx`'s URL effect; the
mapping rules are in `src/lib/deepLinks.ts` (see `routeForAuthLink`).
Links never select an API origin. Mobile-only links first resolve their
one-time `state` against locally pending auth state; web-audience links that
are intercepted by the app expose an explicit browser continuation instead.

## Workspace integration

This app is a regular pnpm workspace member:

- Imports `@postwave/sdk` directly from `packages/sdk-ts`. Hot-reload
  in the SDK reaches the mobile app through Metro's `watchFolders`.
- TypeScript path aliases (`@/*` → `src/*`, `@app/*` → `app/*`) are
  declared in `tsconfig.json` and recognised by Expo Router via
  `experiments.tsconfigPaths`.

## Conventions

- All async error paths return their string to the UI rather than
  letting them throw into the React tree. The SDK's typed errors
  (`AuthError`, `RateLimitError`, etc.) are re-thrown by handlers when
  the user needs to see something specific.
- No global toast surface in V1 — local in-screen errors only. Adding
  Sonner-style toasts is straightforward when needed.
- Mobile is still biased toward on-the-go monitoring, but it now includes
  targeted write paths: subscriber suppression/list membership, campaign
  scheduling/test-send/send-now actions, A/B creation/results, sequence
  editing with offline replay, settings/privacy/outbound-webhook edits, and
  voice-label calibration. Full campaign composition and heavy admin workflows
  still belong on the web.

## CI

`.github/workflows/mobile-release.yml` triggers on `mobile-v*` tags and can be
run manually. It gates lint, typecheck, tests, Expo Doctor, release version,
live app links, and production runtime configuration before starting EAS. It
retains each exact EAS build ID, waits for every selected platform, and submits
only those IDs. Manual `build_mode=export` produces a retained diagnostic JS
artifact only: it is not an OTA update and can never be submitted to a store.

A run with `submit_after_build=true` must be dispatched on a
`mobile-v<expo.version>` tag; `release:version-check` refuses one on a branch.
`runtimeVersion` follows `expo.version` (policy `appVersion`), so every binary
built at one version takes every OTA update published for it, and nothing
bumps that version when the native surface changes. Bump `expo.version` and
`package.json` `version` by hand for any change to native dependencies, config
plugins, `targets/` or `patches/`, then tag. Publish an EAS Update only from
the release tag's hotfix line, never from `main`.

Both build and submit jobs reference the `mobile-production` GitHub
environment. Configure that environment with required reviewers and put its
least-privilege secrets there before enabling the workflow. The EAS project
also needs a separate `production` environment; GitHub variables are not proof
that the remote EAS worker has the same values. The EAS pre-install hook checks
the remote environment and derives the public/Sentry release from
`EAS_BUILD_GIT_COMMIT_HASH`.

Required GitHub secrets / variables for a production run:

- `EXPO_TOKEN`: Expo access token (expo.dev → User Settings → Access Tokens).
- `APPLE_TEAM_ID`: Apple Team ID used for iOS provisioning and AASA appID checks.
- `POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS`: comma-separated SHA-256 signing fingerprints expected in `assetlinks.json`.
- `EXPO_PUBLIC_SENTRY_DSN_MOBILE`: public mobile Sentry DSN.
- `EXPO_PUBLIC_POSTHOG_KEY` and `EXPO_PUBLIC_POSTHOG_HOST`: product analytics config.
- `EXPO_OWNER` and `EXPO_PUBLIC_EAS_PROJECT_ID`: immutable Expo project
  ownership/binding used by EAS and push registration.
- `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT`: Sentry source-map upload credentials.
- `EXPO_PUBLIC_IOS_APP_STORE_ID` (a variable, iOS builds only): the numeric
  Apple ID of the App Store Connect app record (App Information), the same
  number as `ASC_APP_ID`. The forced-upgrade screen opens this App Store
  listing; without it the button opens an App Store search. Set it here and in
  the EAS `production` environment, which is where the remote worker bundles
  it from. The preflight fails an iOS production build that lacks it or has a
  value that is not 6 to 12 digits.

Required in the EAS environments only (the GitHub runner never reads it):

- `GOOGLE_SERVICES_JSON`: a file variable holding the Firebase
  `google-services.json` for `com.moosewave.app`, in both `production` and
  `preview`. The pre-install hook fails an Android production or preview
  build without it. See "Android push: Firebase Cloud Messaging".

In neither list because it is not a secret: `EXPO_UPDATES_CODE_SIGNING_CERTIFICATE`,
the path of the committed public OTA update certificate. The workflow's build
job and the `production` and `preview` profiles in `eas.json` set it to
`certs/postwave-updates.pem`, so do not add it to either environment. The
certificate itself has to be committed first; see "OTA update code signing"
below.

Optional submit secrets, only needed when `submit_after_build=true`:

- iOS: `ASC_APP_ID`, `ASC_API_KEY_ID`, `ASC_API_KEY_ISSUER_ID`,
  `ASC_API_KEY_P8_BASE64`, and `APPLE_TEAM_ID`.
- Android: `GOOGLE_SERVICE_ACCOUNT_JSON`.

Before cutting a `mobile-v*` tag, verify the live association files
with the real production identifiers:

```bash
POSTWAVE_APPLE_TEAM_ID=ABCDE12345 \
POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS="AA:BB:..." \
  pnpm --filter @postwave/mobile release:app-links-check
```

After the production workflow completes, keep these artifacts with the
release notes:

- The `Validate live app link association files` step passed for iOS and Android.
- The `Validate production runtime env` step passed for iOS and Android.
- The EAS build URLs for both platforms.
- The retained `eas-build-<platform>-<run>-<attempt>` evidence matches the tag commit.
- Sentry shows uploaded mobile source maps/debug IDs for the workflow commit SHA.
- A device smoke test opens at least one `https://app.moosewave.com/app/...`
  Universal Link / Android App Link directly into the app.

### OTA update code signing

Every binary that has an EAS Update channel (every profile except
`development`) must ship an expo-updates code-signing certificate. It then
runs only updates signed by the matching private key. Without signing, anyone
holding a leaked `EXPO_TOKEN` could publish JS that every install runs.
`app.config.js` refuses to configure an unsigned channel, and there is no
override.

- **Certificate (public, committed):** `apps/mobile/certs/postwave-updates.pem`.
  The root `.gitignore` ignores `*.pem` but makes an exception for this one
  file. The exception has to be in the root file, because eas-cli copies the
  working tree to the EAS worker through each `.gitignore` separately and an
  exception in `apps/mobile/.gitignore` would not reach it.
- **Path:** the build job in `mobile-release.yml` and the `production` and
  `preview` profiles in `eas.json` set `EXPO_UPDATES_CODE_SIGNING_CERTIFICATE`
  to `certs/postwave-updates.pem`, relative to `apps/mobile`. Keep the three
  identical; `scripts/validate-production-env.test.mjs` fails if they differ.
- **Private key:** held by a named custodian. It never goes in this repo,
  `eas.json`, an EAS build environment or the `mobile-production` GitHub
  environment, and it is kept apart from `EXPO_TOKEN`. Use it only to publish,
  with `eas update --private-key-path <path>`. Key custodian: _not yet named;
  record the person or role here before the first signed release._

Until the certificate is committed, a release fails at the EAS Build step
with `EXPO_UPDATES_CODE_SIGNING_CERTIFICATE points at
certs/postwave-updates.pem, which does not exist under apps/mobile`.

To create the pair (once, by the custodian), write both files to a directory
outside the repo, then copy only the certificate in:

```bash
npx expo-updates codesigning:generate \
  --key-output-directory <outside-the-repo>/keys \
  --certificate-output-directory <outside-the-repo>/certs \
  --certificate-validity-duration-years 10 \
  --certificate-common-name Moosewave
cp <outside-the-repo>/certs/certificate.pem apps/mobile/certs/postwave-updates.pem
```

Commit `apps/mobile/certs/postwave-updates.pem` and nothing else from that
directory. Binaries already in the field trust only the certificate they
shipped with, so replacing the certificate needs a new store build.
