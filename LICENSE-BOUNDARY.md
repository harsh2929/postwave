# License and Release Boundary

This document records the source-tree and release policy implemented by this
repository. It describes what the checked-in license files and build paths do;
it is not a substitute for legal advice. A production or customer distribution
still requires counsel-approved notices, offers, and commercial terms.

## Authoritative path inventory

| Path or component                | License/status                                                                | Release boundary                                                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream Listmonk process        | Upstream AGPL-3.0 dependency; source is not vendored here                     | Development uses a version tag. A release must use an approved immutable image digest and retain upstream notices/source provenance.                             |
| `packages/*`                     | MIT; each immediate package root carries its own `LICENSE`                    | A package may be released independently. Its presence here is not a promise that it is published, mirrored, supported, or available from any registry.           |
| `apps/*`, `services/*`, `infra/` | AGPL-3.0-only                                                                 | Application source distributions must carry the applicable license text and counsel-approved corresponding-source information.                                   |
| `proprietary/`                   | Separately controlled Moosewave material; no redistribution license is granted | Private/internal checkout and selected private Moosewave Cloud images only. Exclude it from every public, customer, self-host, and corresponding-source artifact. |
| `proprietary-stubs/`             | MIT                                                                           | Redistributable placeholders for development and independently operated deployments.                                                                             |

The root [`LICENSE`](LICENSE) contains the complete AGPL text, also retained in
[`LICENSE-AGPL.md`](LICENSE-AGPL.md). The path-specific license summary is in
[`LICENSE-NOTICE.md`](LICENSE-NOTICE.md). An immediate package's own `LICENSE` is
authoritative for that package. Possession of files under `proprietary/` does
not grant a right to use, copy, publish, distribute, or sublicense them.

## Upstream Listmonk dependency (`engine/`)

`engine/` contains integration documentation only. This repository has no
Listmonk source tree, Git submodule, or Moosewave Listmonk fork. Application
components communicate with the separately running process over HTTP and must
not import Listmonk Go packages.

The local Compose contract uses the upstream development dependency
`listmonk/listmonk:v6.1.0` by default. A version tag is useful for development,
but it is not immutable release provenance. Before a staging or production
release can be approved, operators must:

1. resolve the reviewed upstream image to `listmonk/listmonk@sha256:<digest>`;
2. record the digest, upstream version/source reference, license notices, SBOM,
   signature or provenance evidence, and vulnerability-review result; and
3. deploy and rollback by that digest, never by a mutable tag.

A future modified Listmonk build requires a new accepted ADR, an independently
reviewed image and source commit, AGPL notice/corresponding-source handling, and
legal approval. Documentation must not describe a fork or public mirror until
those artifacts actually exist.

## MIT package layer (`packages/*`)

Every immediate package root is an independent MIT-licensed work and must keep
its full MIT text at that root. Native SDK manifests and Java packaged resources
must carry matching license metadata where their ecosystems require it.

Hard rules:

- Packages must not import from `apps/` or `services/`.
- Packages must not contain tuned material from `proprietary/`, secrets, or
  private service configuration.
- A release must include the package's license and applicable third-party
  notices.
- Documentation may identify a registry or mirror only after that destination
  exists and the exact released version has been verified there.

MIT licensing permits independent reuse; it does not create a support, hosting,
maintenance, registry-availability, or service-continuity commitment.

## AGPL application layer (`apps/*`, `services/*`, `infra/`)

These paths are licensed AGPL-3.0-only. Component notices link back to the root
license text and this boundary. The source license and any obligations under it
are distinct from the commercial scope of Moosewave Cloud.

Hard rules:

- Application and service code may consume MIT packages.
- Communication with Listmonk stays at the HTTP/process boundary.
- Application code loads operator-supplied or private asset packs through
  runtime file paths; it must not compile or embed `proprietary/` content.
- Browser, mobile, desktop, SDK, package, source-export, and customer artifacts
  must not contain `proprietary/` content.

An AGPL grant does not promise a supported installer, managed hosting, an SLA,
escrow, continuity, migration assistance, or a particular self-hosted product
edition. Those services exist only when stated in an executed commercial
agreement. This repository's development Compose files are not a supported
production distribution.

## Separately controlled assets (`proprietary/`)

A checkout containing the real files under `proprietary/` is a private/internal
checkout. [`Dockerfile.go`](Dockerfile.go) currently copies only the reviewed
Diagnostician pack into the deliverability image and only the reviewed voice
pack into the voice image. Images containing either pack are private Moosewave
Cloud artifacts; they are not public registry, customer, self-host, or
corresponding-source artifacts.

The other service images do not need these packs. Runtime paths keep the code
and asset works operationally separable. The following controls are mandatory:

- never use `//go:embed` or a source import for `proprietary/`;
- never broadly copy the whole directory into an image;
- keep every image containing a private pack in an access-controlled registry;
- verify the final image file manifest/SBOM before promotion;
- exclude `proprietary/` from public source exports; and
- use `proprietary-stubs/` or independently created assets outside Moosewave
  Cloud.

The repository's `.gitattributes` marks `proprietary/` as `export-ignore` so a
normal `git archive` source export omits it. That guard does not sanitize an
arbitrary filesystem copy, Docker build context, registry, cache, SBOM, or
previous release. Every release process must still inspect the final artifact.

## Redistributable stubs (`proprietary-stubs/`)

The stubs carry their own MIT [`LICENSE`](proprietary-stubs/LICENSE). They are
minimal, uncalibrated examples for exercising the runtime path contract. They
do not represent or contain the tuned Moosewave Cloud packs, and their presence
does not imply production suitability or support.

## Automated enforcement

CI runs these boundary checks:

1. `scripts/check-license-boundary.sh` rejects Listmonk source imports,
   mismatched AGPL application notices, and missing or contradictory MIT
   package licenses.
2. `scripts/check-proprietary-isolation.sh` rejects source embeds/imports,
   requires the public-export exclusion, and requires an MIT license for the
   stubs.
3. `scripts/check-package-imports.sh` rejects package imports from application
   paths.
4. `pnpm licenses:check` reviews the resolved production npm graph against the
   third-party license policy.

These static checks do not prove registry visibility, artifact extraction,
upstream Listmonk digest approval, complete third-party notices, or legal
compliance. Release approval must attach that external evidence.

## Contributor and release checklist

- Treat ADR-006 in [`docs/decisions.md`](docs/decisions.md) as the current
  decision; ADR-001 through ADR-003 are superseded history.
- Include a license-impact note for changes to `engine/`, `packages/`,
  `proprietary/`, `proprietary-stubs/`, or release packaging.
- Run all four automated checks above.
- Inspect the files and SBOM inside each final artifact, not just its source
  directory.
- Obtain counsel review before the first external application-source,
  customer, or self-host distribution and whenever the boundary changes.
