# Publishing Moosewave npm packages

This runbook covers the public npm release set controlled by
`.github/workflows/publish-packages.yml`. VS Code, Python, Go, and the other
language SDKs use separate release channels and are not implied to be
published by this workflow.

The allowlist is deliberately explicit and currently contains:

- `design-tokens`
- `nav`
- `onboarding-schema`
- `query-contract`
- `route-map`
- `telemetry`
- `schema`
- `ai-disclosure`
- `openapi`
- `sdk-ts`
- `audit-portal-react`
- `email-react`
- `track`
- `notifications`
- `cli`

The release-plan script fails when a new public package appears without an
explicit npm rule or documented non-npm channel.

## Release-held MCP distributions

`mcp_distribution_release_held` is machine-enforced for `mcp-server` and
`claude-code-plugin`. Both manifests are private, neither directory is in the
release-plan matrix, and an explicit manual selection fails with the hold code.
Full dispatches and package tags also omit them. Do not pack, publish, install,
or add setup guidance for either source candidate. A future release must first
remove the private flags and release-plan hold in a reviewed change, assign new
versions and digests, and verify installed-artifact/runtime qualification.

## One-time external setup

These npm and GitHub resources cannot be provisioned or validated from the
repository. An operator must complete them before the first release:

1. Create or confirm the `@postwave` npm organization and verified maintainer
   account.
2. Create a granular npm access token scoped to the public packages under
   `@postwave`, with publish permission and the shortest practical expiry.
3. Create the GitHub environment `npm-publish`. Restrict deployments to
   `main` and protected `packages-v*` tags and require a release reviewer.
4. Store the token as the `npm-publish` environment secret `NPM_TOKEN`. Never
   place it in a project `.npmrc`, shell profile, workflow input, or repository
   file.
5. Record an owner and an expiry/rotation reminder. Rotate immediately after
   maintainer offboarding or suspected disclosure.
6. Confirm each npm package is public and that the case-sensitive repository
   metadata resolves to
   `git+https://github.com/harsh2929/postwave.git` with the correct
   `packages/<directory>` subdirectory. npm provenance depends on this match.

Set the secret with stdin so it is not retained in shell history:

```sh
printf '%s' "$NPM_TOKEN" | gh secret set NPM_TOKEN --env npm-publish
```

The workflow also receives a short-lived GitHub OIDC token and requests npm
provenance for every publication. The registry token authorizes publish; it
does not replace provenance.

## Release all packages

All packages in a tag release use one version. From a clean `main` checkout:

```sh
version=0.2.0
for d in design-tokens nav onboarding-schema query-contract route-map \
         telemetry schema ai-disclosure openapi sdk-ts audit-portal-react \
         email-react track notifications cli; do
  jq --arg version "$version" '.version = $version' \
    "packages/$d/package.json" > /tmp/postwave-package.json
  mv /tmp/postwave-package.json "packages/$d/package.json"
done

# Update every affected CHANGELOG before continuing, then refresh the lock.
pnpm install --lockfile-only

# This validates the exact allowlist, metadata, version, and dependency order.
node scripts/release/npm-release-plan.mjs \
  --event tag \
  --tag "packages-v$version" \
  --package '' \
  --repository harsh2929/postwave | jq .

git add packages/*/package.json packages/*/CHANGELOG.md pnpm-lock.yaml
git commit -m "chore(release): packages-v$version"
git tag -a "packages-v$version" -m "Moosewave packages $version"
git push origin main "packages-v$version"
```

The workflow then:

1. Rejects a tag/version mismatch, missing package, duplicate package identity,
   repository mismatch, or invalid public-package metadata.
2. Builds workspace dependencies before their consumers and runs each
   package's available typecheck and test commands.
3. Uses `pnpm pack` so `workspace:` dependencies are rewritten correctly.
4. Inspects every tarball, verifies checksums, and installs the complete set in
   a clean consumer project before the first registry write.
5. Publishes the already-verified tarballs in deterministic dependency order
   with npm provenance. Any error stops the remaining publications.

Never move or recreate a failed tag. If a partial release occurs, determine
which versions reached npm, bump to a new version, rebuild the complete set,
and create a new tag.

## Local package inspection

The CI workflow is authoritative. For a focused local preview before tagging:

```sh
pnpm install --frozen-lockfile
pnpm --filter @postwave/sdk build
mkdir -p /tmp/postwave-npm-pack
(cd packages/sdk-ts && pnpm pack --pack-destination /tmp/postwave-npm-pack)
npm publish /tmp/postwave-npm-pack/*.tgz --access public --dry-run
```

Do not publish from a maintainer laptop; use the tagged workflow so the packed
artifact, checksum, tests, clean-install proof, and provenance remain linked.

## Single-package release

A manual dispatch publishes only the selected allowlisted package:

```sh
gh workflow run publish-packages.yml --ref main -f package=sdk-ts
```

First bump that package to a version that does not exist on npm, update its
changelog and lockfile, and merge the change to `main`. Manual dispatch is not
a dry run.

## Verification

Check the registry identity and provenance after the workflow succeeds:

```sh
npm view @postwave/sdk version repository dist.integrity
npm view @postwave/cli version repository dist.integrity

consumer="$(mktemp -d)"
cd "$consumer"
npm init --yes >/dev/null
npm install --ignore-scripts @postwave/sdk @postwave/cli
```

Also inspect the package's provenance badge and attestation on npmjs.com.

## Other release channels

- `packages/vscode-extension` is released by
  `.github/workflows/publish-vscode.yml`; see `docs/RELEASE.md` section 5.
- `packages/migrate` is a Go module and follows Go module tag conventions.
- Language SDK directories are not covered by the npm workflow. Follow their
  own release automation/runbook; the presence of source metadata alone is
  not evidence that a registry release is configured.

## Troubleshooting

- **`E403 Forbidden`**: confirm npm organization membership, granular-token
  package scope, publish permission, expiry, and required 2FA policy.
- **`E409 Cannot publish over previously published version`**: bump the
  version. npm versions are immutable even after unpublish.
- **Provenance/repository mismatch**: preserve `--provenance`; fix the exact
  case-sensitive `repository.url`, `repository.directory`, workflow identity,
  or OIDC permissions. Never bypass the release control by dropping
  provenance.
- **Partial release set**: stop, inventory `npm view <name>@<version>`, bump the
  complete set, and release under a new tag. Do not attempt to overwrite a
  published version.
