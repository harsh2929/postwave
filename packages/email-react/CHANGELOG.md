# Changelog

All notable changes to `@postwave/email-react` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Upgraded the compiler to MJML 5.4.0 to resolve
  `GHSA-45h5-66jx-r2wf` / `CVE-2025-67898`.
- `renderToHtml` and `renderMjmlToHtml` are now asynchronous and return
  `Promise<RenderToHtmlResult>`, matching MJML 5's compiler contract.

### Security

- Reject `mj-include` and disable MJML include/config resolution at the public
  raw-MJML boundary.

## [0.1.0] - 2026-05-08

Initial public release.
