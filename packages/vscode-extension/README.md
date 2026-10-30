# Moosewave for VS Code

The official Moosewave extension for Visual Studio Code. Live preview your
emails, lint for deliverability and Outlook compatibility, and send test
sends without leaving the editor.

## Features

- **Live preview sidebar.** A webview in the Moosewave activity-bar
  container renders the currently active `*.email.tsx` / `*.mjml` /
  `*.email.md` file via a local Moosewave dev server. Toggle between
  mobile and desktop viewports, reload, and trigger a test send from
  the toolbar.
- **Inline lint warnings.** On save, Moosewave scans your email source
  for the most common deliverability footguns:
  - Outlook-unsupported CSS (`flex`, `grid`, `gap` outside
    web-fonts contexts)
  - Missing `alt` text on images
  - Image-to-text ratio that triggers spam filters
  - Hidden / off-screen / invisible-color text
  - Tiny font sizes (< 9px)
  - Obfuscated spam patterns (zero-width chars, mixed-script
    look-alikes)
    These mirror the same rule set the cloud uses in its
    `html_quality.go` deliverability service so what you see in the
    editor is what the gateway will see.
- **Status bar indicator.** A `Moosewave ●` item shows whether the
  local dev server is reachable.
- **Snippets.** Four starter scaffolds — `pw-welcome`,
  `pw-newsletter`, `pw-promo`, `pw-transactional` — that expand into
  ready-to-edit `Email.tsx` files using `@postwave/email-react`
  primitives.
- **Sign in.** `Moosewave: Sign In` uses a one-time authorization code and PKCE;
  the API key travels directly from the Moosewave API into VS Code's
  SecretStorage and never passes through the browser or user settings.

## Requirements

- VS Code `^1.85.0`.
- Node 18+.
- A running Moosewave dev server. **The extension does not bundle the
  Moosewave server.** Start it from a terminal in your project:

  ```bash
  npx postwave dev
  ```

  By default the dev server listens on `http://localhost:4321`.

## Configuration

| Setting                 | Default                 | Description                              |
| ----------------------- | ----------------------- | ---------------------------------------- |
| `postwave.devServerUrl` | `http://localhost:4321` | URL of your local Moosewave dev server.   |
| `postwave.previewWidth` | `desktop`               | Default viewport: `mobile` or `desktop`. |

## Commands

- `Moosewave: Open Email Preview`
- `Moosewave: Send Test Email`
- `Moosewave: Start Dev Server`
- `Moosewave: Sign In`
- `Moosewave: Sign Out (Clear Local Credential)`

## How linting works

The extension runs the same regex-based static checks that the
deliverability service uses. The rules live in
`src/lint/rules/` and are pure functions — no VSCode imports — so they
can be reused in CI or in `postwave dev`.

## Development and release

```sh
pnpm --filter postwave-vscode typecheck
pnpm --filter postwave-vscode test
pnpm --filter postwave-vscode build
```

Marketplace releases are built from `vscode-vX.Y.Z` tags by the
[repository release workflow](https://github.com/harsh2929/postwave/blob/main/.github/workflows/publish-vscode.yml).
Do not run `vsce publish` from a maintainer workstation or create a Marketplace
PAT. The workflow packages a positive allowlist, verifies the VSIX structure
and checksum, signs GitHub SLSA provenance, and publishes through Microsoft
Entra OIDC. See the
[release runbook](https://github.com/harsh2929/postwave/blob/main/docs/RELEASE.md#5-publishing-the-vs-code-extension)
for the external publisher/environment setup and release procedure.

## License

MIT. See `LICENSE`.
