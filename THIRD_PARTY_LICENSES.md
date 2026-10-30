# Third-party notices and license inventory

This file documents the notice process; it is not a hand-maintained shortlist.
The exact production npm graph is generated for each release platform:

```sh
pnpm licenses:check
pnpm licenses:generate -- --output artifacts/THIRD_PARTY_NOTICES.md
```

The generator reads the frozen pnpm installation, records every resolved
production package version, declared license, upstream link, platform, and the
SHA-256 of `pnpm-lock.yaml`. The resulting notice is retained with the release
artifacts. Because optional native npm packages are platform-specific, notices
are generated on each release runner instead of committing one host's output as
if it represented every installer.

`config/license-policy.json` contains time-bounded review exceptions for
unknown, weak-copyleft, or source-available licenses. `pnpm licenses:check`
fails when a new review-required package or version lacks a current owner,
rationale, evidence link, and expiry.

Additional distribution evidence:

- Every public SDK root carries its MIT `LICENSE`; native package manifests
  also declare MIT, and the Java JAR embeds `META-INF/LICENSE`.
- Application source and manifests declare `AGPL-3.0-only`; the complete text
  is `LICENSE-AGPL.md` and the path boundary is `LICENSE-BOUNDARY.md`.
- Container release workflows attach and verify an SPDX SBOM and provenance
  for the exact image digest. The SBOM is the authoritative inventory for Go,
  operating-system, and container-only components.
- Rust dependencies are locked by `apps/desktop/src-tauri/Cargo.lock` and are
  covered by the desktop release audit; their license notice must accompany
  each signed installer before publication.

Do not copy a generated notice from one platform to another, suppress an
unknown license, or describe this policy as legal approval. License compatibility
and customer distribution terms still require qualified legal review.
