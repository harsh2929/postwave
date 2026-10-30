# Desktop auto-updates

How Moosewave Desktop's auto-update channel works, how to turn it on, and
what an unconfigured build does. Implements gaps doc B5
(`GAPS-REMAINING-2026-06-10.md`).

## Design: env-gated at build time

The updater is **inactive unless the build environment provided both** of
these variables when `cargo`/`tauri build` ran:

| Variable                    | Meaning                                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTWAVE_UPDATER_PUBKEY`   | The minisign **public** key from `tauri signer generate`. Compiled into the binary; every downloaded artifact's signature is verified against it before install.                                                                                  |
| `POSTWAVE_UPDATER_ENDPOINT` | HTTPS URL of the update manifest, e.g. `https://releases.moosewave.com/desktop/{{target}}/{{arch}}/{{current_version}}`. The `{{target}}` / `{{arch}}` / `{{current_version}}` placeholders are substituted by the updater plugin at request time. |

When both are missing or empty (the normal local-development state):

- `tauri_plugin_updater` is **never registered** (`main.rs` gates the
  `.plugin(...)` call on `updater::build_config()`), so no updater code can
  make network requests;
- the `check_for_updates` / `install_update` IPC commands return a typed
  `{"status": "not_configured"}` result;
- Desktop Settings and the account menu show an honest "No update channel in
  this build" state — no simulated check or success toast.

A partial pair is treated as a build-configuration error, not as an
intentionally disabled channel. Rust also parses the endpoint before plugin
registration and rejects non-HTTPS URLs, missing/ambiguous hosts,
credentials, fragments, control characters, and overlong values. The same
native validator runs again before every check/install; release CI's URL
preflight is defense in depth rather than the only HTTPS control.
Artifact URLs returned by the manifest must independently pass the same HTTPS,
host, credentials, and fragment checks. The updater follows at most five
redirects and refuses any redirect that downgrades from HTTPS or introduces URL
credentials/a fragment.

The `plugins.updater` block in `tauri.conf.json` is an intentionally empty
placeholder (`pubkey: ""`, `endpoints: []`) — it exists only because the
plugin requires a config object to deserialize when it _is_ registered.
Editing the JSON cannot activate updates: the pubkey is pinned from the
build env in Rust (`tauri_plugin_updater::Builder::new().pubkey(...)`) and
the endpoint is applied per check in `src-tauri/src/updater.rs`. Activation
always requires a rebuild with real values, which is the fail-safe the
2026-06-10 audit asked for.

## One-time setup: generate a signing key

```sh
pnpm tauri signer generate -w ~/.tauri/postwave-desktop.key
# or: cargo tauri signer generate -w ~/.tauri/postwave-desktop.key
```

This prints a **private key** (optionally password-protected) and a
**public key**.

