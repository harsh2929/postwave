# Runbook: Desktop — Build, Sign, Notarize, Release

This runbook covers everything an operator needs to ship a signed, notarized
Moosewave desktop release on macOS and Windows. Read this end-to-end before
your first release; reference it section-by-section thereafter.

The desktop app is a Tauri 2 wrapper around `app.moosewave.com`. Signing and
notarization are not optional: an unsigned macOS .dmg is blocked by Gatekeeper
on first launch, and an unsigned Windows .msi triggers SmartScreen warnings
that crater install rates by 50%+.

---

## 1. Prerequisites (one-time, per organization)

Each item below is a real cost and a real procurement step. Plan ~2 weeks of
calendar time the first time through, mostly waiting on certificate vendors.

### Apple side

- **Apple Developer Program membership** — $99 USD/year. Enroll at
  [developer.apple.com/programs](https://developer.apple.com/programs/).
  Renewal is automatic; if it lapses your existing notarized binaries keep
  working but you can't ship new ones.
- **Developer ID Application certificate** — generated at
  [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates).
  Choose "Developer ID Application" (NOT "Mac App Distribution" — different
  trust chain). Download the .cer, double-click to import into Keychain,
  then export from Keychain Access as a .p12 with a strong password.
- **App-specific password** for notarytool — generate at
  [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security →
  App-Specific Passwords. Apple blocks the regular Apple ID password from
  notarytool for security reasons.
- **Apple Team ID** — the 10-character string visible at
  [developer.apple.com](https://developer.apple.com) → Membership. Looks
  like `ABCDE12345`.

### Windows side

- **Code-signing certificate, EV preferred** — $300–$500/year. Vendors:
  - [Sectigo](https://sectigo.com/ssl-certificates-tls/code-signing) — cheapest, ~$300/yr.
  - [DigiCert](https://www.digicert.com/signing/code-signing-certificates) — $500/yr, fastest issuance.
  - [GlobalSign](https://www.globalsign.com/en/code-signing-certificate) — $400/yr.

  **EV vs OV (standard)**: EV certs ship on a hardware token (USB key) and
  are pre-trusted by SmartScreen on day one. OV certs are software-only,
  cheaper, but the binary still triggers SmartScreen until reputation builds
  (typically 1–2 weeks + a few hundred installs). For a B2B product where
  install conversion matters, pay for EV.

  Note on EV + GitHub Actions: EV certs on a hardware token don't play well
  with cloud CI without a cloud signing service. Either:
  1. Use a **cloud HSM provider** (Azure Key Vault, DigiCert ONE,
     SignServer Cloud) — keep the key in the cloud, signtool calls it via
     a CSP/KSP. This is what we'll do for production.
  2. Use an **OV cert** for now and accept the 1–2 week SmartScreen warmup.
- **Tauri updater signing keypair** — generated locally with
  `pnpm tauri signer generate -w ~/.tauri/postwave.key`. The CLI prints a
  base64 private key (paste into the `TAURI_SIGNING_PRIVATE_KEY` GitHub
  secret) and a base64 public key (paste into the `POSTWAVE_UPDATER_PUBKEY`
  GitHub secret). `tauri.conf.json` intentionally ships an empty
  `plugins.updater` block; the public key and manifest endpoint are compiled
  into the binary at build time from the `POSTWAVE_UPDATER_PUBKEY` and
  `POSTWAVE_UPDATER_ENDPOINT` secrets (`src-tauri/src/updater.rs`,
  `option_env!`).

---

## 2. GitHub Secrets (configure on the repo)

`Settings → Secrets and variables → Actions → Repository secrets`. Names
must match exactly — they are referenced verbatim by
`.github/workflows/desktop-release.yml`.

| Secret name | How to acquire | Used by |
|---|---|---|
| `APPLE_CERTIFICATE` | `base64 -i developer-id.p12 \| pbcopy` (macOS) | macOS signing |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set during .p12 export | macOS signing |
| `APPLE_SIGNING_IDENTITY` | `security find-identity -v -p codesigning` → copy the full CN, e.g. `Developer ID Application: Moosewave Inc. (ABCDE12345)` | macOS signing |
| `APPLE_ID` | The Apple ID email of the developer account | Notarization |
| `APPLE_PASSWORD` | App-specific password from appleid.apple.com | Notarization |
| `APPLE_TEAM_ID` | 10-char Team ID from developer.apple.com → Membership | Notarization |
| `WINDOWS_CERTIFICATE` | `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))` in PowerShell | Windows signing |
| `WINDOWS_CERTIFICATE_PASSWORD` | The password you set during .pfx export | Windows signing |
| `TAURI_SIGNING_PRIVATE_KEY` | Output of `pnpm tauri signer generate` (private side) | Updater manifest signing |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The passphrase you set during keypair generation | Updater manifest signing |
| `POSTWAVE_UPDATER_PUBKEY` | Output of `pnpm tauri signer generate` (public side) | Compiled into the binary; verifies `latest.json` |
| `POSTWAVE_UPDATER_ENDPOINT` | The HTTPS updater manifest URL (see section 8) | Compiled into the binary; where the app polls |

Total: **12 required secrets**. The authoritative list is
`apps/desktop/scripts/validate-release-env.mjs`, which the release workflow
runs before building; a tag build fails if any required secret is empty.

The workflow additionally reads five optional telemetry secrets
(`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `VITE_SENTRY_DSN_DESKTOP`,
`VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST`). Omitting them produces a build with
no Sentry/PostHog init rather than a failed build.

Rotation: APPLE_CERTIFICATE expires after 5 years. WINDOWS_CERTIFICATE
typically renews annually. Tauri keypair never expires but should be rotated
if compromised — note that rotating it forces every existing install to do
a manual reinstall (the updater can't authenticate the new key).

---

## 3. Local development workflow

```bash
# From repo root.
pnpm install
pnpm --filter postwave-desktop-shell tauri dev
```

`tauri dev` boots Vite on `localhost:1420`, then launches the native window
pointing at it. Hot reload works for both the React side (Vite HMR) and the
Rust side (Cargo recompiles on change, window restarts).

If you only want to iterate on the frontend without paying Rust compile
time, run `pnpm --filter postwave-desktop-shell dev` and load the URL in a
regular browser. The Tauri-specific APIs (deep-link, updater, notification)
will be missing but everything else works.

---

## 4. Local production build

```bash
pnpm --filter postwave-desktop-shell tauri build
```

Output paths:

- **macOS**:
  - `apps/desktop/src-tauri/target/release/bundle/macos/Moosewave.app`
  - `apps/desktop/src-tauri/target/release/bundle/dmg/Postwave_<version>_<arch>.dmg`
  - For universal: pass `--target universal-apple-darwin`; output goes to
    `target/universal-apple-darwin/release/bundle/...`.
- **Windows**:
  - `apps\desktop\src-tauri\target\release\bundle\msi\Postwave_<version>_x64_en-US.msi`
  - `apps\desktop\src-tauri\target\release\bundle\nsis\Postwave_<version>_x64-setup.exe`

To sign a local build (macOS): `apps/desktop/scripts/sign-mac-local.sh`.
To sign a local build (Windows): `apps\desktop\scripts\sign-windows-local.ps1`.

### Rust dependency qualification

Install the same scanner version used by CI and run both the fail-closed policy
tests and the live audit before cutting a release:

```bash
cargo install cargo-audit --version 0.22.2 --locked
pnpm --dir apps/desktop check:rust-dependencies
```

The live command first runs an unsuppressed `cargo audit --deny warnings`. The
shared Cargo lockfile records GTK3/netlink findings that are reachable only on
the unsupported Linux evidence target (the current set is enumerated in
`apps/desktop/src-tauri/audit-exceptions.json`), so that raw scan is expected
to return non-zero. The wrapper accepts it only after all advisory,
kind, package, version, checksum, source, date, and URL fingerprints match the
reviewed policy; the policy is unexpired and recently reviewed; the packages
are absent from `aarch64-apple-darwin`, `x86_64-apple-darwin`, and
`x86_64-pc-windows-msvc`; and the packages remain present on the Linux evidence
graph. Any new or changed finding, target drift, stale exception, old advisory
database, inline workflow ignore, or missing upstream Tauri patch blocks the
build.

The five formerly reachable `unic-*` warnings are not accepted. Cargo pins the
focused upstream Tauri commit that replaces `urlpattern` 0.3 with 0.6; the gate
requires that immutable source and rejects reintroduction of the retired
packages. Review `apps/desktop/src-tauri/audit-exceptions.json` before the
dates in its `lastReviewedOn` and `expiresOn` fields lapse; the gate fails
closed once either is stale. A Linux release is prohibited until every entry
in that file's `exceptions` array is removed or remediated.

---

## 5. Release process

1. **Bump versions** in lockstep:
   - `apps/desktop/src-tauri/tauri.conf.json` → `version` field.
   - `apps/desktop/src-tauri/Cargo.toml` → `[package].version` field.
   - `apps/desktop/package.json` → `version` field (cosmetic but keeps it in sync).
2. **Update `apps/desktop/CHANGELOG.md`** — add a `## [<version>] - <YYYY-MM-DD>`
   heading for the new version with today's real date and write user-visible
   notes. The workflow's `release:version-check` step
   (`apps/desktop/scripts/validate-release-version.mjs`) fails the tag build if
   that heading is missing, still reads `YYYY-MM-DD`, or the three version
   fields disagree.
3. **Commit** the version bumps + changelog edit:
   ```bash
   git add apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/Cargo.toml apps/desktop/package.json apps/desktop/CHANGELOG.md
   git commit -m "desktop: release v0.1.1"
   ```
4. **Tag and push**:
   ```bash
   git tag desktop-v0.1.1
   git push origin main
   git push origin desktop-v0.1.1
   ```
5. **GitHub Actions runs** `desktop-release.yml`. Wall-clock: ~25–35 minutes
   (macOS universal + Windows in parallel; macOS is the long pole due to
   notarization wait). Watch the run; if either job fails, fix forward
   (do not retry the same tag — delete the tag and the failed draft release
   first, then re-tag).
6. **Verify the draft release** at
   the current private repository's **Releases** page:
   - Download the .dmg on a Mac you've never installed Moosewave on. Open.
     Confirm Gatekeeper does NOT warn.
   - Download the .msi on a clean Windows VM. Run. Confirm SmartScreen
     shows "Verified publisher: Moosewave Inc." (or "Unknown publisher" if
     reputation hasn't built yet — see section 7).
   - Confirm `latest.json` is attached as a release asset and contains
     correct version + per-platform `signature` + `url` entries.
   - **Installed-performance qualification.** The draft release body
     generated by `desktop-release.yml` requires it before publishing:
     collect the target records listed in
     `apps/desktop/performance-budgets.json` from these exact signed
     installers, run `pnpm --dir apps/desktop verify:installed-performance`
     with this version and commit SHA, and attach the JSON, raw traces,
     digests, and passing command log to the draft. Procedure:
     `apps/desktop/docs/performance-qualification.md`. Keep the release in
     draft until that evidence is independently reviewed.
7. **Edit the draft release notes** — copy from CHANGELOG.md, add any
   marketing-relevant context (new features, breaking changes for IT admins).
8. **Publish the release** in the GitHub UI.
9. **Push `latest.json` to the updater CDN.** Currently a manual step:
   ```bash
   aws s3 cp latest.json s3://postwave-desktop-releases/desktop/latest.json
   aws cloudfront create-invalidation --distribution-id <ID> --paths "/desktop/latest.json"
   ```
   See `docs/runbooks/desktop-distribution.md` for the full hosting story.
   This step is the gap between a published GitHub release and existing
   users actually receiving the auto-update.

---

## 6. macOS notarization gotchas

- **Re-signing breaks the staple.** If you sign, notarize, staple, then
  re-sign for any reason (e.g. modify the .app's Info.plist), the staple
  is no longer valid. You must re-notarize from scratch. Do not edit
  inside a notarized .app.
- **Hardened runtime entitlements must match exactly.** A typo in
  `entitlements.plist` makes Apple reject notarization with cryptic errors
  like "The signature does not include a secure timestamp." If you see
  that, run `codesign -d --entitlements - <App>.app` to dump the actual
  entitlements and diff against intent.
- **Do not grant JIT/unsigned-memory exceptions to the app executable.**
  Standard WKWebView JavaScript runs in Apple's separately signed WebKit
  content process. `entitlements.plist` is intentionally empty; adding
  `allow-jit`, `allow-unsigned-executable-memory`, or
  `disable-library-validation` requires a reproduced signed-build failure,
  a narrowly documented threat review, and release regression tests.
- **Direct Developer ID builds are not App-Sandboxed.** Absence of the
  sandbox entitlement is not a hardened-runtime exception. Mac App Store
  distribution would require a separate sandbox capability/file-access
  design and test matrix (see section 9).
- **Notarization is asynchronous and rate-limited.** During WWDC week or
  Apple OS release weeks, notarization can take 30+ minutes. Don't panic;
  the job will eventually complete or fail with a real error.

---

## 7. Windows SmartScreen reputation

Even with a valid signed binary:

- **OV certs**: Windows tracks reputation per certificate + per binary hash.
  A brand-new OV cert produces "Unknown publisher" warnings until
  ~hundreds of installs accrue without being reported as malware. This
  takes 1–4 weeks for a new product.
- **EV certs**: pre-trusted on day one — the binary shows
  "Verified publisher: Moosewave Inc." immediately. This is the entire
  reason EV is worth ~$200/yr more.
- **Hash-based reputation resets on every release**. Even with an
  established cert, a brand-new binary hash starts with zero hash-level
  reputation. Most users don't see this because cert reputation
  short-circuits it, but if SmartScreen has been aggressive lately
  (Microsoft tunes thresholds opaquely), a brand-new release can warn
  for the first 24–48 hours.
- **Set expectations in marketing**. The first announcement post should
  include a "if you see a SmartScreen warning, click 'More info → Run
  anyway'" note for the first ~2 weeks after launch.

---

## 8. Auto-update flow

The desktop app polls the URL compiled in from the `POSTWAVE_UPDATER_ENDPOINT`
secret — intended shape
`https://releases.moosewave.com/desktop/{{target}}/{{arch}}/{{current_version}}`
— once shortly after every launch and then every 6 hours while running
(`src-tauri/src/updater.rs`). The endpoint must be HTTPS; the binary refuses
a plaintext endpoint. It should return a JSON manifest in this shape:

```json
{
  "version": "0.1.1",
  "notes": "Bug fixes and stability.",
  "pub_date": "2026-05-08T15:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<base64-ed25519-sig-of-the-tarball>",
      "url": "https://releases.moosewave.com/desktop/v0.1.1/Postwave_universal.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "<base64-ed25519-sig>",
      "url": "https://releases.moosewave.com/desktop/v0.1.1/Postwave_universal.app.tar.gz"
    },
    "windows-x86_64": {
      "signature": "<base64-ed25519-sig>",
      "url": "https://releases.moosewave.com/desktop/v0.1.1/Postwave_0.1.1_x64-setup.nsis.zip"
    }
  }
}
```

The `signature` is generated by `tauri-action` using the
`TAURI_SIGNING_PRIVATE_KEY` secret. The desktop app verifies it at update
time using the public key compiled into the binary from the
`POSTWAVE_UPDATER_PUBKEY` secret. If signatures don't match, the update is
rejected — protects against a compromised CDN.

**Rollback** a bad release:
1. Find the previous good `latest.json` (any old release zip from S3 will have one).
2. `aws s3 cp old-latest.json s3://postwave-desktop-releases/desktop/latest.json`
3. Invalidate CloudFront: `aws cloudfront create-invalidation --distribution-id <ID> --paths "/desktop/latest.json"`
4. Existing users on the bad version stay on the bad version (the updater
   will not downgrade). New installs from moosewave.com/download still get
   the bad .dmg/.msi until you also overwrite those — separate step.

---

## 9. Distribution channels

- **Primary**: direct download from `https://moosewave.com/download`. The
  page detects OS via User-Agent and offers the right artifact. Source of
  truth for downloads is the S3 bucket behind CloudFront.
- **Mac App Store**: NOT pursuing. App Store distribution requires the
  App Sandbox, which would block deep-link to arbitrary file paths and
  break our intended workflow with the file system. Also: 30% Apple cut
  on any in-app purchases, and we'd need to maintain a separate sandboxed
  build target.
- **Microsoft Store**: NOT pursuing. Low B2B reach (admins distribute via
  MDM, not the Store), and again 30% cut. Revisit if we ever target consumer.

---

## 10. Telemetry & privacy

The desktop app collects **no telemetry beyond what the loaded dashboard
collects**. The Tauri shell is a thin wrapper — it does not phone home,
does not log usage, does not have its own analytics SDK. All product
analytics are emitted by the React app loaded from `app.moosewave.com`,
which already sits behind the consented analytics flow (see
`docs/privacy/`).

If we ever want desktop-specific telemetry (e.g. "how many users have
auto-update enabled"), it must go through the same web-vitals pipeline as
the web admin: an explicit consent prompt on first launch, a documented
privacy policy update, and the events flow through our existing
PostHog instance with the same retention rules.

---

## 11. Security posture

- **Tauri's strict CSP** is set in `tauri.conf.json` under
  `app.security.csp`. `connect-src`, image, and frame sources are explicit;
  there is no generic `https:` network grant. CSP governs the webview; it is
  not an IPC authorization mechanism.
- **Capabilities allowlist** in `apps/desktop/src-tauri/capabilities/main.json`
  default-denies plugin APIs. Custom commands are separately narrowed in
  Rust: secret-bearing calls verify the main bundled window, bind API keys to
  one origin, reject redirects/credential headers, stream response bytes over
  an ordered IPC channel, and never return keys. Non-secret credential
  fingerprints partition offline/query data across same-origin key changes.
- **No bundled Node**. This is Tauri's biggest security win over Electron:
  there is no Node runtime inside the app. The frontend can only call into
  Rust via explicit IPC commands in `src-tauri/src/`. The renderer can ask
  the native API broker to call only the configured Moosewave `/api/` origin,
  and can ask the OS to open validated external links. It cannot retrieve
  keychain credentials or the offline-vault AES key.
- **Updater signature verification** prevents a CDN compromise from
  pushing malicious updates. The public key is embedded in the binary at
  build time; the updater rejects manifests it can't verify.

---

## 12. Quick reference

```bash
# Local dev
pnpm --filter postwave-desktop-shell tauri dev

# Local prod build (unsigned)
pnpm --filter postwave-desktop-shell tauri build

# RustSec policy tests + live, supported-target-aware dependency gate
pnpm --dir apps/desktop check:rust-dependencies

# Sign locally (macOS)
APPLE_SIGNING_IDENTITY="..." APPLE_ID="..." APPLE_PASSWORD="..." APPLE_TEAM_ID="..." \
  ./apps/desktop/scripts/sign-mac-local.sh

# Sign locally (Windows, PowerShell)
$env:WINDOWS_CERTIFICATE_PATH = "C:\path\to\cert.pfx"
$env:WINDOWS_CERTIFICATE_PASSWORD = "..."
pwsh apps\desktop\scripts\sign-windows-local.ps1

# Cut a release
git tag desktop-v0.1.1 && git push origin desktop-v0.1.1
```
