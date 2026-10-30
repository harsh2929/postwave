//! Privacy-safe native desktop notifications with retained activation.
//!
//! `tauri-plugin-notification` intentionally discards the desktop
//! `notify-rust` handle, which means a click can never reach the renderer.
//! This module owns the same native backend directly, retains the handle on a
//! blocking worker, and crosses the native boundary with only the encrypted
//! Notification Center's 64-bit opaque row id. Titles, bodies, domain ids and
//! deep links never appear in activation events or the bounded cold-start
//! queue.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

use crate::ipc_guard::ensure_main_bundled_window;

pub const NOTIFICATION_ACTIVATED_EVENT: &str = "notification:activated";
const MAX_PENDING_ACTIVATIONS: usize = 32;
const MAX_TITLE_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 280;

#[derive(Default)]
pub struct NativeNotificationState {
    pending: Mutex<VecDeque<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationActivation {
    activation_id: String,
}

impl NativeNotificationState {
    fn enqueue(&self, activation_id: String) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "notification activation state unavailable".to_string())?;
        if pending.iter().any(|current| current == &activation_id) {
            return Ok(());
        }
        if pending.len() == MAX_PENDING_ACTIVATIONS {
            pending.pop_front();
        }
        pending.push_back(activation_id);
        Ok(())
    }

    fn take_all(&self) -> Result<Vec<NotificationActivation>, String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "notification activation state unavailable".to_string())?;
        Ok(pending
            .drain(..)
            .map(|activation_id| NotificationActivation { activation_id })
            .collect())
    }
}

/// Show privacy-safe OS copy and, when supplied, retain an opaque activation
/// handle. The optional id is a Notification Center row id, never a resource
/// id or deep link. Both IPC copy and id are validated again in native code so
/// a compromised renderer cannot smuggle controls or unbounded data into an
/// OS surface.
#[tauri::command]
pub fn show_native_notification<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    title: String,
    body: String,
    activation_id: Option<String>,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "Native notification")?;
    validate_copy(&title, MAX_TITLE_CHARS)?;
    validate_copy(&body, MAX_BODY_CHARS)?;
    if let Some(id) = activation_id.as_deref() {
        validate_activation_id(id)?;
    }

    let mut notification = notify_rust::Notification::new();
    notification
        .summary(&title)
        .body(&body)
        .appname("Moosewave")
        .auto_icon();

    #[cfg(target_os = "windows")]
    configure_windows_app_id(&app, &mut notification)?;

    #[cfg(target_os = "macos")]
    configure_macos_application(&app)?;

    if activation_id.is_some() {
        notification.action("open", "Open Moosewave");
    }

    let handle = notification
        .show()
        .map_err(|_| "native notification could not be delivered".to_string())?;

    let Some(activation_id) = activation_id else {
        // On Windows/XDG `show` has already delivered. The legacy macOS
        // backend deliberately delivers from `NotificationHandle::drop` when
        // no response is requested, matching the plugin's fire-and-forget
        // behavior for the explicit Settings test alert.
        drop(handle);
        return Ok(());
    };

    // `wait_for_action` blocks until activation/dismissal. Tauri's blocking
    // pool keeps the UI/run loop responsive; retaining the handle is exactly
    // what the upstream plugin's desktop wrapper does not do.
    tauri::async_runtime::spawn_blocking(move || {
        handle.wait_for_action(move |action| {
            if action == "__closed" {
                return;
            }
            let state = app.state::<NativeNotificationState>();
            if state.enqueue(activation_id.clone()).is_err() {
                return;
            }
            crate::window_lifecycle::reveal_main_window(&app);
            // The queue remains authoritative until the renderer drains it.
            // If this live emission races a reload, the next listener-first
            // handshake still receives the same opaque activation.
            let _ = app.emit(
                NOTIFICATION_ACTIVATED_EVENT,
                NotificationActivation { activation_id },
            );
        });
    });

    Ok(())
}

/// Listener-first renderer handshake. The renderer subscribes to the live
/// event before invoking this command, then resolves ids only against the
/// currently decrypted identity-scoped center.
#[tauri::command]
pub fn notification_activation_take_pending(
    window: WebviewWindow,
    state: tauri::State<'_, NativeNotificationState>,
) -> Result<Vec<NotificationActivation>, String> {
    ensure_main_bundled_window(&window, "Notification activation")?;
    state.take_all()
}

fn validate_copy(value: &str, max_chars: usize) -> Result<(), String> {
    if value.is_empty()
        || value.trim() != value
        || value.chars().count() > max_chars
        || value.chars().any(char::is_control)
    {
        return Err("invalid native notification copy".to_string());
    }
    Ok(())
}

fn validate_activation_id(value: &str) -> Result<(), String> {
    if value.len() != 16
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("invalid notification activation id".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn configure_windows_app_id<R: Runtime>(
    app: &AppHandle<R>,
    notification: &mut notify_rust::Notification,
) -> Result<(), String> {
    use std::path::MAIN_SEPARATOR as SEP;

    let executable = tauri::utils::platform::current_exe()
        .map_err(|_| "native notification executable unavailable".to_string())?;
    let directory = executable
        .parent()
        .ok_or_else(|| "native notification executable unavailable".to_string())?
        .display()
        .to_string();
    // An AppUserModelID must be registered by the installed package. Dev
    // binaries are intentionally left on notify-rust's PowerShell fallback.
    if !(directory.ends_with(format!("{SEP}target{SEP}debug").as_str())
        || directory.ends_with(format!("{SEP}target{SEP}release").as_str()))
    {
        notification.app_id(&app.config().identifier);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn configure_macos_application<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let application = if tauri::is_dev() {
        "com.apple.Terminal"
    } else {
        &app.config().identifier
    };
    notify_rust::set_application(application)
        .map_err(|_| "native notification application unavailable".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        validate_activation_id, validate_copy, NativeNotificationState, MAX_PENDING_ACTIVATIONS,
    };

    #[test]
    fn copy_is_bounded_trimmed_and_control_free() {
        assert!(validate_copy("Moosewave update", 120).is_ok());
        assert!(validate_copy("", 120).is_err());
        assert!(validate_copy(" leading", 120).is_err());
        assert!(validate_copy("trailing ", 120).is_err());
        assert!(validate_copy("line\nbreak", 120).is_err());
        assert!(validate_copy(&"x".repeat(121), 120).is_err());
    }

    #[test]
    fn activation_ids_are_exact_lowercase_opaque_hex() {
        assert!(validate_activation_id("0123456789abcdef").is_ok());
        assert!(validate_activation_id("0123456789abcde").is_err());
        assert!(validate_activation_id("0123456789ABCDEf").is_err());
        assert!(validate_activation_id("campaign-1234567").is_err());
        assert!(validate_activation_id("0123456789abcdeg").is_err());
    }

    #[test]
    fn pending_queue_deduplicates_and_evicts_oldest_at_the_bound() {
        let state = NativeNotificationState::default();
        for index in 0..=MAX_PENDING_ACTIVATIONS {
            state.enqueue(format!("{index:016x}")).unwrap();
        }
        state
            .enqueue(format!("{:016x}", MAX_PENDING_ACTIVATIONS))
            .unwrap();

        let pending = state.take_all().unwrap();
        assert_eq!(pending.len(), MAX_PENDING_ACTIVATIONS);
        assert_eq!(pending.first().unwrap().activation_id, "0000000000000001");
        assert_eq!(
            pending.last().unwrap().activation_id,
            format!("{:016x}", MAX_PENDING_ACTIVATIONS)
        );
        assert!(state.take_all().unwrap().is_empty());
    }
}
