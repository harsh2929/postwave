//! IPC commands callable from the dashboard JavaScript side.
//!
//! The dashboard checks for `window.__TAURI__` and, when present, invokes
//! these commands via `@tauri-apps/api/core`'s `invoke()`. All commands
//! return `Result<T, String>` so errors serialize cleanly to JS rejections.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::ipc_guard::ensure_main_bundled_window;

/// Maximum size of a single migration-upload ledger record. Mirrors the
/// JS guard in api-client.ts — keep them in lockstep when bumping.
const MAX_MIGRATION_LEDGER_BYTES: usize = 8 * 1024;
/// Subdirectory under app_local_data_dir where migration ledgers live.
/// Resilient for >5MB localStorage scenarios and survives Safari/WebView
/// storage eviction across OS upgrades.
const MIGRATION_LEDGER_DIR: &str = "migration-upload-ledger";
const MIGRATION_LEDGER_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_MIGRATION_LEDGERS: usize = 20;
const LEGACY_MIGRATION_LEDGER_FILE_PREFIX: &str = "postwave.desktop.migration-upload.v1_";
static LEDGER_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Version payload returned to the JS shell.
#[derive(Debug, Serialize, Deserialize)]
pub struct AppVersion {
    pub version: String,
    pub commit: Option<String>,
}

/// Open an external URL in the user's default browser.
///
/// Only `https://` and `moosewave://` are permitted in release builds.
/// Debug builds also allow loopback `http://localhost` URLs so Docker/local
/// API development remains ergonomic. `file://`, credentials-in-URL, and
/// arbitrary custom schemes are rejected before control reaches the OS opener.
///
/// JS: `await invoke('open_url', { url: 'https://...' })`
#[tauri::command]
pub fn open_url<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    url: String,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "External URL opener")?;
    validate_external_url(&url)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

fn validate_external_url(raw: &str) -> Result<(), String> {
    if raw.len() > 8_192 {
        return Err("url too long".to_string());
    }
    let parsed = Url::parse(raw).map_err(|_| "invalid url".to_string())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URLs with embedded credentials are not allowed".to_string());
    }

    match parsed.scheme() {
        "https" => Ok(()),
        "postwave" => Ok(()),
        "mailto" if is_safe_mailto(&parsed) => Ok(()),
        "sms" if is_safe_sms_intent(&parsed) => Ok(()),
        "http" if cfg!(debug_assertions) && is_loopback_host(parsed.host_str()) => Ok(()),
        scheme => Err(format!("rejected url scheme: {scheme}")),
    }
}

fn is_loopback_host(host: Option<&str>) -> bool {
    match host.map(|h| h.to_ascii_lowercase()) {
        Some(host) => host == "localhost" || host == "127.0.0.1" || host == "::1",
        None => false,
    }
}

fn is_safe_mailto(url: &Url) -> bool {
    let address = url.path();
    if !address.is_empty() && !is_single_postwave_address(address) {
        return false;
    }
    url.fragment().is_none()
        && url
            .query_pairs()
            .all(|(key, _)| matches!(key.as_ref(), "subject" | "body"))
}

fn is_single_postwave_address(address: &str) -> bool {
    if address.len() > 128 || address.contains('%') || address.contains(',') {
        return false;
    }
    let Some((local, domain)) = address.split_once('@') else {
        return false;
    };
    if local.is_empty()
        || local.len() > 64
        || local.starts_with('.')
        || local.ends_with('.')
        || local.contains("..")
        || local.contains('@')
        || !domain.eq_ignore_ascii_case("moosewave.com")
    {
        return false;
    }
    local.bytes().all(|byte| {
        byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'!' | b'#'
                    | b'$'
                    | b'&'
                    | b'\''
                    | b'*'
                    | b'+'
                    | b'-'
                    | b'/'
                    | b'='
                    | b'?'
                    | b'^'
                    | b'_'
                    | b'`'
                    | b'{'
                    | b'|'
                    | b'}'
                    | b'~'
                    | b'.'
            )
    })
}

