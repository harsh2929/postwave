# Runbook: Desktop — Distribution & Auto-Updater Hosting

This runbook covers hosting the download page, the updater manifest, and the
artifact CDN. It assumes you've already cut a signed release per
`desktop-build-and-sign.md`.

---

## 1. Surfaces

There are two user-facing surfaces:

1. **`https://moosewave.com/download`** — the marketing download page. Detects
   OS via User-Agent and offers the right artifact (.dmg for macOS, .msi for
   Windows). Hosted as part of the Moosewave marketing site.
2. **`https://releases.moosewave.com/desktop/{{target}}/{{arch}}/{{current_version}}`**
   — the Tauri updater endpoint. It is NOT read from `tauri.conf.json`
   (`plugins.updater.endpoints` is intentionally empty there); the release
   workflow compiles it into the binary from the `POSTWAVE_UPDATER_ENDPOINT`
   GitHub secret (`apps/desktop/src-tauri/src/updater.rs`). Changing the
   endpoint therefore requires a new release. The desktop app polls this on
   launch and every 6 hours while running.

Both are CloudFront distributions in front of the same S3 bucket. The
download page uses 301s into the bucket; the updater endpoint serves
`latest.json` directly.

---

## 2. S3 bucket layout

Bucket: `s3://postwave-desktop-releases` (us-east-1).

```
postwave-desktop-releases/
  desktop/
    latest.json                          # symlink-equivalent: copy of latest version's manifest
    darwin-aarch64/latest.json           # Tauri updater endpoint per target/arch
    darwin-x86_64/latest.json
    windows-x86_64/latest.json
  v0.1.0/
    macos-universal/
      Postwave_0.1.0_universal.dmg
      Postwave_0.1.0_universal.app.tar.gz   # for the updater (compressed .app)
      Postwave_0.1.0_universal.app.tar.gz.sig
    windows-x86_64/
      Postwave_0.1.0_x64_en-US.msi
      Postwave_0.1.0_x64-setup.exe
      Postwave_0.1.0_x64-setup.nsis.zip     # for the updater
      Postwave_0.1.0_x64-setup.nsis.zip.sig
  v0.1.1/
    ...
```

Versioned directories never get overwritten. The `latest.json` files are
the only thing that changes during a release — they get rewritten to point
at the newest version. This makes rollback trivial (revert the `latest.json`
contents) and gives users on older versions a stable URL for any past
release.

Bucket policy: private (no public ACLs). All public access goes through
CloudFront with an Origin Access Identity (OAI).

---

## 3. CloudFront distribution

- **Origin**: `postwave-desktop-releases.s3.amazonaws.com` via OAI.
- **Aliases**: `releases.moosewave.com`.
- **Cache behavior**:
  - `/desktop/**/latest.json` — TTL 60s. Short TTL so a release goes live
    within a minute (without paying for an invalidation on every release).
  - `/v*/**` — TTL 1 year (immutable per-version artifacts).
- **Compress**: yes (Brotli + gzip). `latest.json` is small but the
  `.app.tar.gz` benefits.
- **HTTPS only**, modern TLS, ACM cert in `us-east-1`.

DNS: `releases.moosewave.com` → CloudFront alias. `moosewave.com/download` is
a path on the marketing site that issues 302 redirects into the bucket
based on User-Agent (`s/.*Mac.*/v<latest>\/macos-universal\/Postwave_<v>_universal.dmg/`,
etc.). The redirect target uses `releases.moosewave.com` so users see a
trustworthy hostname before they download.

---

## 4. IAM policy for GitHub Actions S3 publish

The release workflow does NOT currently push to S3 (we attach to GitHub
Releases instead). When we add the S3 publish step, it should assume an
IAM role via OIDC (no long-lived keys) with this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WriteVersionedArtifacts",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:PutObjectAcl"],
      "Resource": "arn:aws:s3:::postwave-desktop-releases/v*/*"
    },
    {
      "Sid": "WriteLatestManifests",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": [
        "arn:aws:s3:::postwave-desktop-releases/desktop/latest.json",
        "arn:aws:s3:::postwave-desktop-releases/desktop/*/latest.json"
      ]
    },
    {
      "Sid": "InvalidateCloudFront",
      "Effect": "Allow",
      "Action": "cloudfront:CreateInvalidation",
      "Resource": "arn:aws:cloudfront::<ACCOUNT_ID>:distribution/<DISTRIBUTION_ID>"
    }
  ]
}
```

The trust policy on the role restricts `sub` to
`repo:<github-org>/<repo>:ref:refs/tags/desktop-v*` — use the exact
`owner/name` of this repository's `origin` remote (`git remote -v`; currently
`harsh2929/postwave`) — so only tag-triggered release workflows can
assume it. PRs cannot.

---

## 5. Manual publish (current state — until automated)

After GitHub Actions produces the draft release:

```bash
VERSION=0.1.1
RELEASE_DIR=~/postwave-releases/v$VERSION
mkdir -p $RELEASE_DIR/{macos-universal,windows-x86_64}

