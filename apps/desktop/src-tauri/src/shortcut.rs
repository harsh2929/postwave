//! Global quick-compose hotkey (roadmap: "Global quick-compose hotkey").
//!
//! Registers **CmdOrCtrl+Shift+P** as an OS-global shortcut via
//! `tauri-plugin-global-shortcut`. On trigger the main window is shown +
//! focused and a `quick-compose` event is emitted to the webview; the
//! React shell (App.tsx) routes it to the Campaigns section and opens the
//! new-campaign composer through the existing template-handoff store.
//!
//! Why this combo: ⌘⇧P / Ctrl+Shift+P is not reserved by macOS or Windows
//! at the OS level (unlike e.g. ⌘Space / Ctrl+Esc). It does collide with
//! "command palette" bindings *inside* editors like VS Code — but global
//! shortcuts only matter when those apps don't consume the key first, and
//! the user can explicitly opt in: the tray menu carries an "Enable quick
//! compose shortcut" check item (OFF by default, persisted across
//! launches via a flag file in `app_local_data_dir`).
//!
//! Honest-UI notes:
//! * Registration can fail (another app may own the combo). We log it and
//!   keep the persisted state at "disabled" so the tray checkbox never
//!   claims a shortcut that isn't actually registered.
//! * The flag file encodes the opt-in — absence means disabled — so a
//!   fresh install never claims an OS-global shortcut unexpectedly.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tracing::{info, warn};

/// The accelerator, in Tauri/muda syntax. `CmdOrCtrl` maps to ⌘ on macOS
/// and Ctrl on Windows/Linux. Keep in lockstep with the tray item label
/// in tray.rs and the docs in src-tauri/README.md.
pub const QUICK_COMPOSE_ACCELERATOR: &str = "CmdOrCtrl+Shift+P";

/// Event name the webview listens for (App.tsx).
pub const QUICK_COMPOSE_EVENT: &str = "quick-compose";

/// Opt-in flag file under `app_local_data_dir`. Present = enabled.
const ENABLED_FLAG_FILE: &str = "quick-compose-shortcut.on";
/// Legacy opt-out marker retained for readability/back-compat when users
/// disable the shortcut after upgrading from the old opt-out model.
const DISABLED_FLAG_FILE: &str = "quick-compose-shortcut.off";

fn enabled_flag_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join(ENABLED_FLAG_FILE))
}

fn disabled_flag_path_for(enabled_flag: &Path) -> PathBuf {
    enabled_flag.with_file_name(DISABLED_FLAG_FILE)
}

/// Is the quick-compose shortcut enabled (per persisted preference)?
/// Defaults to **false** when the flag file is absent or the data dir is
/// unavailable.
pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    match enabled_flag_path(app) {
        Some(path) => is_enabled_at(&path),
        None => false,
    }
}

/// Path-level core of [`is_enabled`]: the flag file encodes the opt-in,
/// so absence means disabled. Split out (no `AppHandle`) for unit tests.
fn is_enabled_at(enabled_flag: &Path) -> bool {
    enabled_flag.exists()
}

/// Persist the enabled/disabled preference. Presence of the `.on` flag
/// means enabled; disabling removes it and writes the legacy `.off`
/// marker for operator-readable state.
fn persist_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
    let path = enabled_flag_path(app).ok_or_else(|| "app data dir unavailable".to_string())?;
    persist_enabled_at(&path, enabled)
}

/// Path-level core of [`persist_enabled`]. Split out (no `AppHandle`) for
/// unit tests.
fn persist_enabled_at(enabled_flag: &Path, enabled: bool) -> Result<(), String> {
    let disabled_flag = disabled_flag_path_for(enabled_flag);
    if enabled {
        if let Some(parent) = enabled_flag.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(enabled_flag, b"on").map_err(|e| e.to_string())?;
        remove_file_if_exists(&disabled_flag)
    } else {
        remove_file_if_exists(enabled_flag)?;
        if let Some(parent) = disabled_flag.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(disabled_flag, b"off").map_err(|e| e.to_string())
    }
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

/// The actual trigger action: surface the main window and tell the
/// dashboard to open the campaign composer.
pub fn fire_quick_compose<R: Runtime>(app: &AppHandle<R>) {
    crate::window_lifecycle::reveal_main_window(app);
    let _ = app.emit(QUICK_COMPOSE_EVENT, ());
}

/// Register the shortcut with the plugin (handler included).
fn register<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(QUICK_COMPOSE_ACCELERATOR, |app, _shortcut, event| {
            // Fire on key-down only; the plugin reports Released too.
            if event.state() == ShortcutState::Pressed {
                fire_quick_compose(app);
            }
        })
        .map_err(|e| e.to_string())
}