fn is_safe_sms_intent(url: &Url) -> bool {
    let recipient = url.path();
    (recipient.is_empty()
        || recipient
            .chars()
            .all(|character| character.is_ascii_digit() || matches!(character, '+' | '-' | ',')))
        && url
            .query_pairs()
            .all(|(key, _)| key.is_empty() || key == "body")
}

/// Set the tray / dock badge count.
///
/// Behavior per platform:
/// * macOS — sets the dock badge to the count (or clears it if 0).
/// * Windows — best-effort taskbar overlay; gracefully no-ops if the
///   underlying API isn't available on the user's Windows version.
/// * Linux — currently a no-op; logs a warning.
///
/// JS: `await invoke('set_tray_badge', { count: 3 })`
#[tauri::command]
pub fn set_tray_badge<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    count: Option<u32>,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "Tray badge")?;
    let count = count.unwrap_or(0);

    #[cfg(target_os = "macos")]
    {
        let label = if count == 0 {
            None
        } else {
            Some(count.to_string())
        };
        if let Some(window) = app.get_webview_window("main") {
            // Tauri 2's Window has set_badge_count for the dock.
            window
                .set_badge_count(label.as_ref().and_then(|s| s.parse().ok()))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        // Best-effort: Tauri 2 also exposes set_badge_count on Windows where
        // available. If it's unsupported, swallow the error so the dashboard
        // can degrade gracefully.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_badge_count(if count == 0 { None } else { Some(count as i64) });
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        tracing::warn!("set_tray_badge not implemented on this platform (count={count})");
        Ok(())
    }
}

/// Return the desktop app's version (from Cargo.toml at compile time).
///
/// JS: `const v = await invoke<AppVersion>('get_app_version')`
#[tauri::command]
pub fn get_app_version(window: WebviewWindow) -> Result<AppVersion, String> {
    ensure_main_bundled_window(&window, "App version")?;
    Ok(AppVersion {
        version: env!("CARGO_PKG_VERSION").to_string(),
        commit: option_env!("POSTWAVE_COMMIT_SHA").map(str::to_string),
    })
}

/// Return the platform string the dashboard can branch on.
///
/// JS: `const p = await invoke<'macos'|'windows'|'linux'>('get_platform')`
#[tauri::command]
pub fn get_platform(window: WebviewWindow) -> Result<&'static str, String> {
    ensure_main_bundled_window(&window, "Platform info")?;
    #[cfg(target_os = "macos")]
    {
        Ok("macos")
    }
    #[cfg(target_os = "windows")]
    {
        Ok("windows")
    }
    #[cfg(target_os = "linux")]
    {
        Ok("linux")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Ok("unknown")
    }
}

/// Cleanly exit the application.
///
/// JS: `await invoke('quit_app')`
#[tauri::command]
pub fn quit_app<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>) -> Result<(), String> {
    ensure_main_bundled_window(&window, "Application quit")?;
    crate::window_lifecycle::approve_exit(&app);
    let _ = crate::diagnostics::record_native_lifecycle(&app, "exit_approved");
    app.exit(0);
    Ok(())
}

/// Read a migration upload ledger from `app_local_data_dir`.
///
/// The ledger key is sanitized so we never escape the per-app directory.
/// Returns `Ok(None)` when no ledger exists yet or when the stored value
/// exceeds [`MAX_MIGRATION_LEDGER_BYTES`] (in which case we evict).
///
/// JS: `await invoke<string|null>('migration_ledger_read', { key })`
#[tauri::command]
pub fn migration_ledger_read<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    key: String,
) -> Result<Option<String>, String> {
    ensure_main_bundled_window(&window, "Migration ledger")?;
    let path = migration_ledger_path(&app, &key)?;
    read_migration_ledger_path(&path)
}

/// Write a migration upload ledger to `app_local_data_dir`. The payload
/// is treated as opaque JSON — validation happens on the renderer side
/// (parity with the localStorage path) so the contract stays in one place.
///
/// JS: `await invoke('migration_ledger_write', { key, payload })`
#[tauri::command]
pub fn migration_ledger_write<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    key: String,
    payload: String,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "Migration ledger")?;
    let path = migration_ledger_path(&app, &key)?;
    atomic_write_migration_ledger(&path, &payload)
}

