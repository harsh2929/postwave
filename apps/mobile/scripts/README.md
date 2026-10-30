# `apps/mobile/scripts`

Helpers invoked from CI and (occasionally) from a developer's shell.

## `validate-app-links-live.mjs`

Validates the live Universal Link / Android App Link association
documents before a production mobile build starts.

The release workflow runs it through:

```bash
pnpm --filter @postwave/mobile release:app-links-check
```

By default it checks both:

- `https://app.moosewave.com/.well-known/apple-app-site-association`
- `https://app.moosewave.com/.well-known/assetlinks.json`

### Environment variables

| Var                                         | Required | Default                    | Notes                                                                                                     |
| ------------------------------------------- | -------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `POSTWAVE_APP_LINK_ORIGIN`                  | no       | `https://app.moosewave.com` | HTTPS origin to check. Useful for preview hosts.                                                          |
| `POSTWAVE_APP_LINK_CHECK_PLATFORM`          | no       | `all`                      | `ios`, `android`, or `all`. The release matrix sets this via `MATRIX_PLATFORM`.                           |
| `POSTWAVE_APPLE_TEAM_ID`                    | iOS      | —                          | Apple Team ID expected in the AASA `appID`. `EXPO_APPLE_TEAM_ID` or `APPLE_TEAM_ID` are accepted aliases. |
| `POSTWAVE_IOS_BUNDLE_ID`                    | no       | `com.moosewave.app`         | Bundle ID expected in the AASA `appID`.                                                                   |
| `POSTWAVE_ANDROID_PACKAGE_NAME`             | no       | `com.moosewave.app`         | Android package expected in `assetlinks.json`.                                                            |
| `POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS` | Android  | —                          | Comma-separated uppercase SHA-256 signing fingerprints expected in `assetlinks.json`.                     |

The check fails on non-HTTPS origins, missing production identifiers, HTTP
errors, malformed JSON, missing app IDs/package names, or missing required
auth/reset/entity paths. Configuration errors fail before any network request.

## `upload-sourcemaps.sh`

Uploads JavaScript source maps for the bundled Expo app to Sentry so
that production stack traces from `@sentry/react-native` can be
symbolicated back to the original TypeScript.

### What it does

1. Walks `./dist/_expo/static/js/{ios,android}` (the output of
   `expo export`).
2. For each platform directory that exists:
   - Runs `sentry-cli sourcemaps inject` to embed debug-ids in
     both the JS bundle and the `.map` file.
   - Runs `sentry-cli sourcemaps upload` with
     `--release $POSTWAVE_RELEASE --dist <platform>`.
3. Finalizes the Sentry release so events tagged with the same
   release land in the right bucket.

`sentry-cli` is resolved from the workspace install (it ships with
`@sentry/react-native`, already a dependency). It is deliberately **not**
fetched with `npx --yes`.

This script runs with `SENTRY_AUTH_TOKEN` in its environment. `npx --yes`
downloads and executes whatever is published under that name at that moment,
with no version pin — so a compromised or typosquatted publish would run with
the upload token in reach. Resolving a binary that `pnpm install` already
placed on disk removes the install-and-execute step entirely.

The trade is that a fresh clone must run `pnpm install` first; the script says
so and exits non-zero rather than silently downloading a replacement.

### When CI runs this vs when EAS does it

The mobile app has two production-y build paths and Sentry source-map
upload needs to happen exactly once per release on whichever path
ran:

| Build path                                   | Who uploads source-maps                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `eas build --profile production` (EAS Cloud) | `@sentry/react-native` Expo config plugin/native build hooks run inside the EAS container. We do **not** run this script in that path. |
| Diagnostic `expo export` on a GitHub runner  | `.github/workflows/mobile-release.yml` invokes this script and retains the output. The raw export is not an OTA deployment.            |
| Local `expo export` on a dev machine         | Developer runs `pnpm upload-sourcemaps` manually.                                                                                      |

The CI workflow disambiguates with step `id`s: the upload step
runs `if: steps.expo-export.outcome == 'success' &&
env.HAS_SENTRY_AUTH_TOKEN == 'true'` — so it only fires when the
non-EAS export path was actually taken and a Sentry auth token is
available. The token itself is still passed only to the upload step.

### Running locally

You need three env vars and an `expo export` artifact under `./dist`:

```bash
cd apps/mobile

# Build the JS bundle + external source maps (writes ./dist).
pnpm exec expo export --platform ios --source-maps external
pnpm exec expo export --platform android --source-maps external

# Upload the resulting source maps.
SENTRY_AUTH_TOKEN="$(op read op://Moosewave/sentry-cli-token/credential)" \
SENTRY_ORG=postwave \
SENTRY_PROJECT=postwave-mobile \
POSTWAVE_RELEASE="$(git rev-parse HEAD)" \
  ./scripts/upload-sourcemaps.sh
```

Or via the workspace script:

```bash
SENTRY_AUTH_TOKEN=... SENTRY_ORG=postwave SENTRY_PROJECT=postwave-mobile \
  pnpm --filter @postwave/mobile upload-sourcemaps
```

### Environment variables

| Var                 | Required | Default              | Notes                                                                                                    |
| ------------------- | -------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| `SENTRY_AUTH_TOKEN` | yes      | —                    | Personal or org-level Sentry auth token with `project:releases` scope.                                   |
| `SENTRY_ORG`        | yes      | —                    | Sentry org slug (e.g. `postwave`).                                                                       |
| `SENTRY_PROJECT`    | yes      | —                    | Project slug (typically `postwave-mobile`).                                                              |
| `POSTWAVE_RELEASE`  | no       | `git rev-parse HEAD` | Full commit release identifier. CI sets this to `${{ github.sha }}` to match web + desktop + Go backend. |
| `DIST_DIR`          | no       | `./dist`             | Override if `expo export` was pointed somewhere else.                                                    |

### Troubleshooting

**`fatal: dist directory ./dist not found`**
You haven't run `expo export` yet, or it ran with a non-default
output. Re-run the export, or set `DIST_DIR` to wherever the bundle
landed.

**`no platform bundle directories found under .../_expo/static/js/{ios,android}`**
The export ran but produced neither platform — likely a different
output structure from a non-Router build. Inspect `dist/` and
adjust the script's path constants if Expo has changed its export
layout in a major version.

**`401 Unauthorized` from `@sentry/cli`**
The auth token is missing, expired, or doesn't have access to the
org / project. Re-generate at
[sentry.io/settings/account/api/auth-tokens](https://sentry.io/settings/account/api/auth-tokens)
with `project:releases` + `org:read` scopes.

**`release already exists` (warning)**
Harmless on re-runs of the same commit. Sentry de-duplicates by
release name. The `finalize` step at the end has `|| true` to
tolerate this.

**Upload succeeded but stack traces still aren't symbolicated**
Confirm the runtime event tags match the upload tags:

- `release` must match `POSTWAVE_RELEASE` in this script (and the
  `SENTRY_RELEASE` env baked into the EAS build).
- `dist` must match the platform (`ios` or `android`).
  Open the event in Sentry → "Tags" panel and compare.
