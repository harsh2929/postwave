// Moosewave Desktop — Tauri 2 shell.
//
// This binary is intentionally thin: it wires up plugins, builds the tray /
// app menu, registers IPC commands, and hands control off to Tauri. The
// product UI is rendered by the bundled React shell in apps/desktop/src.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::time::Duration;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

mod api_broker;
mod commands;
mod deep_link;
mod diagnostics;
mod file_transfer;
mod ipc_guard;
mod menu;
mod native_notification;
mod net;
mod session_broker;
mod shortcut;
mod tray;
mod updater;
mod vault;
mod window_lifecycle;

fn main() {
    // Install before tracing/plugins so setup panics still leave a structural,
    // one-shot marker. The hook never writes the panic payload.
    diagnostics::install_panic_hook();

    // Initialize structured logging. RUST_LOG controls verbosity in dev.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .try_init();

    let version = env!("CARGO_PKG_VERSION");

    let mut builder = tauri::Builder::default()
        // ----- single-instance MUST be the first plugin so it intercepts
        // duplicate launches before any other initialization runs. -----
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second instance was launched. argv contains the new
            // process's args — including any `moosewave://...` deep link.
            info!("second instance launched with {} args", argv.len());

            // Treat command-line URL arguments as hostile. The same native
            // validator used by the OS plugin gates them before delivery and
            // before we decide whether this launch may steal focus.
            let mut had_deep_link = false;
            let mut accepted_deep_link = false;
            for arg in argv.iter().skip(1) {
                if arg.starts_with("moosewave://") {
                    had_deep_link = true;
                    accepted_deep_link |= deep_link::dispatch_deep_link(app, arg);
                }
            }

            // A normal second launch and a validated intent foreground the
            // app. A rejected intent is queued as a redacted recovery message
            // but does not unexpectedly pull a hidden app over the user's
            // current work; they can reopen it deliberately to see recovery.
            if !had_deep_link || accepted_deep_link {
                window_lifecycle::reveal_main_window(app);
            }
        }))
        // Window state — restore size + position from previous session.
        // Registered before the window is shown so it can apply state.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Native plugins.
        .plugin(tauri_plugin_deep_link::init())
        // The capability file exposes only plain-text write/read/clear.
        // Read + clear are needed solely for secret clear-if-unchanged.
        .plugin(tauri_plugin_clipboard_manager::init())
        // File access stays picker-scoped: dialog extends the fs runtime
        // scope for the exact user-selected path, while the capability grants
        // only read/stat. Export writes stream through guarded Rust commands.
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Global quick-compose hotkey (CmdOrCtrl+Shift+P). The plugin is
        // always loaded; the shortcut itself is only registered in setup()
        // when the user preference allows (see shortcut.rs + the tray's
        // "Enable quick compose shortcut" check item).
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());

    // Auto-updater (gaps doc B5) — REGISTERED only when both
    // POSTWAVE_UPDATER_PUBKEY and POSTWAVE_UPDATER_ENDPOINT were present
    // at build time. The pubkey is pinned here (overriding the empty
    // placeholder in tauri.conf.json); the endpoint is applied per check
    // in updater.rs. Unconfigured builds never load the plugin, so the
    // check_for_updates / install_update commands degrade to a typed
    // `not_configured` result with zero update-related network code.
    match updater::build_config() {
        Ok(Some((pubkey, _endpoint))) => {
            info!("signed auto-updater enabled with an HTTPS endpoint");
            builder = builder.plugin(tauri_plugin_updater::Builder::new().pubkey(pubkey).build());
        }
        Ok(None) => info!("auto-updater not configured for this build"),
        Err(configuration_error) => {
            // Keep the application usable, but fail the update channel closed.
            // Commands report the same configuration error and no updater
            // plugin/network path is registered.
            error!(%configuration_error, "auto-updater configuration rejected");
        }
    }

    builder
        .manage(api_broker::ApiBrokerState::new())
        .manage(session_broker::SessionBrokerState::new())
        .manage(vault::VaultState::default())
        .manage(deep_link::DeepLinkState::default())
        .manage(diagnostics::DiagnosticsState::default())
        .manage(file_transfer::FileTransferState::default())
        .manage(native_notification::NativeNotificationState::default())
        .manage(updater::UpdaterOperationState::default())
        .manage(window_lifecycle::WindowLifecycleState::default())
        // Native close is always stopped first. The renderer's listener-first
        // lifecycle service applies the user's close preference and checks
        // every registered draft/transfer/journal before hide or exit.
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    window_lifecycle::request_close(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            native_notification::show_native_notification,
            native_notification::notification_activation_take_pending,
            commands::open_url,
            api_broker::api_broker_initialize,
            api_broker::api_broker_configure,
            api_broker::api_broker_clear,
            api_broker::api_broker_stream_request,
            api_broker::api_broker_cancel,
            api_broker::api_broker_probe,
            session_broker::session_broker_initialize,
            session_broker::session_broker_stream_request,
            session_broker::session_broker_cancel,
            session_broker::session_broker_clear,
            session_broker::session_broker_clear_all,
            api_broker::api_workspace_store,
            api_broker::api_workspace_remove,
            api_broker::api_workspace_status,
            api_broker::api_workspace_switch,
            vault::vault_seal,
            vault::vault_open,
            vault::vault_purge_key,
            deep_link::deep_link_take_pending,
            commands::set_tray_badge,
            commands::get_app_version,
            commands::get_platform,
            commands::quit_app,
            commands::migration_ledger_read,
            commands::migration_ledger_write,
            commands::migration_ledger_clear,
            commands::migration_ledger_prune,
            updater::check_for_updates,
            updater::get_update_state,
            updater::install_update,
            updater::restart_app,
            diagnostics::diagnostics_record_renderer_event,
            diagnostics::diagnostics_take_startup_crash,
            diagnostics::diagnostics_set_safe_mode,
            diagnostics::diagnostics_read_recent,
            file_transfer::transfer_begin_save,
            file_transfer::transfer_write_chunk,
            file_transfer::transfer_finish_save,
            file_transfer::transfer_cancel_save,
            file_transfer::transfer_revoke_picker_path,
            file_transfer::transfer_reveal_saved,
            window_lifecycle::desktop_window_lifecycle_ready,
            window_lifecycle::desktop_window_hide,
            window_lifecycle::desktop_window_cancel_intent,
            window_lifecycle::desktop_window_set_context,
        ])
        .setup(move |app| {
            info!("Moosewave Desktop v{} started", version);

            if diagnostics::initialize(app.handle()).is_err() {
                // Keep startup recoverable; the renderer still has its bounded
                // structural fallback journal and on-screen incident ID.
                error!("desktop diagnostics could not initialize");
            }
            if window_lifecycle::initialize(app.handle()).is_err() {
                // The app remains usable, but shutdown recovery is then
                // limited to each owner's own durable journal.
                error!("desktop lifecycle recovery marker could not initialize");
            }

            // Register the global quick-compose shortcut (honours the
            // persisted tray-toggle preference; defaults to ON). This MUST
            // run before build_tray: the tray's check item is seeded from
            // the ACTUAL registration result, so a failed OS registration
            // shows up unchecked instead of claiming a shortcut we don't
            // own (the shortcut plugin is loaded above via .plugin(), so
            // it is available here independent of the tray).
            let quick_compose_enabled = shortcut::register_if_enabled(app.handle());

            // Build & install the system tray.
            let _tray = tray::build_tray(app.handle(), quick_compose_enabled)?;

            // Build & install the application menu (mac menubar / win in-window).
            let menu = menu::build_app_menu(app.handle())?;
            app.set_menu(menu)?;

            // Wire menu-item clicks to events the dashboard can listen for.
            app.on_menu_event(|app, event| {
                menu::handle_menu_event(app, event.id().as_ref());
            });

            // Register the moosewave:// deep-link handler. This fires when the
            // OS hands us a URL (e.g. user clicks a link in Mail). On macOS
            // this also catches "open via URL" before the window is created,
            // hence we drain pending URLs on setup.
            deep_link::register(app.handle())?;

            // Show the main window AFTER window-state has restored its
            // position. We set visible=false in tauri.conf.json to avoid a
            // visible flicker where the window first paints at the default
            // position and then jumps to the restored one.
            let main_window = match app.get_webview_window("main") {
                Some(window) => window,
                None => {
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                        .title("Moosewave")
                        .inner_size(1100.0, 720.0)
                        .min_inner_size(880.0, 560.0)
                        .build()?
                }
            };
            // A prior keep-running close hides the NSApplication as well as
            // its window. AppKit can preserve that hidden activation state
            // across a fast relaunch, so startup must reveal through the same
            // app+window path used by Dock/tray reopen.
            window_lifecycle::reveal_main_window(app.handle());
            main_window.show()?;
            main_window.set_focus()?;

            // Window-state restoration completes asynchronously on macOS.
            // Reassert visibility once after it settles so a saved hidden
            // frame cannot win the race and leave only the menu bar running.
            let startup_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(250)).await;
                window_lifecycle::reveal_main_window(&startup_handle);
            });

            // Network state bridge. install_focus_probe hooks the main
            // window's focus event so renderer's onlineManager gets a
            // re-probe nudge after macOS sleep/resume; spawn_watcher
            // listens to OS interface add/remove events (gaps doc B7)
            // and emits debounced `net:state` probe/offline hints. The
            // JS heartbeat stays the source of truth either way.
            net::install_focus_probe(app.handle());
            net::spawn_watcher(app.handle());

            // Check after a short launch grace period and every six hours.
            // The scheduler only checks/emits availability; download,
            // installation, and restart remain explicit operator actions.
            updater::spawn_update_scheduler(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Moosewave Desktop")
        // D03-tauri-shell#4: hide-on-close orderOut()s the main window (see the
        // CloseRequested handler above). AppKit's default reopen only
        // un-minimizes windows; it does NOT re-show a hidden one, so clicking
        // the Dock icon after closing the window did nothing (the window was
        // only recoverable via the tray). Handle RunEvent::Reopen (macOS
        // dock-activation) by showing + focusing main again, mirroring the
        // tray "Open" handler.
        .run(move |app_handle, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                if !window_lifecycle::exit_is_approved(app_handle) {
                    api.prevent_exit();
                    window_lifecycle::request_os_shutdown(app_handle);
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                window_lifecycle::reveal_main_window(app_handle);
            }
            _ => {}
        });
}