fn unregister<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    app.global_shortcut()
        .unregister(QUICK_COMPOSE_ACCELERATOR)
        .map_err(|e| e.to_string())
}

/// Called once from `setup()`, BEFORE the tray is built: register the
/// shortcut iff the persisted preference says enabled. On registration
/// failure (combo owned by another app, missing permission, …) we flip
/// the persisted state to disabled so the next launch doesn't retry.
///
/// Returns the **actual** resulting enabled state. The tray seeds its
/// check item from this return value — not from [`is_enabled`] — so the
/// checkbox stays honest even when persisting the disabled state itself
/// fails (e.g. the data dir is unwritable and the flag file can't be
/// created).
#[must_use]
pub fn register_if_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    if !is_enabled(app) {
        info!("quick-compose shortcut disabled by user preference");
        return false;
    }
    match register(app) {
        Ok(()) => {
            info!("quick-compose shortcut registered ({QUICK_COMPOSE_ACCELERATOR})");
            true
        }
        Err(err) => {
            warn!("failed to register quick-compose shortcut: {err}");
            let _ = persist_enabled(app, false);
            false
        }
    }
}

/// Flip the shortcut on/off (tray check item). Returns the *actual*
/// resulting enabled state so the caller can sync the checkbox — on a
/// failed enable we stay (and persist) disabled.
pub fn set_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> bool {
    if enabled {
        match register(app) {
            Ok(()) => {
                if let Err(err) = persist_enabled(app, true) {
                    warn!("quick-compose: failed to persist enable: {err}");
                }
                info!("quick-compose shortcut enabled");
                true
            }
            Err(err) => {
                warn!("quick-compose: register failed, staying disabled: {err}");
                let _ = persist_enabled(app, false);
                false
            }
        }
    } else {
        if let Err(err) = unregister(app) {
            // Unregister failing is unusual (e.g. it was never registered);
            // the persisted preference still wins for the next launch.
            warn!("quick-compose: unregister failed: {err}");
        }
        if let Err(err) = persist_enabled(app, false) {
            warn!("quick-compose: failed to persist disable: {err}");
        }
        info!("quick-compose shortcut disabled");
        false
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use tauri_plugin_global_shortcut::Shortcut;

    use super::{is_enabled_at, persist_enabled_at, QUICK_COMPOSE_ACCELERATOR};

    /// The accelerator string must stay parseable by the plugin — a typo
    /// here would make register() fail at runtime on every launch.
    #[test]
    fn accelerator_parses() {
        assert!(Shortcut::from_str(QUICK_COMPOSE_ACCELERATOR).is_ok());
    }

    /// The flag file encodes the opt-in: absence (including a brand-new
    /// install with no data dir yet) must read as disabled, and the
    /// persist/read round-trip must agree in both directions. This is the
    /// persisted half of the tray-checkbox honesty contract —
    /// `register_if_enabled` writes through the same helper
    /// when the OS rejects the registration.
    #[test]
    fn opt_in_flag_round_trip() {
        let dir = std::env::temp_dir().join(format!(
            "postwave-shortcut-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let flag = dir.join("quick-compose-shortcut.on");
        let disabled_flag = dir.join("quick-compose-shortcut.off");

        // Absence — even of the parent dir — means disabled (fresh install).
        assert!(!is_enabled_at(&flag));

        // Enable creates the opt-in flag (and the missing parent dir).
        persist_enabled_at(&flag, true).expect("persist enable");
        assert!(is_enabled_at(&flag));
        assert!(!disabled_flag.exists());

        // Enabling again is idempotent.
        persist_enabled_at(&flag, true).expect("persist enable twice");
        assert!(is_enabled_at(&flag));

        // Disable removes the opt-in flag and writes the legacy off marker.
        persist_enabled_at(&flag, false).expect("persist disable");
        assert!(!is_enabled_at(&flag));
        assert!(disabled_flag.exists());

        // Disabling again is idempotent.
        persist_enabled_at(&flag, false).expect("persist disable twice");
        assert!(!is_enabled_at(&flag));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
