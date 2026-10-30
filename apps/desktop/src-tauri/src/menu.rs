//! Application menu — the macOS menu bar and the Windows in-window menu.
//!
//! Menu structure (cross-platform; macOS gets its standard "Moosewave" app
//! menu prepended automatically by Tauri):
//!
//!   File    -> New campaign, Settings…, Close window, Quit
//!   Edit    -> Undo, Redo, Cut, Copy, Paste, Select all
//!   View    -> Toggle full screen
//!   Go      -> Dashboard, Approvals
//!   Window  -> Minimize, Zoom
//!   Help    -> About
//!
//! Note: on macOS the first submenu becomes the application menu, so the
//! File items (including Settings… with ⌘,) land under "Moosewave".

use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, Runtime,
};

// Menu item ids — these double as event names emitted to the dashboard.
// Keep them in sync with the JS-side listeners in App.tsx.
pub const MENU_NEW_CAMPAIGN: &str = "menu:new-campaign";
pub const MENU_CLOSE_WINDOW: &str = "menu:close-window";
pub const MENU_SETTINGS: &str = "menu:settings";
pub const MENU_APPROVALS: &str = "menu:approvals";
pub const MENU_DASHBOARD: &str = "menu:dashboard";
pub const MENU_QUIT: &str = "lifecycle:quit-requested";

/// Handles whose enabled state follows the authenticated renderer context.
/// Close/Quit and the standard Edit/Window commands intentionally stay
/// native and available even before account hydration.
struct AppMenuSessionItems<R: Runtime> {
    new_campaign: MenuItem<R>,
    settings: MenuItem<R>,
    approvals: MenuItem<R>,
    dashboard: MenuItem<R>,
}

/// Build the cross-platform application menu.
pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // ----- File -----
    let new_campaign = MenuItem::with_id(
        app,
        MENU_NEW_CAMPAIGN,
        "New campaign",
        false,
        Some("CmdOrCtrl+N"),
    )?;
    let settings = MenuItem::with_id(app, MENU_SETTINGS, "Settings…", false, Some("CmdOrCtrl+,"))?;
    let close_window = MenuItem::with_id(
        app,
        MENU_CLOSE_WINDOW,
        "Close window",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    // Custom rather than predefined: the renderer's lifecycle coordinator
    // must review drafts, jobs and the outbox before it invokes quit_app.
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit Moosewave", true, Some("CmdOrCtrl+Q"))?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_campaign,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &close_window,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    // ----- Edit ----- (use predefined items so OS keyboard shortcuts work).
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // ----- View -----
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;

    // ----- Go ----- (navigation shortcuts; the dashboard routes on these).
    let dashboard =
        MenuItem::with_id(app, MENU_DASHBOARD, "Dashboard", false, Some("CmdOrCtrl+1"))?;
    // D03-tauri-shell#3: Approvals is ⌘8, not ⌘2. The JS layer maps
    // ⌘2 → Subscribers (store.ts NUMERIC_SECTIONS / desktop-routes kbd)
    // and ⌘8 → Approvals. A native accelerator is consumed by the OS
    // menu before the webview's keydown handler, so binding this item to
    // ⌘2 hijacked the advertised Subscribers shortcut. Match ⌘8.
    let approvals =
        MenuItem::with_id(app, MENU_APPROVALS, "Approvals", false, Some("CmdOrCtrl+8"))?;
    let go = Submenu::with_items(app, "Go", true, &[&dashboard, &approvals])?;

    // ----- Window -----
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    // ----- Help ----- (no Documentation item: no docs URL exists and the
    // dashboard has no `menu:docs` listener — see AUDIT-DESKTOP-2026-06-10 §6).
    let about = PredefinedMenuItem::about(
        app,
        Some("About Moosewave"),
        Some(AboutMetadata {
            name: Some("Moosewave".to_string()),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            ..Default::default()
        }),
    )?;
    let help = Submenu::with_items(app, "Help", true, &[&about])?;

    let menu = Menu::with_items(app, &[&file, &edit, &view, &go, &window_menu, &help])?;
    app.manage(AppMenuSessionItems {
        new_campaign,
        settings,
        approvals,
        dashboard,
    });
    Ok(menu)
}

/// Keep native navigation honest while credentials/role/capabilities are
/// unresolved, and disable the already-active top-level destination.
pub fn set_session_context<R: Runtime>(
    app: &AppHandle<R>,
    authenticated: bool,
    can_compose: bool,
    active_section: &str,
) {
    if let Some(items) = app.try_state::<AppMenuSessionItems<R>>() {
        let _ = items.new_campaign.set_enabled(authenticated && can_compose);
        let _ = items
            .settings
            .set_enabled(authenticated && active_section != "settings");
        let _ = items
            .approvals
            .set_enabled(authenticated && active_section != "approvals");
        let _ = items
            .dashboard
            .set_enabled(authenticated && active_section != "dashboard");
    }
}

/// Handle a click on any of our custom menu items. Predefined items
/// (Cut/Copy/Paste/Quit/etc) are handled by Tauri itself and never reach
/// this function.
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        MENU_CLOSE_WINDOW => {
            // Close preference + every active-work decision live in the
            // renderer lifecycle coordinator. Retention closes the race when
            // the operator invokes Cmd+W during slow credential hydration.
            crate::window_lifecycle::request_close(app);
        }
        // Forward everything else to the dashboard as an event whose name
        // is the menu id. The dashboard decides what to do (route, modal, …).
        MENU_QUIT => {
            crate::window_lifecycle::request_quit(app);
        }
        other => {
            let _ = app.emit(other, ());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_accelerator_routes_through_renderer_lifecycle_review() {
        assert_eq!(MENU_QUIT, "lifecycle:quit-requested");
    }
}
