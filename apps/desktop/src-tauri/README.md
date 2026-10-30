# Moosewave Desktop (Tauri 2)

Native shell for the bundled Moosewave desktop dashboard. The Rust side wires
native capabilities (notifications, tray/menu, deep links, updater checks) and
the React frontend invokes those capabilities through the IPC commands defined
in `src/commands.rs`.

## Layout

```
src-tauri/
  Cargo.toml          # Rust crate + Tauri plugin deps
  build.rs            # tauri-build glue
  tauri.conf.json     # window, bundle, CSP, plugin config
  capabilities/       # Tauri 2 explicit permission allowlist
  entitlements.plist  # audited empty macOS hardened-runtime exception set
  icons/              # bundle icons (regenerate via `pnpm tauri icon`)
  src/
    main.rs           # builder wiring (plugins + setup)
    commands.rs       # IPC commands the dashboard calls
    tray.rs           # system tray menu
    menu.rs           # macOS menubar / Windows in-window menu
    deep_link.rs      # moosewave:// URL parsing & dispatch
    shortcut.rs       # global quick-compose hotkey (CmdOrCtrl+Shift+P)
```

## Global quick-compose hotkey

`shortcut.rs` registers **⌘⇧P / Ctrl+Shift+P** as an OS-global shortcut
(tauri-plugin-global-shortcut). Triggering it shows + focuses the main
window and emits a `quick-compose` event; the React shell routes it to
the Campaigns section and opens the new-campaign composer by stashing an
empty draft in the template-handoff store (the same mechanism Templates'
"Use in campaign" uses) and remounting the page via a keyed nonce.

The shortcut ships **OFF** and is toggled from the tray menu item
"Enable quick compose shortcut" — the preference persists as a flag file
in `app_local_data_dir` (the `.on` marker means enabled; the legacy
`.off` marker is written when disabled). If OS registration fails (some
other app owns the combo), the persisted state and tray checkbox fall
back to disabled rather than pretending the hotkey works. The combo is
not OS-reserved on macOS or Windows; it does overlap some in-app editor
palettes (e.g. VS Code), which win while focused — that's the expected
global-shortcut behavior, and the opt-in toggle exists for users who
want it.

## Native secret boundary

The multi-workspace switcher (frontend `src/lib/workspaces.ts`) stores
profile metadata in localStorage but keeps API keys exclusively in
origin-bound v2 records owned by `api_broker.rs`. Renderer IPC can submit,
probe, activate, or remove a credential, but no command returns plaintext.
Broker requests accept only `/api/` URLs on the bound origin, reject caller
credential headers, and never follow redirects. Response bytes use an ordered
Tauri channel, so SSE and downloads remain progressive and cancellable without
putting the bearer in renderer memory. Broker status exposes only capability
metadata plus a domain-separated SHA-256 credential fingerprint; the frontend
uses that non-authenticating value to isolate offline queues and query caches
when keys change on the same origin.

The encrypted offline-cache key is likewise Rust-only: `vault_seal` and
`vault_open` preserve the AES-GCM envelope format without exposing the key.
There are no generic renderer-callable keychain read/write/delete commands.
Every custom command also verifies the `main` bundled renderer label and origin
inside Rust; plugin capability files are not treated as authorization for
custom IPC.

All keychain accounts use service `com.moosewave.desktop`; workspace IDs are
restricted to `[A-Za-z0-9_-]{1,64}` before account names are constructed.

## Native deep-link boundary

The renderer cannot call `tauri-plugin-deep-link` directly. Cold-start URLs,
live OS events, and second-instance command-line arguments all enter
`deep_link.rs`, which caps the complete URL at 8 KiB, rejects authority and
fragment ambiguity, allowlists actions and per-action parameters, decodes each
path/query component exactly once, validates the decoded value, and emits only
the rebuilt canonical URL. Native magic, OAuth-return, and reset links must
carry the complete backend HMAC envelope (`token`, `v=1`, matching `flow`,
`aud=mobile`, device `state`, and 43-character `sig`); no signed field is
dropped or synthesized. Auth tokens are capped at 2,048 bytes, native auth
state is base64url and 16–128 bytes, and migration state remains URL-unreserved
ASCII capped at 256 bytes. Duplicate/unknown parameters and migration sources
are rejected.

A 16-entry native queue holds ordered messages until the main bundled renderer
first calls `deep_link_take_pending`. Accepted messages contain only canonical
URLs; rejected auth intents contain a redacted reason/flow and never echo the
URL, token, state, or signature. The renderer attaches its event listener before
that handshake, closing the cold-start race. The command is protected by the
same window-label/origin check as credential IPC.

## Dev

Prereqs:

- Rust 1.94.0 (matches the pinned desktop CI/release toolchain)
- Node 20+, pnpm 9+
- Platform-specific toolchain — see Tauri's [prerequisites guide](https://tauri.app/start/prerequisites/).

Run:

```bash
pnpm install
pnpm tauri dev
```

This launches the bundled local frontend shell (`apps/desktop/src/`) on
`http://localhost:1420`, then opens the native window.

## Build

```bash
pnpm tauri build
```

Output:

| Platform | Artifacts                                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| macOS    | `target/release/bundle/macos/Moosewave.app`, `target/release/bundle/dmg/Postwave_<v>.dmg`                        |
| Windows  | `target/release/bundle/msi/Postwave_<v>_x64_en-US.msi`, `target/release/bundle/nsis/Postwave_<v>_x64-setup.exe` |

Code-signing material is supplied by CI (Apple Developer ID for `.app`/
`.dmg`, Authenticode cert for `.msi`/`.exe`) — never commit `*.p12`,
`*.pfx`, or `apple-key.json`. The auto-updater public key is injected at
build time via the `POSTWAVE_UPDATER_PUBKEY` env var; the matching
private key lives only in CI secrets.

## Notes

- `tauri.conf.json` sets `app.windows[0].visible = false` on purpose: the
  `tauri-plugin-window-state` plugin restores the window's prior size and
  position, then `setup()` calls `window.show()`. This avoids the
  default-position-then-jump flicker.
- The CSP in `tauri.conf.json` only permits Moosewave domains and the
  specific localhost dev ports. If the dashboard ever needs an additional
  origin (e.g. a third-party iframe), update `connect-src` / `frame-src`
  there with the narrowest host possible.
- All native capabilities are explicitly listed in
  `capabilities/main.json` — Tauri 2 enforces an opt-in allowlist.
- Hardened runtime is enabled with an intentionally empty entitlement set.
  Standard WKWebView does not require the app executable to receive JIT or
  unsigned-executable-memory exceptions. Current macOS distribution is
  Developer ID + notarization, not Mac App Store; an App Store build remains
  a separate sandboxing project and release test matrix.
