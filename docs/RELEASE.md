# Release operator runbook

Audience: the human pushing release tags. This file is the single index
of every Moosewave release pipeline — what they do, how to invoke them,
which secrets they need, and where to look when they fail. The deeper
per-pipeline runbooks live alongside this one (see "Related runbooks"
at the bottom).

If you've never cut a release before, skim section 1 ("What ships, on
what trigger") top-to-bottom, then jump to the section for the artifact
you're shipping.

---

## 1. What ships, on what trigger

Moosewave has five release pipelines. Each is independently triggerable
so a desktop release doesn't force a backend redeploy and vice versa.

| Pipeline                 | Trigger                    | Artifacts                                                                                                    | Workflow file                                |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| Backend container images | Push to `main`             | Six signed, multi-architecture GHCR images, including the immutable DB migrator                              | `.github/workflows/docker-push.yml`          |
| Desktop app              | Tag matching `desktop-v*`  | Signed/notarized macOS `.dmg` + `.app.tar.gz`, signed Windows `.msi` + `.exe`, signed Tauri updater manifest | `.github/workflows/desktop-release.yml`      |
| npm packages             | Tag matching `packages-v*` | The 14 allowlisted public `@postwave/*` packages, with npm provenance                                        | `.github/workflows/publish-packages.yml`     |
| VS Code extension        | Tag matching `vscode-v*`   | Verified `.vsix`, GitHub SLSA attestation, Marketplace release                                               | `.github/workflows/publish-vscode.yml`       |
| CI verification          | PR + push to `main`        | None — gates merges                                                                                          | `.github/workflows/{ci,test,desktop-ci}.yml` |

The five pipelines have no dependencies between them. You can ship a
desktop release without re-pushing containers, and vice versa.

---

## 2. Cutting a backend release (Docker images)

The `docker-push.yml` workflow rebuilds and pushes five Go-service images
and the dedicated database migrator on every push to `main`. There is no
human action required to
"cut" a backend release — merging to main is the release.

### What gets pushed

For each of `api`, `voice`, `automation`, `deliverability`, `migration`,
and `db-migrator`:

```
ghcr.io/<owner>/postwave-<service>:latest
ghcr.io/<owner>/postwave-<service>:main
ghcr.io/<owner>/postwave-<service>:sha-<commit-sha>
```

`<owner>` is the lowercased GitHub repo owner.

### What to deploy

ECS task definitions and CloudFormation stacks should reference
`:sha-<commit-sha>`, never `:latest`. `:latest` is for `docker pull`
convenience in operator workflows; pinning production to it defeats
rollback.

### Required secrets

None. The workflow uses `GITHUB_TOKEN` with `packages: write`
permissions, which is automatic.

### Common failures

- **403 on push** — the repo owner is mixed-case. The workflow
  lowercases it (see the "Lowercase repository owner" step) but a
  forked repo with a renamed owner can mismatch the package's
  pre-existing owner. Visit `https://github.com/users/<owner>/packages`
  and delete the orphan package, then re-run.
- **Cache miss on every build** — `cache-to: type=gha,mode=max`
  populates the GitHub Actions cache per `scope`. Scope keys include
  the service name; renaming a service invalidates its cache once,
  which is fine.

---

## 3. Cutting a desktop release

### Pre-flight (5 minutes)

1. Confirm `apps/desktop/CHANGELOG.md` has an entry for the new version.
2. Confirm `apps/desktop/src-tauri/tauri.conf.json` `version` matches.
3. Confirm `apps/desktop/package.json` `version` matches.

### Cut the release

```sh
# Replace 0.2.0 with the actual version.
git tag -a desktop-v0.2.0 -m "Moosewave Desktop 0.2.0"
git push origin desktop-v0.2.0
```

The push triggers `desktop-release.yml`, which:

1. Builds a universal macOS bundle (Apple Silicon + Intel) on `macos-14`.
2. Builds a Windows x86_64 bundle on pinned `windows-2022`.
3. Validates the complete icon matrix, Rust advisories, tests, release
   version, signing identities, updater configuration, and source-map policy.
4. Requires Apple signing/notarization, Windows signing, updater signing,
   and Sentry upload credentials for a tag release. Missing production
   material fails before an unsigned artifact can be presented as releasable.
   Manual workflow runs remain dry runs and may build unsigned artifacts.
5. For a tag run, creates a draft GitHub Release with the artifacts attached.
   A manual run creates no release and keeps its unsigned test bundles only as
   workflow artifacts.
6. Generates `latest.json` (the Tauri updater manifest), signed with
   `TAURI_SIGNING_PRIVATE_KEY`.

### Publish the draft release

Every tag run creates a _draft_. After smoke-testing (download
.dmg / .msi from the draft release, install, launch), edit the draft
on GitHub and click "Publish release". Auto-publish is intentionally
disabled because retracting a published release is messy.

