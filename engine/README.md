# `engine/` — upstream Listmonk integration boundary

Moosewave uses a separately running upstream Listmonk process for subscriber,
list, campaign, and delivery operations. Moosewave applications and services
communicate with it over HTTP. This directory contains documentation only.

There is no Listmonk source tree, Git submodule, or Moosewave Listmonk fork in
this repository. Do not use historical ADR-001 text or planning documents as
evidence that one exists; ADR-006 in [`docs/decisions.md`](../docs/decisions.md)
is the current decision.

## Development dependency

[`infra/docker-compose.yml`](../infra/docker-compose.yml) uses the upstream
image `listmonk/listmonk:v6.1.0` by default. `LISTMONK_VERSION` can select a
different version for an explicit compatibility test. This Compose dependency
is for local development and test environments, not a production release pin.

Container tags can move. A staging or production release must resolve the
reviewed upstream image to an immutable reference of the form:

```text
listmonk/listmonk@sha256:<64-hex-character-digest>
```

The release evidence must record that digest together with the upstream source
version/reference, license notices, SBOM, signature or provenance evidence,
vulnerability review, and tested rollback digest. Deploy and roll back by
digest, never by the development tag.

## Source and process boundary

- Never import `github.com/knadh/listmonk/...` or a downstream Listmonk fork
  from `apps/`, `services/`, or `packages/`.
- Never copy or vendor upstream Listmonk source into those paths.
- Keep application-to-Listmonk communication on the documented HTTP boundary.
- Preserve upstream license notices and source provenance in release evidence.
- Do not claim a public mirror, fork, or submodule unless that exact artifact
  exists and has been reviewed.

[`scripts/check-license-boundary.sh`](../scripts/check-license-boundary.sh)
enforces the source-import rule. The full path and release policy is in
[`LICENSE-BOUNDARY.md`](../LICENSE-BOUNDARY.md).

## If a modified engine is ever required

Do not add an ad hoc fork or submodule. First accept a new ADR that identifies
the source repository and immutable commit, then complete legal review,
corresponding-source and notice handling, image provenance/signing, registry
controls, compatibility tests, and rollback evidence. Only after those gates
pass may release documentation identify the modified engine.
