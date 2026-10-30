//! Native half of the desktop window/lifecycle handshake.
//!
//! Native close and process-exit requests are always stopped first. The
//! renderer owns the user-facing decision because it is the only layer that
//! can inspect drafts, transfers and encrypted journals. Pending intents are
//! retained until the listener-first renderer handshake, so a slow keychain
//! unlock cannot turn an early close/quit into lost work.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

use crate::ipc_guard::ensure_main_bundled_window;

pub const CLOSE_REQUESTED_EVENT: &str = "lifecycle:close-requested";
pub const QUIT_REQUESTED_EVENT: &str = "lifecycle:quit-requested";
pub const OS_SHUTDOWN_REQUESTED_EVENT: &str = "lifecycle:os-shutdown-requested";
const LIFECYCLE_DIR: &str = "lifecycle";
const SHUTDOWN_MARKER: &str = "interrupted-shutdown.marker";
#[cfg(target_os = "macos")]
const FULLSCREEN_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(target_os = "macos")]
const FULLSCREEN_EXIT_TIMEOUT: Duration = Duration::from_secs(4);
#[cfg(target_os = "macos")]
const FULLSCREEN_EXIT_STABLE_SAMPLES: usize = 6;

#[derive(Default)]
pub struct WindowLifecycleState {
    close_requested: AtomicBool,
    quit_requested: AtomicBool,
    os_shutdown_requested: AtomicBool,
    approved_exit: AtomicBool,
    recovered_interrupted_shutdown: AtomicBool,
    shutdown_marker: Mutex<Option<PathBuf>>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowLifecycleSnapshot {
    pub close_requested: bool,
    pub quit_requested: bool,
    pub os_shutdown_requested: bool,
    pub recovered_interrupted_shutdown: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowContext {
    title: String,
    authenticated: bool,
    can_compose: bool,
    active_section: String,
}

pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "desktop lifecycle storage unavailable".to_string())?
        .join(LIFECYCLE_DIR);
    create_private_dir(&directory)?;
    let marker = directory.join(SHUTDOWN_MARKER);
    let state = app.state::<WindowLifecycleState>();
    state
        .recovered_interrupted_shutdown
        .store(marker.exists(), Ordering::Release);
    *state
        .shutdown_marker
        .lock()
        .map_err(|_| "desktop lifecycle state unavailable".to_string())? = Some(marker);
    Ok(())
}

/// Retain and emit a window-close intent. The caller must already have
/// prevented the native close; no fallback hides or exits behind the
/// renderer's back.
pub fn request_close<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<WindowLifecycleState>();
    state.close_requested.store(true, Ordering::Release);
    reveal_main_window(app);
    let _ = app.emit(CLOSE_REQUESTED_EVENT, ());
}

/// Retain menu/tray quit until the renderer has installed its listeners.
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<WindowLifecycleState>();
    state.quit_requested.store(true, Ordering::Release);
    reveal_main_window(app);
    let _ = app.emit(QUIT_REQUESTED_EVENT, ());
}

/// Intercept an unapproved process exit. This is best effort during an OS
/// shutdown: the OS may still terminate us, so a private one-shot marker is
/// written before the renderer is asked to flush durable owners.
pub fn request_os_shutdown<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<WindowLifecycleState>();
    if state.os_shutdown_requested.swap(true, Ordering::AcqRel) {
        return;
    }
    let _ = write_shutdown_marker(&state);
    let _ = crate::diagnostics::record_native_lifecycle(app, "os_shutdown_requested");
    reveal_main_window(app);
    let _ = app.emit(OS_SHUTDOWN_REQUESTED_EVENT, ());
}

pub fn exit_is_approved<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<WindowLifecycleState>()
        .approved_exit
        .load(Ordering::Acquire)
}

pub fn approve_exit<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<WindowLifecycleState>();
    state.approved_exit.store(true, Ordering::Release);
    state.close_requested.store(false, Ordering::Release);
    state.quit_requested.store(false, Ordering::Release);
    state.os_shutdown_requested.store(false, Ordering::Release);
    remove_shutdown_marker(&state);
}

