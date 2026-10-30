# Moosewave Desktop

Bundled React dashboard for the Tauri 2 native shell. The desktop app is not a
remote web wrapper: it ships the same operational surfaces as the web app, then
uses native IPC only for desktop-specific behavior such as notifications, deep
links, app menus, and update checks.

## Dev

```bash
pnpm install
pnpm --filter postwave-desktop-shell dev
pnpm --filter postwave-desktop-shell tauri dev
```

The Vite frontend runs on `http://localhost:1420`. The default development API
target is `http://localhost:8080`; packaged production builds default to
`https://api.moosewave.com` and reject non-HTTPS API URLs.

## Build And Test

```bash
pnpm --filter postwave-desktop-shell build
pnpm --filter postwave-desktop-shell test
pnpm --dir apps/desktop check:rust-dependencies
pnpm --filter postwave-desktop-shell tauri build
```

Platform artifacts are produced by Tauri under
`apps/desktop/src-tauri/target/release/bundle/`.

The Rust dependency gate requires `cargo-audit` 0.22.2. It first runs the
offline policy/mutation tests, then runs a raw
`--deny warnings` scan, checks every residual finding against the exact,
short-lived fingerprints in `src-tauri/audit-exceptions.json`, and recomputes
normal/build dependency reachability for both macOS architectures and Windows
x64. It also proves those lockfile-only packages remain confined to an
unsupported Linux evidence graph. Do not add scanner ignores directly to a
workflow or restore `audit.toml`; CI and release deliberately call the same
gate.

Renderer startup, route-transition, bundle and retained-heap budgets plus the
artifact-bound macOS/Windows qualification procedure are documented in
[`docs/performance-qualification.md`](docs/performance-qualification.md).

## Store And Distribution Readiness

- Privacy, terms, support, and account deletion links are available from the
  auth surfaces and Settings.
- Account deletion can be requested in-app from Settings by a workspace admin.
- The API URL validator requires HTTPS in packaged production builds.
- The Tauri capability allowlist grants only the native plugins the app uses:
  notifications, deep links, opener, updater, and window-state.
- The native `open_url` IPC only opens HTTPS, `moosewave://` deep links, and
  Moosewave-owned `mailto:` links in release builds. Debug builds additionally
  allow loopback HTTP for local Docker/API work.
- The updater remains disabled until release signing keys, manifests, and the
  public verification key are finalized.

Mac App Store distribution is not the current target. A MAS build would need a
separate sandboxed entitlement profile, App Store payment/compliance review,
and Sign in with Apple support if third-party OAuth remains enabled.