### Required secrets

#### macOS code-signing (required for tag releases)

| Secret                       | What it is                                                                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64-encoded `.p12` export of the Developer ID Application cert. Acquire from [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates), export as `.p12` from Keychain Access, then `base64 -i cert.p12 \| pbcopy`. |
| `APPLE_CERTIFICATE_PASSWORD` | The password set when you exported the `.p12`.                                                                                                                                                                                                                                |
| `APPLE_SIGNING_IDENTITY`     | The exact CN of the cert, e.g. `Developer ID Application: Moosewave Inc. (ABCDE12345)`. Find via `security find-identity -v -p codesigning`.                                                                                                                                   |
| `APPLE_ID`                   | Apple ID email of the developer account used for notarization.                                                                                                                                                                                                                |
| `APPLE_TEAM_ID`              | 10-character team ID from [developer.apple.com/account#MembershipDetailsCard](https://developer.apple.com/account#MembershipDetailsCard).                                                                                                                                     |
| `APPLE_PASSWORD`             | App-specific password generated at [appleid.apple.com](https://appleid.apple.com/) → Sign-In and Security → App-Specific Passwords. NOT your regular Apple ID password — Apple blocks those for `notarytool`.                                                                 |

Without `APPLE_CERTIFICATE` (or any companion secret), a tag build fails
before bundling. A manual dry run may still produce an unsigned `.dmg` for
internal pipeline testing; it must never be shared as a production release.

Without all of `APPLE_ID` + `APPLE_TEAM_ID` + `APPLE_PASSWORD`, a tag
release fails. Set all three together so the signed application is also
notarized and stapled.

#### Windows code-signing (required for tag releases)

| Secret                         | What it is                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WINDOWS_CERTIFICATE`          | Base64-encoded `.pfx` export of the EV (or OV) code-signing cert. Vendor (Sectigo, DigiCert, GlobalSign) ships you a USB token or a downloadable cert; export from the Windows cert store as `.pfx`, then base64. |
| `WINDOWS_CERTIFICATE_PASSWORD` | The password set when you exported the `.pfx`.                                                                                                                                                                    |

Without either Windows certificate secret, a tag build fails. Manual dry
runs may create unsigned installers for internal testing only.

EV certs (Extended Validation, requires hardware token) build
SmartScreen reputation immediately. OV certs (Organization Validation,
software-only) require ~3000 unique installs to build reputation
before SmartScreen stops warning. Budget for an EV cert if you're
shipping to consumers.

#### Tauri updater (required for tag releases)

| Secret                               | What it is                                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Base64-encoded ed25519 private key. Generate with `pnpm tauri signer generate -w ~/.tauri/postwave.key` and base64-encode the resulting private key file. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password set when generating the keypair.                                                                                                                 |

The matching public key goes into
`apps/desktop/src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.
Once shipped, you can NEVER rotate this keypair without a manual
re-install — the public key is baked into every installed copy of the
app. Treat it like a CA root.

Tag builds also require `POSTWAVE_UPDATER_PUBKEY` and an HTTPS
`POSTWAVE_UPDATER_ENDPOINT`; missing or malformed updater configuration
fails the release preflight. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is
required when the private key was generated with a password.

#### Sentry source maps (required for tag releases)

The macOS matrix leg requires `SENTRY_AUTH_TOKEN` and `SENTRY_ORG`, uploads
the release maps with pinned `@sentry/cli`, finalizes the Sentry release,
then deletes the maps before native packaging. The workflow verifies that
no `.map` file enters a customer bundle. `VITE_SENTRY_DSN_DESKTOP` remains
optional; omitting it disables runtime Sentry initialization.

### Common notarization failures

| Symptom                                                                        | Likely cause                                                                                                                                               | Fix                                                                                                                                                                          |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xcrun notarytool submit` exits with `Invalid Credentials`                     | `APPLE_PASSWORD` is your regular Apple ID password, not an app-specific password.                                                                          | Regenerate at [appleid.apple.com](https://appleid.apple.com/) → App-Specific Passwords. Update the `APPLE_PASSWORD` secret.                                                  |
| Notarization succeeds, but `spctl -a` says "rejected"                          | `.app` was signed but not stapled. tauri-action staples automatically; if you're invoking `tauri build` manually, run `xcrun stapler staple Moosewave.app`. | Use the workflow, not local builds, for shipping artifacts.                                                                                                                  |
| "The signature does not include a secure timestamp."                           | `codesign` was invoked without `--timestamp`. tauri-action does this correctly; check you haven't overridden bundling args.                                | Remove any custom `args:` that disables timestamps.                                                                                                                          |
| Notarization log: "The executable does not have the hardened runtime enabled." | The bundle was signed without hardened runtime.                                                                                                            | Confirm `bundle.macOS.hardenedRuntime` is `true`, `apps/desktop/src-tauri/entitlements.plist` is referenced, and the signing command did not override Tauri's runtime flags. |
| Notarization stuck in "In Progress" >30m                                       | Apple's queue depth. Notarization SLA is "minutes" but degrades on holidays.                                                                               | Wait. Check status with `xcrun notarytool history --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_PASSWORD"`.                                           |

For deeper notarization troubleshooting, see
`docs/runbooks/desktop-build-and-sign.md`.

---

## 4. Cutting an npm package release

Run from a clean working tree on `main`:

```sh
# 1. Bump every public npm package to exactly the release version.
version=0.2.0
for d in design-tokens nav onboarding-schema query-contract route-map \
         telemetry schema openapi sdk-ts email-react notifications \
         mcp-server cli claude-code-plugin; do
  jq --arg version "$version" '.version = $version' \
    "packages/$d/package.json" > /tmp/postwave-package.json
  mv /tmp/postwave-package.json "packages/$d/package.json"
done
pnpm install --lockfile-only

# 2. Commit and tag.
git add packages/*/package.json packages/*/CHANGELOG.md pnpm-lock.yaml
git commit -m "chore(release): packages-v0.2.0"
git tag -a packages-v0.2.0 -m "Moosewave packages 0.2.0"
git push origin main packages-v0.2.0
```

The tag push triggers `publish-packages.yml`. Its registry-write job waits for
approval in the protected `npm-publish` environment. It rejects an incomplete or
mismatched release plan, builds and tests every package, verifies each packed
tarball, installs the entire set into a clean consumer project, checks all
checksums, and only then publishes in deterministic dependency order. The
first publish failure stops the sequence. Verify on
[npmjs.com/~postwave](https://www.npmjs.com/~postwave) once it completes.

### Required secrets

| Secret      | What it is                                                                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN` | Granular npm access token scoped to public packages under `@postwave`, with publish permission and the minimum practical expiry. Store it only in the protected `npm-publish` environment and rotate it before expiry. |

See `packages/PUBLISH.md` for the full first-time setup (creating the
npm org, configuring the protected environment, and storing the token).

### Single-package republish

If only one package needs republishing (e.g. fix-up after a botched
tag):

1. Go to [Actions → publish-packages](../../actions/workflows/publish-packages.yml).
2. Click "Run workflow".
3. Set `package` to the directory name (e.g. `sdk-ts`).
4. Run.

Bumping the `version` field is still your responsibility — npm rejects
republishes of an already-published version.

---

## 5. Publishing the VS Code extension

The extension has a separate Marketplace release because a VSIX is not an npm
package. A manual run of `publish-vscode.yml` is a package-only dry run. Only a
tag exactly matching `vscode-vX.Y.Z` can reach the protected publish job.

### One-time external setup

These resources live in Microsoft Entra, Visual Studio Marketplace, and GitHub;
the repository cannot provision or prove them on its own. An operator must
complete and test all of the following before the first tag:

1. Claim the Marketplace publisher ID `postwave` and confirm the extension ID
   will be `postwave.postwave-vscode` in the
   [Marketplace publisher portal](https://marketplace.visualstudio.com/manage).
2. Create a Microsoft Entra application/service principal, grant that identity
   permission to publish for the `postwave` publisher, and add a GitHub OIDC
   federated credential with:

   ```text
   issuer:   https://token.actions.githubusercontent.com
   audience: api://AzureADTokenExchange
   subject:  repo:harsh2929/postwave:environment:vscode-marketplace
   ```

3. Create the GitHub environment `vscode-marketplace`. Restrict deployments to
   protected `vscode-v*` tags and require a release reviewer. Add environment
   secrets `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`; do not create or store a
   client secret or Marketplace PAT.
4. Run the workflow manually once. This must build, test, list, package, and
   structurally verify the VSIX without publishing. Then validate Entra access
   during a controlled first tag release.

Microsoft's current extension publishing guide is the source of truth for the
publisher and Entra role setup:
[Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

### Dry run

From GitHub Actions, choose **Publish VS Code extension → Run workflow**. The
manual path never invokes Marketplace publish, even if it is dispatched from a
tag ref. It uploads a checksum-verified VSIX for inspection.

The equivalent local verification is:

```sh
pnpm install --frozen-lockfile
pnpm --filter postwave-vscode typecheck
pnpm --filter postwave-vscode test
pnpm --filter postwave-vscode build
pnpm --dir packages/vscode-extension exec vsce package \
  --no-dependencies --githubBranch main \
  --out /tmp/postwave-vscode-0.1.0.vsix
scripts/release/verify-vscode-vsix.sh \
  /tmp/postwave-vscode-0.1.0.vsix 0.1.0 harsh2929/postwave
```

### Cut a release

Update `packages/vscode-extension/package.json` and `CHANGELOG.md`, commit the
change to `main`, then create the matching annotated tag:

```sh
git tag -a vscode-v0.1.0 -m "Moosewave VS Code 0.1.0"
git push origin vscode-v0.1.0
```

The workflow refuses a version mismatch, non-canonical repository, tag commit
that is not reachable from `origin/main`, unpinned VSCE version, unexpected
archive member, source file/map, credential-like file, checksum mismatch, or
provenance identity mismatch. It publishes the same downloaded VSIX that was
tested and attested, using short-lived Entra credentials obtained through
GitHub OIDC. It then waits for the exact version to appear in Marketplace.

GitHub signs a SLSA provenance statement for the pre-upload VSIX and the
publish job verifies the repository, workflow path, tag ref, commit SHA, and
GitHub-hosted runner identity. Visual Studio Marketplace separately scans and
signs extensions after upload. Those are complementary controls; the repo does
not claim that Marketplace's post-signing bytes equal the local VSIX digest.

Marketplace versions are immutable. If a release is wrong, do not reuse the
tag or version: unpublish/disable it through the publisher portal as policy
allows, fix the source, bump the version, and cut a new tag.

---

## 6. Required-secret quick reference

Cross-reference of every secret consumed by every release workflow.
Names match exactly what the workflow reads via
`${{ secrets.<NAME> }}`.

| Secret                               | Used by                                          | Required?                                              |
| ------------------------------------ | ------------------------------------------------ | ------------------------------------------------------ |
| `GITHUB_TOKEN`                       | `docker-push.yml`                                | Auto-injected. No action needed.                       |
| `APPLE_CERTIFICATE`                  | `desktop-release.yml`                            | Required for macOS tag release                         |
| `APPLE_CERTIFICATE_PASSWORD`         | `desktop-release.yml`                            | Required for macOS tag release                         |
| `APPLE_SIGNING_IDENTITY`             | `desktop-release.yml`                            | Required for macOS tag release                         |
| `APPLE_ID`                           | `desktop-release.yml`                            | Required for macOS tag release                         |
| `APPLE_TEAM_ID`                      | `desktop-release.yml`                            | Required for macOS tag release                         |
| `APPLE_PASSWORD`                     | `desktop-release.yml`                            | Required for macOS tag release                         |
| `WINDOWS_CERTIFICATE`                | `desktop-release.yml`                            | Required for Windows tag release                       |
| `WINDOWS_CERTIFICATE_PASSWORD`       | `desktop-release.yml`                            | Required for Windows tag release                       |
| `TAURI_SIGNING_PRIVATE_KEY`          | `desktop-release.yml`                            | Required for every desktop tag release                 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `desktop-release.yml`                            | Required if the updater key is encrypted               |
| `POSTWAVE_UPDATER_PUBKEY`            | `desktop-release.yml`                            | Required for every desktop tag release                 |
| `POSTWAVE_UPDATER_ENDPOINT`          | `desktop-release.yml`                            | Required HTTPS URL for desktop tag release             |
| `SENTRY_AUTH_TOKEN`                  | `desktop-release.yml`                            | Required for desktop tag source-map upload             |
| `SENTRY_ORG`                         | `desktop-release.yml`                            | Required for desktop tag source-map upload             |
| `NPM_TOKEN`                          | `publish-packages.yml` `npm-publish` environment | Required for npm publishes                             |
| `AZURE_CLIENT_ID`                    | `publish-vscode.yml` environment                 | Required for Marketplace tag publish                   |
| `AZURE_TENANT_ID`                    | `publish-vscode.yml` environment                 | Required for Marketplace tag publish                   |
| `VITE_POSTHOG_KEY`                   | Desktop build env (Tauri / EAS-equivalent)       | Optional (gates desktop telemetry)                     |
| `NEXT_PUBLIC_POSTHOG_KEY`            | Web (Vercel env)                                 | Optional (gates web telemetry)                         |
| `EXPO_PUBLIC_POSTHOG_KEY`            | Mobile (EAS env)                                 | Optional (gates mobile telemetry)                      |
| `POSTHOG_API_KEY`                    | Go API (AWS Secrets Manager)                     | Optional (gates server-side telemetry)                 |
| Cosign keyless                       | `docker-push.yml`, `verify-images.yml`           | Auto-injected via `id-token: write`. No secret to set. |

To set a secret:

```sh
gh secret set APPLE_CERTIFICATE --body "$(base64 -i cert.p12)"
```

Or via GitHub UI: `Settings → Secrets and variables → Actions → New
repository secret`.

---

## 7. OpenAPI regen pipeline

The `packages/openapi/openapi.{yaml,json}` spec drives the marketing
site's `/api-docs` page, the typed SDK exports in `@postwave/sdk`, and
contract-test harnesses against the gateway. To keep it from drifting
behind the routes registered in `apps/api/main.go`, we run a route
extractor on every PR that touches the API source tree.

### Local regen

```sh
# From the repo root or anywhere underneath:
pnpm --filter @postwave/openapi regen           # writes new path stubs
pnpm --filter @postwave/openapi regen:dry       # prints what would change
pnpm --filter @postwave/openapi regen:check     # exits 1 if drift exists
pnpm --filter @postwave/openapi sync-json       # rewrites openapi.json from openapi.yaml
pnpm --filter @postwave/openapi sync-json:check # exits 1 if json/yaml diverge
```

The regen script lives in `packages/openapi/scripts/regenerate.go`. It
walks `apps/api/main.go` plus every `internal/*` package that defines a
`MountRoutes(r chi.Router)` (or sibling) func, looking for static-path
calls of the shape `r.{Get,Post,Put,Patch,Delete}("/api/...", handler)`.
For every route that isn't already declared in the spec, it appends a
stub path entry with method, summary (derived from the handler symbol),
tag (derived from the package name), and an `x-postwave-source` pointer
back to the Go source line. **Existing path entries are never modified**,
so hand-curated request/response schemas stay intact across regenerations.

Routes the extractor can't statically resolve (variable paths,
conditionally-mounted routes, etc.) are reported on stderr; those need
manual entry into `openapi.yaml`.

The companion `sync-json` script
(`packages/openapi/scripts/yaml-to-json.py`) parses `openapi.yaml`
end-to-end and rewrites `openapi.json` so the two stay in lockstep.
Run it whenever you hand-edit the YAML (added schemas, components, or
hand-curated path entries that bypass `regenerate.go`). It requires
PyYAML, which is bundled with the dev environment. The check variant
exits non-zero when JSON and YAML have drifted — wire it into CI to
gate hand-edits.

### CI: `.github/workflows/openapi-check.yml`

Runs `regenerate.go` and then `git diff --exit-code packages/openapi/`.
If the diff is non-empty the PR introduced a route without updating the
spec.

The workflow's diff step has `continue-on-error: true` set during the
initial bake-in window: the X1+X2+X3 work landed without spec updates,
so flipping the gate to hard-fail immediately would block legitimate
historical PRs. Once the spec catches up to `main` (one regen-and-merge
PR is enough), drop the `continue-on-error` line so subsequent route
additions are gated.

---

## 8. Dodo Payments setup (production checkout)

The marketing site at `/pricing` exposes paid tier CTAs that mint a
Dodo Payments Checkout session via `POST /api/public/billing/checkout`. The
endpoint lives in `apps/api/internal/billing/public_checkout.go` and
returns 503 `checkout_not_configured` when the Dodo Payments inputs below
are unset; the marketing page surfaces that as "Payments aren't
configured on this Moosewave install yet" so the rest of the site
keeps working.

To enable production checkout end-to-end:

### a. Create the Dodo Payments products

Three SKUs map to the three paid marketing tiers
(`apps/web/src/lib/pricing.ts::TIERS`):

| Marketing tier (slug) | Dodo product name                       | Price model          | Env var                            |
| --------------------- | --------------------------------------- | -------------------- | ---------------------------------- |
| `launch` | Moosewave — Launch | Recurring, $39/month | `DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY` |
| `growth` | Moosewave — Growth | Recurring, $99/month | `DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY` |
| `scale` | Moosewave — Scale | Recurring, $349/month | `DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY` |

> **Paid-launch blocker:** the public copy also advertises 50K/250K included
> volumes and $0.80/$0.50 per-1K overages, but the API deliberately does not
> collect automatic overage. Do not enable live paid traffic
> until product/finance either approve and engineering implements/rehearses the
> overage charge path, or the product blocks/top-ups at the included limit and
> all customer-facing copy is changed. Exact live Product/Price IDs and their
> tax/currency settings must also be created and independently verified in
> Dodo Payments; repository placeholders cannot prove them.

Product IDs use the `pdt_...` prefix. Copy them into the secret store under the
names above. Checkout and `DodoWebhookHandler` resolve tiers from the same three
environment variables, so post-payment entitlement projection cannot drift
from the product used to create the session.

### b. Required env vars

| Env var                            | Used by                                          | Required when      |
| ---------------------------------- | ------------------------------------------------ | ------------------ |
| `BILLING_PROVIDER=dodo`            | Selects canonical Moosewave billing              | Production billing |
| `DODO_PAYMENTS_ENVIRONMENT`        | Selects `test_mode` or `live_mode` API            | Always             |
| `DODO_PAYMENTS_API_KEY`            | Checkout and tenant-bound Customer Portal        | Production billing |
| `DODO_PAYMENTS_WEBHOOK_KEY`        | Standard Webhooks signature verification         | Always             |
| `DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY` | Launch monthly tier resolution | Launch CTA |
| `DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY` | Growth monthly tier resolution | Growth CTA |
| `DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY` | Scale monthly tier resolution | Scale CTA |
| `MOOSEWAVE_BILLING_LAUNCH_APPROVAL` | `approved:<release-record-id>` paid-launch lock | Production billing |
| `PUBLIC_BASE_URL`                  | Default success/cancel URL hostname               | Redirect URLs      |
| `PRICING_SUCCESS_URL`              | Optional post-payment redirect override           | Optional           |
| `PRICING_CANCEL_URL`               | Optional cancel redirect override                 | Optional           |

Use separate Dodo test and live credentials. Production readiness rejects test
mode, missing product IDs, duplicate product IDs, or a missing approval record.

### c. Configure the Dodo Payments webhook endpoint

In the Dodo Payments live dashboard, point a new endpoint at
`https://api.moosewave.com/api/public/dodo/webhook` and subscribe
to at minimum:

- `payment.{succeeded,failed,cancelled}`
- `subscription.{active,updated,renewed,plan_changed}`
- `subscription.{past_due,on_hold,paused,unpaused}`
- `subscription.{cancelled,failed,expired}`
- `refund.succeeded`
- `dunning.{started,recovered}`

Copy the `whsec_...` signing key into `DODO_PAYMENTS_WEBHOOK_KEY`. The handler
verifies the Standard Webhooks ID, timestamp, and signature over the raw body,
enforces a replay window, and deduplicates by delivery ID.

### d. Verify

After setting the env vars and redeploying:

```sh
# 1. The /pricing CTAs should NOT show the "Payments not configured"
#    error any more.
# 2. Tail the API and click a tier; you should see Dodo Payments respond
#    with a session id within a few hundred ms.
# 3. Send a signed test event; the delivery should receive HTTP 200 and the
#    matching provider event should be marked processed exactly once.
```

If `/api/public/billing/checkout` returns 400 `invalid_product`, the requested
tier/product does not match the allow-listed environment mapping. A 502
`payment_provider_request_failed` is deliberately generic; inspect the
server-side structured error for Dodo Payments detail. Common causes are an
inactive product, a recurring/one-time mismatch, or an API key without access
to the live business.

---

## 9. PostHog telemetry setup

Moosewave ships opt-in product telemetry across desktop, web, mobile,
and the Go API. The wiring is **dormant by default** — none of the
clients send a single event until the operator provisions a
`POSTHOG_*` env var. Without keys, the code paths short-circuit to
no-ops; the apps build and run normally. There is no fallback that
silently sends data to a hard-coded project.

### a. Create a PostHog project

1. Sign in at [posthog.com](https://posthog.com) (or use your
   self-hosted instance — `POSTHOG_HOST` is settable, see below).
2. Project settings → API keys.
3. Copy the **Project API Key** (`phc_...`) — used by browser /
   mobile clients (public, embedded in the JS bundle).
4. Copy a **Personal API Key** with the `posthog:capture` scope —
   used by the Go API for server-side events (treated as a secret).

Project API keys can be rotated freely; the public one ships in every
build artifact, so plan to rotate after a public key leak by
re-issuing and rebuilding.

### b. Required env vars

Naming is unfortunately split because each surface has its own build
tool's bundling rules:

| Surface | Public key (browser-visible) | Server key (secret) | Host override              |
| ------- | ---------------------------- | ------------------- | -------------------------- |
| Desktop | `VITE_POSTHOG_KEY`           | n/a                 | `VITE_POSTHOG_HOST`        |
| Web     | `NEXT_PUBLIC_POSTHOG_KEY`    | n/a                 | `NEXT_PUBLIC_POSTHOG_HOST` |
| Mobile  | `EXPO_PUBLIC_POSTHOG_KEY`    | n/a                 | `EXPO_PUBLIC_POSTHOG_HOST` |
| Go API  | n/a                          | `POSTHOG_API_KEY`   | `POSTHOG_API_HOST`         |

Where each goes:

- **Desktop** (`VITE_POSTHOG_KEY`): set at Tauri-build time. The
  `apps/desktop/vite.config.ts` `envPrefix` whitelists `VITE_*`, so
  the value is statically inlined into the bundle; an unset key
  compiles to a `null` literal and the telemetry module short-
  circuits to a no-op (`apps/desktop/src/lib/telemetry.ts`).
- **Web** (`NEXT_PUBLIC_POSTHOG_KEY`): set in Vercel → Project →
  Settings → Environment variables. `NEXT_PUBLIC_*` is exposed to
  the browser by Next; an unset key disables init in
  `apps/web/src/components/telemetry-provider.tsx`.
- **Mobile** (`EXPO_PUBLIC_POSTHOG_KEY`): set as an EAS Secret OR
  inline in `eas.json` `build.<profile>.env`. Expo embeds the value
  into the JS bundle at build time.
- **Go API** (`POSTHOG_API_KEY`): set in AWS Secrets Manager and
  injected via the ECS task definition. `apps/api/internal/telemetry/
posthog.go::NewFromEnv` returns a Noop tracker when the var is
  empty, so production deploys without the key are safe.

### c. Events captured (current set)

Quality > quantity. We deliberately ship a narrow event surface:

| Surface | Event                                | Distinct id    | Fires when                                                   |
| ------- | ------------------------------------ | -------------- | ------------------------------------------------------------ |
| Desktop | `app_opened`                         | anon device id | Boot pipeline reaches `ready`                                |
| Desktop | `auth_method`                        | anon device id | Once per session, `{method: session\|api_key}`               |
| Desktop | `section_viewed`                     | anon device id | User navigates to a sidebar section                          |
| Desktop | `command_palette_opened`             | anon device id | ⌘K pressed                                                   |
| Desktop | `campaign_created`                   | anon device id | Successful POST /api/v1/campaigns                            |
| Desktop | `campaign_sent`                      | anon device id | Successful POST /api/v1/campaigns/{id}/send                  |
| Desktop | `subscriber_added`                   | anon device id | Successful POST /api/v1/subscribers                          |
| Desktop | `error_surface`                      | anon device id | Toast.error renders. `{code, path}` only — no message        |
| Web     | `page_viewed`                        | anon device id | Every Next.js route change                                   |
| Web     | `mcp_install_clicked`                | anon device id | Click on the /forge install card                             |
| Web     | `pricing_tier_clicked`               | anon device id | Click on a /pricing tier CTA                                 |
| Web     | `forge_signup_started`               | anon device id | /signup form passes validation and submits                   |
| Mobile  | `mobile.app_opened`                  | anon device id | Auth hydration completes                                     |
| Mobile  | `user.signed_in`                     | anon device id | Sign-in succeeds, `{method: session\|api_key}`               |
| Mobile  | `mobile.tab_viewed`                  | anon device id | Bottom-tab press (1-in-4 sampled per session)                |
| Mobile  | `mobile.push_registration_completed` | anon device id | Push registration succeeds, fails, or is unavailable         |
| Mobile  | `mobile.push_revocation_completed`   | anon device id | Device revocation or a queued retry succeeds or fails        |
| Mobile  | `mobile.offline_replay_completed`    | anon device id | A queued offline mutation succeeds or fails                  |
| Mobile  | `mobile.mfa_completed`               | anon device id | MFA enrollment or challenge succeeds or fails                |
| Mobile  | `mobile.link_handled`                | anon device id | A recognized auth/deep link is accepted or rejected          |
| Mobile  | `mobile.api_availability`            | anon device id | A session API request succeeds or encounters transport error |
| Go API  | `tenant_created`                     | tenant id      | POST /api/v1/auth/signup commits                             |
| Go API  | `campaign_first_sent`                | tenant id      | Campaign send orchestrator flips status → sending            |
| Go API  | `migration_completed`                | tenant id      | services/migration orchestrator terminates (success or fail) |
| Go API  | `paid_sub_created`                   | tenant id      | Stripe `customer.subscription.created` webhook               |

The Go API surface uses a hybrid emit strategy:

1. Always emits a structured slog line with the prefix
   `event:posthog:`. A logs → PostHog forwarder (Vector / Fluent
   Bit / your favourite) can pick those up and ship them without any
   API key on the gateway itself.
2. When `POSTHOG_API_KEY` is set, ALSO calls
   `telemetry.Tracker.Track` directly via the Go SDK. The two paths
   are independent, so a flaky forwarder doesn't drop events when
   the SDK is configured (and vice versa).

### d. PII discipline (HARD RULE)

The event names + property keys above are reviewed against this
allow-list. No event ever carries:

- subscriber email addresses, names, or any list-member PII
- email body content (HTML, MJML, rendered text)
- subject lines (may contain personalization tokens)
- free-form user-typed strings — campaign titles, segment names,
  workspace names — unless explicitly hashed
- error messages from the server (may contain stack traces with
  row data)
- API keys, session tokens, OAuth tokens, signed URLs

The Go SDK has a defence-in-depth allow-list in
`apps/api/internal/telemetry/posthog.go::sanitizeProps` that drops
common sensitive keys (email, password, token, name, ip, …) before
send. Treat that as a safety net, not a substitute for code review.

### e. Per-app opt-out

Default ON; respects the user's preference at runtime:

| Surface | Persisted in                                                                       | Setting copy                                      |
| ------- | ---------------------------------------------------------------------------------- | ------------------------------------------------- |
| Desktop | localStorage                                                                       | Settings → Privacy → "Send anonymous usage data…" |
| Web     | localStorage + cookie banner (`postwave.cookie.consent.v1`)                        | Cookie banner → "Reject optional"                 |
| Mobile  | SecureStore                                                                        | Settings → Privacy → "Send anonymous usage data"  |
| Go API  | n/a (server-side; per-tenant flag goes into tenant settings on a future iteration) | n/a                                               |

The cookie banner on the marketing site already calls
`window.posthog.opt_in_capturing()` / `opt_out_capturing()` —
required for EU consent. The TelemetryProvider re-checks the cookie-
banner localStorage key on init so the consent decision flows through
even on a cold boot.

### f. Optional features (NOT enabled by default)

Both off by default; flip them on per-project from the PostHog
project settings:

- **Session recording** — `disable_session_recording: true` in
  every client config. We do NOT enable this without an explicit
  consent UX upgrade because session replay can capture form
  contents and is far more PII-sensitive than event capture.
- **Autocapture** (DOM click events) — `autocapture: false`. Same
  rationale; targeted explicit events are preferable.

If you turn either on later, document it in the privacy policy at
`/legal/privacy` and re-prompt EU users for consent.

### g. Verify

```sh
# 1. Set VITE_POSTHOG_KEY locally.
VITE_POSTHOG_KEY=phc_... pnpm --filter postwave-desktop-shell dev
# 2. Open the desktop app, navigate around. PostHog Live Events
#    should show app_opened + section_viewed inside ~5 seconds.
# 3. Toggle Settings → Privacy → "Send anonymous usage data" off.
# 4. Confirm new section navigations no longer appear in PostHog.
```

For the Go API:

```sh
POSTHOG_API_KEY=phx_... go run ./apps/api
# In another shell, hit signup; the gateway logs should include
# `telemetry: posthog enabled` at startup and one `tenant_created`
# event should land in PostHog within ~5 seconds.
```

---

## 10. Image signing (cosign keyless)

The Docker images we push to ghcr.io are signed via cosign + GitHub
OIDC (no private key on disk; no new secret in GitHub Actions). The
signing happens automatically on every push to main as part of
`.github/workflows/docker-push.yml`. Signing, exact workflow-identity
verification, provenance verification, or SBOM verification failures fail
the workflow. The ECR bridge only promotes a successful source workflow and
re-verifies the source before copying it by digest. Both workflows also require
exactly the `linux/amd64` and `linux/arm64` payloads and bind every payload's OCI
source/revision labels to the canonical repository and requested full commit
SHA; a moved `sha-*` tag therefore cannot silently promote another build.

### Verify a signature locally

```sh
cosign verify \
  --certificate-identity 'https://github.com/harsh2929/postwave/.github/workflows/docker-push.yml@refs/heads/main' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/<lowercase-owner>/postwave-api@sha256:<digest>
```

Resolve the immutable digest from the `sha-<full-commit-sha>` tag. Do not
verify `:latest` and then deploy it later; the tag may move between those
operations.

### What the certificate-identity should look like

For a push from the canonical repo on `main`, cosign will verify the
signing certificate's SAN against:

```
https://github.com/<owner>/postwave/.github/workflows/docker-push.yml@refs/heads/main
```

The production verifier intentionally accepts only the canonical workflow on
`refs/heads/main`. A signature from a fork, branch, renamed workflow, or other
repository is not promotable.

### Nightly drift check

`.github/workflows/verify-images.yml` resolves and verifies all six images on
a 04:17 UTC cron. A verification failure fails the job (configure GitHub
workflow notifications for the on-call). It also accepts a
`workflow_dispatch` tag input for an ad-hoc immutable-tag check.

### What to do on a verify failure

1. Check the workflow log for the cosign output. If the error is `no matching
signatures`, do not promote the image. Fix the signing run and rebuild the
   immutable commit image through `docker-push.yml`.
2. If the certificate identity does not match, treat the artifact as
   untrusted. Do not widen the identity expression to accommodate a fork or
   feature branch; production accepts the canonical workflow on `main` only.
3. If Sigstore's Rekor log is unhealthy, cosign's verify will hang.
   Check [status.sigstore.dev](https://status.sigstore.dev/) — there
   is no operator action other than waiting.

---

## 11. Related runbooks

- `docs/runbooks/desktop-build-and-sign.md` — full Apple/Windows
  certificate procurement and signing deep-dive.
- `docs/runbooks/desktop-distribution.md` — uploading the Tauri
  updater manifest to the release CDN, customer download URLs.
- `packages/PUBLISH.md` — first-time npm org setup, token
  configuration, dry-run procedures.
- `docs/aws-deployment-runbook.md` — pulling images from GHCR into ECS,
  rotating task definitions, rollback.
