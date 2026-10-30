# Changelog

All notable changes to `@postwave/openapi` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
- **Description coverage cleanup** — 29 operations identified by the prior
  hygiene-pass audit as still lacking `description:` fields now have
  concise 1-2 sentence descriptions specialized per tag.
- **Hygiene pass** — added descriptions to 286 operations, deduped 4 (now 300 total)
  operationIds, added 31 missing top-level tag entries, and inlined 20 request-
  body examples. No breaking changes; purely metadata.
- **Generator fix** — `regenerate.go` now emits proper path-parameter
  declarations for every `{param}` it finds in a path, and no longer
  mangles paths with HTTP-method suffixes. Fixes the 57 remaining
  spectral `path-params` errors from the v0.x hygiene pass.

## [0.1.0] - 2026-05-08

Initial public release.