- Private key + password → CI secret store ONLY (e.g. GitHub Actions
  secrets `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
  Never commit it; losing it means shipped apps can never accept another
  update (no key rotation in the v1 updater protocol).
- Public key → CI variable `POSTWAVE_UPDATER_PUBKEY`.

## CI: building a release with updates enabled

```yaml
env:
  POSTWAVE_UPDATER_PUBKEY: ${{ vars.POSTWAVE_UPDATER_PUBKEY }}
  POSTWAVE_UPDATER_ENDPOINT: https://releases.moosewave.com/desktop/{{target}}/{{arch}}/{{current_version}}
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
steps:
  - run: pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":true}}'
```

Notes:

- `createUpdaterArtifacts` is applied as a CLI `--config` overlay rather
  than committed to `tauri.conf.json`, so local `pnpm tauri build` keeps
  working without signing keys (with it committed, every build would fail
  unless `TAURI_SIGNING_PRIVATE_KEY` is set).
- With the overlay set, the bundler produces updater artifacts and a
  `.sig` file per artifact: macOS `Moosewave.app.tar.gz(.sig)`, Windows
  `*-setup.exe(.sig)` / `*.msi(.sig)`.
- The two `POSTWAVE_UPDATER_*` vars must be present **before cargo
  compiles** the shell (they're read via `option_env!`; `build.rs` declares
  `rerun-if-env-changed` so flipping them forces a recompile).

## Endpoint manifest format

The endpoint must return `HTTP 200` with this JSON when an update exists,
or `HTTP 204 No Content` when the requesting version is current:

```json
{
  "version": "0.2.0",
  "notes": "Fixes the suppression console and adds audience syncs.",
  "severity": "important",
  "pub_date": "2026-06-10T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of Moosewave.app.tar.gz.sig>",
      "url": "https://releases.moosewave.com/desktop/v0.2.0/Postwave_aarch64.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "…",
      "url": "https://releases.moosewave.com/desktop/v0.2.0/Postwave_x64.app.tar.gz"
    },
    "windows-x86_64": {
      "signature": "<contents of Postwave_0.2.0_x64-setup.exe.sig>",
      "url": "https://releases.moosewave.com/desktop/v0.2.0/Postwave_0.2.0_x64-setup.exe"
    }
  }
}
```

A static-file layout also works (one JSON per `{{target}}/{{arch}}`) since
the plugin both substitutes URL placeholders and matches
`platforms.<target>-<arch>` keys. `signature` is the **contents** of the
`.sig` file, not a path. `version` may have a leading `v`. `notes` and
`pub_date` are optional. `notes` is bounded and rendered as plain text in
Desktop Settings. `severity` is optional and allowlisted to `informational`,
`recommended`, `important`, or `critical`; absent/unknown values resolve to
`recommended`.

## Runtime flow

1. `main.tsx` starts the process-wide update listener before credential/API
   hydration. Rust checks once 15 seconds after launch and then six hours after
   each completed check. Every result (including failure) is retained natively
   before `updater:state` is emitted, and the renderer installs its listener
   before calling `get_update_state`. A slow renderer or reload therefore
   cannot lose the scheduled result.
2. `check_for_updates` (Rust) hits the endpoint, verifies versioning, and
   returns version, release notes, severity, publication/check timestamps, and
   whether the check was manual or scheduled.
3. `desktop-update-service.ts` owns one durable state machine independent of
   menu/page mounts and transient toasts. Desktop Settings presents the full
   state and release notes; the account menu presents the primary action; the
   top-bar account button carries the attention badge. Operators can retry,
   install, remind in four hours/tomorrow, or resume reminders.
4. **Install** → `install_update` rechecks, downloads, verifies the signature
   against the compiled-in pubkey, and applies the update (Rust emits
   `updater:download-progress {downloaded, total}` events along the way).
5. Installed state persists as `ready_to_restart`; the current process keeps
   running until the operator chooses **Review & restart**. The global restart
   decision probes every `registerUpdateRestartGuard` owner, fails closed on
   probe/prepare errors, refuses blocking work, and requires an explicit
   decision for warnings. **Restart later** preserves the reminder.
6. On the next boot, the service compares the running version with the staged
   version and clears restart-required state only when that version or a newer
   one is actually running.

Automatic and manual checks share a native operation lock, so a periodic tick
cannot race an install. Installation and restart always require an explicit
operator action. A failed refresh never turns a previously verified available
update into "up to date"; it retains and labels the prior result.

## Release qualification still required

Unit/IPC tests cannot prove the distribution path. Before enabling a client
channel, qualify the exact signed hashes produced by release CI:

1. Install signed N-1 packages on every supported macOS architecture and
   Windows installer type; check, download, verify, install, restart, and prove
   N is running without losing drafts or active durable work.
2. Exercise cold start, slow renderer/keychain startup, hidden-to-tray,
   suspend/resume, offline/reconnect, interrupted download, endpoint 204/5xx,
   invalid signature, and relaunch failure.
3. Prove server-side staged rollout, pause/kill switch, artifact withdrawal,
   and forward-recovery procedures. The client intentionally does not invent a
   local rollout percentage: release eligibility belongs to the signed channel.
4. Archive the manifest, artifact hashes/signatures, OS/version/hardware matrix,
   and screenshots/logs as release evidence. A draft CI artifact is not proof
   of an installed update path.
