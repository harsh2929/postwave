# Public source release

This is a standalone public snapshot of Postwave, currently branded Moosewave.
The snapshot includes the application source, SDKs, services, infrastructure
templates, tests, and selected developer documentation as of October 30, 2026.

## Scope and licenses

- Application code under `apps/`, `services/`, and `infra/` retains AGPL-3.0-only.
- Immediate package roots under `packages/` retain their existing MIT licenses.
- `proprietary-stubs/` contains redistributable MIT placeholders. Private tuned
  asset packs under `proprietary/` are excluded.
- The original private repository's commits, branches, tags, Git configuration,
  and remote credentials are not included. This repository begins with fresh history.
- Local environment files, deployment state, runtime data, internal reports,
  generated outputs, dependency caches, screenshots, and private research
  archives are excluded.

## Credentials and local development

Copy the relevant `.env.example` or root `.env.local.example` into an ignored
local environment file, and supply your own credentials. Credential assignments
in the distributed environment examples are empty. Existing Compose examples
are for local development and contain visibly non-production sample passwords;
they must not be used with production data or exposed to a network.

The private checkout's development token and database password were replaced
in this snapshot. The private working checkout and its credentials were not
modified. Configure `POSTWAVE_INTERNAL_API_TOKEN` yourself before using the
full local integration stack.

Original deployment and publishing workflows are kept as `.disabled` files in
`.github/workflow-templates/`. They cannot run automatically. The active public
workflow performs source-boundary and secret-scanning checks only.

## Verification

The publication process scans the exported files with Gitleaks and TruffleHog,
checks for the private checkout's known credentials (including common encoded
forms), rejects private/runtime files, and checks the fresh Git history. The
published commit is checked again from a fresh clone before publication.

Synthetic test inputs remain in the source. These include fake provider tokens,
invalid PEM strings used by validation tests, UUIDs, checksums, and example URLs.
The Gitleaks configuration records exact detector-match and exact-path
exceptions for reviewed non-secrets. It does not exempt entire test directories
or arbitrary credential values.

These checks reduce exposure risk; they do not constitute a mathematical
guarantee that every possible secret format is detectable. This is a source
snapshot, not a certification of application correctness, production readiness,
or the safety of previously distributed private artifacts.

## Public asset boundary

The public voice service includes one independently written, uncalibrated
welcome example and the MIT prompt stubs. The private template library and
tuned prompts are not distributed. Operators can supply their own assets using
the existing runtime path settings. Public Docker builds copy only
`proprietary-stubs/`. Seed mailbox entries use inactive reserved-domain examples.

The source-boundary check compares content fingerprints as well as paths, so
renaming a private asset or moving it into application code does not bypass the
publication guard. The check also covers Git object history in CI.
