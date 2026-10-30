# Changelog

All notable changes to the `postwave-vscode` extension will be documented in
this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-05-01

### Added

- Initial release.
- Webview-based live email preview in the Moosewave activity-bar container,
  with mobile/desktop toggle, reload, and send-test toolbar actions.
- On-save lint diagnostics for `*.email.tsx`, `*.mjml`, `*.email.md` files,
  covering Outlook-unsupported CSS, missing image `alt` attributes,
  image-to-text ratio, hidden / tiny text, and obfuscated-spam patterns.
- Status bar indicator showing dev-server connectivity (10s poll).
- Four starter snippets: `pw-welcome`, `pw-newsletter`, `pw-promo`,
  `pw-transactional`.
- `Moosewave: Sign In` command that uses browser approval plus a one-time PKCE
  code exchange, then stores the directly returned key in VS Code SecretStorage.
- MJML language registration for `.mjml` files.

### Security

- Sign-in now uses the backend's authorization-code + PKCE exchange. API keys
  are delivered directly to VS Code SecretStorage rather than through the
  browser callback.
- Removed the plaintext `postwave.apiKey` setting and added a command to clear
  the local SecretStorage credential.
