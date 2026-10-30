# Changelog

All notable changes to `@postwave/mcp-server` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`mcp_distribution_release_held` is the current distribution status. Unreleased
entries describe mutable source candidates only; they are not claims about a
published artifact, hosted runtime, working-key setup, or available tool
surface. The historical `0.1.0` publication exposed 133 tools and is not
catalogue-equivalent to this repository candidate.

## [Unreleased]

### Added

- Drafted nine visual campaign-template source definitions plus compact catalog
  and full-template candidate resources. Voice sequence templates remain separate.
- Added immutable editable-template revision reads and concurrency-safe
  update/archive/restore tools that require the server-issued strong ETag.
- Added API-key-principal-bound favorite/unfavorite tools and required
  caller-stable idempotency keys for every durable design mutation.
- Deprecated `campaign_template_delete` as a compatibility name for safe,
  recoverable archival; it never permanently deletes template content.

## [0.1.0] - 2026-05-08

Historical initial publication. It is now release-held and not
production-qualified; this entry does not lift the current hold.