/// Delete a migration upload ledger. No-op if the file doesn't exist.
///
/// JS: `await invoke('migration_ledger_clear', { key })`
#[tauri::command]
pub fn migration_ledger_clear<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    key: String,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "Migration ledger")?;
    let path = migration_ledger_path(&app, &key)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

/// Remove ownership-ambiguous v1 ledgers, records older than seven days, and
/// the oldest records above the bounded native resume-state cap.
#[tauri::command]
pub fn migration_ledger_prune<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "Migration ledger")?;
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join(MIGRATION_LEDGER_DIR);
    prune_migration_ledger_dir(&directory)
}

fn prune_migration_ledger_dir(directory: &std::path::Path) -> Result<(), String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.to_string()),
    };
    let now = SystemTime::now();
    let mut retained = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".json") {
            continue;
        }
        if name.starts_with(LEGACY_MIGRATION_LEDGER_FILE_PREFIX) {
            let _ = fs::remove_file(path);
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        if now.duration_since(modified).unwrap_or_default() > MIGRATION_LEDGER_TTL {
            let _ = fs::remove_file(path);
            continue;
        }
        retained.push((path, modified));
    }
    retained.sort_by(|left, right| right.1.cmp(&left.1));
    for (path, _) in retained.into_iter().skip(MAX_MIGRATION_LEDGERS) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn migration_ledger_path<R: Runtime>(app: &AppHandle<R>, key: &str) -> Result<PathBuf, String> {
    let safe = sanitize_ledger_key(key)?;
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join(MIGRATION_LEDGER_DIR);
    Ok(base.join(format!("{safe}.json")))
}

fn read_migration_ledger_path(path: &std::path::Path) -> Result<Option<String>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.to_string()),
    };
    if bytes.len() > MAX_MIGRATION_LEDGER_BYTES {
        let _ = fs::remove_file(path);
        return Ok(None);
    }
    let payload = match String::from_utf8(bytes) {
        Ok(payload) => payload,
        Err(_) => {
            let _ = fs::remove_file(path);
            return Ok(None);
        }
    };
    if serde_json::from_str::<serde_json::Value>(&payload).is_err() {
        let _ = fs::remove_file(path);
        return Ok(None);
    }
    Ok(Some(payload))
}

/// Persist a ledger with crash-safe same-directory replacement: write and
/// fsync a private temp file, atomically replace the destination, then fsync
/// the directory (or request write-through replacement on Windows).
fn atomic_write_migration_ledger(path: &std::path::Path, payload: &str) -> Result<(), String> {
    if payload.len() > MAX_MIGRATION_LEDGER_BYTES {
        return Err("payload too large".to_string());
    }
    if serde_json::from_str::<serde_json::Value>(payload).is_err() {
        return Err("payload must be valid JSON".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "ledger path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid ledger filename".to_string())?;
    let sequence = LEDGER_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp_path = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        sequence
    ));

    let result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut temp = options.open(&temp_path).map_err(|e| e.to_string())?;
        temp.write_all(payload.as_bytes())
            .map_err(|e| e.to_string())?;
        temp.sync_all().map_err(|e| e.to_string())?;
        drop(temp);
        replace_file_atomically(&temp_path, path)?;
        #[cfg(unix)]
        File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[cfg(not(windows))]
