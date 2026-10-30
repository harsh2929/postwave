//! System tray (menu bar icon on macOS, taskbar icon on Windows).
//!
//! The tray menu lets the user reach common Moosewave actions without
//! bringing the main window to the foreground. Each item emits a retained or
//! live Tauri intent that the renderer subscribes to. Quit always routes
//! through the shared lifecycle decision; it never exits directly.

#[cfg(not(target_os = "macos"))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Emitter, Manager, Runtime,
};

use crate::shortcut;

/// Menu item ids — also used as the event name when emitted to the
/// dashboard. Keep them in sync with the JS-side listeners.
pub const TRAY_OPEN: &str = "tray:open";
pub const TRAY_NEW_CAMPAIGN: &str = "tray:new-campaign";
pub const TRAY_SETTINGS: &str = "tray:settings";
pub const TRAY_SIGN_OUT: &str = "tray:sign-out";
pub const TRAY_QUIT: &str = "lifecycle:quit-requested";
/// Check item toggling the global quick-compose shortcut. Handled
/// entirely on the Rust side (no event reaches the dashboard).
pub const TRAY_QUICK_COMPOSE_TOGGLE: &str = "tray:quick-compose-toggle";

/// Handle to the quick-compose check item so the toggle handler can
/// re-sync the checkbox when enabling fails (the OS-level register can
/// be rejected when another app owns the combo). Stored in Tauri's
/// managed state by `build_tray`.
struct QuickComposeToggle<R: Runtime>(CheckMenuItem<R>);

struct TraySessionItems<R: Runtime> {
    new_campaign: MenuItem<R>,
    settings: MenuItem<R>,
    sign_out: MenuItem<R>,
}

/// Build the system tray and install it on the app handle.
///
/// `quick_compose_enabled` seeds the quick-compose check item and must be
/// the *actual* registration state returned by
/// `shortcut::register_if_enabled` — not `shortcut::is_enabled` — so the
/// checkbox never claims a shortcut the OS refused to register (main.rs
/// runs the registration before building the tray for exactly this
/// reason).
///
/// Returns the [`TrayIcon`] so callers can hold a reference (Tauri keeps
/// the tray alive as long as the icon handle lives somewhere — we let the
/// app handle's resource map own it).
pub fn build_tray<R: Runtime>(
    app: &AppHandle<R>,
    quick_compose_enabled: bool,
) -> tauri::Result<TrayIcon<R>> {
    let open = MenuItem::with_id(app, TRAY_OPEN, "Open Moosewave", true, None::<&str>)?;
    let new_campaign = MenuItem::with_id(
        app,
        TRAY_NEW_CAMPAIGN,
        "New campaign",
        false,
        Some("CmdOrCtrl+N"),
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    // Settings-free toggle for the global quick-compose shortcut
    // (CmdOrCtrl+Shift+P). Checked state mirrors the ACTUAL registration
    // outcome passed in by the caller; clicking flips it via
    // handle_tray_event.
    let quick_compose_toggle = CheckMenuItem::with_id(
        app,
        TRAY_QUICK_COMPOSE_TOGGLE,
        "Enable quick compose shortcut",
        true,
        quick_compose_enabled,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(app, TRAY_SETTINGS, "Settings", false, None::<&str>)?;
    let sign_out = MenuItem::with_id(app, TRAY_SIGN_OUT, "Sign out", false, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, "Quit", true, Some("CmdOrCtrl+Q"))?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &new_campaign,
            &sep1,
            &quick_compose_toggle,
            &settings,
            &sign_out,
            &sep2,
            &quit,
        ],
    )?;

    // Keep a handle to the check item so the toggle handler can write the
    // checkbox back to the real state after a failed register.
    app.manage(QuickComposeToggle(quick_compose_toggle));
    app.manage(TraySessionItems {
        new_campaign,
        settings,
        sign_out,
    });

    let tray = TrayIconBuilder::with_id("postwave-tray")
        .tooltip("Moosewave")
        .icon(
            app.default_window_icon()
                .cloned()
                .ok_or_else(|| tauri::Error::AssetNotFound("default window icon missing".into()))?,
        )
        .menu(&menu)
        // macOS menu-bar extras conventionally open their menu on a primary
        // click. Windows notification-area icons conventionally restore the
        // app; the explicit Open item remains available from the context menu.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| handle_tray_event(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            #[cfg(not(target_os = "macos"))]
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                reveal_and_emit_open(tray.app_handle());
            }
            #[cfg(target_os = "macos")]
            let _ = (tray, event);
        })
        .build(app)?;

    Ok(tray)
}

pub fn set_session_context<R: Runtime>(app: &AppHandle<R>, authenticated: bool, can_compose: bool) {
    if let Some(items) = app.try_state::<TraySessionItems<R>>() {
        let _ = items.new_campaign.set_enabled(authenticated && can_compose);
        let _ = items.settings.set_enabled(authenticated);
        let _ = items.sign_out.set_enabled(authenticated);
    }
}

fn reveal_and_emit_open<R: Runtime>(app: &AppHandle<R>) {
    crate::window_lifecycle::reveal_main_window(app);
    let _ = app.emit(TRAY_OPEN, ());
}

/// Dispatch a tray menu click. We keep this pub(crate) so menu.rs can share
/// the same handler vocabulary if needed.
pub(crate) fn handle_tray_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        TRAY_OPEN => {
            reveal_and_emit_open(app);
        }
        TRAY_QUIT => {
            crate::window_lifecycle::request_quit(app);
        }
        TRAY_QUICK_COMPOSE_TOGGLE => {
            // Flip the persisted preference + (un)register the OS-global
            // shortcut. `set_enabled` returns the ACTUAL resulting state —
            // a failed enable stays disabled — and we write that back to
            // the checkbox so the menu never lies about registration.
            let actual = shortcut::set_enabled(app, !shortcut::is_enabled(app));
            if let Some(toggle) = app.try_state::<QuickComposeToggle<R>>() {
                let _ = toggle.0.set_checked(actual);
            }
        }
        // Everything else: emit an event the dashboard listens for and
        // navigates / acts on. Single source of truth: id == event name.
        other => {
            let _ = app.emit(other, ());
            // Also bring the window to the front so the user can see the
            // result of whatever action they just triggered.
            crate::window_lifecycle::reveal_main_window(app);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_quit_routes_through_renderer_lifecycle_review() {
        assert_eq!(TRAY_QUIT, "lifecycle:quit-requested");
    }
}