# Download from the GitHub draft release
gh release download desktop-v$VERSION --dir $RELEASE_DIR

# Sort artifacts into the bucket layout
mv $RELEASE_DIR/*.dmg $RELEASE_DIR/macos-universal/
mv $RELEASE_DIR/*.app.tar.gz* $RELEASE_DIR/macos-universal/
mv $RELEASE_DIR/*.msi $RELEASE_DIR/windows-x86_64/
mv $RELEASE_DIR/*setup.exe $RELEASE_DIR/windows-x86_64/
mv $RELEASE_DIR/*nsis.zip* $RELEASE_DIR/windows-x86_64/

# Push versioned artifacts (immutable)
aws s3 sync $RELEASE_DIR s3://postwave-desktop-releases/v$VERSION/

# Update the per-target manifests. tauri-action emits these as latest.json
# in the release; copy each into its target-specific path.
aws s3 cp $RELEASE_DIR/latest.json s3://postwave-desktop-releases/desktop/darwin-aarch64/latest.json
aws s3 cp $RELEASE_DIR/latest.json s3://postwave-desktop-releases/desktop/darwin-x86_64/latest.json
aws s3 cp $RELEASE_DIR/latest.json s3://postwave-desktop-releases/desktop/windows-x86_64/latest.json
aws s3 cp $RELEASE_DIR/latest.json s3://postwave-desktop-releases/desktop/latest.json

# Invalidate the manifests so users see the new version within minutes
aws cloudfront create-invalidation \
  --distribution-id <DISTRIBUTION_ID> \
  --paths "/desktop/latest.json" "/desktop/*/latest.json"
```

---

## 6. Rollback

Use case: v0.1.5 ships a regression. You want existing users to stop
receiving it on next update poll.

```bash
# Restore the previous manifest
aws s3 cp s3://postwave-desktop-releases/v0.1.4/latest.json \
          s3://postwave-desktop-releases/desktop/latest.json
aws s3 cp s3://postwave-desktop-releases/v0.1.4/latest.json \
          s3://postwave-desktop-releases/desktop/darwin-aarch64/latest.json
# ... repeat for darwin-x86_64 and windows-x86_64

# Invalidate
aws cloudfront create-invalidation \
  --distribution-id <DISTRIBUTION_ID> \
  --paths "/desktop/latest.json" "/desktop/*/latest.json"
```

Caveats:

- The Tauri updater **will not downgrade** users already on v0.1.5. It
  only auto-installs strictly-newer versions. Users on v0.1.5 stay there
  until v0.1.6 ships with the fix.
- Users still on v0.1.4 or earlier now stay on v0.1.4 until v0.1.6 ships.
- New downloads from `moosewave.com/download` should also be reverted — the
  marketing page redirect targets are based on a separate `latest_download_version`
  variable on the marketing CMS. Update there too.

---

## 7. Honest gaps (as of this runbook's writing)

The following infrastructure is **referenced but not yet provisioned**:

- The S3 bucket `postwave-desktop-releases` does not exist yet. Create
  per `infra/` patterns when v0.1.0 is ready to ship.
- The CloudFront distribution at `releases.moosewave.com` does not exist
  yet. ACM cert request must precede CloudFront setup (us-east-1).
- The marketing page `moosewave.com/download` does not exist yet — the web
  team owns this; coordinate when it's needed.
- The OIDC IAM role for GitHub Actions S3 publish does not exist yet. See
  section 4 for the policy when ready.

Until those exist, the release process stops at the GitHub draft release.
That is functional for internal testing but cannot push auto-updates to
users in the wild.