fn replace_file_atomically(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn replace_file_atomically(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from_wide: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to_wide: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both buffers are NUL-terminated and remain alive for the call.
    let ok = unsafe {
        MoveFileExW(
            from_wide.as_ptr(),
            to_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

/// Sanitize a ledger key into a filesystem-safe filename. We allow only
/// alphanumerics, dot, dash, and underscore. Anything else (including the
/// `:` separator used in the JS-side key shape) is replaced with `_`. We
/// also cap the length so absurdly long filenames don't blow up the FS.
fn sanitize_ledger_key(key: &str) -> Result<String, String> {
    if key.is_empty() {
        return Err("empty ledger key".to_string());
    }
    let mut out = String::with_capacity(key.len().min(200));
    for c in key.chars().take(200) {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        return Err("invalid ledger key".to_string());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{
        atomic_write_migration_ledger, prune_migration_ledger_dir, read_migration_ledger_path,
        sanitize_ledger_key, validate_external_url,
    };
    use std::fs;

    #[test]
    fn allows_https_and_postwave_links() {
        assert!(validate_external_url("https://moosewave.com/legal/privacy").is_ok());
        assert!(validate_external_url("moosewave://auth/magic?token=abc").is_ok());
        assert!(validate_external_url("mailto:privacy@moosewave.com").is_ok());
        assert!(validate_external_url("mailto:?subject=Hello&body=Share%20this").is_ok());
        assert!(validate_external_url("sms:?&body=Share%20this").is_ok());
    }

    #[test]
    fn rejects_dangerous_url_shapes() {
        assert!(validate_external_url("file:///etc/passwd").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("https://user:pass@example.com").is_err());
        assert!(validate_external_url("mailto:attacker@example.com").is_err());
        assert!(validate_external_url("mailto:attacker@example.com,privacy@moosewave.com").is_err());
        assert!(validate_external_url("mailto:privacy@moosewave.com.evil.test").is_err());
        assert!(validate_external_url("mailto:%70rivacy@moosewave.com").is_err());
        assert!(validate_external_url("mailto:.privacy@moosewave.com").is_err());
        assert!(validate_external_url("mailto:privacy..team@moosewave.com").is_err());
        assert!(validate_external_url("sms:12345?redirect=https://evil.test").is_err());
    }

    #[test]
    fn ledger_keys_are_sanitized() {
        // Real-shaped key from api-client: prefix:source:hash:size:lastmod
        let safe =
            sanitize_ledger_key("postwave.desktop.migration-upload.v1:csv:abc:13:99").unwrap();
        assert!(!safe.contains(':'));
        assert!(!safe.contains('/'));
        assert!(!safe.contains('\\'));
        assert!(sanitize_ledger_key("").is_err());
        // Path traversal attempt collapses path separators into underscores
        // so the result can't escape the per-app ledger directory.
        let trav = sanitize_ledger_key("../../etc/passwd").unwrap();
        assert!(!trav.contains('/'));
        assert!(!trav.contains('\\'));
        // Length is capped.
        assert!(sanitize_ledger_key(&"a".repeat(500)).unwrap().len() <= 200);
    }

    #[test]
    fn ledger_write_is_atomic_and_corruption_recovers() {
        let dir = std::env::temp_dir().join(format!(
            "postwave-ledger-test-{}-{}",
            std::process::id(),
            super::LEDGER_TEMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ledger.json");

        atomic_write_migration_ledger(&path, r#"{"offset":1}"#).unwrap();
        atomic_write_migration_ledger(&path, r#"{"offset":2}"#).unwrap();
        assert_eq!(
            read_migration_ledger_path(&path).unwrap().as_deref(),
            Some(r#"{"offset":2}"#)
        );
        assert!(fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));

        // A rejected write cannot damage the last good ledger.
        assert!(atomic_write_migration_ledger(&path, "not-json").is_err());
        assert!(read_migration_ledger_path(&path).unwrap().is_some());

        // Crash/corruption recovery evicts an unreadable destination rather
        // than feeding partial state back into upload resumption.
        fs::write(&path, b"{partial").unwrap();
        assert_eq!(read_migration_ledger_path(&path).unwrap(), None);
        assert!(!path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ledger_prune_removes_legacy_and_bounds_native_resume_state() {
        let dir = std::env::temp_dir().join(format!(
            "postwave-ledger-prune-test-{}-{}",
            std::process::id(),
            super::LEDGER_TEMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("postwave.desktop.migration-upload.v1_csv_old.json"),
            r#"{"version":1}"#,
        )
        .unwrap();
        for index in 0..25 {
            fs::write(
                dir.join(format!(
                    "postwave.desktop.migration-upload.v2_{index:064}.json"
                )),
                r#"{"version":2}"#,
            )
            .unwrap();
        }

        prune_migration_ledger_dir(&dir).unwrap();

        let files = fs::read_dir(&dir).unwrap().count();
        assert_eq!(files, super::MAX_MIGRATION_LEDGERS);
        assert!(!dir
            .join("postwave.desktop.migration-upload.v1_csv_old.json")
            .exists());
        let _ = fs::remove_dir_all(dir);
    }
}