#[cfg(test)]
mod bundle_security_tests {
    #[test]
    fn macos_hardened_runtime_has_no_unsafe_code_execution_exceptions() {
        let entitlements = include_str!("../entitlements.plist");
        for forbidden in [
            "com.apple.security.cs.allow-jit",
            "com.apple.security.cs.allow-unsigned-executable-memory",
            "com.apple.security.cs.disable-library-validation",
            "com.apple.security.app-sandbox</key>",
        ] {
            assert!(
                !entitlements.contains(forbidden),
                "unsafe entitlement returned: {forbidden}"
            );
        }

        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["bundle"]["macOS"]["hardenedRuntime"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["bundle"]["macOS"]["entitlements"].as_str(),
            Some("entitlements.plist")
        );
    }

    #[test]
    fn renderer_has_no_direct_deep_link_plugin_permission() {
        let capability = include_str!("../capabilities/main.json");
        assert!(!capability.contains("deep-link:"));
    }

    #[test]
    fn notifications_have_one_opaque_activation_backend() {
        let main_source = include_str!("main.rs");
        let native_source = include_str!("native_notification.rs");
        let cargo = include_str!("../Cargo.toml");
        let package = include_str!("../../package.json");
        let capability = include_str!("../capabilities/main.json");
        // Split the forbidden token so this source-contract test does not
        // make its own `include_str!("main.rs")` assertion fail by containing
        // the exact registration call it is checking for.
        let notification_plugin_init = ["tauri_plugin_", "notification::init()"].concat();

        assert!(!main_source.contains(&notification_plugin_init));
        assert!(!cargo.contains("tauri-plugin-notification"));
        assert!(!package.contains("@tauri-apps/plugin-notification"));
        assert!(!capability.contains("notification:"));
        assert!(cargo.contains("notify-rust = \"4.18.0\""));
        assert!(native_source.contains("handle.wait_for_action"));
        assert!(native_source.contains("validate_activation_id"));
        assert!(native_source.contains("MAX_PENDING_ACTIVATIONS"));
    }

    #[test]
    fn clipboard_plugin_is_registered_with_text_only_least_privilege() {
        let source = include_str!("main.rs");
        let capability = include_str!("../capabilities/main.json");

        assert!(source.contains("tauri_plugin_clipboard_manager::init()"));
        for required in [
            "clipboard-manager:allow-write-text",
            "clipboard-manager:allow-read-text",
            "clipboard-manager:allow-clear",
        ] {
            assert!(capability.contains(required), "missing {required}");
        }
        for forbidden in [
            "clipboard-manager:default",
            "allow-read-image",
            "allow-write-image",
            "allow-write-html",
        ] {
            assert!(
                !capability.contains(forbidden),
                "clipboard capability is broader than the renderer contract: {forbidden}"
            );
        }
    }
}