pub fn reveal_main_window<R: Runtime>(app: &AppHandle<R>) {
    // `desktop_window_hide` hides the whole NSApplication on macOS. Showing
    // only its NSWindow afterwards leaves the application hidden and can
    // produce an empty/black Space, so unhide the application first.
    #[cfg(target_os = "macos")]
    {
        // AppKit can retain an accessory/hidden activation state after a
        // keep-running close or an interrupted development launch. A window
        // cannot become key in that state even when `show()` succeeds, which
        // leaves a menu-bar process with zero visible windows. Reassert the
        // ordinary application policy before every user-facing reveal.
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        let _ = app.show();
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub fn desktop_window_lifecycle_ready(
    window: WebviewWindow,
    state: tauri::State<'_, WindowLifecycleState>,
) -> Result<WindowLifecycleSnapshot, String> {
    ensure_main_bundled_window(&window, "Desktop lifecycle")?;
    let snapshot = WindowLifecycleSnapshot {
        close_requested: state.close_requested.swap(false, Ordering::AcqRel),
        quit_requested: state.quit_requested.swap(false, Ordering::AcqRel),
        os_shutdown_requested: state.os_shutdown_requested.swap(false, Ordering::AcqRel),
        recovered_interrupted_shutdown: state
            .recovered_interrupted_shutdown
            .load(Ordering::Acquire),
    };
    Ok(snapshot)
}

#[tauri::command]
pub async fn desktop_window_hide(
    window: WebviewWindow,
    state: tauri::State<'_, WindowLifecycleState>,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "Desktop window")?;
    state.close_requested.store(false, Ordering::Release);
    // Hiding only an NSWindow keeps Moosewave as the active macOS application.
    // In fullscreen that strands the user on the app's now-empty Space; in a
    // regular Space it leaves Moosewave's menu bar over a black/empty desktop.
    // AppKit's application hide performs the native deactivation and Space
    // transition atomically while keeping the renderer and background work
    // alive. Other desktop platforms retain window-only hide semantics.
    #[cfg(target_os = "macos")]
    {
        leave_macos_fullscreen_and_wait_for_stable_frame(&window).await?;
        window
            .app_handle()
            .hide()
            .map_err(|_| "desktop application could not be hidden".to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        window
            .hide()
            .map_err(|_| "desktop window could not be hidden".to_string())
    }
}

/// AppKit animates a fullscreen NSWindow back into its ordinary content frame.
/// Hiding the application before that animation settles can preserve the
/// fullscreen WebView origin with the ordinary window height: the top chrome
/// is clipped and the same displaced band appears blank at the bottom. Wait
/// until fullscreen is off and the restored client size has remained stable
/// for several samples before allowing NSApplication::hide.
#[cfg(target_os = "macos")]
async fn leave_macos_fullscreen_and_wait_for_stable_frame(
    window: &WebviewWindow,
) -> Result<(), String> {
    let fullscreen = window
        .is_fullscreen()
        .map_err(|_| "desktop fullscreen state unavailable".to_string())?;
    if !fullscreen {
        return Ok(());
    }

    window
        .set_fullscreen(false)
        .map_err(|_| "desktop window could not leave fullscreen".to_string())?;

    let deadline = Instant::now() + FULLSCREEN_EXIT_TIMEOUT;
    let mut last_size = None;
    let mut stable_samples = 0;
    loop {
        tokio::time::sleep(FULLSCREEN_EXIT_POLL_INTERVAL).await;
        if Instant::now() >= deadline {
            return Err("desktop window did not finish leaving fullscreen".to_string());
        }
        if window
            .is_fullscreen()
            .map_err(|_| "desktop fullscreen state unavailable".to_string())?
        {
            last_size = None;
            stable_samples = 0;
            continue;
        }

        let size = window
            .inner_size()
            .map_err(|_| "desktop window size unavailable".to_string())?;
        if last_size == Some(size) {
            stable_samples += 1;
        } else {
            last_size = Some(size);
            stable_samples = 1;
        }
        if stable_samples >= FULLSCREEN_EXIT_STABLE_SAMPLES {
            return Ok(());
        }
    }
}

#[tauri::command]
pub fn desktop_window_cancel_intent(
    window: WebviewWindow,
    state: tauri::State<'_, WindowLifecycleState>,
    kind: String,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "Desktop lifecycle")?;
    match kind.as_str() {
        "close-window" => state.close_requested.store(false, Ordering::Release),
        "quit-app" => state.quit_requested.store(false, Ordering::Release),
        "os-shutdown" => {
            state.os_shutdown_requested.store(false, Ordering::Release);
            remove_shutdown_marker(&state);
        }
        "recovered-shutdown" => {
            state
                .recovered_interrupted_shutdown
                .store(false, Ordering::Release);
            remove_shutdown_marker(&state);
        }
        _ => return Err("invalid desktop lifecycle intent".to_string()),
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_window_set_context<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    context: DesktopWindowContext,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "Desktop window context")?;
    let title = validate_title(&context.title)?;
    let active_section = validate_active_section(&context.active_section)?;
    window
        .set_title(title)
        .map_err(|_| "desktop window title could not be updated".to_string())?;
    crate::menu::set_session_context(
        &app,
        context.authenticated,
        context.can_compose,
        active_section,
    );
    crate::tray::set_session_context(&app, context.authenticated, context.can_compose);
    Ok(())
}

fn validate_title(raw: &str) -> Result<&str, String> {
    let title = raw.trim();
    if title.is_empty() || title.chars().count() > 160 || title.chars().any(char::is_control) {
        return Err("invalid desktop window title".to_string());
    }
    Ok(title)
}

fn validate_active_section(raw: &str) -> Result<&str, String> {
    match raw {
        "dashboard" | "approvals" | "settings" | "other" => Ok(raw),
        _ => Err("invalid desktop active section".to_string()),
    }
}

fn create_private_dir(path: &PathBuf) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|_| "desktop lifecycle storage unavailable".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "desktop lifecycle storage unavailable".to_string())?;
    }
    Ok(())
}

fn write_shutdown_marker(state: &WindowLifecycleState) -> Result<(), String> {
    let path = state
        .shutdown_marker
        .lock()
        .map_err(|_| "desktop lifecycle state unavailable".to_string())?
        .clone()
        .ok_or_else(|| "desktop lifecycle storage unavailable".to_string())?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "desktop lifecycle marker unavailable".to_string())?;
    file.write_all(b"shutdown-requested-v1\n")
        .and_then(|_| file.flush())
        .map_err(|_| "desktop lifecycle marker unavailable".to_string())
}

fn remove_shutdown_marker(state: &WindowLifecycleState) {
    if let Ok(marker) = state.shutdown_marker.lock() {
        if let Some(path) = marker.as_ref() {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{validate_active_section, validate_title, WindowLifecycleSnapshot};

    #[test]
    fn title_contract_is_bounded_and_rejects_control_characters() {
        assert_eq!(
            validate_title("Dashboard — Moosewave"),
            Ok("Dashboard — Moosewave")
        );
        assert!(validate_title("").is_err());
        assert!(validate_title("bad\ntitle").is_err());
        assert!(validate_title(&"x".repeat(161)).is_err());
    }

    #[test]
    fn menu_context_accepts_only_non_sensitive_route_classes() {
        for section in ["dashboard", "approvals", "settings", "other"] {
            assert_eq!(validate_active_section(section), Ok(section));
        }
        assert!(validate_active_section("workspace/acme").is_err());
    }

    #[test]
    fn retained_snapshot_serializes_with_renderer_field_names() {
        let value = serde_json::to_value(WindowLifecycleSnapshot {
            close_requested: true,
            quit_requested: false,
            os_shutdown_requested: true,
            recovered_interrupted_shutdown: true,
        })
        .unwrap();
        assert_eq!(value["closeRequested"], true);
        assert_eq!(value["osShutdownRequested"], true);
        assert_eq!(value["recoveredInterruptedShutdown"], true);
    }

    #[test]
    fn every_native_close_and_unapproved_exit_routes_through_lifecycle() {
        let main = include_str!("main.rs");
        let menu = include_str!("menu.rs");
        let tray = include_str!("tray.rs");
        assert!(main.contains("api.prevent_close()"));
        assert!(main.contains("window_lifecycle::request_close(window.app_handle())"));
        assert!(main.contains("tauri::RunEvent::ExitRequested"));
        assert!(main.contains("window_lifecycle::request_os_shutdown(app_handle)"));
        assert!(menu.contains("crate::window_lifecycle::request_close(app)"));
        assert!(menu.contains("crate::window_lifecycle::request_quit(app)"));
        assert!(tray.contains("crate::window_lifecycle::request_quit(app)"));
    }

    #[test]
    fn window_geometry_contract_has_restoration_and_supported_bounds() {
        let main = include_str!("main.rs");
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(main.contains("tauri_plugin_window_state::Builder::default().build()"));
        let window = &config["app"]["windows"][0];
        assert_eq!(window["width"], 1100);
        assert_eq!(window["height"], 720);
        assert_eq!(window["minWidth"], 880);
        assert_eq!(window["minHeight"], 560);
        assert_eq!(window["visible"], false);
    }

    #[test]
    fn tray_click_conventions_and_menu_readiness_are_source_pinned() {
        let tray = include_str!("tray.rs");
        let menu = include_str!("menu.rs");
        assert!(tray.contains("show_menu_on_left_click(cfg!(target_os = \"macos\"))"));
        assert!(tray.contains("MouseButton::Left"));
        assert!(tray.contains("set_session_context"));
        assert!(menu.contains("set_session_context"));
    }
}
